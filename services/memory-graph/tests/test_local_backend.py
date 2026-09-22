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
