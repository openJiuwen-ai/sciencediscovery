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

"""The event -> graph translation, and the flood control around it.

`plan_writes` is pure, so the rules that are easy to get wrong and expensive to
discover later — a replayed batch double-counting visits, a failed candidate
carrying a sentinel score, a criterion map that Neo4j cannot store — are all
testable without a database. The Cypher around it needs a live Neo4j and is
covered by the existing `needs_neo4j` suite.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from sciencediscovery_memory_graph import query
from sciencediscovery_memory_graph.search_graph import plan_writes
from sciencediscovery_memory_graph.server import app


def record(sequence: int, event: dict, created_at: str = "2026-08-19T00:00:00.000Z") -> dict:
    return {"createdAt": created_at, "event": event, "sequence": sequence}


def plan(records, last_seq: int = 0):
    return plan_writes(search_id="run-1", session_id="s1", records=records, last_seq=last_seq)


def _stored(row: dict) -> dict:
    """What actually reaches Neo4j: `_clean` drops None so a later event cannot
    blank a property an earlier one set."""
    return {key: value for key, value in row.items() if value is not None}


SEEDED = record(2, {"baselineScore": 0.5, "nodeIndex": 0, "type": "seeded"})


def test_a_started_search_sets_the_run_and_seeds_the_root() -> None:
    result = plan([
        record(1, {"algorithm": "puct", "scorecardHash": "sha256:card", "type": "search_started"}),
        SEEDED,
    ])

    assert result.run["algorithm"] == "puct"
    assert result.run["scorecard_hash"] == "sha256:card"
    assert result.run["last_seq"] == 2
    assert result.root_index == 0
    assert result.nodes[0]["node_index"] == 0
    assert result.nodes[0]["score"] == 0.5


def test_visits_are_absolute_so_a_replay_cannot_double_count() -> None:
    selected = record(3, {
        "ancestorVisits": [{"nodeIndex": 1, "visits": 1}, {"nodeIndex": 0, "visits": 4}],
        "nodeIndex": 1, "puct": 0.71, "rankScore": 0.83, "type": "selected",
    })

    once = plan([selected])
    twice = plan([selected, selected])

    # Applying the same event twice yields the same absolute counts, which is
    # the whole reason the wire format carries totals instead of increments.
    assert once.visits == [{"node_index": 1, "visits": 1}, {"node_index": 0, "visits": 4}]
    assert twice.visits[-2:] == once.visits
    assert once.nodes[0]["selected_puct"] == 0.71


def test_records_at_or_below_the_watermark_are_dropped() -> None:
    records = [
        record(1, {"algorithm": "puct", "scorecardHash": "h", "type": "search_started"}),
        SEEDED,
        record(3, {"cents": 10, "tokens": 1000, "type": "cost"}),
    ]

    result = plan(records, last_seq=2)

    assert result.skipped == 2
    assert result.last_seq == 3
    assert result.run["tokens"] == 1000
    assert result.nodes == [], "the seeded node was already applied"


def test_a_fully_replayed_batch_changes_nothing() -> None:
    result = plan([SEEDED], last_seq=5)
    assert result.skipped == 1
    assert result.last_seq is None
    assert result.run == {}
    assert result.nodes == []


def test_a_failed_candidate_carries_null_and_still_becomes_a_node() -> None:
    result = plan([record(4, {
        "depth": 1, "error": "SyntaxError", "nodeIndex": 3, "parentIndex": 0,
        "score": None, "type": "expanded", "valid": False,
    })])

    node = result.nodes[0]
    assert node["node_index"] == 3
    assert node["valid"] is False
    assert node["error"] == "SyntaxError"
    assert "score" not in _stored(node), "a null score is left unset, never a sentinel"
    # It is in the tree: dropping it would change the rank denominator of every
    # later iteration.
    assert result.expands == [{"node_index": 3, "parent_index": 0}]


def test_non_finite_numbers_never_reach_a_property() -> None:
    result = plan([record(4, {
        "depth": 1, "nodeIndex": 1, "parentIndex": 0,
        "score": float("-inf"), "type": "expanded", "valid": False,
    })])
    assert result.nodes[0]["score"] is None


def test_criteria_are_flattened_into_queryable_properties() -> None:
    result = plan([record(5, {
        "criteria": {"f1": 0.62, "runtime": 180.0}, "nodeIndex": 1,
        "reward": 0.6, "type": "evaluated",
    })])

    node = result.nodes[0]
    # Neo4j has no nested maps, and a JSON blob would kill `WHERE n.crit_runtime
    # > 300` — the query this graph exists to answer.
    assert node["crit_f1"] == 0.62
    assert node["crit_runtime"] == 180.0
    assert node["reward"] == 0.6


def test_an_accepted_candidate_moves_the_elected_edge() -> None:
    result = plan([
        record(6, {"accepted": True, "nodeIndex": 1, "reason": "留出门分数提升", "type": "merged"}),
        record(7, {"accepted": False, "category": "constraint-violated", "nodeIndex": 2,
                   "reason": "太慢", "rejectedBy": "too-slow", "type": "merged"}),
    ])

    assert result.elected_index == 1, "a refused candidate must not become the best"
    refused = next(node for node in result.nodes if node["node_index"] == 2)
    assert refused["rejected_by"] == "too-slow"
    assert refused["accepted"] is False


def test_openevolve_lineage_and_occupancy() -> None:
    result = plan([
        record(4, {
            "depth": 1, "inspirationIndexes": [0, 2], "island": 1, "nodeIndex": 3,
            "parentIndex": 2, "programId": "p-3", "score": 0.7, "type": "expanded", "valid": True,
        }),
        record(5, {"complexityBin": 2, "diversityBin": 1, "island": 1, "nodeIndex": 3,
                   "type": "inserted", "via": "insert"}),
        record(6, {"fromIsland": 1, "nodeIndex": 3, "toIsland": 2, "type": "migrated"}),
        record(7, {"complexityBin": 2, "diversityBin": 1, "island": 2, "nodeIndex": 3,
                   "type": "inserted", "via": "migration"}),
    ])

    assert result.expands == [{"node_index": 3, "parent_index": 2}]
    assert result.inspires == [
        {"node_index": 3, "source_index": 0},
        {"node_index": 3, "source_index": 2},
    ]
    # Migration copies rather than moves, so one candidate holds cells on two
    # islands at once — occupancy is a relation, not a property of the node.
    assert [cell["island"] for cell in result.cells] == [1, 2]
    assert result.cells[1]["via"] == "migration"


def test_the_finish_event_settles_the_run() -> None:
    result = plan([record(9, {
        "bestNodeIndex": 4, "bestTestScore": 0.59, "candidates": 7,
        "status": "succeeded", "type": "search_finished",
    })])

    assert result.run["status"] == "succeeded"
    assert result.run["best_node_index"] == 4
    assert result.run["candidates"] == 7
    assert result.elected_index == 4


def test_unnumbered_records_are_ignored_rather_than_crashing() -> None:
    result = plan([{"event": {"type": "seeded"}}, {"sequence": "x", "event": {}}, SEEDED])
    assert result.last_seq == 2
    assert len(result.nodes) == 1


# --- Flood control ----------------------------------------------------------


def test_the_session_subgraph_excludes_search_nodes_and_cells() -> None:
    source = query.get_subgraph.__doc__ or ""
    import inspect

    body = inspect.getsource(query.get_subgraph)
    assert "NOT n:SearchNode" in body and "NOT n:SearchCell" in body, (
        "a session with one search would otherwise gain hundreds of nodes and push "
        "the nodes the session is about out of the LIMIT window"
    )
    assert "'searches'" in body, "the one edge that shows a session ran a search stays visible"
    for structural in ("'expands'", "'root'", "'inspires'", "'occupies'"):
        assert structural not in body, f"{structural} must not enter the session subgraph"
    assert source is not None


def test_chain_hops_never_walk_expands_downwards() -> None:
    for label, hops in query._CHAIN_HOPS.items():
        for hop in hops:
            edge, direction = hop[0], hop[1]
            if edge in ("expands", "inspires", "occupies"):
                assert direction == "in", (
                    f"{label} walks {edge} {direction}: one 'view chain' would pull a whole "
                    "search tree into the picture"
                )


def test_a_subtask_chain_reaches_the_search_handle_only() -> None:
    # ToolCall since upstream's Task/ToolCall split: an evolve search is a
    # ToolCall (task_type=program_evolution), and its chain entry carries the
    # `searches` handle.
    hops = query._CHAIN_HOPS["ToolCall"]
    assert ("searches", "out", "SearchRun") in hops
    assert not any(hop[0] == "expands" for hop in hops)


# --- Routes -----------------------------------------------------------------


def test_search_progress_degrades_instead_of_failing() -> None:
    """Neo4j is unreachable in this suite, which is the case that matters: the
    graph is a projection, so a write that cannot land must not surface as an
    error on the run."""
    client = TestClient(app)
    response = client.post("/observe/search-progress", json={
        "search_id": "run-1", "session_id": "s1",
        "records": [json.loads(json.dumps(SEEDED))],
    })

    assert response.status_code == 200
    assert response.json()["applied"] == 0
    assert response.json()["reason"] == "memory_graph_unreachable"


def test_an_empty_batch_is_accepted_without_touching_the_database() -> None:
    client = TestClient(app)
    response = client.post("/observe/search-progress", json={
        "search_id": "run-1", "session_id": "s1", "records": [],
    })
    assert response.status_code == 200
    assert response.json() == {"applied": 0, "skipped": 0}


def test_reading_an_unknown_search_is_a_degraded_answer_not_a_crash() -> None:
    client = TestClient(app)
    response = client.post("/query/search-graph", json={"search_id": "nope"})
    assert response.status_code == 200
    assert response.json()["reason"] == "memory_graph_unreachable"


def test_every_readable_label_has_an_id_field() -> None:
    """A label the reader does not know how to identify is **silently dropped**.

    This is not hypothetical: `SearchRun` was written to Neo4j correctly and
    still never appeared in a session subgraph, because `_node_identity`
    returned None for it and the loop skipped the node without a word. Pinning
    the whole table means the next label cannot repeat it.
    """
    from sciencediscovery_memory_graph.server import _NODE_LABELS

    missing = sorted(label for label in _NODE_LABELS if label not in query._ID_FIELDS)
    assert missing == [], f"labels the reader cannot identify: {missing}"


def test_a_searchs_nodes_do_not_collapse_onto_one_identity() -> None:
    """Every node of one search shares `search_id`, so the identity has to carry
    the rest of the composite key."""
    first = query._node_identity("SearchNode", {"search_id": "run-1", "node_index": 0})
    second = query._node_identity("SearchNode", {"search_id": "run-1", "node_index": 1})
    assert first != second

    cell_a = query._node_identity(
        "SearchCell", {"search_id": "run-1", "island": 0, "complexity_bin": 1, "diversity_bin": 2})
    cell_b = query._node_identity(
        "SearchCell", {"search_id": "run-1", "island": 1, "complexity_bin": 1, "diversity_bin": 2})
    assert cell_a != cell_b

    # An incomplete key is no identity at all, rather than a colliding one.
    assert query._node_identity("SearchNode", {"search_id": "run-1"}) is None


def test_the_search_subtask_is_created_rather_than_assumed() -> None:
    """Nothing else mirrors a task node for a search, so binding must create one.

    Matching an existing node — which is what this did first — left the
    `searches` edge unwritten and the search off the session's task chain, which
    is the chain `trace_provenance` walks to decide whether a saved artifact can
    be traced back to the research goal.
    """
    import inspect

    from sciencediscovery_memory_graph import search_graph

    body = inspect.getsource(search_graph.bind_subtask)
    # `:ToolCall` since the Task/ToolCall split — a `:SubTask` node would fall
    # out of the session chain the rebuild walks (`st:Task OR st:ToolCall`).
    assert "MERGE (st:ToolCall" in body, "the ToolCall has to be created here"
    assert "MERGE (st)-[:searches]->(r)" in body
    assert "program_evolution" in body
