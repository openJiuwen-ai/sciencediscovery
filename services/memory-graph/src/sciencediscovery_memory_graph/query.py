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

"""Read helpers for the MVP subgraph endpoint.

``get_subgraph(session_id)`` returns the nodes + ``produces`` edges for one
session. Hard cap 500 nodes (results are truncated; the response carries a
``truncated`` flag). When the driver is unreachable the caller gets an empty
subgraph + a ``reason`` ("memory_graph_unreachable") so the frontend can
render a degraded notice rather than erroring.
"""

from __future__ import annotations

import datetime
import re
from typing import Any

from .logging_config import get_logger
from .neo4j_driver import handle

log = get_logger("query")

_NODE_LIMIT = 500


def get_subgraph(session_id: str) -> dict[str, Any]:
    driver = handle()
    if not driver.is_reachable():
        log.warning("get_subgraph skipped: Neo4j not reachable (session=%s)", session_id)
        return {
            "nodes": [],
            "edges": [],
            "total": 0,
            "truncated": False,
            "reason": "memory_graph_unreachable",
        }

    with driver.session() as session:
        nodes_result = session.run(
            """
            MATCH (n) WHERE n.session_id = $sid
              AND NOT coalesce(n.deleted_session, false)
            RETURN labels(n)[0] AS label, n AS node
            ORDER BY n.created_at DESC
            LIMIT $limit
            """,
            sid=session_id,
            limit=_NODE_LIMIT,
        )

        nodes: list[dict[str, Any]] = []
        node_ids: set[str] = set()
        for record in nodes_result:
            node = record["node"]
            label = record["label"]
            node_id = _node_identity(label, node)
            if node_id is None:
                continue
            node_ids.add(node_id)
            nodes.append(
                {
                    "label": label,
                    "id": node_id,
                    "session_id": node.get("session_id"),
                    "extra": _json_safe({
                        k: v
                        for k, v in node.items()
                        if k not in {"session_id", "created_at", "finished_at"}
                    }),
                    "created_at": _iso(node.get("created_at")),
                }
            )

        # Edges: ``produces`` (SubTask→Code→Artifact, SubTask→Paper) and
        # ``next`` (ResearchGoal→SubTask head, SubTask→SubTask). Both endpoints
        # carry session_id so the same session filter applies. Edge properties
        # (inferred/basis/method for temporal_chain, or absent for produces)
        # are forwarded via ``extra`` so the frontend can style temporal_chain
        # links as a fallback rather than a real dependency.
        # supports/extracts/stated_in are also returned so the full
        # claim↔evidence↔paper↔report chain renders in the graph view, not just
        # in a per-node chain lookup.
        edges_result = session.run(
            """
            MATCH (a)-[r]->(b)
            WHERE a.session_id = $sid AND b.session_id = $sid
              AND NOT coalesce(a.deleted_session, false)
              AND NOT coalesce(b.deleted_session, false)
              AND type(r) IN ['produces', 'next', 'extracts', 'supports', 'stated_in', 'supersedes', 'input']
            RETURN a AS src, b AS dst, labels(a)[0] AS src_label,
                   labels(b)[0] AS dst_label, type(r) AS edge_type, r AS rel
            """,
            sid=session_id,
        )
        edges: list[dict[str, Any]] = []
        for record in edges_result:
            src_id = _node_identity(record["src_label"], record["src"])
            dst_id = _node_identity(record["dst_label"], record["dst"])
            if src_id is None or dst_id is None:
                continue
            if src_id in node_ids and dst_id in node_ids:
                rel = record["rel"]
                edge: dict[str, Any] = {
                    "source": src_id,
                    "target": dst_id,
                    "type": record["edge_type"],
                }
                extra = {k: v for k, v in dict(rel).items() if k}
                if extra:
                    edge["extra"] = extra
                edges.append(edge)

        return {
            "nodes": nodes,
            "edges": edges,
            "total": len(nodes),
            "truncated": len(nodes) >= _NODE_LIMIT,
        }


# --- Cross-session read helpers -------------------------------------------
#
# These functions mirror `get_subgraph`'s contract: they never throw into the
# caller when Neo4j is unreachable — they return an empty result with a
# ``reason`` so the API server can degrade gracefully. ``_NODE_LIMIT`` is the
# shared hard cap (500); results beyond it carry ``truncated: True``.
#
# Labels ResearchGoal / Evidence / Claim are not persisted yet
# (SubTask / Code / Artifact / Paper are). The code below is label-agnostic
# where possible so the same Cypher keeps working once those labels exist;
# functions that
# touch label-specific id fields fall back to returning empty / None rather
# than erroring when a label has no nodes.


def query_match(query: str, session_id: str | None = None) -> dict[str, Any]:
    """Case-insensitive substring search, scoped to one session when
    ``session_id`` is given.

    The query is split into whitespace/punctuation-separated terms; a node
    matches when its searchable text contains *any* term (OR semantics), so a
    word absent from the graph (e.g. "paper", "frequency") never zeroes out
    every result the way a strict AND would. Hits are ranked by how many terms
    they contain (most first), then by field priority (title before abstract/
    body), so the most relevant nodes still surface even though looser terms
    bring in extras. The haystack spans every textual field (title + abstract
    for Papers, content for Evidence/Claim, core_objective for ResearchGoal,
    path for Artifact, tool for Code).

    Returns ``{hits, total, truncated}``; an empty graph returns ``{hits: [],
    total: 0, truncated: False}`` rather than erroring.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("query_match skipped: Neo4j not reachable (query=%s)", query)
        return {"hits": [], "total": 0, "truncated": False, "reason": "memory_graph_unreachable"}

    tokens = [t for t in re.split(r"[\W_]+", (query or "").lower()) if t]
    if not tokens:
        return {"hits": [], "total": 0, "truncated": False}

    with driver.session() as session:
        result = session.run(
            """
            MATCH (n)
            WHERE ($sid IS NULL OR n.session_id = $sid)
              AND NOT coalesce(n.deleted_session, false)
            WITH n, labels(n)[0] AS label,
                 toLower(coalesce(toString(n.title), '') + ' '
                   + coalesce(toString(n.abstract), '') + ' '
                   + coalesce(toString(n.content), '') + ' '
                   + coalesce(toString(n.core_objective), '') + ' '
                   + coalesce(toString(n.task_type), '') + ' '
                   + coalesce(toString(n.path), '') + ' '
                   + coalesce(toString(n.tool), '')) AS haystack
            UNWIND $tokens AS t
            WITH n, label, haystack, collect(CASE WHEN haystack CONTAINS t THEN 1 ELSE 0 END) AS hits
            WITH n, label, haystack, reduce(s = 0, x IN hits | s + x) AS matched
            WHERE matched > 0
            RETURN n, label, matched
            ORDER BY matched DESC,
              CASE WHEN toLower(coalesce(toString(n.title), ''))           CONTAINS $primary THEN 0
                   WHEN toLower(coalesce(toString(n.abstract), ''))       CONTAINS $primary THEN 1
                   WHEN toLower(coalesce(toString(n.core_objective), '')) CONTAINS $primary THEN 2
                   WHEN toLower(coalesce(toString(n.content), ''))        CONTAINS $primary THEN 4
                   ELSE 5
              END,
              n.created_at DESC
            LIMIT $limit
            """,
            tokens=tokens,
            primary=tokens[0],
            sid=session_id,
            limit=_NODE_LIMIT,
        )
        hits = [_to_hit(rec["n"], rec["label"]) for rec in result]
        hits = [h for h in hits if h is not None]
        return {
            "hits": hits,
            "total": len(hits),
            "truncated": len(hits) >= _NODE_LIMIT,
        }


def by_node_type(node_types: list[str], session_id: str | None = None) -> dict[str, Any]:
    """Filter nodes by label(s), scoped to one session when ``session_id`` is
    given. Returns ``{hits, total, truncated}``."""
    driver = handle()
    if not driver.is_reachable():
        log.warning("by_node_type skipped: Neo4j not reachable (types=%s)", node_types)
        return {"hits": [], "total": 0, "truncated": False, "reason": "memory_graph_unreachable"}

    if not node_types:
        return {"hits": [], "total": 0, "truncated": False}

    with driver.session() as session:
        result = session.run(
            """
            MATCH (n) WHERE labels(n)[0] IN $types
              AND ($sid IS NULL OR n.session_id = $sid)
              AND NOT coalesce(n.deleted_session, false)
            RETURN n, labels(n)[0] AS label
            ORDER BY n.created_at DESC
            LIMIT $limit
            """,
            types=node_types,
            sid=session_id,
            limit=_NODE_LIMIT,
        )
        hits = [_to_hit(rec["n"], rec["label"]) for rec in result]
        hits = [h for h in hits if h is not None]
        return {
            "hits": hits,
            "total": len(hits),
            "truncated": len(hits) >= _NODE_LIMIT,
        }


def by_edge_type(edge_types: list[str], session_id: str | None = None) -> dict[str, Any]:
    """Filter edges by type(s), scoped to one session when ``session_id`` is
    given; returns edges plus de-duplicated endpoint nodes."""
    driver = handle()
    if not driver.is_reachable():
        log.warning("by_edge_type skipped: Neo4j not reachable (types=%s)", edge_types)
        return {"edges": [], "nodes": [], "total": 0, "truncated": False, "reason": "memory_graph_unreachable"}

    if not edge_types:
        return {"edges": [], "nodes": [], "total": 0, "truncated": False}

    with driver.session() as session:
        result = session.run(
            """
            MATCH (a)-[r]->(b)
            WHERE type(r) IN $types
              AND ($sid IS NULL OR a.session_id = $sid)
              AND ($sid IS NULL OR b.session_id = $sid)
              AND NOT coalesce(a.deleted_session, false)
              AND NOT coalesce(b.deleted_session, false)
            RETURN a, b, labels(a)[0] AS a_label, labels(b)[0] AS b_label,
                   type(r) AS edge_type, properties(r) AS edge_props
            ORDER BY a.created_at DESC
            LIMIT $limit
            """,
            types=edge_types,
            sid=session_id,
            limit=_NODE_LIMIT,
        )
        edges: list[dict[str, Any]] = []
        node_map: dict[str, dict[str, Any]] = {}
        for rec in result:
            src = _to_hit(rec["a"], rec["a_label"])
            dst = _to_hit(rec["b"], rec["b_label"])
            if src is None or dst is None:
                continue
            node_map[src["id"]] = src
            node_map[dst["id"]] = dst
            edges.append({
                "type": rec["edge_type"],
                "source": src["id"],
                "target": dst["id"],
                "extra": _json_safe(dict(rec["edge_props"])) if rec["edge_props"] else {},
            })
        nodes = list(node_map.values())
        return {
            "edges": edges,
            "nodes": nodes,
            "total": len(edges),
            "truncated": len(edges) >= _NODE_LIMIT,
        }


def get_artifact_provenance(
    artifact_id: str, version: int, session_id: str | None = None,
) -> dict[str, Any]:
    """Aggregate the five provenance fields' addressing info + derived-from
    dependencies for one Artifact version in a single Cypher (graph =
    directory; only hashes / routing keys, never content blobs). Pinned to the
    composite-key version node ``(artifact_id, version)``, scoped to one
    session when ``session_id`` is given.

    Backbone is the derived-from 2-hop
    ``(outArtifactV) <-[:produces]- (c:Code) <-[:input]- (inArtifactV)``
    (see docs/memory-graph-derived-from.md §3): ``c`` carries the
    code/stdout/stderr/env hashes + execution status; the producing SubTask
    carries ``turn_id`` (messages routing key — the same key review uses); the
    version node carries ``turn_id`` (review routing key) + ``content_hash``.
    The ``input`` edge is OPTIONAL so this works even when the run read no
    inputs: ``dependencies`` is then an empty list (the Node handler falls back
    to the store's ``version.inputArtifactVersionIds``).

    Returns ``{artifact_id, version, logical_name, dependencies, ...}`` with
    all five fields' addressing info, or an empty-dependencies shape with a
    ``reason`` when Neo4j is down or the version is not in the graph (the Node
    reverse-proxy degrades on both). Dependencies are ordered by
    ``logical_name`` so the frontend's `` · ``-joined multi-input line is
    stable.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("get_artifact_provenance skipped: Neo4j not reachable (artifact=%s v%s)",
                    artifact_id, version)
        return {"artifact_id": artifact_id, "version": version, "logical_name": None,
                "dependencies": [], "reason": "memory_graph_unreachable"}

    with driver.session() as session:
        # out version node <-[:produces]- Code; the producing SubTask (via
        # SubTask -produces-> Code); OPTIONAL input edges to Code for deps.
        result = session.run(
            """
            MATCH (out:Artifact {artifact_id: $aid, version: $v})
            WHERE $sid IS NULL OR out.session_id = $sid
            OPTIONAL MATCH (out)<-[:produces]-(c:Code)
            OPTIONAL MATCH (st:SubTask)-[:produces]->(c)
            OPTIONAL MATCH (c)<-[:input]-(inA:Artifact)
            WHERE $sid IS NULL OR inA.session_id = $sid
            WITH out, c, st, inA
            ORDER BY inA.logical_name
            RETURN out.turn_id        AS turn_id,
                   out.content_hash   AS content_hash,
                   out.logical_name   AS logical_name,
                   out.version        AS version,
                   out.artifact_id    AS artifact_id,
                   out.media_type    AS media_type,
                   c.code_hash        AS code_hash,
                   c.stdout_hash      AS stdout_hash,
                   c.stderr_hash      AS stderr_hash,
                   c.env_hash         AS env_hash,
                   c.exit_code        AS exit_code,
                   c.status           AS status,
                   c.finished_at      AS finished_at,
                   c.started_at       AS started_at,
                   c.code_id          AS code_id,
                   c.language         AS language,
                   c.tool             AS tool,
                   st.turn_id         AS subtask_turn_id,
                   collect(DISTINCT CASE WHEN inA IS NULL THEN null
                       ELSE {
                         artifact_id:  inA.artifact_id,
                         version:      inA.version,
                         logical_name: inA.logical_name,
                         media_type:   inA.media_type,
                         path:         inA.path
                       } END) AS dependencies
            """,
            aid=artifact_id,
            v=version,
            sid=session_id,
        )
        rec = result.single()

    if rec is None or rec["version"] is None:
        # The output Artifact version node itself is not in the graph (e.g. the
        # execution that produced it ran while the graph was off — fire-and-
        # forget writes are not replayed, see §7.2). Return empty dependencies;
        # the frontend's "non-empty overrides" rule keeps it on the legacy
        # SessionStore endpoint instead of silently blanking the row.
        return {"artifact_id": artifact_id, "version": version, "logical_name": None,
                "dependencies": [], "reason": "node_not_found"}

    deps = [d for d in (rec["dependencies"] or []) if d and d.get("artifact_id")]
    return {
        "artifact_id": rec["artifact_id"],
        "version": rec["version"],
        "logical_name": rec["logical_name"],
        "media_type": rec["media_type"],
        "content_hash": rec["content_hash"],
        "turn_id": rec["turn_id"],
        "code_hash": rec["code_hash"],
        "stdout_hash": rec["stdout_hash"],
        "stderr_hash": rec["stderr_hash"],
        "env_hash": rec["env_hash"],
        "exit_code": rec["exit_code"],
        "status": rec["status"],
        "finished_at": _iso(rec["finished_at"]),
        "started_at": _iso(rec["started_at"]),
        "code_id": rec["code_id"],
        "language": rec["language"],
        "tool": rec["tool"],
        # The producing SubTask's turn_id — the messages routing key (store
        # filters manifests by turnId). SubTask.turn_id is the execution's
        # turn, which is the same turn the manifest belongs to.
        "messages_turn_id": rec["subtask_turn_id"],
        "dependencies": deps,
    }


def get_chain(
    node_id: str,
    session_id: str | None = None,
    version: int | None = None,
    chain_kind: str = "full",
) -> dict[str, Any]:
    """Walk the preset chain from a selected node, scoped to one session when
    ``session_id`` is given.

    ``chain_kind`` selects which chain to walk:

    - ``"full"`` (default, backward-compatible): the joint upstream↔downstream
      subgraph from the preset ``_CHAIN_HOPS`` table (both ``in`` and ``out``
      hops, all edge types). Used by ResearchGoal/SubTask/Code single-button
      nodes and the autoChain entry points.
    - ``"task"``: the pure task chain — only ``next`` + ``produces`` hops from
      the preset table (no citation/derived-from edges). Used by the Artifact
      "task chain" button.
    - ``"artifact"``: the artifact/derivation chain — centered on the selected
      node itself, walking ``Artifact ←[:produces]← Code ←[:input]← Artifact …``
      backward to the root inputs. Used by Paper/Evidence/Claim single-button
      nodes and the Artifact "artifact chain" button.

    The backend decides which edge/node types to traverse based on the source
    node's label. Only SubTask/Code/Artifact/Paper + ``produces`` edges are
    persisted today; the ResearchGoal end label is not yet. Until
    then this returns whatever portion of the chain exists, never erroring on
    missing labels — the same Cypher keeps working once the
    later PRs fill those nodes in.

    ``version`` pins an Artifact source to a specific version: Artifact is
    keyed on the composite ``(artifact_id, version)``, so a bare
    ``node_id`` (artifact_id) now matches multiple version nodes. With
    ``version`` set the source is that exact version; without it the latest
    version is used (max(version)) so the chain still resolves without error.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("get_chain skipped: Neo4j not reachable (node_id=%s)", node_id)
        return {"nodes": [], "edges": [], "total": 0, "truncated": False, "reason": "memory_graph_unreachable"}

    with driver.session() as session:
        # Step 1: locate the source node's elementId + label. Non-Artifact
        # labels match by their single id field; Artifact by the composite
        # (artifact_id, version). The logic (version suffix peeling, latest-
        # version fallback, cross-label MATCH) lives in _resolve_source_node so
        # the chain_kind branches below stay readable.
        src_eid, src_label = _resolve_source_node(session, node_id, version, session_id)
        if src_eid is None:
            return {"nodes": [], "edges": [], "total": 0, "truncated": False, "reason": "node_not_found"}

        # Step 2: branch on chain_kind. ``artifact`` walks the produces/input
        # derivation chain centered on the selected node itself
        # (Artifact ←[:produces]← Code ←[:input]← Artifact …), anchor-free so
        # it resolves even before a report/Claim exists. ``task`` walks just
        # the next+produces spine. ``full`` (default, backward-compatible)
        # walks the whole preset table — the legacy behavior.
        if chain_kind == "artifact":
            return _artifact_chain(session, src_eid, src_label, session_id)

        # full / task: walk the preset hops. ``task`` keeps only the next +
        # produces entries (pure task spine); ``full`` keeps the whole table.
        if chain_kind == "task":
            hops = [e for e in _CHAIN_HOPS.get(src_label, []) if e[0] in ("next", "produces")]
        else:
            hops = _CHAIN_HOPS.get(src_label, [])
        eids = _walk_hops(session, hops, [src_eid], session_id)
        return _serialize_subgraph(session, eids, session_id)


def _resolve_source_node(
    session: Any, node_id: str, version: int | None, session_id: str | None,
) -> tuple[str | None, str | None]:
    """Locate the source node's elementId + label.

    Non-Artifact labels match by their single id field; Artifact by the
    composite ``(artifact_id, version)``. An explicit ``version`` pins the
    exact node; no version falls back to the latest (max version). The frontend
    passes the subgraph node id as ``node_id``; for Artifact that id is
    ``"<artifact_id>#v<version>"`` (see ``_node_identity``), so peel the
    version suffix off the artifact_id and use it as the explicit version when
    the caller did not pass one separately.
    """
    chain_id = node_id
    effective_version = version
    if "#v" in node_id:
        base, _, ver_suffix = node_id.partition("#v")
        try:
            parsed = int(ver_suffix)
            chain_id = base
            if effective_version is None:
                effective_version = parsed
        except ValueError:
            pass
    if effective_version is None:
        latest = session.run(
            "MATCH (a:Artifact {artifact_id: $id}) "
            "WHERE $sid IS NULL OR a.session_id = $sid "
            "RETURN max(a.version) AS v",
            id=chain_id, sid=session_id,
        ).single()
        effective_version = latest["v"] if latest else None
    src_result = session.run(
        """
        MATCH (n)
        WHERE (n.task_id     = $id
           OR n.code_id     = $id
           OR n.link        = $id
           OR n.goal_id     = $id
           OR n.evidence_id = $id
           OR n.claim_id    = $id
           OR (n:Artifact AND n.artifact_id = $id
               AND $v IS NOT NULL AND n.version = $v))
          AND ($sid IS NULL OR n.session_id = $sid)
        RETURN elementId(n) AS src_eid, labels(n)[0] AS src_label LIMIT 1
        """,
        id=chain_id,
        sid=session_id,
        v=effective_version,
    )
    src_rec = src_result.single()
    if src_rec is None:
        return None, None
    return src_rec["src_eid"], src_rec["src_label"]


def _walk_hops(
    session: Any, hops: list[tuple], start_eids: list[str], session_id: str | None,
) -> list[str]:
    """Walk a directed preset hop list, expanding the eid set hop-by-hop.

    Reuses the same directed-traversal engine as the legacy get_chain: each hop
    starts from the elementIds gathered so far and appends the newly-reached
    nodes' elementIds. A hop that matches nothing simply adds nothing — the
    walk short-stops there without erroring. Direction ``in`` walks against
    edge orientation (toward upstream); ``out`` walks along it (toward
    downstream). ``edge_type`` + ``depth`` come from the ``_CHAIN_HOPS``
    whitelist (not user input), so interpolating them into the Cypher string is
    safe; Neo4j does not accept relationship types as query parameters.
    """
    eids: list[str] = list(start_eids)
    for entry in hops:
        edge_type, direction, _target_label = entry[0], entry[1], entry[2]
        depth = entry[3] if len(entry) > 3 else "1"
        rel = f"`{edge_type}`*{depth}"
        pattern = f"<-[:{rel}]-" if direction == "in" else f"-[:{rel}]->"
        step = session.run(
            f"""
            MATCH (src){pattern}(next)
            WHERE elementId(src) IN $eids
              AND ($sid IS NULL OR next.session_id = $sid OR next:Paper)
            RETURN collect(DISTINCT elementId(next)) AS new_eids
            """,
            eids=eids,
            sid=session_id,
        )
        new_eids = step.single()["new_eids"]
        eids.extend(e for e in new_eids if e not in eids)
    return eids


def _serialize_subgraph(
    session: Any, eids: list[str], session_id: str | None,
    *,
    allowed_edges: set[tuple[str, str, str]] | None = None,
) -> dict[str, Any]:
    """Shape a set of elementIds into the ``{nodes, edges, total, truncated}``
    chain subgraph response.

    Shared by the ``full``/``task`` hop walk and the ``artifact`` directed
    walk so the three paths share one node/edge serialization (de-dup +
    ``_to_hit`` + ``_json_safe``). An empty eid set returns an empty subgraph
    rather than erroring.

    ``allowed_edges`` (optional) whitelists specific ``(src_eid, dst_eid,
    edge_type)`` triples (in raw elementId space). When set, an edge is
    rendered only if it is in the whitelist — used by ``_artifact_chain`` to
    drop sibling ``produces`` branches the derivation tail did NOT traverse (a
    Code may produce several sibling Artifacts; only the cited one's produces
    edge belongs on the derivation chain — the rest are pruned even though
    the sibling eids happen to be in the set as inputs). ``None`` (the
    default) renders every edge between two in-set eids, the legacy
    full/task behavior.
    """
    if not eids:
        return {"nodes": [], "edges": [], "total": 0, "truncated": False}

    nodes_result = session.run(
        """
        MATCH (n) WHERE elementId(n) IN $eids
        RETURN n, labels(n)[0] AS label
        ORDER BY n.created_at DESC
        LIMIT $limit
        """,
        eids=eids,
        limit=_NODE_LIMIT,
    )
    nodes: list[dict[str, Any]] = []
    for rec in nodes_result:
        hit = _to_hit(rec["n"], rec["label"])
        if hit is None:
            continue
        nodes.append(hit)

    edges_result = session.run(
        """
        MATCH (a)-[r]->(b)
        WHERE elementId(a) IN $eids AND elementId(b) IN $eids
        RETURN a, b, labels(a)[0] AS a_label, labels(b)[0] AS b_label,
               type(r) AS edge_type, properties(r) AS edge_props,
               elementId(a) AS a_eid, elementId(b) AS b_eid
        """,
        eids=eids,
    )
    edges: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for rec in edges_result:
        src = _to_hit(rec["a"], rec["a_label"])
        dst = _to_hit(rec["b"], rec["b_label"])
        if src is None or dst is None:
            continue
        key = (src["id"], dst["id"], rec["edge_type"])
        if key in seen:
            continue
        seen.add(key)
        # Whitelist filter (elementId space): the artifact chain restricts
        # ``Code -[:produces]-> Artifact`` edges to the ones its derivation
        # tail actually traversed, so sibling ``produces`` branches a Code
        # emits to OTHER uncited Artifacts are pruned even though their eids
        # may sit in the set as inputs of that same Code. Only Code→Artifact
        # produces is gated (Artifacts are Code-produced; SubTask→produces→
        # Code/Paper/Evidence are never sibling Artifact branches, so they
        # pass unconditionally). ``input`` edges (Artifact→Code) are always
        # real derivation inputs, never sibling branches — pass unconditionally.
        if (allowed_edges is not None
                and rec["edge_type"] == "produces"
                and rec["a_label"] == "Code"
                and rec["b_label"] == "Artifact"):
            eid_key = (rec["a_eid"], rec["b_eid"], rec["edge_type"])
            if eid_key not in allowed_edges:
                continue
        edges.append({
            "source": src["id"],
            "target": dst["id"],
            "type": rec["edge_type"],
            "extra": _json_safe(dict(rec["edge_props"])) if rec["edge_props"] else {},
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "total": len(nodes),
        "truncated": len(nodes) >= _NODE_LIMIT,
    }


def _artifact_chain(
    session: Any, src_eid: str, src_label: str, session_id: str | None,
) -> dict[str, Any]:
    """Artifact/derivation chain centered on the selected node itself.

    The center is always the clicked node — never a session's report anchor.
    The chain has two parts:

    1. The produces/input derivation, walked backward from the center:

         Artifact ←[:produces]← Code ←[:input]← Artifact ←[:produces]← Code …

       alternating until a pass adds nothing. ``_artifact_derivation_tail`` is
       this walk; it records the (Code, Artifact, ``produces``/``input``) edges
       it traversed so ``_serialize_subgraph`` can whitelist them and prune a
       Code's sibling ``produces`` branches to OTHER Artifacts.

    2. The citation downstream, walked forward from the center when it is an
       Artifact that Claims are ``stated_in`` (a report): stated_in→Claim→
       supports→Evidence/Artifact, then Evidence←extracts←Paper. Every node reached this
       way (Claims, Evidence, cited Artifacts, source Papers) joins the chain
       so the report's references are visible alongside its derivation. A
       cited Artifact is also a derivation seed — its own produces/input
       ancestry is walked too.

    For an Artifact source this is the whole chain — an intermediate product
    produced mid-session (before any report/Claim exists) still resolves its
    full input ancestry, so "View artifact chain" works at any time. For
    Paper/Evidence/Claim sources the citation entry (source → supports/
    extracts → … → a cited Artifact) seeds the derivation walk; the
    source's own upstream task-chain tail (← produces ← SubTask ← next ←
    ResearchGoal) is appended. These entries also run without a report anchor.
    """
    # Citation-entry hops per non-Artifact source label: walk from the source
    # to the Artifact(s) its chain should be centered on, then the upstream
    # task-chain tail (source ← produces ← SubTask ← next(1..) ← ResearchGoal).
    # Each entry is (edge_type, direction, target_label[, depth]); ``out`` walks
    # along edge orientation (toward the cited Artifact), ``in`` walks against
    # it (toward the producing task / goal).
    _ENTRY_HOPS: dict[str, list[tuple]] = {
        # Paper ←produces← SubTask ←next(1..)← ResearchGoal, PLUS the reverse
        # citation side: Paper -[:extracts]-> Evidence -[:supports]-> Claim
        # -[:stated_in]-> report Artifact, so a paper's artifact chain shows the
        # reports that reference it through the Evidence/Claims built from it.
        "Paper": [
            ("produces", "in", "SubTask"),
            ("next", "in", "ResearchGoal", "1.."),
            ("extracts", "out", "Evidence"),
            ("supports", "out", "Claim"),
            ("stated_in", "out", "Artifact"),
        ],
        # Evidence ←extracts← Paper ←produces← SubTask ←next(1..)← Goal,
        # PLUS the forward citation side: Evidence -[:supports]-> Claim -[:stated_in]
        # ← report Artifact, so an evidence node's artifact chain also shows
        # the report(s) that reference it via the Claims backing it. Without
        # these two reverse hops the evidence chain stops at the source Paper
        # and the 报告→claim→evidence path is invisible from this entry point.
        "Evidence": [
            ("extracts", "in", "Paper"),
            ("produces", "in", "SubTask"),
            ("next", "in", "ResearchGoal", "1.."),
            ("supports", "out", "Claim"),
            ("stated_in", "out", "Artifact"),
        ],
        # Claim ←supports← Evidence ←extracts← Paper ←produces← SubTask
        # ←next(1..)← Goal, PLUS Claim -[:stated_in]-> report Artifact (the report
        # that asserts this claim), so a claim's artifact chain shows the
        # report it appears in alongside the Evidence/Paper it is built from.
        "Claim": [
            ("supports", "in", "Evidence"),
            ("extracts", "in", "Paper"),
            ("produces", "in", "SubTask"),
            ("next", "in", "ResearchGoal", "1.."),
            ("stated_in", "out", "Artifact"),
        ],
    }
    # Citation hops walked forward from an Artifact source that Claims are ``stated_in``
    # Claims (a report): report → its Claims → what they cite (Evidence /
    # Artifact / Code), then Evidence → the Paper it was extracted from.
    # These are the report's references; they join the derivation chain so a
    # reviewer sees the cited Evidence/Artifacts/Papers alongside the inputs
    # that produced the report. Edge types are the citation vocabulary; depth
    # is single-hop (the recursion below fans out across Claims/Evidence).
    _REPORT_CITATION_HOPS: list[tuple] = [
        ("stated_in", "in", "Claim"),
        ("supports", "in", "Evidence"),
        ("supports", "in", "Artifact"),
        ("extracts", "in", "Paper"),
    ]
    # Reverse citation hops walked backward from ANY Artifact source that a
    # Claim supports (a cited figure): fig -[:supports]-> Claim -[:stated_in]-> report.
    # This surfaces "which report's which Claim references this figure" on the
    # figure's own chain — without it, a cited figure shows only its produces/
    # input derivation and hides the citing relationship. The walk stops at the
    # citing report: it does NOT fan out the report's full citation downstream
    # (that would explode the chain with every other figure/evidence the report
    # references). ``direction = "in"`` walks against edge orientation.
    _CITED_BY_HOPS: list[tuple] = [
        ("supports", "out", "Claim"),
        ("stated_in", "out", "Artifact"),
    ]

    keep: set[str] = {src_eid}
    tail_eids: list[str] = []
    # For a non-Artifact source (Paper/Evidence/Claim), walk the citation entry
    # hops first — they reach the cited Artifact(s) that seed the derivation
    # walk, plus the source's own upstream task-chain tail. An Artifact source
    # skips this: it is its own derivation seed.
    entry_hops = _ENTRY_HOPS.get(src_label)
    if entry_hops is not None:
        walked = _walk_hops(session, entry_hops, [src_eid], session_id)
        tail_eids = [e for e in walked if e != src_eid]

    # Citation for an Artifact source — two directions, both centered on the
    # selected Artifact itself:
    #  - forward (the report's own references): if this Artifact has Claims
    #    ``stated_in`` it (a report), walk stated_in→Claim→supports→Evidence/Artifact
    #    and Evidence←extracts←Paper. The report's references join the chain.
    #  - forward (who supports this Artifact): walk fig-[:supports]->Claim-[:stated_in]
    #    ->report. A cited figure surfaces the citing Claim + its report.
    # Every node reached joins the chain; the stated_in/supports/extracts
    # edges render automatically (their endpoints are both in the eid set, and
    # the allowed_edges whitelist only gates Code→Artifact ``produces`` sibling
    # branches, never citation edges).
    citation_eids: list[str] = []
    if src_label == "Artifact":
        forward = _walk_hops(session, _REPORT_CITATION_HOPS, [src_eid], session_id)
        reverse = _walk_hops(session, _CITED_BY_HOPS, [src_eid], session_id)
        citation_eids = [e for e in forward + reverse if e != src_eid]

    # Derivation walk, centered on the selected node. For an Artifact source
    # the seed is the source itself; for Paper/Evidence/Claim the seed is the
    # Artifact(s) the entry hops reached (a cited product the source points
    # at). For a report Artifact the cited Artifacts (reached via the citation
    # walk above) are also seeds — each cited figure's own produces/input
    # ancestry is walked too. Falls back to the source eid when no cited
    # Artifact was reached so the chain still shows the center.
    #
    # NOTE: the seed for a non-Artifact source must come from the entry hops'
    # *result* (``tail_eids``), NOT from ``keep`` (which is just ``{src_eid}``).
    # A Claim source's own eid is not an Artifact, so ``_cited_artifact_eids``
    # over ``{claim_eid}`` matches nothing and would skip the derivation walk —
    # the cited figure's producing Code/SubTask/goal chain would never be
    # walked, dead-ending the Artifact path at the Code (the Code IS reached
    # by the entry hops' ``produces in`` from the cited Artifact, but the
    # Code's producing SubTask is a second ``produces`` hop the entry hops
    # don't take). Passing the Artifacts the entry hops actually reached
    # (``tail_eids`` filtered to Artifact labels) seeds the derivation tail
    # so each cited figure traces its full ancestry to the goal.
    if src_label == "Artifact":
        seed_arts = [src_eid]
    else:
        # Candidate seeds = every Artifact the entry hops reached (in
        # ``tail_eids``), plus the source eid itself in case it is an Artifact
        # (Paper/Evidence/Claim are not, but this stays correct for any label).
        candidates = set(tail_eids) | keep
        seed_arts = _cited_artifact_eids(session, candidates, None, session_id)
    if src_label == "Artifact":
        # Add cited Artifacts reached via the report's Claims (stated_in→supports→
        # Artifact) as extra derivation seeds.
        cited_via_claims = _cited_artifact_eids(session, set(citation_eids), None, session_id)
        for e in cited_via_claims:
            if e not in seed_arts:
                seed_arts.append(e)
    if src_label != "Artifact" and not seed_arts:
        # No cited Artifact reached from the source (e.g. a Claim that supports
        # only non-Artifact nodes). Keep the center + its entry tail only.
        all_eids = list(keep) + [e for e in tail_eids if e not in keep]
        return _serialize_subgraph(session, all_eids, session_id)
    deriv_eids, allowed_edges = _artifact_derivation_tail(
        session, seed_arts, session_id,
    )
    all_eids = list(keep) + [e for e in tail_eids if e not in keep] \
        + [e for e in citation_eids if e not in keep and e not in tail_eids] \
        + [e for e in deriv_eids if e not in keep and e not in tail_eids and e not in citation_eids]
    return _serialize_subgraph(session, all_eids, session_id, allowed_edges=allowed_edges)


def _cited_artifact_eids(
    session: Any, candidate_eids: set[str], anchor_eid: str | None,
    session_id: str | None,
) -> list[str]:
    """Return the elementIds of Artifacts in ``candidate_eids`` that a Claim
    supports (``Artifact -[:supports]-> Claim``), excluding the report anchor.

    These are the cited products whose derivation (the Code that produced
    them, the inputs that Code read) the artifact chain must trace. The
    anchor is excluded because it is the report itself, not a cited product —
    its own input edges are out of scope (the chain shows how cited figures
    were produced, not what the report consumed). The supports edge is now
    Artifact → Claim, so the MATCH walks (a:Artifact)-[:supports]->(cl:Claim)
    with the candidate Artifact on the source side.
    """
    if not candidate_eids:
        return []
    arts = [e for e in candidate_eids if e != anchor_eid]
    if not arts:
        return []
    rows = session.run(
        """
        MATCH (a:Artifact)-[:supports]->(cl:Claim)
        WHERE elementId(a) IN $arts
          AND ($sid IS NULL OR cl.session_id = $sid)
        RETURN collect(DISTINCT elementId(a)) AS cited
        """,
        arts=arts,
        sid=session_id,
    ).single()
    return rows["cited"] if rows else []


def _artifact_derivation_tail(
    session: Any, seed_artifact_eids: list[str], session_id: str | None,
) -> tuple[list[str], set[tuple[str, str, str]]]:
    """Walk the produces/input derivation chain backward from each cited
    Artifact, returning the reached eids AND the set of (Code, Artifact,
    edge_type) derivation edges actually traversed.

    For each cited Artifact A:
      A <-produces- Code_P          (the Code that produced A)
      Code_P <-input- input_Artifact  (the Artifacts Code_P read as inputs)
      input_Artifact <-produces- Code_Q (the Code that produced each input)
      Code_Q <-input- ...           (recurse until a pass adds nothing)

    Each producing Code is ALSO anchored to its task-chain tail — the
    SubTask that produced it (SubTask -[:produces]-> Code, walked ``in``),
    then the ``next`` chain up to the ResearchGoal and back down to every
    SubTask — so a cited Artifact whose Code read no inputs still traces all
    the way to the goal instead of dead-ending at the Code. This mirrors the
    ``produces``+``next`` entry hops ``_ENTRY_HOPS`` walks for non-Artifact
    sources, keeping the artifact chain's reach symmetric with theirs. The
    walked edges (Code→Artifact ``produces``, Artifact→Code ``input``)
    are recorded so ``_serialize_subgraph`` can whitelist them and prune
    sibling ``produces`` branches a Code emits to OTHER uncited Artifacts —
    a Code may produce several sibling Artifacts; only the one this tail
    traced from stays on the derivation chain, the rest drop even though
    they may enter the eid set as that Code's inputs.
    """
    if not seed_artifact_eids:
        return [], set()
    reached: set[str] = set(seed_artifact_eids)
    # A frontier of Artifact eids: each needs its producing Code found.
    # Alternates Artifact→(find producing Code)→(find that Code's input
    # Artifacts)→(find those inputs' producing Code)… until convergence.
    artifact_frontier: list[str] = list(seed_artifact_eids)
    allowed: set[tuple[str, str, str]] = set()
    # Task-chain tail hops, run from each newly-discovered producing Code so a
    # derivation that dead-ends at a Code (no input edges) still reaches the
    # goal. ``produces in`` finds the producing SubTask (SubTask→Code), then
    # the next-chain up to ResearchGoal and back down to every SubTask — the
    # same hops ``_ENTRY_HOPS`` uses for the non-Artifact sources' own tails.
    _CODE_TAIL_HOPS: list[tuple] = [
        ("produces", "in", "SubTask"),
        ("next", "in", "ResearchGoal", "1.."),
        ("next", "out", "SubTask", "1.."),
    ]
    while artifact_frontier:
        # Artifact <-produces- Code: for each frontier Artifact, the Code(s)
        # that produced it. Records (Code_eid, Artifact_eid, "produces") only
        # when the producing Code is NEWLY reached — this is what keeps sibling
        # branches out: a self-referential Code that both produces and reads an
        # input Artifact (e.g. the figure Code that also re-reads its own .pdf
        # output) is already in `reached`, so its produces edge to that input
        # is NOT whitelisted and drops in serialization. Only the first pass
        # that discovers a Code (from a cited Artifact) records its produces
        # edge, so the edge always points at the cited Artifact, never at a
        # sibling the Code also produced.
        code_rows = session.run(
            """
            MATCH (a:Artifact)<-[:produces]-(c:Code)
            WHERE elementId(a) IN $arts
              AND ($sid IS NULL OR c.session_id = $sid)
            RETURN collect(DISTINCT {art: elementId(a), code: elementId(c)}) AS pairs
            """,
            arts=artifact_frontier,
            sid=session_id,
        ).single()
        pairs = code_rows["pairs"] if code_rows else []
        new_codes: list[str] = []
        for p in pairs:
            code_eid, art_eid = p["code"], p["art"]
            if code_eid not in reached:
                reached.add(code_eid)
                new_codes.append(code_eid)
                # Whitelist this produces edge only when the Code is newly
                # discovered from THIS Artifact — the edge is the
                # Artifact's own derivation, not a sibling branch.
                allowed.add((code_eid, art_eid, "produces"))
        if not new_codes:
            break
        # Each newly-discovered producing Code anchors to its task-chain tail
        # (producing SubTask → next-chain → ResearchGoal), so the cited
        # Artifact's chain reaches the goal even when the Code read no inputs
        # and the produces/input alternation dead-ends here. The reached
        # SubTasks/ResearchGoal are added to the eid set; the produces/next
        # edges between them render automatically in serialization (both
        # endpoints are in the set, and the allowed_edges whitelist only gates
        # Code→Artifact produces sibling branches, never task-chain edges).
        tail_eids = _walk_hops(session, _CODE_TAIL_HOPS, new_codes, session_id)
        for e in tail_eids:
            reached.add(e)
        # Code <-input- Artifact: for each newly-reached Code, the Artifacts
        # it read as inputs. Records (input_Artifact_eid, Code_eid, "input")
        # — note edge orientation is Artifact -[:input]-> Code, so the source
        # eid is the input Artifact and the target eid is the Code.
        input_rows = session.run(
            """
            MATCH (c:Code)<-[:input]-(a:Artifact)
            WHERE elementId(c) IN $codes
              AND ($sid IS NULL OR a.session_id = $sid)
            RETURN collect(DISTINCT {code: elementId(c), art: elementId(a)}) AS pairs
            """,
            codes=new_codes,
            sid=session_id,
        ).single()
        in_pairs = input_rows["pairs"] if input_rows else []
        new_input_arts: list[str] = []
        for p in in_pairs:
            code_eid, art_eid = p["code"], p["art"]
            allowed.add((art_eid, code_eid, "input"))
            if art_eid not in reached:
                reached.add(art_eid)
                new_input_arts.append(art_eid)
        # Next pass: trace the producing Code of each newly-reached input
        # Artifact. If no new input Artifacts, the derivation has bottomed out.
        artifact_frontier = new_input_arts
    return list(reached), allowed


def get_trace(
    node_id: str,
    target_label: str | None = None,
    max_hops: int = 8,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Trace the upstream provenance chain from a node and return whether it
    is intact.

    Unlike ``get_chain`` (which returns a *subgraph* — unordered nodes+edges
    walked both upstream and downstream), this returns a **linear, ordered
    chain** plus the authenticity signals ``broken``/``truncated``/``reason``
    that the reviewer specialist consumes (see docs/05 §3). It reuses the same
    hop-by-hop elementId-expansion engine as ``get_chain`` and the same
    ``_CHAIN_HOPS`` preset table, but:

    - walks **upstream only** (toward the origin — by default ResearchGoal),
      filtering the preset entries to ``direction == "in"``;
    - records the hop order and the edge type used to reach each node
      (``via_edge``);
    - judges the chain: reaching ``target_label`` → ``broken:false``; a hop
      that finds no new nodes → ``broken:true``; running past ``max_hops``
      without reaching the terminal → ``truncated:true``.

    The direction is fixed to upstream on purpose: a reviewer verifying an
    artifact's authenticity only needs "can this be traced back to its
    ResearchGoal?" — a one-way origin walk. ``get_chain`` remains the tool for
    the full upstream↔downstream subgraph view.

    Degrades identically to ``get_chain``: an unreachable graph returns an
    empty trace with ``broken:true`` + ``reason:"memory_graph_unreachable"``
    (never throws into the caller). A missing start node returns
    ``reason:"start_node_not_found"`` for the route layer to turn into a 404.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("get_trace skipped: Neo4j not reachable (node_id=%s)", node_id)
        return {
            "start_node": None,
            "chain": [],
            "broken": True,
            "truncated": False,
            "reason": "memory_graph_unreachable",
        }

    target = target_label or "ResearchGoal"
    with driver.session() as session:
        # Step 1: locate the start node's elementId + label — same all-fields
        # OR match as get_chain (task_id/code_id/artifact_id/link/goal_id/
        # evidence_id/claim_id), with the session/Paper exception so
        # a session-scoped read still finds cross-session Papers.
        src_result = session.run(
            """
            MATCH (n)
            WHERE (n.task_id       = $id
               OR n.code_id       = $id
               OR n.artifact_id   = $id
               OR n.link          = $id
               OR n.goal_id       = $id
               OR n.evidence_id   = $id
               OR n.claim_id      = $id)
              AND ($sid IS NULL OR n.session_id = $sid OR n:Paper)
            RETURN elementId(n) AS src_eid, labels(n)[0] AS src_label,
                   n AS node LIMIT 1
            """,
            id=node_id,
            sid=session_id,
        )
        src_rec = src_result.single()
        if src_rec is None:
            return {
                "start_node": None,
                "chain": [],
                "broken": True,
                "truncated": False,
                "reason": "start_node_not_found",
            }
        src_eid = src_rec["src_eid"]
        src_label = src_rec["src_label"]
        start_node = _to_trace_node(src_rec["node"], src_label)

        # The start node itself is the terminal (e.g. tracing from a
        # ResearchGoal toward ResearchGoal) — nothing to walk.
        if src_label == target:
            return {
                "start_node": start_node,
                "chain": [],
                "broken": False,
                "truncated": False,
                "reason": f"reached terminal node {target}",
            }

        # Step 2: take only the upstream hops (direction == "in"). The preset
        # table mixes upstream and downstream entries (it was built for
        # get_chain's two-way subgraph walk); trace walks upstream only — the
        # reviewer wants "can this artifact be traced back to its origin?".
        # Keeping the table's natural order preserves the deliberate
        # own-subtree-first ordering (so the walk doesn't fan out to siblings
        # while the eid set is still tight).
        hops = [entry for entry in _CHAIN_HOPS.get(src_label, []) if entry[1] == "in"]

        chain: list[dict[str, Any]] = []
        current_eids: list[str] = [src_eid]
        for hop in range(1, max_hops + 1):
            new_nodes: list[dict[str, Any]] = []
            new_eids: list[str] = []
            for entry in hops:
                edge_type, edge_dir, hop_target_label = entry[0], entry[1], entry[2]
                depth = entry[3] if len(entry) > 3 else "1"
                # Same safe interpolation as get_chain: edge_type + depth come
                # from the _CHAIN_HOPS whitelist (not user input), so building
                # the Cypher string from them is safe; Neo4j does not accept
                # relationship types as query parameters.
                rel = f"`{edge_type}`*{depth}"
                pattern = f"<-[:{rel}]-" if edge_dir == "in" else f"-[:{rel}]->"
                # Project the label in Cypher (``labels(next)[0]``) alongside
                # the node and its elementId, instead of reading it back from
                # a Bolt ``Node.labels`` attribute on the Python side — the HTTP
                # REST API returns nodes as their bare properties dict, which
                # carries no label, so ``_node_label`` would return ``None`` and
                # drop every hop hit. ``WITH DISTINCT next`` dedupes before the
                # three plain ``collect``s, keeping them length-aligned.
                step = session.run(
                    f"""
                    MATCH (src){pattern}(next)
                    WHERE elementId(src) IN $eids
                      AND ($sid IS NULL OR next.session_id = $sid OR next:Paper)
                    WITH DISTINCT next
                    RETURN collect(next) AS reached,
                           collect(elementId(next)) AS reached_eids,
                           collect(labels(next)[0]) AS reached_labels
                    """,
                    eids=current_eids,
                    sid=session_id,
                )
                rec = step.single()
                reached = rec["reached"] if rec else []
                reached_eids = rec["reached_eids"] if rec else []
                reached_labels = rec["reached_labels"] if rec else []
                for node, eid, label in zip(reached, reached_eids, reached_labels):
                    if label is None:
                        continue
                    if eid in new_eids or eid in current_eids:
                        continue
                    new_eids.append(eid)
                    new_nodes.append({
                        "node": _to_trace_node(node, label),
                        "via_edge": edge_type,
                        "is_terminal": label == target,
                    })

            # Reached the terminal this hop → chain intact.
            terminal_hits = [n for n in new_nodes if n["is_terminal"]]
            if terminal_hits:
                for hit in terminal_hits:
                    chain.append({"hop": hop, "node": hit["node"],
                                  "via_edge": hit["via_edge"], "is_terminal": True})
                return {
                    "start_node": start_node,
                    "chain": chain,
                    "broken": False,
                    "truncated": False,
                    "reason": f"reached terminal node {target}",
                }

            # No new nodes this hop → the chain is severed.
            if not new_nodes:
                last_label = chain[-1]["node"]["label"] if chain else src_label
                last_id = (chain[-1]["node"]["id"] if chain else node_id)
                return {
                    "start_node": start_node,
                    "chain": chain,
                    "broken": True,
                    "truncated": False,
                    "reason": f"no upstream of {last_label} #{last_id}",
                }

            # Append every node reached this hop and keep walking.
            for hit in new_nodes:
                chain.append({"hop": hop, "node": hit["node"], "via_edge": hit["via_edge"]})
            current_eids = new_eids

        # Ran out of hops without reaching the terminal — chain not broken,
        # just not fully traced.
        return {
            "start_node": start_node,
            "chain": chain,
            "broken": False,
            "truncated": True,
            "reason": f"truncated at max_hops={max_hops}",
        }


# --- helpers --------------------------------------------------------------


# Preset chain hops per source label: each source label has a fixed list
# of hops walking upstream toward ResearchGoal and downstream toward the
# report Artifact a Claim is stated_in.
#
# Each entry is (edge_type, direction, target_label[, depth]).
# ``direction = "in"``  walks against edge orientation (toward ResearchGoal,
# upstream); ``"out"`` walks along orientation (toward the report Artifact,
# downstream).
# ``depth`` defaults to ``"1"`` (single hop); ``"1.."`` is variable-length
# and unfolds a whole chain in one hop — used to walk the SubTask
# ``next``-chain from the ResearchGoal all the way to the last SubTask, so
# any SubTask/Paper/Code's View chain shows the full
# ResearchGoal → head → ... → last task chain.
#
# The traversal is *directed* so it never fans out to sibling nodes of the
# same hop — e.g. clicking a Paper pulls in its producing SubTask (upstream)
# but NOT the other Papers that SubTask produced (those are a different
# Paper's chain).
#
# The chain is walked hop-by-hop: each hop starts from the elementIds
# gathered so far and appends the newly-reached nodes' elementIds. A hop
# that matches nothing (labels not yet persisted) simply adds nothing —
# the chain short-stops there without erroring.
#
# ``next``/``produces``/``extracts``/``supports``/``stated_in``/``input``/
# ``supersedes`` are all persisted today (SubTask/Code/Artifact/Paper via the
# observe mirror; Evidence/Claim via the declare tools; input/supersedes via
# the execution upsert). A Claim no longer ``supports`` a Paper directly — it
# reaches a Paper only via ``supports Evidence → extracts Paper`` (walked backward).
_CHAIN_HOPS: dict[str, list[tuple]] = {
    "Paper": [
        # upstream: Paper <-produces- SubTask, then walk the `next` chain
        # *up* to the ResearchGoal and *down* from the goal to every
        # SubTask — so any Paper's View chain shows the full task chain.
        ("produces", "in", "SubTask"),
        ("next", "in", "ResearchGoal", "1.."),
        ("next", "out", "SubTask", "1.."),
        # downstream: the `extracts` edge is Paper -> Evidence (Paper extracts
        # Evidence), so from a Paper we walk it *along* its orientation (out)
        # to reach the Evidence extracted from it. Then the citation side:
        # Evidence -[:supports]-> Claim (walk supports *out* from the Evidence
        # just reached), and Claim -[:stated_in]-> report Artifact (walk
        # stated_in *out* once Claim is in the eid set). A Claim no longer
        # supports a Paper directly — a Claim reaches a Paper only via Evidence.
        ("extracts", "out", "Evidence"),
        ("supports", "out", "Claim"),
        ("stated_in", "out", "Artifact"),
    ],
    "SubTask": [
        # This SubTask's OWN produces subtree first, while the eid set is
        # still just the source — so only this SubTask's Code/Artifact/Paper
        # are pulled in. Doing produces *after* the next-chain unfold would
        # fan out to every SubTask's produces (the whole graph), which is
        # what we avoid here. Code before Artifact so Code's Artifacts are
        # reached (Code -produces-> Artifact, not SubTask -produces-> Artifact).
        ("produces", "out", "Code"),
        ("produces", "out", "Artifact"),
        ("produces", "out", "Paper"),
        ("produces", "out", "Evidence"),
        # Then the task chain: walk `next` up to the ResearchGoal and back
        # down to the last SubTask — Goal → head → ... → this → ... → last.
        # Variable-length because the source can sit in the middle of the chain.
        ("next", "in", "ResearchGoal", "1.."),
        ("next", "out", "SubTask", "1.."),
        ("supports", "in", "Claim"),
    ],
    "Code": [
        # This Code's OWN produces (Artifacts) first, while eid set is just
        # {Code, producing-SubTask} — so only this Code's Artifacts come in.
        # Doing produces *after* the next-chain unfold would fan out to every
        # SubTask's Artifacts (the whole graph).
        ("produces", "in", "SubTask"),
        ("produces", "out", "Artifact"),
        # The Artifact versions this Code read as inputs (Artifact -[:input]->
        # Code): surfaces the derived-from inputs alongside the outputs.
        ("input", "in", "Artifact"),
        # Then the task chain: up to the ResearchGoal, back down to the last
        # SubTask. Variable-length because the producing SubTask can sit in
        # the middle of the chain.
        ("next", "in", "ResearchGoal", "1.."),
        ("next", "out", "SubTask", "1.."),
        ("supports", "in", "Claim"),
    ],
    "Artifact": [
        # Own produces first (Code that produced this Artifact), then the
        # task chain — same ordering rationale as Code above.
        ("produces", "in", "Code"),
        # derived-from: the input Artifact versions the producing Code read.
        # `produces in Code` lands on the Code that made this Artifact, then
        # `input in Artifact` walks the reverse direction (Artifact→Code) to
        # reach the versions that Code consumed — so the derived-from chain
        # appears when viewing an output Artifact.
        ("input", "in", "Artifact"),
        ("produces", "in", "SubTask"),
        ("next", "in", "ResearchGoal", "1.."),
        ("next", "out", "SubTask", "1.."),
        ("supports", "out", "Claim"),
        # A Claim is stated_in a report Artifact (Claim → Artifact): walking
        # the stated_in edge *in* (against Claim→Artifact) reaches the Claims the
        # report contains, from the report side.
        ("stated_in", "in", "Claim"),
        # Citation continuation: once the Claims are in the eid set (reached
        # via supports-out or stated_in-in above), walk Evidence -[:supports]-> Claim
        # backwards (supports *in*) to surface the Evidence backing those Claims,
        # then Paper -[:extracts]-> Evidence (extracts *in*) to surface the
        # source Papers. This makes a report Artifact's view chain show the
        # full 报告→claim→evidence→paper citation path.
        ("supports", "in", "Evidence"),
        ("extracts", "in", "Paper"),
    ],
    # ResearchGoal: only the task chain — Goal → head → ... → last SubTask.
    # No produces subtree (each SubTask's produces is shown when *its* chain
    # is viewed; the goal view stays a clean task skeleton).
    "ResearchGoal": [
        ("next", "out", "SubTask", "1.."),
    ],
    "Evidence": [
        # extracts is Paper -> Evidence, so walking *in* (against it) reaches
        # the Paper this evidence was extracted from.
        ("extracts", "in", "Paper"),
        ("produces", "in", "SubTask"),
        ("next", "in", "ResearchGoal", "1.."),
        ("next", "out", "SubTask", "1.."),
        # Citation side: Evidence -[:supports]-> Claim, so walk supports *out*
        # from this Evidence to reach the Claim(s) it backs; then Claim
        # -[:stated_in]-> report Artifact (stated_in *out* once Claim is in the eid set).
        ("supports", "out", "Claim"),
        ("stated_in", "out", "Artifact"),
    ],
    "Claim": [
        # Basis: Evidence -[:supports]-> Claim (walk supports *in* to the
        # Evidence it backs), then Paper -[:extracts]-> Evidence (walk extracts
        # *in* once Evidence is in the eid set) to surface the source Paper.
        ("supports", "in", "Evidence"),
        ("extracts", "in", "Paper"),
        # Output: Claim -[:stated_in]-> report Artifact (walk stated_in *out*).
        ("stated_in", "out", "Artifact"),
        ("produces", "in", "SubTask"),
        ("next", "in", "ResearchGoal", "1.."),
        ("next", "out", "SubTask", "1.."),
    ],
}


def _to_hit(node: Any, label: str) -> dict[str, Any] | None:
    """Shape a Neo4j node into a search-hit dict.

    Returns ``None`` (and the caller drops the node) when the label is unknown
    to ``_node_identity`` — e.g. labels whose write path is not wired up yet.
    """
    node_id = _node_identity(label, node)
    if node_id is None:
        return None
    node_dict = dict(node) if hasattr(node, "items") else dict(node)
    return {
        "label": label,
        "id": node_id,
        "session_id": node_dict.get("session_id"),
        "session_title": None,
        "excerpt": _excerpt(node_dict, label),
        "extra": _json_safe({
            k: v
            for k, v in node_dict.items()
            if k not in {"session_id", "created_at", "finished_at"}
        }),
        "created_at": _iso(node_dict.get("created_at")),
    }


def _node_label(node: Any) -> str | None:
    """First label of a Neo4j node, as a plain string.

    ``get_chain``/``get_subgraph`` read the label in Cypher (``labels(n)[0]
    AS label``); ``get_trace`` fetches whole nodes via ``collect(DISTINCT
    next)`` and needs the label on the Python side, so this mirrors the
    Cypher ``labels(n)[0]`` projection. ``Node`` exposes ``labels`` as a
    frozenset; falls back to ``None`` for non-node values.
    """
    labels = getattr(node, "labels", None)
    if not labels:
        return None
    # ``labels`` is a frozenset; iteration order is not guaranteed, but every
    # persisted node carries exactly one label (the write path MERGEs on a
    # single label), so any element is the right one.
    return next(iter(labels))


def _to_trace_node(node: Any, label: str | None = None) -> dict[str, Any] | None:
    """Shape a Neo4j node into a ``trace_provenance`` chain node.

    A trimmed form of ``_to_hit``: only ``{label, id, excerpt}`` (no
    session_id/extra/created_at) — the reviewer walks the chain linearly and
    does not need node payloads here (those come from ``GET /nodes/:label/:id``
    when a hop is inspected). Returns ``None`` when the label is unknown to
    ``_node_identity`` (a node whose write path isn't wired yet), so the
    caller drops it instead of erroring — same label-agnostic contract as
    ``get_chain``.
    """
    if label is None:
        label = _node_label(node)
    if label is None:
        return None
    node_id = _node_identity(label, node)
    if node_id is None:
        return None
    node_dict = dict(node) if hasattr(node, "items") else dict(node)
    out = {"label": label, "id": node_id, "excerpt": _excerpt(node_dict, label)}
    # Carry the node's content CAS hash so the reviewer can locate the real
    # blob (graph = directory; CAS/store = warehouse, per !70 provenance-fields).
    # Artifact's body hash is `content_hash`; Code's is `code_hash`; other
    # labels carry no body hash and the field is omitted.
    hash_field = _CONTENT_HASH_FIELDS.get(label)
    if hash_field is not None:
        content_hash = node_dict.get(hash_field)
        if content_hash:
            out["content_hash"] = content_hash
    return out


_EXCERPT_FIELDS: dict[str, tuple[str, ...]] = {
    "ResearchGoal": ("core_objective", "domain"),
    "SubTask": ("task_type",),
    "Paper": ("title", "identifier", "abstract"),
    "Evidence": ("content", "locator"),
    "Claim": ("content", "locator"),
    "Code": ("tool", "code_id"),
    "Artifact": ("path", "artifact_id"),
}

_EXCERPT_LIMIT = 240


def _excerpt(node: dict[str, Any], label: str) -> str:
    """Pick the most relevant field for a label and trim to <= 240 chars."""
    fields = _EXCERPT_FIELDS.get(label) or ()
    if isinstance(fields, str):
        fields = (fields,)
    for key in fields:
        value = node.get(key)
        if value:
            text = str(value)
            return text[:_EXCERPT_LIMIT]
    return str(node.get("id") or label)


_ID_FIELDS: dict[str, str] = {
    "ResearchGoal": "goal_id",
    "SubTask": "task_id",
    "Paper": "link",
    "Evidence": "evidence_id",
    "Claim": "claim_id",
    "Code": "code_id",
    "Artifact": "artifact_id",
}

# Per-label field holding the node's body-content CAS hash, so the trace can
# carry the artifact/code hash the reviewer uses to locate the real blob
# (graph = directory; CAS/store = warehouse, per !70 provenance-fields).
# Artifact's body hash is `content_hash`, Code's is `code_hash`; the other
# labels carry no body hash and are absent here (the field is then omitted).
_CONTENT_HASH_FIELDS: dict[str, str] = {
    "Artifact": "content_hash",
    "Code": "code_hash",
}


def _node_identity(label: str, node: dict[str, Any]) -> str | None:
    """Pick the unique key for a node by label.

    Table-driven over ``_ID_FIELDS`` so labels (ResearchGoal/Evidence/
    Claim) are supported the moment their nodes land in the graph, without
    requiring another query.py edit.

    Artifact is keyed on the composite ``(artifact_id, version)`` (one node per
    version), so its identity encodes the version: ``"<artifact_id>#v<version>"``.
    A bare ``artifact_id`` would collide across versions, dropping all but one
    version from the subgraph's node set and breaking the ``supersedes`` edge
    endpoint check. Callers that resolve a bare ``artifact_id`` (chip click,
    View chain source) compare against ``extra.artifact_id``, not this id.
    """
    if not hasattr(node, "get"):
        node = dict(node)
    field = _ID_FIELDS.get(label)
    if field is None:
        return None
    base = node.get(field)
    if base is None:
        return None
    # Artifact: append the version so each version is a distinct node identity.
    if label == "Artifact":
        version = node.get("version")
        if version is not None:
            return f"{base}#v{version}"
    return base


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    # Neo4j datetime / zoned datetime → ISO string.
    iso = getattr(value, "to_iso", None)
    if callable(iso):
        try:
            return iso()
        except Exception:
            pass
    return str(value)


def _json_safe(value: Any) -> Any:
    """Recursively convert Neo4j-specific types in a node's ``extra`` payload
    into JSON-serializable primitives.

    Neo4j's ``DateTime``/``Date``/``Time``/``Duration``/``LocalizedString``
    objects carry a ``to_iso`` (or similar) method but pydantic's JSON
    serializer cannot dump them, so a node holding e.g. ``retrieved_at`` as a
    Neo4j ``DateTime`` makes the whole response 500. This walks dicts/lists
    and converts any value exposing ``to_iso`` / ``to_native`` (and stdlib
    ``datetime`` objects, which arrive via ``to_native()`` conversion) to its
    ISO / native form; everything else passes through untouched.
    """
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    # stdlib datetime/date/time (arrive after Neo4j's to_native() or are stored
    # directly by some upserts) — isoformat() is JSON-safe.
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    # Neo4j temporal types expose to_iso() → ISO 8601 string.
    iso = getattr(value, "to_iso", None)
    if callable(iso):
        try:
            return iso()
        except Exception:
            pass
    # Other Neo4j types (Date, Time, Duration, …) expose to_native().
    native = getattr(value, "to_native", None)
    if callable(native):
        try:
            return _json_safe(native())
        except Exception:
            pass
    return value
