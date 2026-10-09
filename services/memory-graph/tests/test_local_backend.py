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

"""The Neo4j-free backend: Cypher subset, JSONL persistence, backend selection."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))
from fastapi.testclient import TestClient

from sciencediscovery_memory_graph import backend
from sciencediscovery_memory_graph.local_backend import LocalHandle


def _handle(tmp_path: Path) -> LocalHandle:
    return LocalHandle(tmp_path / "graph")


def test_merge_is_idempotent_and_on_match_only_updates(tmp_path: Path) -> None:
    h = _handle(tmp_path)
    q = ("MERGE (a:Artifact {artifact_id: $id, version: 1}) "
         "ON CREATE SET a.n = 1 ON MATCH SET a.n = a.n + 1 RETURN a.n AS n")
    with h.session() as s:
        assert s.run(q, id="x").single()["n"] == 1
        assert s.run(q, id="x").single()["n"] == 2
    assert h.session().run("MATCH (a:Artifact) RETURN count(a) AS c").single()["c"] == 1


def test_variable_length_and_aggregation(tmp_path: Path) -> None:
    h = _handle(tmp_path)
    with h.session() as s:
        s.run("UNWIND range(0, 3) AS i MERGE (:T {i: i})")
        s.run("MATCH (a:T), (b:T) WHERE b.i = a.i + 1 MERGE (a)-[:next]->(b)")
        rows = s.run("MATCH (:T {i: 0})-[:next*1..2]->(x) RETURN x.i AS i ORDER BY i")
        assert [r["i"] for r in rows] == [1, 2]
        chain = s.run("MATCH (:T {i: 0})-[:next*0..]->(x) RETURN collect(x.i) AS xs").single()
        assert sorted(chain["xs"]) == [0, 1, 2, 3]
        assert s.run("MATCH (x:Nope) RETURN count(x) AS c").single()["c"] == 0


def test_variable_length_path_value_and_cycle_semantics(tmp_path: Path) -> None:
    h = _handle(tmp_path)
    with h.session() as s:
        s.run("UNWIND range(0, 2) AS i CREATE (:Cycle {i: i})")
        s.run("MATCH (a:Cycle), (b:Cycle) WHERE b.i = a.i + 1 "
              "CREATE (a)-[:next {step: b.i}]->(b)")
        s.run("MATCH (a:Cycle {i: 2}), (b:Cycle {i: 0}) "
              "CREATE (a)-[:next {step: 3}]->(b)")
        path = s.run("MATCH (:Cycle {i: 0})-[r:next*3..3]->(b) "
                     "RETURN r, b.i AS end").single()
        assert path["end"] == 0
        assert [rel["step"] for rel in path["r"]] == [1, 2, 3]
        assert s.run("MATCH (:Cycle {i: 0})-[:next*0..]->(b) "
                     "RETURN count(b) AS n").single()["n"] == 4


def test_folded_products_visit_rejoined_children_once(monkeypatch: pytest.MonkeyPatch,
                                                     tmp_path: Path) -> None:
    """A diamond DAG has exponentially many paths but linearly many children."""
    from sciencediscovery_memory_graph import query
    from sciencediscovery_memory_graph._cypher import CypherBudgetExceeded
    from sciencediscovery_memory_graph.local_graph import Graph

    h = _handle(tmp_path)
    h._graph = Graph()
    g = h.graph

    def node(label: str, sid: str, **props):
        return g.create_node([label], {"session_id": sid, **props})

    scope = node("Task", "affected", task_id="scope", task_type="subagent")
    first = node("ToolCall", "affected", task_id="first", parent_subtask_id="scope")
    g.create_rel("contains", scope, first, {})
    previous = first
    for i in range(18):
        left = node("ToolCall", "affected", task_id=f"l{i}", parent_subtask_id="scope")
        right = node("ToolCall", "affected", task_id=f"r{i}", parent_subtask_id="scope")
        joined = node("ToolCall", "affected", task_id=f"j{i}", parent_subtask_id="scope")
        for src, dst in ((previous, left), (previous, right), (left, joined), (right, joined)):
            g.create_rel("next", src, dst, {"method": "scope_chain"})
        previous = joined
    g.create_rel("next", previous, first, {"method": "scope_chain"})  # historical cycle
    paper = node("Paper", "affected", link="paper:in")
    g.create_rel("produces", previous, paper, {})
    code = node("Code", "affected", code_id="code:in")
    artifact = node("Artifact", "affected", artifact_id="art:in", version=1)
    g.create_rel("produces", previous, code, {})
    g.create_rel("produces", code, artifact, {})

    outsider = node("ToolCall", "affected", task_id="outside", parent_subtask_id="other")
    outside_paper = node("Paper", "affected", link="paper:outside")
    g.create_rel("next", previous, outsider, {"method": "temporal_chain"})
    g.create_rel("next", first, outsider, {"method": "scope_chain"})
    g.create_rel("produces", outsider, outside_paper, {})
    historical_scope = node("Task", "historical", task_id="old", task_type="subagent")
    historical_child = node("ToolCall", "historical", task_id="old-child", parent_subtask_id="old")
    g.create_rel("contains", historical_scope, historical_child, {})
    g.create_rel("produces", historical_child, node("Paper", "historical", link="paper:old"), {})

    monkeypatch.setattr(query, "handle", lambda: h)
    folded = query.get_subgraph("affected")
    surrogates = [e for e in folded["edges"] if e.get("extra", {}).get("surrogate")]
    assert {(e["target"], e["extra"]["via_child"]) for e in surrogates} == {
        ("paper:in", "j17"), ("art:in#v1", "j17")}
    expansion = query.get_group_expansion("_group:scope:Paper", "affected")
    assert [n["id"] for n in expansion["nodes"]] == ["paper:in"]
    assert query.get_subgraph("new-session")["nodes"] == []
    # Generic Cypher retains path semantics, but stops a caller that asks to
    # materialize all of the exponentially many paths.
    with pytest.raises(CypherBudgetExceeded):
        h.session().run("MATCH (:ToolCall {task_id: 'first'})-[:next*0..]->(child) "
                        "RETURN child.task_id AS id")


def test_variable_length_budget_stops_path_explosion_and_rolls_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    from sciencediscovery_memory_graph import _cypher

    h = _handle(tmp_path)
    with h.session() as s:
        s.run("UNWIND range(0, 20) AS i CREATE (:T {i: i})")
        s.run("MATCH (a:T), (b:T) WHERE b.i = a.i + 1 CREATE (a)-[:next]->(b)")
        monkeypatch.setattr(_cypher, "_MAX_QUERY_WORK", 100)
        with pytest.raises(_cypher.CypherBudgetExceeded):
            s.run("CREATE (:Doomed {k: 1}) WITH 1 AS one "
                  "MATCH (a:T)-[:next*0..]->(b:T) RETURN count(b) AS n")
        assert s.run("MATCH (n:Doomed) RETURN count(n) AS n").single()["n"] == 0


def test_long_linear_path_shares_prefix_until_path_is_requested(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    from sciencediscovery_memory_graph import _cypher
    from sciencediscovery_memory_graph.local_graph import Graph

    h = _handle(tmp_path)
    h._graph = Graph()
    previous = h.graph.create_node(["Chain"], {"i": 0})
    for i in range(1, 2001):
        current = h.graph.create_node(["Chain"], {"i": i})
        h.graph.create_rel("next", previous, current, {})
        previous = current
    monkeypatch.setattr(_cypher, "_MAX_PATH_ELEMENTS", 5_000)
    assert h.session().run("MATCH (:Chain {i: 0})-[r:next*0..]->(b) "
                           "RETURN count(b) AS n").single()["n"] == 2001
    with pytest.raises(_cypher.CypherBudgetExceeded, match="path payload"):
        h.session().run("MATCH (:Chain {i: 0})-[r:next*0..]->(b) RETURN r")
    # The relationship-variable path semantics remain available below budget.
    assert h.session().run("MATCH (:Chain {i: 0})-[r:next*0..3]->(b) "
                           "RETURN count(b) AS n").single()["n"] == 4


def test_nested_writes_and_no_match_expansion_obey_budget(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    from sciencediscovery_memory_graph import _cypher

    h = _handle(tmp_path)
    with h.session() as session:
        monkeypatch.setattr(_cypher, "_MAX_QUERY_WORK", 30)
        for statement in (
            "CALL { UNWIND range(0, 100) AS i CREATE (:ReviewNode {i: i}) } RETURN 1 AS n",
            "FOREACH (i IN range(0, 100) | CREATE (:ReviewNode {i: i}))",
        ):
            with pytest.raises(_cypher.CypherBudgetExceeded):
                session.run(statement)
        monkeypatch.setattr(_cypher, "_MAX_QUERY_WORK", 250_000)
        assert session.run("MATCH (n:ReviewNode) RETURN count(n) AS n").single()["n"] == 0

        root = h.graph.create_node(["Fan"], {"i": 0})
        for i in range(1, 101):
            leaf = h.graph.create_node(["Fan"], {"i": i})
            h.graph.create_rel("next", root, leaf, {})
        monkeypatch.setattr(_cypher, "_MAX_QUERY_WORK", 30)
        with pytest.raises(_cypher.CypherBudgetExceeded):
            session.run("MATCH (:Fan {i: 0})-[:next]->(:Fan {i: 999}) RETURN count(*) AS n")


def test_unwind_refuses_large_collection_before_rows_materialize(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sciencediscovery_memory_graph import _cypher
    from sciencediscovery_memory_graph.local_graph import Graph

    monkeypatch.setattr(_cypher, "_MAX_INTERMEDIATE_ROWS", 10)
    stats = _cypher.QueryStats()
    with pytest.raises(_cypher.CypherBudgetExceeded, match="collection"):
        _cypher.execute(Graph(), "UNWIND range(0, 10000) AS i RETURN i", {}, stats)
    assert stats.intermediate_peak == 0


def test_repeated_constant_collection_is_shared_across_result_rows(
    tmp_path: Path,
) -> None:
    from sciencediscovery_memory_graph import _cypher

    h = _handle(tmp_path)
    stats = _cypher.QueryStats()
    columns, rows = _cypher.execute(
        h.graph, "UNWIND range(1, 4000) AS i RETURN range(1, 4000) AS xs", {}, stats)
    assert columns == ["xs"]
    assert len(rows) == 4000
    assert rows[0][0] == list(range(1, 4001))
    assert rows[-1][0] is rows[0][0]
    assert stats.collection_elements < 20_000
    records = list(h.session().run(
        "UNWIND range(1, 4000) AS i RETURN range(1, 4000) AS xs"))
    assert len(records) == 4000
    assert records[0]["xs"][0] == 1
    assert records[-1]["xs"][-1] == 4000


def test_projection_cache_keeps_case_branches_row_dependent(tmp_path: Path) -> None:
    h = _handle(tmp_path)
    rows = h.session().run(
        "UNWIND range(1, 2) AS i "
        "RETURN CASE WHEN i = 1 THEN [1, 2] ELSE [2, 3] END AS xs")
    assert [row["xs"] for row in rows] == [[1, 2], [2, 3]]


def test_row_dependent_collections_stop_before_cumulative_payload_grows(
    tmp_path: Path,
) -> None:
    from sciencediscovery_memory_graph import _cypher

    h = _handle(tmp_path)
    stats = _cypher.QueryStats()
    with pytest.raises(_cypher.CypherBudgetExceeded, match="cumulative collection"):
        _cypher.execute(h.graph, "UNWIND range(1, 4000) AS i "
                        "RETURN range(i, i + 3999) AS xs", {}, stats)
    assert stats.collection_elements <= _cypher._MAX_COLLECTION_ELEMENTS
    assert stats.work < _cypher._MAX_QUERY_WORK

    # A failed statement with a preceding write must not leave that write behind.
    with pytest.raises(_cypher.CypherBudgetExceeded, match="cumulative collection"):
        h.session().run("CREATE (:Doomed {k: 1}) WITH 1 AS i "
                        "UNWIND range(1, 4000) AS n RETURN range(n, n + 3999) AS xs")
    assert h.session().run("MATCH (n:Doomed) RETURN count(n) AS n").single()["n"] == 0


def test_list_concatenation_charges_output_before_allocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sciencediscovery_memory_graph import _cypher
    from sciencediscovery_memory_graph.local_graph import Graph

    monkeypatch.setattr(_cypher, "_MAX_COLLECTION_ELEMENTS", 7_000)
    stats = _cypher.QueryStats()
    with pytest.raises(_cypher.CypherBudgetExceeded, match="cumulative collection"):
        _cypher.execute(Graph(), "RETURN $left + $right AS xs",
                        {"left": list(range(4000)), "right": list(range(4000))}, stats)
    assert stats.collection_elements == 0


def test_empty_session_uses_index_despite_historical_nodes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    from sciencediscovery_memory_graph import _cypher, query
    from sciencediscovery_memory_graph.local_graph import Graph

    h = _handle(tmp_path)
    h._graph = Graph()
    for i in range(2000):
        h.graph.create_node(["SearchNode"], {"session_id": "historical", "id": i})
    monkeypatch.setattr(query, "handle", lambda: h)
    monkeypatch.setattr(_cypher, "_MAX_QUERY_WORK", 100)
    assert query.get_subgraph("fresh")["nodes"] == []
    assert query.get_scope_expansion("missing", "fresh")["reason"] == "node_not_found"
    assert query.get_group_expansion("_group:missing:Paper", "fresh")["reason"] == "node_not_found"


def test_query_budget_has_a_user_visible_error(monkeypatch: pytest.MonkeyPatch,
                                               tmp_path: Path) -> None:
    from sciencediscovery_memory_graph import _cypher, server

    h = _handle(tmp_path)
    h.session().run("CREATE (:Task {task_id: 'one', session_id: 's'})")
    router = backend.BackendRouter(local=h)
    router.set_backend("local")
    monkeypatch.setattr(backend, "_router", router)
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test-token")
    monkeypatch.setattr(_cypher, "_MAX_QUERY_WORK", 0)
    response = TestClient(server.app).get(
        "/subgraph", params={"session_id": "s"},
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "memory_graph_query_limit"


def test_write_routes_preserve_query_budget_error(monkeypatch: pytest.MonkeyPatch,
                                                  tmp_path: Path) -> None:
    from sciencediscovery_memory_graph import _cypher, server

    h = _handle(tmp_path)
    router = backend.BackendRouter(local=h)
    router.set_backend("local")
    monkeypatch.setattr(backend, "_router", router)
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test-token")

    def exhausted(**_kwargs):
        raise _cypher.CypherBudgetExceeded("test limit")

    monkeypatch.setattr(server, "upsert_tool_call", exhausted)
    monkeypatch.setattr(server, "upsert_subagent", exhausted)
    client = TestClient(server.app)
    headers = {"authorization": "Bearer test-token"}
    for path, payload in (
        ("/observe/tool-call", {"task_id": "t", "session_id": "s", "turn_id": "u",
                                "tool_name": "search", "tool_type": "search"}),
        ("/observe/subagent", {"subagent_id": "t", "session_id": "s", "turn_id": "u",
                               "objective": "search", "created_at": "2026-09-27T00:00:00Z",
                               "status": "running"}),
    ):
        response = client.post(path, json=payload, headers=headers)
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "memory_graph_query_limit"


def test_scope_rebuild_keeps_other_next_method(tmp_path: Path) -> None:
    from sciencediscovery_memory_graph.persistence import _link_scope_children

    h = _handle(tmp_path)
    g = h.graph
    g.create_node(["Task"], {"task_id": "scope", "session_id": "s"})
    first = g.create_node(["ToolCall"], {"task_id": "a", "session_id": "s",
                                               "parent_subtask_id": "scope", "seq": 1})
    second = g.create_node(["ToolCall"], {"task_id": "b", "session_id": "s",
                                                "parent_subtask_id": "scope", "seq": 2})
    g.create_rel("next", first, second, {"method": "temporal_chain"})
    with h.session() as session:
        _link_scope_children(session, "s", "scope")
        _link_scope_children(session, "s", "scope")
    methods = [rel.props.get("method") for rel in g.rels.values() if rel.type == "next"]
    assert sorted(methods) == ["scope_chain", "temporal_chain"]


def test_failed_transaction_rolls_back(tmp_path: Path) -> None:
    h = _handle(tmp_path)
    with pytest.raises(RuntimeError):
        with h.session() as s:
            s.run("CREATE (:Doomed {k: 1})")
            raise RuntimeError("boom")
    assert h.session().run("MATCH (n:Doomed) RETURN count(n) AS c").single()["c"] == 0
    assert not (tmp_path / "graph" / "nodes.jsonl").exists()


def test_failing_statement_leaves_no_partial_writes(tmp_path: Path) -> None:
    h = _handle(tmp_path)
    with h.session() as s:
        with pytest.raises(Exception):
            s.run("CREATE (:Half {k: 1}) WITH 1 AS one RETURN nope")
        assert s.run("MATCH (n:Half) RETURN count(n) AS c").single()["c"] == 0


def test_graph_survives_restart_as_plain_text(tmp_path: Path) -> None:
    h = _handle(tmp_path)
    with h.session() as s:
        s.run("MERGE (a:Task {task_id: 't1'}) SET a.status = 'running'")
        s.run("MERGE (a:Task {task_id: 't1'}) SET a.status = 'done'")
        s.run("MERGE (b:Task {task_id: 't2'})")
        s.run("MATCH (a:Task {task_id: 't1'}), (b:Task {task_id: 't2'}) MERGE (a)-[:next]->(b)")
        s.run("MATCH (b:Task {task_id: 't2'}) DETACH DELETE b")

    lines = (tmp_path / "graph" / "nodes.jsonl").read_text().splitlines()
    assert any('"task_id":"t1"' in line for line in lines)  # greppable

    reopened = _handle(tmp_path)
    rows = list(reopened.session().run("MATCH (n:Task) RETURN n.task_id AS id, n.status AS st"))
    assert [(r["id"], r["st"]) for r in rows] == [("t1", "done")]
    assert reopened.session().run("MATCH ()-[r]->() RETURN count(r) AS c").single()["c"] == 0
    # New ids never collide with live replayed ones, and replay stays last-wins.
    reopened.session().run("CREATE (:Task {task_id: 't3'})")
    again = _handle(tmp_path)
    ids = [r["id"] for r in again.session().run("MATCH (n:Task) RETURN n.task_id AS id ORDER BY id")]
    assert ids == ["t1", "t3"]
    live = {json.loads(l)["id"] for l in (tmp_path / "graph" / "nodes.jsonl").read_text().splitlines()}
    assert {"n1"} <= live


def test_torn_final_line_is_skipped(tmp_path: Path) -> None:
    h = _handle(tmp_path)
    h.session().run("CREATE (:Task {task_id: 'ok'})")
    with (tmp_path / "graph" / "nodes.jsonl").open("a") as fh:
        fh.write('{"id":"n99","labels":["Task"],"pr')
    rows = list(_handle(tmp_path).session().run("MATCH (n:Task) RETURN n.task_id AS id"))
    assert [r["id"] for r in rows] == ["ok"]


def test_backend_is_a_setting_that_defaults_to_local(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("SCIENCE_AGENT_MEMORY_GRAPH_BACKEND", raising=False)
    router = backend.BackendRouter(local=_handle(tmp_path))
    assert router.kind == "local"
    router.set_password("secret")  # a saved credential alone does not switch stores
    try:
        assert router.kind == "local"
        router.set_backend("neo4j")
        assert router.kind == "neo4j"
        router.set_backend("local")
        assert router.kind == "local"
    finally:
        router.set_password(None)
    with pytest.raises(ValueError):
        router.set_backend("sqlite")


def test_health_is_healthy_without_any_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_BACKEND", "local")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test-token")
    from sciencediscovery_memory_graph import neo4j_driver, persistence, query, server

    monkeypatch.setattr(neo4j_driver, "_handle", None)
    monkeypatch.setattr(backend, "_router", None)
    for module in (persistence, query, server):
        importlib.reload(module)
    client = TestClient(server.app)
    assert client.get("/health").json() == {"status": "healthy", "backend": "local"}
    headers = {"authorization": "Bearer test-token"}
    # Selecting Neo4j without a password is the documented needs-password state.
    switched = client.post("/internal/backend", json={"backend": "neo4j"}, headers=headers)
    assert switched.json()["status"] == "needs-password"
    back = client.post("/internal/backend", json={"backend": "local"}, headers=headers)
    assert back.json() == {"status": "healthy", "backend": "local"}


def test_variable_length_bounds_follow_opencypher(tmp_path: Path) -> None:
    """``*0..`` starts at the node itself, ``*..n`` and ``*`` start at one hop."""
    from sciencediscovery_memory_graph._cypher import Parser

    def bounds(spec: str) -> tuple[int, int | None]:
        branches, _ = Parser(f"MATCH (a)-[:x{spec}]->(b) RETURN b").parse()
        rel = branches[0][0][1][0].rels[0]
        return rel.lo, rel.hi

    assert bounds("*0..") == (0, None)
    assert bounds("*..3") == (1, 3)
    assert bounds("*1..3") == (1, 3)
    assert bounds("*2") == (2, 2)
    assert bounds("*") == (1, None)


def test_division_by_zero_is_a_cypher_error(tmp_path: Path) -> None:
    from sciencediscovery_memory_graph._cypher import CypherError

    h = _handle(tmp_path)
    for expr in ("1 / 0", "1.5 / 0.0", "5 % 0"):
        with pytest.raises(CypherError):
            h.session().run(f"RETURN {expr} AS x")


def test_call_subquery_union_removes_duplicates(tmp_path: Path) -> None:
    h = _handle(tmp_path)
    rows = list(h.session().run(
        "CALL { RETURN 1 AS x UNION RETURN 1 AS x UNION RETURN 2 AS x } RETURN x ORDER BY x"
    ))
    assert [r["x"] for r in rows] == [1, 2]
