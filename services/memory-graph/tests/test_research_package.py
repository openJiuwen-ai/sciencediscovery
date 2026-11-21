# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License");
"""Lossless package snapshots, persistence and validation on the real local backend."""
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_memory_graph import backend, server
from sciencediscovery_memory_graph.local_backend import LocalHandle, LocalSession


def test_snapshot_roundtrip_includes_hidden_search_nodes_and_real_edges(monkeypatch, tmp_path: Path):
    handle = LocalHandle(tmp_path / "graph")
    router = backend.BackendRouter(local=handle)
    router.set_backend("local")
    monkeypatch.setattr(backend, "_router", router)
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test")
    headers = {"authorization": "Bearer test"}
    client = TestClient(server.app)
    with handle.session() as session:
        session.run("CREATE (a:SearchRun {search_id: 'search', session_id: 'old', created_at: 'yesterday'}) "
                    "CREATE (b:SearchNode {search_id: 'search', node_index: 3, session_id: 'old', score: 0.75}) "
                    "CREATE (a)-[:root {basis: 'original'}]->(b)")
        session.run("CREATE (:Task {task_id: 'unrelated', session_id: 'other'})")
    assert client.post("/internal/research-package/export", json={"session_ids": ["old"]}).status_code == 401
    exported = client.post("/internal/research-package/export", json={"session_ids": ["old"]}, headers=headers)
    assert exported.status_code == 200, exported.text
    snapshot = exported.json()
    assert len(snapshot["nodes"]) == 2
    assert len(snapshot["edges"]) == 1
    assert snapshot["edges"][0]["properties"] == {"basis": "original"}
    for node in snapshot["nodes"]:
        node["properties"]["session_id"] = "new"
        node["properties"]["search_id"] = "imported-search"
    result = client.post("/internal/research-package/import", json={"session_ids": ["new"], **snapshot}, headers=headers)
    assert result.status_code == 200, result.text
    # Reload disk state: this must survive service restarts, not just render once.
    reopened = LocalHandle(tmp_path / "graph")
    router = backend.BackendRouter(local=reopened)
    router.set_backend("local")
    monkeypatch.setattr(backend, "_router", router)
    restored = client.post("/internal/research-package/export", json={"session_ids": ["new"]}, headers=headers).json()
    assert len(restored["nodes"]) == 2
    assert len(restored["edges"]) == 1
    assert any(node["properties"].get("score") == 0.75 for node in restored["nodes"])
    assert all(not any(key.startswith("_package_") for key in node["properties"]) for node in restored["nodes"])
    # Re-import cannot silently overwrite an existing graph.
    assert client.post("/internal/research-package/import", json={"session_ids": ["new"], **snapshot}, headers=headers).status_code == 400
    snapshot["edges"][0]["target"] = "missing"
    for node in snapshot["nodes"]:
        node["properties"]["session_id"] = "invalid"
    assert client.post("/internal/research-package/import", json={"session_ids": ["invalid"], **snapshot}, headers=headers).status_code == 400
    assert client.post("/internal/research-package/export", json={"session_ids": ["invalid"]}, headers=headers).json()["nodes"] == []


def test_snapshot_is_not_limited_to_ui_node_budget(monkeypatch, tmp_path: Path):
    handle = LocalHandle(tmp_path / "graph")
    router = backend.BackendRouter(local=handle)
    router.set_backend("local")
    monkeypatch.setattr(backend, "_router", router)
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test")
    headers = {"authorization": "Bearer test"}
    client = TestClient(server.app)
    nodes = [{"id": str(index), "labels": ["Task"],
              "properties": {"task_id": f"task-{index}", "session_id": "large"}}
             for index in range(510)]
    body = {"session_ids": ["large"], "nodes": nodes, "edges": []}
    assert client.post("/internal/research-package/validate", json=body).status_code == 401
    assert client.post("/internal/research-package/validate", json=body, headers=headers).status_code == 200
    assert client.post("/internal/research-package/import", json=body, headers=headers).status_code == 200
    exported = client.post("/internal/research-package/export", json={"session_ids": ["large"]}, headers=headers)
    assert exported.status_code == 200
    assert len(exported.json()["nodes"]) == 510
    # Different archive keys must not duplicate the same logical graph node.
    nodes.append({**nodes[0], "id": "duplicate"})
    assert client.post("/internal/research-package/validate", json=body, headers=headers).status_code == 400



def test_package_scope_uses_index_with_unrelated_history(monkeypatch, tmp_path: Path):
    from sciencediscovery_memory_graph import _cypher

    handle = LocalHandle(tmp_path / "graph")
    router = backend.BackendRouter(local=handle)
    router.set_backend("local")
    monkeypatch.setattr(backend, "_router", router)
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test")
    client = TestClient(server.app, headers={"authorization": "Bearer test"})
    with handle.session() as session:
        session.run("UNWIND $rows AS row CREATE (:Task {task_id: row, session_id: 'unrelated'})", rows=list(range(1500)))
        session.run("CREATE (a:Task {task_id: 'a', session_id: 'first'}) "
                    "CREATE (b:Task {task_id: 'b', session_id: 'second'}) "
                    "CREATE (out:Task {task_id: 'out', session_id: 'unrelated'}) "
                    "CREATE (a)-[:next]->(b) CREATE (a)-[:next]->(out)")
    monkeypatch.setattr(_cypher, "_MAX_QUERY_WORK", 2500)
    exported = client.post("/internal/research-package/export", json={"session_ids": ["first", "second", "first"]})
    assert exported.status_code == 200, exported.text
    graph = exported.json()
    assert {node["properties"]["task_id"] for node in graph["nodes"]} == {"a", "b"}
    assert len(graph["nodes"]) == 2
    assert len(graph["edges"]) == 1
    for node in graph["nodes"]:
        node["properties"]["session_id"] = "restored"
    imported = client.post("/internal/research-package/import", json={"session_ids": ["restored"], **graph})
    assert imported.status_code == 200, imported.text
    discarded = client.post("/internal/research-package/discard", json={"session_ids": ["restored", "restored"]})
    assert discarded.status_code == 200, discarded.text
    assert client.post("/internal/research-package/export", json={"session_ids": ["restored"]}).json() == {"nodes": [], "edges": []}
    # The cleanup must preserve both the original export and unrelated history.
    assert len(client.post("/internal/research-package/export", json={"session_ids": ["first", "second"]}).json()["edges"]) == 1
    monkeypatch.undo()
    with handle.session() as session:
        assert session.run("MATCH (n {session_id: 'unrelated'}) RETURN count(n) AS count").single()["count"] == 1501


def test_snapshot_import_can_retry_after_relationship_write_failure(monkeypatch, tmp_path: Path):
    handle = LocalHandle(tmp_path / "graph")
    router = backend.BackendRouter(local=handle)
    router.set_backend("local")
    monkeypatch.setattr(backend, "_router", router)
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test")
    client = TestClient(server.app, headers={"authorization": "Bearer test"})
    scope = {"session_ids": ["restored"]}
    snapshot = {
        **scope,
        "nodes": [
            {"id": "job", "labels": ["Task"], "properties": {"session_id": "restored", "task_id": "task-1"}},
            {"id": "report", "labels": ["Artifact"], "properties": {
                "session_id": "restored", "artifact_id": "report", "version": 2, "content_hash": "sha256:test",
            }},
        ],
        "edges": [{"source": "job", "target": "report", "type": "produces", "properties": {}}],
    }
    run = LocalSession.run

    def fail_relationship(self, cypher, **params):
        if "CREATE (a)-[r:produces]->(b)" in cypher:
            # Node writes really happened in this transaction. The import must
            # compensate them when the relationship cannot be persisted.
            pending = run(self, "MATCH (n {session_id: 'restored'}) RETURN count(n) AS count").single()
            assert pending["count"] == 2
            raise RuntimeError("injected relationship persistence failure")
        return run(self, cypher, **params)

    with monkeypatch.context() as fault:
        fault.setattr(LocalSession, "run", fail_relationship)
        failed = client.post("/internal/research-package/import", json=snapshot)
        assert failed.status_code == 503, failed.text
    assert client.post("/internal/research-package/export", json=scope).json() == {"nodes": [], "edges": []}
    retry = client.post("/internal/research-package/import", json=snapshot)
    assert retry.status_code == 200, retry.text
    restored = client.post("/internal/research-package/export", json=scope).json()
    assert len(restored["nodes"]) == 2
    artifact = next(node for node in restored["nodes"] if "Artifact" in node["labels"])
    assert artifact["properties"]["version"] == 2
    assert artifact["properties"]["content_hash"] == "sha256:test"
    assert [(edge["type"], edge["target"]) for edge in restored["edges"]] == [("produces", artifact["id"])]
