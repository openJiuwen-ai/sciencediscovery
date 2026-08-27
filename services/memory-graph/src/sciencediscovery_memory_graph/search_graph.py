# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""The `/evolve` search graph: one SubTask binds one SearchRun, under which the
candidates live.

```
SubTask -[:searches]-> SearchRun -[:root]->     SearchNode
                                 -[:elected]->  |
                                                +-[:expands]->  SearchNode
                                                +-[:inspires]-> SearchNode   (openevolve)
                                                +-[:occupies]-> SearchCell   (openevolve)
```

Translation is split in two on purpose:

* :func:`plan_writes` is **pure** — event records in, UNWIND payloads out. Every
  rule worth getting right (a failed candidate's ``score`` is null, visits are
  absolute, the watermark drops a replay, a candidate can hold cells on two
  islands) is decided here and can be tested without a database.
* :func:`upsert_search_progress` is the thin part that runs the Cypher.

The graph is a **projection, not the source of truth**: the control plane's
``events.ndjson`` is what a run is replayed, resumed and audited from. So every
write here is idempotent and a Neo4j outage costs nothing but a later replay.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from .logging_config import get_logger
from .neo4j_driver import handle

log = get_logger("search_graph")

#: Cap on the nodes one read returns. A run is bounded by its expansion budget,
#: but a caller asking for a 5,000-node tree should get a marked-truncated
#: answer rather than a page that takes a second to draw.
_MAX_NODES = 2_000

#: openevolve grids only. ``islands x feature_bins^2`` is 48 at the defaults;
#: the cap is here so a misconfigured run cannot mint cells without bound.
_MAX_CELLS = 512


@dataclass
class WritePlan:
    """Everything one batch of events changes, as UNWIND-ready rows."""

    #: ``SearchRun`` properties to set (always includes ``last_seq``).
    run: dict[str, Any] = field(default_factory=dict)
    #: ``SearchNode`` rows to MERGE.
    nodes: list[dict[str, Any]] = field(default_factory=list)
    #: ``(node_index, visits)`` — absolute counts, never deltas.
    visits: list[dict[str, Any]] = field(default_factory=list)
    #: ``expands`` edges as ``{parent_index, node_index}``.
    expands: list[dict[str, Any]] = field(default_factory=list)
    #: ``inspires`` edges as ``{source_index, node_index}`` (openevolve).
    inspires: list[dict[str, Any]] = field(default_factory=list)
    #: ``SearchCell`` rows plus the occupancy they claim (openevolve).
    cells: list[dict[str, Any]] = field(default_factory=list)
    #: The node index the ``root`` edge points at, when this batch seeded one.
    root_index: int | None = None
    #: The node index the ``elected`` edge should point at, when it moved.
    elected_index: int | None = None
    #: Watermark after this batch; ``None`` when nothing was applied.
    last_seq: int | None = None
    #: Records dropped because they were at or below the incoming watermark.
    skipped: int = 0


def plan_writes(
    *,
    search_id: str,
    session_id: str,
    records: Iterable[dict[str, Any]],
    last_seq: int = 0,
) -> WritePlan:
    """Fold a batch of event records into one write plan.

    Records at or below ``last_seq`` are dropped: the sidecar assigns the
    numbering, so a reconnecting producer that replays its buffer must be a
    no-op rather than a double-count. That guarantee is what lets a mid-run
    Neo4j outage be repaired by replaying the log from the beginning.
    """
    plan = WritePlan()
    by_index: dict[int, dict[str, Any]] = {}

    for record in records:
        sequence = record.get("sequence")
        if not isinstance(sequence, int):
            continue
        if sequence <= last_seq:
            plan.skipped += 1
            continue
        event = record.get("event") or {}
        kind = event.get("type")
        plan.last_seq = sequence if plan.last_seq is None else max(plan.last_seq, sequence)
        created_at = record.get("createdAt")

        if kind == "search_started":
            plan.run.update({
                "algorithm": event.get("algorithm"),
                "scorecard_hash": event.get("scorecardHash"),
                "started_at": created_at,
                "status": "running",
            })

        elif kind == "seeded":
            index = int(event.get("nodeIndex", 0))
            node = _node_row(index, search_id, session_id, created_at)
            node.update({
                "depth": 0,
                "parent_index": None,
                "score": _finite(event.get("baselineScore")),
                "valid": True,
            })
            by_index[index] = node
            plan.root_index = index
            plan.run["baseline_score"] = _finite(event.get("baselineScore"))

        elif kind == "selected":
            for entry in event.get("ancestorVisits") or []:
                # Absolute, not a delta: SET n.visits = $visits. A replayed
                # increment would over-count; a replayed absolute cannot.
                plan.visits.append({
                    "node_index": int(entry.get("nodeIndex", 0)),
                    "visits": int(entry.get("visits", 0)),
                })
            index = event.get("nodeIndex")
            if isinstance(index, int):
                node = by_index.setdefault(index, _node_row(index, search_id, session_id, created_at))
                if event.get("puct") is not None:
                    node["selected_puct"] = _finite(event.get("puct"))
                if event.get("rankScore") is not None:
                    node["selected_rank_score"] = _finite(event.get("rankScore"))

        elif kind == "expanded":
            index = int(event.get("nodeIndex", 0))
            node = by_index.setdefault(index, _node_row(index, search_id, session_id, created_at))
            node.update({
                "change_summary": event.get("changeSummary"),
                "code_chars": event.get("codeChars"),
                "code_hash": event.get("codeHash"),
                "depth": event.get("depth"),
                "error": event.get("error"),
                "island": event.get("island"),
                "iteration": event.get("iteration"),
                "parent_index": event.get("parentIndex"),
                "program_id": event.get("programId"),
                # `-inf` is the upstream failure sentinel and is not valid JSON;
                # a failed candidate carries null and `valid: false`, and still
                # enters the tree — dropping it would change the rank
                # denominator of every later iteration.
                "score": _finite(event.get("score")),
                "valid": bool(event.get("valid")),
                "worker": event.get("worker"),
            })
            parent = event.get("parentIndex")
            if isinstance(parent, int):
                plan.expands.append({"node_index": index, "parent_index": parent})
            for source in event.get("inspirationIndexes") or []:
                plan.inspires.append({"node_index": index, "source_index": int(source)})

        elif kind == "evaluated":
            index = int(event.get("nodeIndex", 0))
            node = by_index.setdefault(index, _node_row(index, search_id, session_id, created_at))
            node.update({
                "evaluated_at": created_at,
                "gate_score": _finite(event.get("gateScore")),
                "reward": _finite(event.get("reward")),
                "rollout_score": _finite(event.get("rolloutScore")),
            })
            # Per-criterion scores are flattened: Neo4j properties are scalars
            # and arrays, with no nested maps, and a JSON blob would kill the
            # `WHERE n.crit_runtime > 300` queries this graph exists to answer.
            for criterion_id, value in (event.get("criteria") or {}).items():
                node[f"crit_{criterion_id}"] = _finite(value)

        elif kind == "inserted":
            plan.cells.append({
                "complexity_bin": int(event.get("complexityBin", 0)),
                "diversity_bin": int(event.get("diversityBin", 0)),
                "island": int(event.get("island", 0)),
                "node_index": int(event.get("nodeIndex", 0)),
                "updated_at": created_at,
                "via": event.get("via") or "insert",
            })

        elif kind == "migrated":
            # Migration *copies* an elite into the neighbouring island, so the
            # same candidate can hold cells on several islands at once. The
            # target cell's coordinates arrive with the next `inserted`.
            index = int(event.get("nodeIndex", 0))
            node = by_index.setdefault(index, _node_row(index, search_id, session_id, created_at))
            node["migrated_to_island"] = int(event.get("toIsland", 0))

        elif kind == "merged":
            index = int(event.get("nodeIndex", 0))
            node = by_index.setdefault(index, _node_row(index, search_id, session_id, created_at))
            node.update({
                "accepted": bool(event.get("accepted")),
                "merge_reason": event.get("reason"),
                "rejected_by": event.get("rejectedBy"),
            })
            if event.get("accepted"):
                plan.elected_index = index

        elif kind == "cost":
            plan.run.update({"cost_cents": event.get("cents"), "tokens": event.get("tokens")})

        elif kind == "search_finished":
            plan.run.update({
                "best_test_score": _finite(event.get("bestTestScore")),
                "candidates": event.get("candidates"),
                "finished_at": created_at,
                "status": event.get("status"),
            })
            best = event.get("bestNodeIndex")
            if isinstance(best, int):
                plan.run["best_node_index"] = best
                plan.elected_index = best

    plan.nodes = [by_index[index] for index in sorted(by_index)]
    if plan.last_seq is not None:
        plan.run["last_seq"] = plan.last_seq
    return plan


def upsert_search_progress(
    *,
    search_id: str,
    session_id: str,
    records: list[dict[str, Any]],
) -> dict[str, Any]:
    """Apply one batch. Idempotent: safe to replay from any point.

    The watermark is read inside the same session that writes, so two batches
    racing cannot both pass the check — the second sees the first's ``last_seq``.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("search progress skipped: Neo4j not reachable (search=%s)", search_id)
        return {"applied": 0, "reason": "memory_graph_unreachable", "skipped": len(records)}

    with driver.session() as session:
        current = session.run(
            "MATCH (r:SearchRun {search_id: $search_id}) RETURN coalesce(r.last_seq, 0) AS last_seq",
            search_id=search_id,
        ).single()
        last_seq = int(current["last_seq"]) if current else 0

        plan = plan_writes(
            search_id=search_id, session_id=session_id, records=records, last_seq=last_seq,
        )
        if plan.last_seq is None:
            return {"applied": 0, "skipped": plan.skipped}

        session.run(
            """
            MERGE (r:SearchRun {search_id: $search_id})
              ON CREATE SET r.session_id = $session_id, r.created_at = datetime()
            SET r += $props
            """,
            search_id=search_id, session_id=session_id, props=_clean(plan.run),
        ).consume()

        if plan.nodes:
            # No `contains` edge from the run to each node: structure is carried
            # by `expands`, and retrieval is an indexed lookup on `search_id`.
            # An edge per node would be N redundant edges whose only use is a
            # query the property already answers more cheaply.
            session.run(
                """
                UNWIND $rows AS row
                MERGE (n:SearchNode {search_id: $search_id, node_index: row.node_index})
                  ON CREATE SET n.session_id = $session_id, n.created_at = datetime()
                SET n += row
                """,
                rows=[_clean(node) for node in plan.nodes],
                search_id=search_id, session_id=session_id,
            ).consume()

        if plan.visits:
            session.run(
                """
                UNWIND $rows AS row
                MATCH (n:SearchNode {search_id: $search_id, node_index: row.node_index})
                SET n.visits = row.visits
                """,
                rows=plan.visits, search_id=search_id,
            ).consume()

        for rows, statement in (
            (plan.expands, """
                UNWIND $rows AS row
                MATCH (parent:SearchNode {search_id: $search_id, node_index: row.parent_index})
                MATCH (child:SearchNode  {search_id: $search_id, node_index: row.node_index})
                MERGE (parent)-[:expands]->(child)
            """),
            (plan.inspires, """
                UNWIND $rows AS row
                MATCH (source:SearchNode {search_id: $search_id, node_index: row.source_index})
                MATCH (child:SearchNode  {search_id: $search_id, node_index: row.node_index})
                MERGE (source)-[:inspires]->(child)
            """),
        ):
            if rows:
                session.run(statement, rows=rows, search_id=search_id).consume()

        if plan.cells:
            session.run(
                """
                UNWIND $rows AS row
                MERGE (c:SearchCell {search_id: $search_id, island: row.island,
                                     complexity_bin: row.complexity_bin,
                                     diversity_bin: row.diversity_bin})
                  ON CREATE SET c.session_id = $session_id, c.created_at = datetime()
                SET c.occupant_node_index = row.node_index,
                    c.updated_at = row.updated_at,
                    c.via = row.via
                WITH c, row
                MATCH (n:SearchNode {search_id: $search_id, node_index: row.node_index})
                // Previous occupants keep their edge with current=false: "who
                // held this cell before" is what explains a MAP-Elites run.
                OPTIONAL MATCH (:SearchNode)-[old:occupies {current: true}]->(c)
                SET old.current = false, old.evicted_at = row.updated_at
                MERGE (n)-[held:occupies]->(c)
                SET held.current = true, held.via = row.via, held.since = row.updated_at
                """,
                rows=plan.cells, search_id=search_id, session_id=session_id,
            ).consume()

        if plan.root_index is not None:
            session.run(
                """
                MATCH (r:SearchRun {search_id: $search_id})
                MATCH (n:SearchNode {search_id: $search_id, node_index: $index})
                MERGE (r)-[:root]->(n)
                """,
                search_id=search_id, index=plan.root_index,
            ).consume()

        if plan.elected_index is not None:
            # One elected edge at a time: the best moves, it does not accumulate.
            session.run(
                """
                MATCH (r:SearchRun {search_id: $search_id})
                OPTIONAL MATCH (r)-[old:elected]->(:SearchNode)
                DELETE old
                WITH r
                MATCH (n:SearchNode {search_id: $search_id, node_index: $index})
                MERGE (r)-[:elected]->(n)
                """,
                search_id=search_id, index=plan.elected_index,
            ).consume()

    log.info(
        "search progress: search=%s applied=%d skipped=%d last_seq=%s",
        search_id, len(records) - plan.skipped, plan.skipped, plan.last_seq,
    )
    return {"applied": len(records) - plan.skipped, "last_seq": plan.last_seq, "skipped": plan.skipped}


def bind_subtask(
    *,
    search_id: str,
    task_id: str,
    session_id: str,
    status: str = "running",
    finished_at: Any = None,
) -> None:
    """Create the SubTask that owns this search and link it to the SearchRun.

    **It creates rather than matches.** An earlier version only MATCHed an
    existing SubTask, on the assumption that something else mirrored it — nothing
    does, so the `searches` edge never landed and the search sat off the session's
    task chain entirely. That is not cosmetic: `trace_provenance` walks that chain
    to decide whether a saved artifact can be traced back to the research goal,
    and a search with no SubTask makes every artifact it produced look unrooted.

    A resumed run is a *second* SubTask continuing the *same* search, so both
    point at one SearchRun rather than the run's identity being split.

    The `subtask:` prefix is load-bearing: the temporal-chain rebuild selects
    auto-mirrored SubTasks by exactly that prefix.
    """
    driver = handle()
    if not driver.is_reachable():
        return
    with driver.session() as session:
        session.run(
            """
            MERGE (st:SubTask {task_id: $task_id})
              ON CREATE SET st.session_id = $session_id,
                            st.task_type  = 'program_evolution',
                            st.created_at = datetime()
            SET st.status = $status
            WITH st
            MATCH (r:SearchRun {search_id: $search_id})
            MERGE (st)-[:searches]->(r)
            """,
            search_id=search_id, task_id=task_id, session_id=session_id, status=status,
        ).consume()
        if finished_at is not None:
            # Stamped only when the search settles: the chain rebuild orders by
            # `finished_at`, and Neo4j sorts nulls last ascending — so a running
            # search sits at the tail, which is where the newest step belongs.
            session.run(
                "MATCH (st:SubTask {task_id: $task_id}) SET st.finished_at = $finished_at",
                task_id=task_id, finished_at=finished_at,
            ).consume()
            _link_search_subtask_chain(session, session_id)


def link_search_artifacts(
    *,
    search_id: str,
    session_id: str,
    artifacts: list[dict[str, Any]],
) -> dict[str, Any]:
    """The run's published result — seed and winner — as Artifact nodes.

    Without this the evolve SubTask sat in the graph with a `searches` edge and
    nothing else: the one thing the run existed to produce was in SessionStore
    but invisible to `trace_provenance`, so the winner looked unrooted the
    moment anyone asked where it came from.

    Same vocabulary as an execution's output: composite-keyed Artifact nodes
    and a `produces` edge — from the SubTask rather than a Code node, because
    a search has no single execution to blame. `role` (seed / winner) rides on
    the edge, not the node: the node is the version, which exists independent
    of which part it played in this search.
    """
    driver = handle()
    if not driver.is_reachable():
        return {"linked": 0, "reason": "memory_graph_unreachable"}
    task_id = f"subtask:evolve:{search_id}"
    linked = 0
    with driver.session() as session:
        for art in artifacts:
            session.run(
                """
                MERGE (a:Artifact {artifact_id: $artifact_id, version: $version})
                  ON CREATE SET a.session_id   = $session_id,
                                a.logical_name = $logical_name,
                                a.path         = $logical_name,
                                a.media_type   = $media_type,
                                a.created_at   = datetime()
                  ON MATCH  SET a.logical_name = $logical_name,
                                a.media_type   = $media_type
                MERGE (st:SubTask {task_id: $task_id})
                  ON CREATE SET st.session_id = $session_id,
                                st.task_type  = 'program_evolution',
                                st.created_at = datetime()
                MERGE (st)-[p:produces]->(a)
                SET p.role = $role
                """,
                artifact_id=art.get("artifact_id"),
                version=art.get("version"),
                session_id=session_id,
                logical_name=art.get("logical_name"),
                media_type=art.get("media_type"),
                task_id=task_id,
                role=art.get("role"),
            ).consume()
            linked += 1
    return {"linked": linked}


def _link_search_subtask_chain(session: Any, session_id: str) -> None:
    """Rebuild the session's temporal chain so the search takes its place in it.

    Delegates to the same helper the execution mirror uses, so a search and a
    code execution are ordered by one rule rather than two.
    """
    from .persistence import _link_subtasks_by_finish_time

    try:
        _link_subtasks_by_finish_time(session, session_id)
    except Exception as exc:  # noqa: BLE001 - the chain is a convenience, not the record
        log.warning("chain rebuild after search failed (non-fatal): %s", exc)


def get_search_graph(search_id: str, max_nodes: int = _MAX_NODES) -> dict[str, Any]:
    """Read one search back: the run, its candidates, its cells and its edges."""
    driver = handle()
    if not driver.is_reachable():
        return _empty("memory_graph_unreachable")

    with driver.session() as session:
        run_record = session.run(
            "MATCH (r:SearchRun {search_id: $search_id}) RETURN r AS run",
            search_id=search_id,
        ).single()
        if run_record is None:
            return _empty("search_not_found")

        node_rows = session.run(
            """
            MATCH (n:SearchNode {search_id: $search_id})
            RETURN n AS node ORDER BY n.node_index LIMIT $limit
            """,
            search_id=search_id, limit=max_nodes + 1,
        )
        nodes = [dict(row["node"]) for row in node_rows]
        truncated = len(nodes) > max_nodes
        nodes = nodes[:max_nodes]
        kept = {node.get("node_index") for node in nodes}

        cells = [
            dict(row["cell"]) for row in session.run(
                """
                MATCH (c:SearchCell {search_id: $search_id})
                RETURN c AS cell ORDER BY c.island, c.complexity_bin, c.diversity_bin LIMIT $limit
                """,
                search_id=search_id, limit=_MAX_CELLS,
            )
        ]

        edges: list[dict[str, Any]] = []
        for row in session.run(
            """
            MATCH (r:SearchRun {search_id: $search_id})-[rel:root|elected]->(n:SearchNode)
            RETURN type(rel) AS type, n.node_index AS target
            """,
            search_id=search_id,
        ):
            edges.append({"source": search_id, "target": row["target"], "type": row["type"]})
        for row in session.run(
            """
            MATCH (a:SearchNode {search_id: $search_id})-[rel:expands|inspires]->(b:SearchNode)
            RETURN a.node_index AS source, b.node_index AS target, type(rel) AS type
            """,
            search_id=search_id,
        ):
            edges.append({"source": row["source"], "target": row["target"], "type": row["type"]})
        for row in session.run(
            """
            MATCH (n:SearchNode {search_id: $search_id})-[rel:occupies]->(c:SearchCell)
            WHERE rel.current = true
            RETURN n.node_index AS source, c.island AS island,
                   c.complexity_bin AS complexity_bin, c.diversity_bin AS diversity_bin
            """,
            search_id=search_id,
        ):
            edges.append({
                "source": row["source"],
                "target": f"{row['island']}:{row['complexity_bin']}:{row['diversity_bin']}",
                "type": "occupies",
            })

    return {
        "cells": cells,
        "edges": [edge for edge in edges if edge["type"] in ("root", "elected", "occupies")
                  or (edge["source"] in kept and edge["target"] in kept)],
        "nodes": nodes,
        "run": dict(run_record["run"]),
        "truncated": truncated,
    }


def _empty(reason: str) -> dict[str, Any]:
    return {"cells": [], "edges": [], "nodes": [], "reason": reason, "run": None, "truncated": False}


def _node_row(index: int, search_id: str, session_id: str, created_at: Any) -> dict[str, Any]:
    return {"node_index": index, "search_id": search_id, "session_id": session_id, "created_at": created_at}


def _finite(value: Any) -> float | None:
    """``None`` for anything that is not a finite number.

    Neo4j properties cannot hold NaN or infinity, and the failure sentinel
    upstream is ``-inf``; a failed candidate is recorded by ``valid: false``,
    not by a magic score.
    """
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def _clean(row: dict[str, Any]) -> dict[str, Any]:
    """Drop ``None`` values so a later event cannot blank a property an earlier
    one set (SET n += {k: null} removes the key)."""
    return {key: value for key, value in row.items() if value is not None}
