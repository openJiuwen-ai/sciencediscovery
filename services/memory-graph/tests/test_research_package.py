# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License");
"""Lossless package snapshots, persistence and validation on the real local backend."""
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_memory_graph import backend, server
from sciencediscovery_memory_graph.local_backend import LocalHandle


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
