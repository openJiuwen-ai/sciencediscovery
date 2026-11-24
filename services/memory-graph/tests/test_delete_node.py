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

"""Single-record deletion: one whitelisted node, its edges, nothing else.

Runs on the Neo4j-free local backend so the preservation assertions are exact:
after deleting one Evidence, the Session's other Evidence/Claim/SourceFile and
another Session's Evidence are still present, while the deleted node's edges
are gone. The existing cleanup/session bulk semantics are re-checked here too,
because the new route must not have changed them.

``test_delete_one_evidence_on_a_real_graph_store`` repeats the same assertions
against a real Neo4j. Its value is pinning the server-side behaviour — ``DETACH
DELETE`` and the implicit edge detach — on the engine production uses, not being
the only case that would notice a wrong statement: the local backend also
refuses deleting a node that still has relationships, so the local cases fail
too if the route drops ``DETACH``. It needs
``SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J`` plus ``..._TEST_NEO4J_PASSWORD`` and
skips otherwise; no CI job in this repository starts a graph store, so it runs
only where an operator points it at one.
"""

from __future__ import annotations

import importlib
import os
import uuid

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))
from fastapi.testclient import TestClient

_HEADERS = {"authorization": "Bearer test-token"}
needs_neo4j = pytest.mark.science_tags(status="external")


def _real_neo4j_config() -> tuple[str, str] | None:
    """A reachable Neo4j only: the local-backend sentinel does not count."""
    http_uri = os.environ.get("SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J")
    password = os.environ.get("SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J_PASSWORD")
    if http_uri and http_uri != "local" and password:
        return http_uri, password
    return None


def _configured_graph_client(monkeypatch: pytest.MonkeyPatch, http_uri: str, password: str) -> TestClient:
    if http_uri == "local":
        monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_BACKEND", "local")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_ENABLED", "1")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test-token")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP", http_uri)
    from sciencediscovery_memory_graph import backend, neo4j_driver, persistence, query, server

    importlib.reload(neo4j_driver)
    monkeypatch.setattr(backend, "_router", None)
    importlib.reload(persistence)
    importlib.reload(query)
    importlib.reload(server)
    server.handle().set_password(password)
    if not server.handle().is_reachable():
        pytest.fail("configured graph backend not reachable")
    if http_uri != "local":
        # Mirror the real boot path (/internal/neo4j-password), as test_smoke's
        # helper does, so the composite (artifact_id, version) constraint holds.
        from sciencediscovery_memory_graph.constraints import ensure_schema

        ensure_schema()
    return TestClient(server.app)


@pytest.fixture()
def live_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The same sidecar wired to a real Neo4j; skipped when none is configured."""
    config = _real_neo4j_config()
    if config is None:
        pytest.skip("needs a live Neo4j (SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J)")
    http_uri, password = config
    return _configured_graph_client(monkeypatch, http_uri, password)


@pytest.fixture()
def local_client(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    """The sidecar on its Neo4j-free JSONL backend, one store per test."""
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_TEST_BACKEND", "local")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_DATA_DIR", str(tmp_path / "graph"))
    return _configured_graph_client(monkeypatch, "local", "")


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """A sidecar with no Neo4j password: every graph route degrades."""
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_ENABLED", "1")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test-token")
    from sciencediscovery_memory_graph import backend, neo4j_driver, persistence, query, server

    importlib.reload(neo4j_driver)
    monkeypatch.setattr(backend, "_router", None)
    importlib.reload(persistence)
    importlib.reload(query)
    importlib.reload(server)
    return TestClient(server.app)


def _create(client: TestClient, label: str, **props: object) -> None:
    """Seed one node through the local Cypher surface (fixture setup only)."""
    from sciencediscovery_memory_graph.backend import handle

    assignments = ", ".join(f"{key}: ${key}" for key in props)
    with handle().session() as session:
        session.run(f"CREATE (:{label} {{{assignments}}})", **props)


def _link(client: TestClient, source: str, source_key: str, source_id: str,
          edge: str, target: str, target_key: str, target_id: str) -> None:
    from sciencediscovery_memory_graph.backend import handle

    with handle().session() as session:
        session.run(
            f"MATCH (a:{source} {{{source_key}: $source_id}}), "
            f"(b:{target} {{{target_key}: $target_id}}) "
            f"CREATE (a)-[:{edge}]->(b)",
            source_id=source_id,
            target_id=target_id,
        )


def _hits(client: TestClient, label: str, session_id: str) -> list[dict[str, object]]:
    response = client.post(
        "/query/by-node-type",
        json={"node_types": [label], "session_id": session_id},
        headers=_HEADERS,
    )
    assert response.status_code == 200, response.text
    return response.json()["hits"]


def test_delete_one_evidence_keeps_the_rest_of_both_sessions(local_client: TestClient) -> None:
    evidence = "2026-01-01T00:00:00Z"
    _create(local_client, "SourceFile", file_id="sf-1", session_id="s1", name="paper.pdf", created_at=evidence)
    _create(local_client, "Evidence", evidence_id="e-1", session_id="s1", content="delete me", created_at=evidence)
    _create(local_client, "Evidence", evidence_id="e-2", session_id="s1", content="keep me", created_at=evidence)
    _create(local_client, "Claim", claim_id="c-1", session_id="s1", content="keep the claim", created_at=evidence)
    _create(local_client, "Evidence", evidence_id="e-other", session_id="s2", content="other session", created_at=evidence)
    _link(local_client, "SourceFile", "file_id", "sf-1", "extracts", "Evidence", "evidence_id", "e-1")
    _link(local_client, "Evidence", "evidence_id", "e-1", "supports", "Claim", "claim_id", "c-1")
    _link(local_client, "Evidence", "evidence_id", "e-2", "supports", "Claim", "claim_id", "c-1")

    deleted = local_client.post(
        "/delete/node",
        json={"node_type": "Evidence", "node_id": "e-1", "session_id": "s1"},
        headers=_HEADERS,
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"status": "healthy", "deleted": 1}

    assert [hit["id"] for hit in _hits(local_client, "Evidence", "s1")] == ["e-2"]
    assert [hit["id"] for hit in _hits(local_client, "Claim", "s1")] == ["c-1"]
    assert [hit["id"] for hit in _hits(local_client, "SourceFile", "s1")] == ["sf-1"]
    assert [hit["id"] for hit in _hits(local_client, "Evidence", "s2")] == ["e-other"]

    supports = local_client.post(
        "/query/by-edge-type",
        json={"edge_types": ["supports"], "session_id": "s1"},
        headers=_HEADERS,
    ).json()["edges"]
    assert supports == [{"type": "supports", "source": "e-2", "target": "c-1", "extra": {}}]
    extracts = local_client.post(
        "/query/by-edge-type",
        json={"edge_types": ["extracts"], "session_id": "s1"},
        headers=_HEADERS,
    ).json()["edges"]
    assert extracts == [], "the deleted Evidence's incoming edge is gone too"


def test_delete_unknown_or_forbidden_targets_is_an_explicit_refusal(local_client: TestClient) -> None:
    _create(local_client, "Evidence", evidence_id="e-1", session_id="s1", content="keep", created_at="2026-01-01")

    missing = local_client.post(
        "/delete/node",
        json={"node_type": "Evidence", "node_id": "absent", "session_id": "s1"},
        headers=_HEADERS,
    )
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "node_not_found"

    wrong_session = local_client.post(
        "/delete/node",
        json={"node_type": "Evidence", "node_id": "e-1", "session_id": "s2"},
        headers=_HEADERS,
    )
    assert wrong_session.status_code == 404, "the session scope must not fall through"

    refused = local_client.post(
        "/delete/node",
        json={"node_type": "Claim", "node_id": "e-1", "session_id": "s1"},
        headers=_HEADERS,
    )
    assert refused.status_code == 400
    assert refused.json()["detail"]["code"] == "node_type_not_deletable"

    blank = local_client.post(
        "/delete/node",
        json={"node_type": "Evidence", "node_id": "   "},
        headers=_HEADERS,
    )
    assert blank.status_code == 400

    assert local_client.post(
        "/delete/node",
        json={"node_type": "Evidence", "node_id": "e-1"},
    ).status_code == 401
    assert [hit["id"] for hit in _hits(local_client, "Evidence", "s1")] == ["e-1"]


def test_delete_degrades_without_neo4j(client: TestClient) -> None:
    response = client.post(
        "/delete/node",
        json={"node_type": "Evidence", "node_id": "e-1", "session_id": "s1"},
        headers=_HEADERS,
    )
    assert response.status_code == 200
    assert response.json() == {
        "status": "degraded",
        "reason": "memory_graph_unreachable",
        "deleted": 0,
    }


def test_cleanup_session_still_soft_marks_artifacts_and_deletes_private_nodes(local_client: TestClient) -> None:
    _create(local_client, "Evidence", evidence_id="e-clean", session_id="s-clean", content="gone", created_at="2026-01-01")
    _create(local_client, "Claim", claim_id="c-clean", session_id="s-clean", content="gone too", created_at="2026-01-01")
    _create(local_client, "Artifact", artifact_id="a-clean", version=1, session_id="s-clean", created_at="2026-01-01")

    cleaned = local_client.post("/cleanup/session", json={"session_id": "s-clean"}, headers=_HEADERS)
    assert cleaned.status_code == 200, cleaned.text
    assert cleaned.json()["status"] == "healthy"
    assert cleaned.json()["marked"] == 1
    assert cleaned.json()["deleted"] == 2

    from sciencediscovery_memory_graph.backend import handle

    with handle().session() as session:
        assert session.run(
            "MATCH (e:Evidence {evidence_id: 'e-clean'}) RETURN count(e) AS n"
        ).single()["n"] == 0
        artifact = session.run(
            "MATCH (a:Artifact {artifact_id: 'a-clean'}) RETURN a.deleted_session AS marked"
        ).single()
    assert artifact is not None and artifact["marked"] is True
    assert _hits(local_client, "Artifact", "s-clean") == [], "reads still hide soft-marked versions"


def _raw_count(cypher: str, **params: object) -> int:
    from sciencediscovery_memory_graph.backend import handle

    with handle().session() as session:
        return session.run(cypher, **params).single()["n"]


@needs_neo4j
def test_delete_one_evidence_on_a_real_graph_store(live_client: TestClient) -> None:
    """The same single-record contract, executed by a real Neo4j.

    ``DETACH DELETE`` and the implicit edge detach are server-side behaviour the
    local JSONL backend only emulates, so one live case pins them. Neo4j is
    shared between runs here: every session and record id below is unique.
    """
    run = str(uuid.uuid4())
    evidence = "2026-01-01T00:00:00Z"
    sid, other = f"s-del-{run}", f"s-del-other-{run}"
    target, kept, claim_id = f"e-del-{run}", f"e-keep-{run}", f"c-keep-{run}"
    file_id, other_id = f"sf-{run}", f"e-other-{run}"
    _create(live_client, "SourceFile", file_id=file_id, session_id=sid, name="paper.pdf", created_at=evidence)
    _create(live_client, "Evidence", evidence_id=target, session_id=sid, content="delete me", created_at=evidence)
    _create(live_client, "Evidence", evidence_id=kept, session_id=sid, content="keep me", created_at=evidence)
    _create(live_client, "Claim", claim_id=claim_id, session_id=sid, content="keep the claim", created_at=evidence)
    _create(live_client, "Evidence", evidence_id=other_id, session_id=other, content="other session", created_at=evidence)
    _link(live_client, "SourceFile", "file_id", file_id, "extracts", "Evidence", "evidence_id", target)
    _link(live_client, "Evidence", "evidence_id", target, "supports", "Claim", "claim_id", claim_id)
    _link(live_client, "Evidence", "evidence_id", kept, "supports", "Claim", "claim_id", claim_id)

    deleted = live_client.post(
        "/delete/node",
        json={"node_type": "Evidence", "node_id": target, "session_id": sid},
        headers=_HEADERS,
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"status": "healthy", "deleted": 1}

    assert _raw_count("MATCH (e:Evidence {evidence_id: $id}) RETURN count(e) AS n", id=target) == 0
    assert [hit["id"] for hit in _hits(live_client, "Evidence", sid)] == [kept]
    assert [hit["id"] for hit in _hits(live_client, "Claim", sid)] == [claim_id]
    assert [hit["id"] for hit in _hits(live_client, "SourceFile", sid)] == [file_id]
    assert [hit["id"] for hit in _hits(live_client, "Evidence", other)] == [other_id]

    supports = live_client.post(
        "/query/by-edge-type",
        json={"edge_types": ["supports"], "session_id": sid},
        headers=_HEADERS,
    ).json()["edges"]
    assert supports == [{"type": "supports", "source": kept, "target": claim_id, "extra": {}}]
    extracts = live_client.post(
        "/query/by-edge-type",
        json={"edge_types": ["extracts"], "session_id": sid},
        headers=_HEADERS,
    ).json()["edges"]
    assert extracts == [], "the deleted Evidence's incoming edge is gone from the real store"
    assert _raw_count(
        "MATCH (:Evidence {evidence_id: $id})-[r]->() RETURN count(r) AS n", id=target
    ) == 0

    again = live_client.post(
        "/delete/node",
        json={"node_type": "Evidence", "node_id": target, "session_id": sid},
        headers=_HEADERS,
    )
    assert again.status_code == 404
    assert again.json()["detail"]["code"] == "node_not_found"
