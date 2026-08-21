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

"""Smoke tests for the memory-graph service.

These exercise the FastAPI routes without a real Neo4j (the ``Neo4jHandle``
reports no-password → degraded, exactly the lazy-degrade contract). A real
end-to-end round-trip is covered manually by the success screen in the plan.
Tests that need a live Neo4j (idempotency / orphan-chain linking) are guarded
by ``needs_neo4j`` and skipped unless the operator points the suite at a
running Neo4j via ``SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J=http://...`` plus a
password.
"""

from __future__ import annotations

import importlib
import os

import pytest
from fastapi.testclient import TestClient


def _live_neo4j_config() -> tuple[str, str] | None:
    """Return (http_uri, password) when an integration Neo4j is configured."""
    http_uri = os.environ.get("SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J")
    password = os.environ.get("SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J_PASSWORD")
    if http_uri and password:
        return http_uri, password
    return None


needs_neo4j = pytest.mark.skipif(
    _live_neo4j_config() is None,
    reason="needs a live Neo4j (set SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J + ..._PASSWORD)",
)


def _wipe_session(session_id: str) -> None:
    """Delete every node belonging to a session (and its relationships).

    Live Neo4j tests share one database and re-run repeatedly during
    development; without a wipe, re-runs accumulate stale Claim/Artifact nodes
    (Claim is never deduped — each declare CREATEs a fresh uuid) and assertions
    like ``len(cites) == 1`` break on the residue. Called at the top of each
    live test on its own (unique) session id.
    """
    from sciencediscovery_memory_graph.neo4j_driver import handle
    if not handle().is_reachable():
        return
    with handle().session() as s:
        s.run("MATCH (n) WHERE n.session_id = $sid DETACH DELETE n", sid=session_id).consume()


@pytest.fixture()
def live_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """A client wired to a real Neo4j (for idempotency / chain-link tests).

    Skipped at collection when no integration Neo4j is configured.
    """
    cfg = _live_neo4j_config()
    if cfg is None:
        pytest.skip("needs a live Neo4j")
    http_uri, password = cfg
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_ENABLED", "1")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test-token")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP", http_uri)
    from sciencediscovery_memory_graph import neo4j_driver, persistence, query, server
    from sciencediscovery_memory_graph.constraints import ensure_schema

    importlib.reload(neo4j_driver)
    importlib.reload(persistence)
    importlib.reload(query)
    importlib.reload(server)
    server.handle().set_password(password)
    if not server.handle().is_reachable():
        pytest.skip("configured Neo4j not reachable")
    # Mirror the real boot path: /internal/neo4j-password runs ensure_schema
    # after set_password, so the composite (artifact_id, version) constraint is
    # in place and any legacy artifact_id-only constraint is dropped before
    # tests write versioned Artifact nodes.
    ensure_schema()
    return TestClient(server.app)


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_ENABLED", "1")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test-token")
    # Reload the driver module so the singleton picks up the env (no password
    # set → has_password is False → degraded branch).
    from sciencediscovery_memory_graph import neo4j_driver, persistence, query, server

    importlib.reload(neo4j_driver)
    importlib.reload(persistence)
    importlib.reload(query)
    importlib.reload(server)
    return TestClient(server.app)


def test_health_needs_password(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] in {"needs-password", "degraded"}


def test_observe_execution_degrades_without_neo4j(client: TestClient) -> None:
    payload = {
        "execution_id": "exec-1",
        "session_id": "sess-1",
        "turn_id": "turn-1",
        "tool": "run_python",
        "language": "python",
        "code_hash": "deadbeef",
        "exit_code": 0,
        "status": "succeeded",
        "started_at": "2026-07-26T00:00:00Z",
        "finished_at": "2026-07-26T00:00:01Z",
        "produced_artifacts": [
            {"artifact_id": "art-1", "path": "out.png", "version": 1, "media_type": "image/png"}
        ],
    }
    response = client.post(
        "/observe/execution",
        json=payload,
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["written"] == 0


def test_produced_artifact_model_preserves_input_artifact_versions() -> None:
    """Regression guard: the ``input_artifact_versions`` field MUST survive
    Pydantic validation — otherwise the Node-side POST body carries it but the
    sidecar silently drops it (Pydantic v2 default extra="ignore"), model_dump()
    omits it, and upsert_execution never builds the ``input`` edge. That made
    derived-from a no-op in production while looking healthy (the live
    ``test_input_edge_and_artifact_provenance_round_trip`` was the only thing
    that would have caught it, and it is Neo4j-gated). This unit test needs no
    Neo4j. See docs/memory-graph-provenance-fields-impl.md §0.1.
    """
    from sciencediscovery_memory_graph.server import ProducedArtifact

    # Field present → survives into model_dump (the dict upsert_execution sees).
    pa = ProducedArtifact(
        artifact_id="art-1",
        input_artifact_versions=[{"artifact_id": "art-0", "version": 1}],
    )
    dump = pa.model_dump()
    assert dump.get("input_artifact_versions") == [{"artifact_id": "art-0", "version": 1}]

    # Field absent → None (upsert_execution's ``or []`` falls back to no-op loop).
    assert ProducedArtifact(artifact_id="art-2").model_dump()["input_artifact_versions"] is None


def test_subgraph_returns_unreachable_reason(client: TestClient) -> None:
    # With no Neo4j reachable (no password set in the fixture), the read
    # path degrades and reports memory_graph_unreachable so the frontend can
    # render a degraded notice rather than erroring.
    response = client.get(
        "/subgraph",
        params={"session_id": "sess-1"},
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["nodes"] == []
    assert body["edges"] == []
    assert body["reason"] == "memory_graph_unreachable"


def test_observe_execution_rejects_missing_token(client: TestClient) -> None:
    # With a token configured, requests without it must 401.
    response = client.post(
        "/observe/execution",
        json={
            "execution_id": "exec-2",
            "session_id": "sess-2",
            "turn_id": "turn-2",
            "tool": "run_python",
            "language": "python",
            "code_hash": "x",
            "exit_code": 0,
            "status": "succeeded",
            "started_at": "2026-07-26T00:00:00Z",
            "finished_at": "2026-07-26T00:00:01Z",
        },
        # no auth header
    )
    assert response.status_code == 401


def test_observe_mcp_search_degrades_without_neo4j(client: TestClient) -> None:
    payload = {
        "invocation_id": "inv-1",
        "session_id": "sess-1",
        "turn_id": "turn-1",
        "source": "europe-pmc",
        "tool_type": "search",
        "retrieved_at": "2026-07-26T00:00:00Z",
        "records": [
            {"url": "https://europepmc.org/article/MED/123", "title": "TP53 in lung cancer",
             "identifier": "123", "identifierType": "PMID", "year": "2023", "source": "europe-pmc"},
            {"url": "https://europepmc.org/article/MED/456", "title": "Another paper",
             "identifier": "456", "identifierType": "PMID", "year": "2024", "source": "europe-pmc"},
        ],
    }
    response = client.post(
        "/observe/mcp-search",
        json=payload,
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["written"] == 0


def test_observe_mcp_search_rejects_missing_token(client: TestClient) -> None:
    response = client.post(
        "/observe/mcp-search",
        json={
            "invocation_id": "inv-2",
            "session_id": "sess-2",
            "turn_id": "turn-2",
            "source_id": "europe-pmc",
            "tool_id": "search",
            "retrieved_at": "2026-07-26T00:00:00Z",
            "records": [],
        },
        # no auth header
    )
    assert response.status_code == 401


def test_normalize_link_collapses_same_paper_variants() -> None:
    """All of these are the same Paper and must MERGE to one node."""
    from sciencediscovery_memory_graph.persistence import _normalize_link

    # http vs https, trailing slash, query, fragment, case — all collapse.
    assert _normalize_link("http://europepmc.org/article/MED/123") == \
           _normalize_link("https://europepmc.org/article/MED/123/")
    assert _normalize_link("https://europepmc.org/article/MED/123") == \
           _normalize_link("HTTPS://europePmc.org/article/MED/123#abstract")
    assert _normalize_link("https://europepmc.org/article/MED/123") == \
           _normalize_link("https://europepmc.org/article/MED/123?utm_source=feed&page=2")
    # Bare DOI merges with its doi.org URL form.
    assert _normalize_link("10.1038/s41586-024-12345-6") == \
           _normalize_link("https://doi.org/10.1038/s41586-024-12345-6")
    assert _normalize_link("doi:10.1038/s41586-024-12345-6") == \
           _normalize_link("https://doi.org/10.1038/s41586-024-12345-6")
    # Empty / whitespace stays empty (record dropped).
    assert _normalize_link("   ") == ""


# --- observeSessionFirstMessage (ResearchGoal fallback) ---------------------

def test_observe_session_first_message_degrades_without_neo4j(client: TestClient) -> None:
    response = client.post(
        "/observe/session-first-message",
        json={
            "session_id": "sess-goal-1",
            "goal_id": "goal:session:sess-goal-1",
            "core_objective": "帮我研究 TP53 在肺癌中的突变频率",
            "domain": "Biology",
            "topic_scope": [],
            "created_at": "2026-07-27T00:00:00Z",
        },
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["written"] == 0


def test_observe_session_first_message_rejects_missing_token(client: TestClient) -> None:
    response = client.post(
        "/observe/session-first-message",
        json={
            "session_id": "sess-goal-2",
            "goal_id": "goal:session:sess-goal-2",
            "core_objective": "analyze sales.csv",
            "created_at": "2026-07-27T00:00:00Z",
        },
        # no auth header
    )
    assert response.status_code == 401


# --- observeSessionPlanProposed (SubTask DAG mirror) ------------------------

def test_observe_session_plan_degrades_without_neo4j(client: TestClient) -> None:
    response = client.post(
        "/observe/session-plan",
        json={
            "session_id": "sess-plan-1",
            "goal_id": "goal:session:sess-plan-1",
            "plan_id": "plan-1",
            "scope": "TP53 突变频率研究",
            "domain": "Biology",
            "steps": [
                {"id": "s1", "description": "检索 TP53 肺癌文献"},
                {"id": "s2", "description": "整合为综合摘要"},
            ],
        },
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["written"] == 0
    assert body["goal_corrected"] is False


def test_observe_session_plan_rejects_missing_token(client: TestClient) -> None:
    response = client.post(
        "/observe/session-plan",
        json={
            "session_id": "sess-plan-2",
            "goal_id": "goal:session:sess-plan-2",
            "plan_id": "plan-2",
            "scope": "x",
            "steps": [],
        },
        # no auth header
    )
    assert response.status_code == 401


# --- declare_evidence / declare_claim -------------------------------------

def test_persist_evidence_degrades_without_neo4j(client: TestClient) -> None:
    response = client.post(
        "/persist/evidence",
        json={
            "content": "TP53 mutation frequency ~8-12%",
            "source_paper_link": "https://europepmc.org/article/MED/123",
            "locator": "abstract",
            "evidence_type": "QUOTE",
            "confidence": "HIGH",
            "strength": "MODERATE",
            "session_id": "sess-ev-1",
        },
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["evidence_id"] is None


def test_persist_evidence_rejects_missing_token(client: TestClient) -> None:
    response = client.post("/persist/evidence", json={
        "content": "x", "source_paper_link": "https://x.test/1", "locator": "abstract",
        "evidence_type": "QUOTE", "confidence": "HIGH", "strength": "MODERATE", "session_id": "s",
    })
    assert response.status_code == 401


def test_persist_claim_no_cites_returns_422(client: TestClient) -> None:
    # A claim with no cites must be rejected with the no_cites_target code
    # before any Cypher runs (degraded branch is skipped by the guard order).
    # The detail carries an actionable instruction the LLM can follow.
    response = client.post(
        "/persist/claim",
        json={
            "content": "unsupported claim",
            "claim_type": "STATISTICAL",
            "confidence": "HIGH",
            "locator": "abstract",
            "cites_evidence_aliases": {},
            "cites_artifact_aliases": {},
            "session_id": "sess-cl-1",
        },
        headers={"authorization": "Bearer test-token"},
    )
    # The no_cites_target guard fires before the degraded branch.
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "no_cites_target"
    assert "instruction" in detail


def test_persist_claim_artifact_alias_passes_cite_guard(client: TestClient) -> None:
    # A code-execution finding cited only via cites_artifact_aliases (no paper,
    # no evidence) must pass the no_cites_target guard and reach the degraded
    # branch — the alias→artifact_id path is a first-class cite, not a no-op.
    response = client.post(
        "/persist/claim",
        json={
            "content": "dose-response curve peaks near 50 µM",
            "claim_type": "STATISTICAL",
            "confidence": "HIGH",
            "locator": "fig1",
            "cites_evidence_aliases": {},
            "cites_artifact_aliases": {"fig1": "art-abc-123"},
            "session_id": "sess-cl-art",
        },
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["claim_id"] is None


def test_persist_claim_accepts_artifact_versions_and_report_version(client: TestClient) -> None:
    # The new cites_artifact_versions (alias→version) and artifact_version
    # (report version, stated_in target) fields are accepted by the request
    # model and do not trip the no_cites_target guard; the degraded branch runs
    # and returns no claim. Verifies the version-pinning extension is wired
    # without a live Neo4j.
    response = client.post(
        "/persist/claim",
        json={
            "content": "dose-response curve peaks near 50 µM",
            "claim_type": "STATISTICAL",
            "confidence": "HIGH",
            "locator": "fig1",
            "cites_evidence_aliases": {},
            "cites_artifact_aliases": {"fig1": "art-abc-123"},
            "cites_artifact_versions": {"fig1": 1},
            "artifact_id": "art-report-1",
            "artifact_version": 2,
            "session_id": "sess-cl-ver",
        },
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["claim_id"] is None


def test_persist_stated_in_requires_artifact_version(client: TestClient) -> None:
    # LinkClaimsRequest now requires artifact_version (composite key pins
    # stated_in to the report's exact version); omitting it is a 422, not a
    # silent 200.
    response = client.post(
        "/persist/stated_in",
        json={
            "artifact_id": "art-report-1",
            "claim_ids": ["cl-1"],
            "session_id": "sess-stated-in-1",
        },
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 422


def test_persist_claim_degrades_with_cites(client: TestClient) -> None:
    # With cites present, the degraded branch runs (Neo4j unreachable). A
    # Claim cites Evidence now (not Paper directly), so a cite is an evidence
    # alias / node id.
    response = client.post(
        "/persist/claim",
        json={
            "content": "TP53 frequency ~8-12%",
            "claim_type": "STATISTICAL",
            "confidence": "HIGH",
            "locator": "abstract",
            "cites_evidence_aliases": {"ev1": "ev-id-1"},
            "session_id": "sess-cl-2",
        },
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["claim_id"] is None


def test_persist_claim_rejects_missing_token(client: TestClient) -> None:
    response = client.post("/persist/claim", json={
        "content": "x", "claim_type": "STATISTICAL", "confidence": "HIGH", "locator": "a",
        "cites_evidence_aliases": {"ev1": "ev-1"}, "session_id": "s",
    })
    assert response.status_code == 401


# --- cleanup/session + cleanup/project (degraded + token guards) ----------

def test_cleanup_session_degrades_without_neo4j(client: TestClient) -> None:
    """With no reachable Neo4j the cleanup endpoint returns degraded (the
    store deletion on the Node side has already committed; the orphan graph
    state stays but the HTTP deletion response is unaffected)."""
    response = client.post(
        "/cleanup/session",
        json={"session_id": "sess-cleanup"},
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["reason"] == "memory_graph_unreachable"
    assert body["marked"] == 0 and body["deleted"] == 0


def test_cleanup_project_degrades_without_neo4j(client: TestClient) -> None:
    response = client.post(
        "/cleanup/project",
        json={"project_id": "proj-cleanup", "session_ids": ["s1", "s2"]},
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["reason"] == "memory_graph_unreachable"
    assert body["deleted"] == 0


def test_cleanup_project_accepts_empty_session_ids(client: TestClient) -> None:
    """A project with no sessions is a no-op (UNWIND over an empty list)."""
    response = client.post(
        "/cleanup/project",
        json={"project_id": "proj-empty", "session_ids": []},
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "degraded"  # unreachable short-circuits


def test_cleanup_session_rejects_missing_token(client: TestClient) -> None:
    assert client.post("/cleanup/session", json={"session_id": "s"}).status_code == 401


def test_cleanup_project_rejects_missing_token(client: TestClient) -> None:
    assert client.post("/cleanup/project",
                       json={"project_id": "p", "session_ids": []}).status_code == 401


# --- existence-checked cite targets (need a live graph to probe) -----------

@needs_neo4j
def test_persist_claim_evidence_not_found_returns_422(live_client: TestClient) -> None:
    # An evidence_id that was never declared must 422 with an actionable
    # instruction (re-call declare_evidence), not silently drop the cite.
    response = live_client.post("/persist/claim", json={
        "content": "x", "claim_type": "STATISTICAL", "confidence": "HIGH", "locator": "a",
        "cites_evidence_aliases": {"ev1": "never-declared-ev-id"}, "session_id": "sess-evnf",
    }, headers={"authorization": "Bearer test-token"})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "evidence_not_found"
    assert "declare_evidence" in detail["instruction"]


@needs_neo4j
def test_persist_claim_artifact_version_not_found_returns_422(live_client: TestClient) -> None:
    # An artifact_id/version pair that was never mirrored must 422 with an
    # actionable instruction (call list_artifacts), not silently drop the cite.
    response = live_client.post("/persist/claim", json={
        "content": "x", "claim_type": "STATISTICAL", "confidence": "HIGH", "locator": "a",
        "cites_artifact_aliases": {"a1": "never-mirrored-art-id"},
        "cites_artifact_versions": {"a1": 1},
        "session_id": "sess-artnf",
    }, headers={"authorization": "Bearer test-token"})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "artifact_version_not_found"
    assert "list_artifacts" in detail["instruction"]


# --- live-Neo4j integration (idempotency / orphan-chain linking) -----------

@needs_neo4j
def test_goal_id_deterministic_dedup(live_client: TestClient) -> None:
    """Re-sending the first message of a session stays one ResearchGoal."""
    payload = {
        "session_id": "sess-dedup",
        "goal_id": "goal:session:sess-dedup",
        "core_objective": "research TP53",
        "domain": "Biology",
        "topic_scope": [],
        "created_at": "2026-07-27T00:00:00Z",
    }
    r1 = live_client.post("/observe/session-first-message", json=payload,
                          headers={"authorization": "Bearer test-token"})
    r2 = live_client.post("/observe/session-first-message", json=payload,
                          headers={"authorization": "Bearer test-token"})
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["written"] == 1
    # Second send must hit the existing goal (MERGE) — no new node written.
    assert r2.json()["written"] == 1
    sub = live_client.get("/subgraph", params={"session_id": "sess-dedup"},
                          headers={"authorization": "Bearer test-token"}).json()
    goals = [n for n in sub["nodes"] if n["label"] == "ResearchGoal"]
    assert len(goals) == 1


@needs_neo4j
def test_plan_corrects_goal_and_writes_no_skeleton_subtasks(live_client: TestClient) -> None:
    """A recorded plan corrects the ResearchGoal from plan.scope and does NOT
    write a step-skeleton SubTask chain (the framework doesn't advance step
    status, so a skeleton would stay PENDING and clutter the graph)."""
    headers = {"authorization": "Bearer test-token"}
    # First seed the goal from a first-message fallback (wrong domain).
    live_client.post("/observe/session-first-message", json={
        "session_id": "sess-mirror",
        "goal_id": "goal:session:sess-mirror",
        "core_objective": "analyze sales.csv",
        "domain": "DataAnalysis",
        "topic_scope": [],
        "created_at": "2026-07-28T00:00:00Z",
    }, headers=headers)
    payload = {
        "session_id": "sess-mirror",
        "goal_id": "goal:session:sess-mirror",
        "plan_id": "plan-mirror-1",
        "scope": "TP53 study",
        "domain": "Biology",
        "steps": [
            {"id": "m1", "description": "search literature"},
            {"id": "m2", "description": "summarize"},
        ],
    }
    live_client.post("/observe/session-plan", json=payload, headers=headers)
    live_client.post("/observe/session-plan", json=payload, headers=headers)
    sub = live_client.get("/subgraph", params={"session_id": "sess-mirror"},
                          headers=headers).json()
    # No plan-derived SubTask skeletons written.
    subtasks = [n for n in sub["nodes"] if n["label"] == "SubTask"]
    assert subtasks == []
    # Goal corrected: core_objective overwritten by plan.scope, domain by plan,
    # method tagged corrected_by_plan (added once, not piled up by re-mirror).
    goal = next(n for n in sub["nodes"] if n["label"] == "ResearchGoal")
    extra = goal["extra"]
    assert extra["core_objective"] == "TP53 study"
    assert extra["domain"] == "Biology"
    assert extra["method"].count("corrected_by_plan") == 1


@needs_neo4j
def test_temporal_chain_only_links_orphans(live_client: TestClient) -> None:
    """A plan-linked SubTask is not re-linked by the temporal chain."""
    headers = {"authorization": "Bearer test-token"}
    # Two executions → two auto-inferred SubTasks; the upsert also runs the
    # temporal-chain linker, which should connect them by finish time.
    for i in (1, 2):
        live_client.post(
            "/observe/execution",
            json={
                "execution_id": f"exec-orphan-{i}",
                "session_id": "sess-orphan",
                "turn_id": f"turn-{i}",
                "tool": "run_python",
                "language": "python",
                "code_hash": f"hash-{i}",
                "exit_code": 0,
                "status": "succeeded",
                "started_at": "2026-07-27T00:00:00Z",
                "finished_at": f"2026-07-27T00:00:0{i}Z",
                "produced_artifacts": [],
            },
            headers=headers,
        )
    sub = live_client.get("/subgraph", params={"session_id": "sess-orphan"},
                          headers=headers).json()
    next_edges = [e for e in sub["edges"] if e["type"] == "next"]
    # Exactly one next edge between the two execution SubTasks (idempotent —
    # no duplicate edges even though the linker ran on both upserts).
    assert len(next_edges) == 1
    assert (next_edges[0].get("extra") or {}).get("method") == "temporal_chain"


@needs_neo4j
def test_artifact_versions_keep_both_nodes_and_supersedes(live_client: TestClient) -> None:
    """Two versions of one artifact coexist as separate Artifact nodes linked
    by a ``supersedes`` edge (new→old); logical_name is mirrored."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-ver"
    _wipe_session(sid)
    # v1, then v2 of the same artifact_id (a re-run that overwrites the file).
    for v in (1, 2):
        live_client.post(
            "/observe/execution",
            json={
                "execution_id": f"exec-ver-{v}",
                "session_id": sid,
                "turn_id": f"turn-ver-{v}",
                "tool": "run_python",
                "language": "python",
                "code_hash": f"hash-ver-{v}",
                "exit_code": 0,
                "status": "succeeded",
                "started_at": f"2026-07-30T00:00:0{v}Z",
                "finished_at": f"2026-07-30T00:00:0{v}Z",
                "produced_artifacts": [{
                    "artifact_id": "art-squares",
                    "path": "squares.csv",
                    "logical_name": "squares.csv",
                    "version": v,
                    "media_type": "text/csv",
                }],
            },
            headers=headers,
        )
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    arts = [n for n in sub["nodes"] if n["label"] == "Artifact"]
    # Both versions survive as separate nodes (composite key); v1 is NOT
    # clobbered by v2.
    assert len(arts) == 2
    # The two Artifact nodes must have DISTINCT node ids — _node_identity
    # encodes the version (artifact_id#vN). A bare artifact_id would collide,
    # the frontend's id-keyed node set would drop one, and only one Artifact
    # would render (the regression this guards against).
    assert arts[0]["id"] != arts[1]["id"]
    assert all("#v" in a["id"] for a in arts)
    by_ver = {n["extra"]["version"]: n for n in arts}
    assert set(by_ver) == {1, 2}
    assert by_ver[1]["extra"]["logical_name"] == "squares.csv"
    assert by_ver[2]["extra"]["logical_name"] == "squares.csv"
    # supersedes: v2 → v1, endpoints are the version-encoded node ids.
    sup = [e for e in sub["edges"] if e["type"] == "supersedes"]
    assert len(sup) == 1
    assert sup[0]["source"] == by_ver[2]["id"]
    assert sup[0]["target"] == by_ver[1]["id"]


@needs_neo4j
def test_cites_and_states_pin_to_specific_version(live_client: TestClient) -> None:
    """supports and stated_in edges land on the exact version declared, not
    the latest (which would drift as the product is regenerated)."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-cite"
    _wipe_session(sid)
    # Two versions of a figure artifact, cited as v1.
    for v in (1, 2):
        live_client.post(
            "/observe/execution",
            json={
                "execution_id": f"exec-cite-{v}",
                "session_id": sid,
                "turn_id": f"turn-cite-{v}",
                "tool": "run_python",
                "language": "python",
                "code_hash": f"hash-cite-{v}",
                "exit_code": 0,
                "status": "succeeded",
                "started_at": f"2026-07-30T00:00:0{v}Z",
                "finished_at": f"2026-07-30T00:00:0{v}Z",
                "produced_artifacts": [{
                    "artifact_id": "art-fig",
                    "path": "fig.svg",
                    "logical_name": "fig.svg",
                    "version": v,
                    "media_type": "image/svg+xml",
                }],
            },
            headers=headers,
        )
    # Declare a claim citing fig v1 (explicit version), stated in a report
    # artifact v2 (stated_in target = report v2).
    claim = live_client.post("/persist/claim", json={
        "content": "curve peaks at 50 µM",
        "claim_type": "STATISTICAL",
        "confidence": "HIGH",
        "locator": "fig1",
        "cites_artifact_aliases": {"fig1": "art-fig"},
        "cites_artifact_versions": {"fig1": 1},
        "artifact_id": "art-report",
        "artifact_version": 2,
        "session_id": sid,
    }, headers=headers).json()
    assert claim["status"] == "ok"
    # The report artifact version must be mirrored first for stated_in to attach.
    live_client.post("/observe/execution", json={
        "execution_id": "exec-report",
        "session_id": sid,
        "turn_id": "turn-report",
        "tool": "run_python",
        "language": "python",
        "code_hash": "hash-report",
        "exit_code": 0,
        "status": "succeeded",
        "started_at": "2026-07-30T00:00:03Z",
        "finished_at": "2026-07-30T00:00:03Z",
        "produced_artifacts": [{
            "artifact_id": "art-report",
            "path": "report.md",
            "logical_name": "report.md",
            "version": 2,
            "media_type": "text/markdown",
        }],
    }, headers=headers)
    live_client.post("/persist/stated_in", json={
        "artifact_id": "art-report",
        "artifact_version": 2,
        "claim_ids": [claim["claim_id"]],
        "session_id": sid,
    }, headers=headers)
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    arts = {n["extra"]["artifact_id"]: n for n in sub["nodes"] if n["label"] == "Artifact"}
    fig_v1 = next(n for n in sub["nodes"] if n["label"] == "Artifact"
                  and n["extra"]["artifact_id"] == "art-fig" and n["extra"]["version"] == 1)
    report_v2 = next(n for n in sub["nodes"] if n["label"] == "Artifact"
                     and n["extra"]["artifact_id"] == "art-report" and n["extra"]["version"] == 2)
    # supports: fig v1 (NOT v2) is the edge source — supports runs Artifact →
    # Claim, so the cited figure is the source.
    sup = [e for e in sub["edges"] if e["type"] == "supports" and e["source"] == fig_v1["id"]]
    assert len(sup) == 1, "supports must be anchored to fig v1 (the cited version)"
    # stated_in → report v2. stated_in runs Claim → Artifact, so the report is
    # the edge target.
    stated = [e for e in sub["edges"] if e["type"] == "stated_in" and e["target"] == report_v2["id"]]
    assert len(stated) == 1, "stated_in must be anchored to report v2"


@needs_neo4j
def test_get_chain_pins_artifact_version(live_client: TestClient) -> None:
    """get_chain resolves an Artifact source by (artifact_id, version): an
    explicit version hits that node; no version defaults to the latest."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-chain"
    _wipe_session(sid)
    for v in (1, 2):
        live_client.post("/observe/execution", json={
            "execution_id": f"exec-chain-{v}",
            "session_id": sid,
            "turn_id": f"turn-chain-{v}",
            "tool": "run_python",
            "language": "python",
            "code_hash": f"hash-chain-{v}",
            "exit_code": 0,
            "status": "succeeded",
            "started_at": f"2026-07-30T00:00:0{v}Z",
            "finished_at": f"2026-07-30T00:00:0{v}Z",
            "produced_artifacts": [{
                "artifact_id": "art-chain",
                "path": "out.csv",
                "logical_name": "out.csv",
                "version": v,
                "media_type": "text/csv",
            }],
        }, headers=headers)
    # Explicit v1: chain source is the v1 node.
    chain_v1 = live_client.post("/query/chain", json={
        "node_id": "art-chain", "session_id": sid, "version": 1,
    }, headers=headers).json()
    src_v1 = next(n for n in chain_v1["nodes"] if n["label"] == "Artifact")
    assert src_v1["extra"]["version"] == 1
    # No version: defaults to latest (v2).
    chain_latest = live_client.post("/query/chain", json={
        "node_id": "art-chain", "session_id": sid,
    }, headers=headers).json()
    src_latest = next(n for n in chain_latest["nodes"] if n["label"] == "Artifact")
    assert src_latest["extra"]["version"] == 2


@needs_neo4j
def test_get_chain_accepts_version_encoded_node_id(live_client: TestClient) -> None:
    """The frontend passes the subgraph node id (``<artifact_id>#v<N>``) as
    get_chain's node_id; the chain source must resolve to that version."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-chain-enc"
    _wipe_session(sid)
    for v in (1, 2):
        live_client.post("/observe/execution", json={
            "execution_id": f"exec-ce-{v}", "session_id": sid,
            "turn_id": f"turn-ce-{v}", "tool": "run_python", "language": "python",
            "code_hash": f"hash-ce-{v}", "exit_code": 0, "status": "succeeded",
            "started_at": f"2026-07-30T00:00:0{v}Z", "finished_at": f"2026-07-30T00:00:0{v}Z",
            "produced_artifacts": [{
                "artifact_id": "art-ce", "path": "ce.csv", "logical_name": "ce.csv",
                "version": v, "media_type": "text/csv",
            }],
        }, headers=headers)
    # node_id carries #v1 (as the frontend would pass from the subgraph).
    chain = live_client.post("/query/chain", json={
        "node_id": "art-ce#v1", "session_id": sid,
    }, headers=headers).json()
    src = next(n for n in chain["nodes"] if n["label"] == "Artifact")
    assert src["extra"]["version"] == 1


@needs_neo4j
def test_legacy_artifact_id_constraint_dropped(live_client: TestClient) -> None:
    """A pre-existing artifact_id-only unique constraint is dropped at boot so
    v2 writes do not 500 (the same hazard Paper's link-only constraint had)."""
    headers = {"authorization": "Bearer test-token"}
    _wipe_session("sess-leg")
    from sciencediscovery_memory_graph.constraints import ensure_schema
    from sciencediscovery_memory_graph.neo4j_driver import handle

    # This test exercises a schema-level invariant (legacy single-field
    # constraint is dropped at boot), which requires the Artifact label to be
    # free of any duplicate artifact_id values: creating a single-field unique
    # constraint fails outright if ANY two Artifact nodes share an artifact_id,
    # even across other sessions on this shared Neo4j. NOTE: dropping the
    # composite (artifact_id, version) constraint does NOT make this legal —
    # it only stops enforcing the pair; the data still has two nodes sharing
    # one artifact_id, so a single-field ``artifact_id IS UNIQUE`` constraint
    # still rejects them at creation.
    #
    # Test artifacts use fixed non-UUID ids (art-leg/art-ce/...) while real runs
    # use randomUUID() — so deleting only the non-UUID artifact_id nodes clears
    # exactly the test residue (which is what carries duplicate ids) without
    # touching real sessions' UUID-keyed Artifact nodes. The UUID regex matches
    # the 8-4-4-4-12 hex form randomUUID() produces.
    with handle().session() as s:
        s.run(
            "MATCH (a:Artifact) "
            "WHERE NOT a.artifact_id =~ $uuid "
            "DETACH DELETE a",
            uuid=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        ).consume()

    def _constraint_names(properties: list[str]) -> list[str]:
        with handle().session() as s:
            return [
                rec["name"]
                for rec in s.run(
                    "SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties, entityType "
                    "WHERE entityType = 'NODE' AND 'Artifact' IN labelsOrTypes "
                    "AND properties = $props RETURN name",
                    props=properties,
                )
            ]

    with handle().session() as s:
        # Collapse multi-version Artifact nodes: keep the max version per
        # artifact_id, delete the rest (with their edges) so no two Artifact
        # nodes share an artifact_id — the legacy single-field unique
        # constraint can then be created.
        s.run(
            """
            MATCH (a:Artifact)
            WITH a.artifact_id AS aid, max(a.version) AS keep
            MATCH (d:Artifact {artifact_id: aid}) WHERE d.version <> keep
            DETACH DELETE d
            """
        ).consume()

    # Schema modification (DROP/CREATE CONSTRAINT) must run in its own
    # transaction — Neo4j forbids schema ops in a transaction that already
    # ran a data write (ForbiddenDueToTransactionType).
    with handle().session() as s:
        # Drop the composite (artifact_id, version) constraint so ensure_schema
        # is the one that restores it (exercising the drop-legacy path).
        for name in _constraint_names(["artifact_id", "version"]):
            s.run(f"DROP CONSTRAINT `{name}`").consume()
        s.run("CREATE CONSTRAINT IF NOT EXISTS FOR (n:Artifact) REQUIRE n.artifact_id IS UNIQUE").consume()
    ensure_schema()
    # Now writing v2 must succeed (not 500 from colliding with the legacy
    # single-field constraint).
    for v in (1, 2):
        r = live_client.post("/observe/execution", json={
            "execution_id": f"exec-leg-{v}",
            "session_id": "sess-leg",
            "turn_id": f"turn-leg-{v}",
            "tool": "run_python",
            "language": "python",
            "code_hash": f"hash-leg-{v}",
            "exit_code": 0,
            "status": "succeeded",
            "started_at": f"2026-07-30T00:00:0{v}Z",
            "finished_at": f"2026-07-30T00:00:0{v}Z",
            "produced_artifacts": [{
                "artifact_id": "art-leg",
                "path": "leg.csv",
                "logical_name": "leg.csv",
                "version": v,
                "media_type": "text/csv",
            }],
        }, headers=headers)
        assert r.status_code == 200
        assert r.json()["status"] == "healthy"
    # Verify the legacy single-field constraint is gone (only the composite
    # (artifact_id, version) uniqueness remains on Artifact).
    with handle().session() as s:
        legacy = s.run(
            "SHOW CONSTRAINTS YIELD labelsOrTypes, properties, entityType "
            "WHERE entityType = 'NODE' AND 'Artifact' IN labelsOrTypes "
            "AND properties = ['artifact_id'] "
            "RETURN count(*) AS c"
        ).single()["c"]
        assert legacy == 0


def test_artifact_provenance_degrades_without_neo4j(client: TestClient) -> None:
    """Without a reachable Neo4j the new endpoint returns empty dependencies
    + a ``memory_graph_unreachable`` reason (the defensive contract the
    frontend's non-empty-overrides rule relies on)."""
    response = client.get(
        "/query/artifact-provenance",
        params={"artifact_id": "art-1", "version": 1, "session_id": "sess-1"},
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["dependencies"] == []
    assert body["reason"] == "memory_graph_unreachable"


def test_artifact_provenance_validates_params(client: TestClient) -> None:
    """artifact_id must be non-empty and version a positive integer (FastAPI
    Query constraints surface as 422)."""
    headers = {"authorization": "Bearer test-token"}
    assert client.get("/query/artifact-provenance",
                      params={"artifact_id": "", "version": 1},
                      headers=headers).status_code == 422
    assert client.get("/query/artifact-provenance",
                      params={"artifact_id": "art-1", "version": 0},
                      headers=headers).status_code == 422
    # Missing version entirely.
    assert client.get("/query/artifact-provenance",
                      params={"artifact_id": "art-1"},
                      headers=headers).status_code == 422


@needs_neo4j
def test_input_edge_and_artifact_provenance_round_trip(live_client: TestClient) -> None:
    """The derived-from chain end-to-end: an execution that reads squares.csv
    v1 and produces plot.svg v1 builds ``(squares v1) -[:input]-> (Code)
    -[:produces]-> (plot v1)``; the aggregation endpoint returns the input as
    a dependency; the subgraph whitelist surfaces the ``input`` edge."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-derived"
    _wipe_session(sid)
    # First register the input artifact version (squares.csv v1) by observing
    # an execution that produces it (no inputs of its own).
    live_client.post("/observe/execution", json={
        "execution_id": "exec-df-squares",
        "session_id": sid,
        "turn_id": "turn-df-squares",
        "tool": "run_python",
        "language": "python",
        "code_hash": "hash-df-squares",
        "exit_code": 0,
        "status": "succeeded",
        "started_at": "2026-08-01T00:00:00Z",
        "finished_at": "2026-08-01T00:00:01Z",
        "produced_artifacts": [{
            "artifact_id": "art-df-squares",
            "path": "squares.csv",
            "logical_name": "squares.csv",
            "version": 1,
            "media_type": "text/csv",
        }],
    }, headers=headers)
    # Then the consuming execution: produces plot.svg v1 AND declares it read
    # squares.csv v1 as an input (composite-key pair, not UUID).
    #
    # NOTE: artifact_id and execution_id use a "df-" prefix unique to this test.
    # The live Neo4j suite shares one database and re-runs; other tests (e.g.
    # test_artifact_versions_keep_both_nodes_and_supersedes, sid=sess-ver) also
    # use "art-squares". MERGE on the composite key (artifact_id, version) does
    # NOT include session_id, so reusing an id across sessions re-uses the other
    # test's node WITHOUT updating its session_id — then this test's endpoint
    # query filters by session_id and filters the input node out → dependencies
    # come back empty even though the input edge exists. A unique id sidesteps it.
    live_client.post("/observe/execution", json={
        "execution_id": "exec-df-plot",
        "session_id": sid,
        "turn_id": "turn-df-plot",
        "tool": "run_python",
        "language": "python",
        "code_hash": "hash-df-plot",
        "exit_code": 0,
        "status": "succeeded",
        "started_at": "2026-08-01T00:00:02Z",
        "finished_at": "2026-08-01T00:00:03Z",
        "produced_artifacts": [{
            "artifact_id": "art-df-plot",
            "path": "plot.svg",
            "logical_name": "plot.svg",
            "version": 1,
            "media_type": "image/svg+xml",
            "input_artifact_versions": [{"artifact_id": "art-df-squares", "version": 1}],
        }],
    }, headers=headers)

    # The aggregation endpoint returns squares.csv v1 as a dependency of plot.svg v1.
    prov = live_client.get("/query/artifact-provenance",
                            params={"artifact_id": "art-df-plot", "version": 1, "session_id": sid},
                            headers=headers).json()
    assert prov["logical_name"] == "plot.svg"
    assert len(prov["dependencies"]) == 1
    dep = prov["dependencies"][0]
    assert dep["artifact_id"] == "art-df-squares"
    assert dep["version"] == 1
    assert dep["logical_name"] == "squares.csv"
    assert "reason" not in prov

    # The subgraph surfaces the ``input`` edge (whitelist update) alongside produces.
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    edge_types = {e["type"] for e in sub["edges"]}
    assert "input" in edge_types
    assert "produces" in edge_types
    # The input edge runs Artifact(squares v1) → Code(exec-df-plot). Node ids
    # follow _node_identity: Artifact = "<artifact_id>#v<version>", Code = code_id.
    code_plot = "exec-df-plot"
    squares_v1 = "art-df-squares#v1"
    inputs = [e for e in sub["edges"] if e["type"] == "input"]
    assert len(inputs) == 1
    assert inputs[0]["source"] == squares_v1
    assert inputs[0]["target"] == code_plot


@needs_neo4j
def test_artifact_provenance_empty_when_no_input_edge(live_client: TestClient) -> None:
    """A version produced by a Code that read no inputs returns empty
    dependencies with no reason — the frontend keeps the legacy endpoint's
    dependencies rather than blanking the row."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-no-input"
    _wipe_session(sid)
    live_client.post("/observe/execution", json={
        "execution_id": "exec-solo",
        "session_id": sid,
        "turn_id": "turn-solo",
        "tool": "run_python",
        "language": "python",
        "code_hash": "hash-solo",
        "exit_code": 0,
        "status": "succeeded",
        "started_at": "2026-08-01T00:00:00Z",
        "finished_at": "2026-08-01T00:00:01Z",
        "produced_artifacts": [{
            "artifact_id": "art-solo",
            "path": "solo.csv",
            "logical_name": "solo.csv",
            "version": 1,
            "media_type": "text/csv",
            # No input_artifact_versions — the run read no other artifacts.
        }],
    }, headers=headers)
    prov = live_client.get("/query/artifact-provenance",
                            params={"artifact_id": "art-solo", "version": 1, "session_id": sid},
                            headers=headers).json()
    assert prov["dependencies"] == []
    assert "reason" not in prov
# --- trace_provenance ------------------------------------------------------
#
# The degraded-path and validation tests run without Neo4j (the `client`
# fixture): the 400 checks fire before any Cypher runs, and the degraded
# branch returns broken:true + memory_graph_unreachable before locating the
# start node. The 404 (start_node_not_found) and the intact/broken/truncated
# chain paths need a live graph and live under `needs_neo4j` below.

_HEADERS = {"authorization": "Bearer test-token"}


def test_trace_degrades_without_neo4j(client: TestClient) -> None:
    # Same degraded contract as /subgraph: no Neo4j → broken:true + reason,
    # never a 500, so the reviewer / frontend degrades instead of erroring.
    response = client.post(
        "/trace/provenance",
        json={"node_id": "art-1"},
        headers=_HEADERS,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["broken"] is True
    assert body["chain"] == []
    assert body["start_node"] is None
    assert body["reason"] == "memory_graph_unreachable"


def test_trace_rejects_missing_token(client: TestClient) -> None:
    response = client.post("/trace/provenance", json={"node_id": "art-1"})
    assert response.status_code == 401


def test_trace_rejects_empty_node_id(client: TestClient) -> None:
    response = client.post(
        "/trace/provenance", json={"node_id": "  "}, headers=_HEADERS,
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "bad_request"


def test_trace_rejects_bad_target_label(client: TestClient) -> None:
    response = client.post(
        "/trace/provenance",
        json={"node_id": "art-1", "target_label": "WishfulThinking"},
        headers=_HEADERS,
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "bad_request"


def test_trace_rejects_bad_max_hops(client: TestClient) -> None:
    response = client.post(
        "/trace/provenance", json={"node_id": "art-1", "max_hops": 99},
        headers=_HEADERS,
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "bad_request"


@needs_neo4j
def test_observe_execution_mirrors_provenance_fields(live_client: TestClient) -> None:
    """The five provenance fields' addressing info lands on the right nodes:
    Code mirrors stdout_hash/stderr_hash/env_hash/turn_id; SubTask mirrors
    turn_id (messages routing key — manifest_ids would race manifest
    persistence at mirror time); each Artifact version node mirrors turn_id +
    content_hash. No content blobs are stored — only hashes / routing keys."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-prov"
    _wipe_session(sid)
    live_client.post(
        "/observe/execution",
        json={
            "execution_id": "exec-prov",
            "session_id": sid,
            "turn_id": "turn-prov",
            "tool": "run_python",
            "language": "python",
            "code_hash": "code-hash-prov",
            "exit_code": 0,
            "status": "succeeded",
            "started_at": "2026-07-30T00:00:00Z",
            "finished_at": "2026-07-30T00:00:01Z",
            "stdout_hash": "stdout-hash-prov",
            "stderr_hash": "stderr-hash-prov",
            "env_hash": "env-hash-prov",
            "produced_artifacts": [{
                "artifact_id": "art-prov",
                "path": "result.csv",
                "logical_name": "result.csv",
                "version": 1,
                "media_type": "text/csv",
                "turn_id": "turn-prov",
                "content_hash": "content-hash-prov",
            }],
        },
        headers=headers,
    )
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    code = next(n for n in sub["nodes"] if n["label"] == "Code")
    assert code["extra"]["stdout_hash"] == "stdout-hash-prov"
    assert code["extra"]["stderr_hash"] == "stderr-hash-prov"
    assert code["extra"]["env_hash"] == "env-hash-prov"
    assert code["extra"]["turn_id"] == "turn-prov"
    st = next(n for n in sub["nodes"] if n["label"] == "SubTask")
    assert st["extra"]["turn_id"] == "turn-prov"
    art = next(n for n in sub["nodes"] if n["label"] == "Artifact")
    assert art["extra"]["turn_id"] == "turn-prov"
    assert art["extra"]["content_hash"] == "content-hash-prov"
    # No content blobs on any node — only addressing info (graph = directory).
    # code_id is the Code node's business key (executionId), not content; the
    # other *_hash / turn_id fields are addressing info.
    content_keys = {"code", "stdout", "stderr", "packages", "abstract", "content"}
    for n in sub["nodes"]:
        for key in n["extra"]:
            assert key not in content_keys, \
                f"unexpected content field {key} on {n['label']}"


@needs_neo4j
def test_artifact_provenance_endpoint_returns_addressing(live_client: TestClient) -> None:
    """GET /query/artifact-provenance returns the five fields' addressing info
    + dependencies in one call, pinned to the version node. No content blobs."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-agg"
    _wipe_session(sid)
    live_client.post(
        "/observe/execution",
        json={
            "execution_id": "exec-agg",
            "session_id": sid,
            "turn_id": "turn-agg",
            "tool": "run_python",
            "language": "python",
            "code_hash": "code-hash-agg",
            "exit_code": 0,
            "status": "succeeded",
            "started_at": "2026-07-30T00:00:00Z",
            "finished_at": "2026-07-30T00:00:01Z",
            "stdout_hash": "stdout-hash-agg",
            "stderr_hash": "stderr-hash-agg",
            "env_hash": "env-hash-agg",
            "produced_artifacts": [{
                "artifact_id": "art-agg",
                "path": "out.csv",
                "logical_name": "out.csv",
                "version": 1,
                "media_type": "text/csv",
                "turn_id": "turn-agg",
                "content_hash": "content-hash-agg",
            }],
        },
        headers=headers,
    )
    r = live_client.get(
        "/query/artifact-provenance",
        params={"artifact_id": "art-agg", "version": 1},
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["artifact_id"] == "art-agg"
    assert body["version"] == 1
    assert body["content_hash"] == "content-hash-agg"
    assert body["turn_id"] == "turn-agg"
    assert body["code_hash"] == "code-hash-agg"
    assert body["stdout_hash"] == "stdout-hash-agg"
    assert body["stderr_hash"] == "stderr-hash-agg"
    assert body["env_hash"] == "env-hash-agg"
    # messages_turn_id is the producing SubTask's turn_id (messages routing key).
    assert body["messages_turn_id"] == "turn-agg"
    assert body["dependencies"] == []  # input edge not landed (derived-from)
    # A missing version returns 200 with empty dependencies + a node_not_found
    # reason (the frontend's non-empty-overrides rule keeps it on the legacy
    # endpoint instead of erroring).
    r_missing = live_client.get(
        "/query/artifact-provenance",
        params={"artifact_id": "art-agg", "version": 99},
        headers=headers,
    )
    assert r_missing.status_code == 200
    assert r_missing.json()["reason"] == "node_not_found"


@needs_neo4j
def test_get_chain_artifact_kind_centered_on_selected_node(live_client: TestClient) -> None:
    """chain_kind='artifact' is centered on the selected node itself — it does
    NOT anchor on the session report. The chain walks the selected node's own
    citation entry (Paper → extracts → Evidence → supports → Claim → …) plus
    its produces/input derivation; a sibling citation branch that the selected
    node does not reference is structurally unreachable and stays out.

    Topology (one session, two Paper branches converging on one report):
        paper-A -extracts-> ev-A -supports-> claim-A -stated_in-> report
        paper-B -extracts-> ev-B -supports-> claim-B -stated_in-> report
    Selecting paper-A must keep paper-A's own branch (paper-A / ev-A) and drop
    paper-B's fork entirely — not by pruning to an anchor path, but because the
    artifact chain walks from paper-A's center and never crosses to paper-B.
    """
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-artchain"
    _wipe_session(sid)
    # Seed two Papers (with URLs so the mirror keeps them) via one mcp-search.
    live_client.post("/observe/mcp-search", json={
        "invocation_id": "search-ac", "session_id": sid, "turn_id": "turn-ac",
        "source": "pubmed", "tool_type": "search", "retrieved_at": "2026-08-09T00:00:00Z",
        "records": [
            {"url": "https://x.test/paper-A", "title": "paper A"},
            {"url": "https://x.test/paper-B", "title": "paper B"},
        ],
    }, headers=headers)
    # Mirror the report artifact (two versions — v2 is the anchor as the max).
    # Artifact is keyed on the composite (artifact_id, version) with a GLOBAL
    # uniqueness constraint (not session-scoped), so other tests' ``art-report``
    # vN would silently MERGE-hit this one and the session_id would never land
    # here — use a session-unique artifact_id to avoid the collision.
    AC_REPORT = "art-report-ac"
    for v in (1, 2):
        live_client.post("/observe/execution", json={
            "execution_id": f"exec-report-{v}", "session_id": sid,
            "turn_id": f"turn-report-{v}", "tool": "run_python", "language": "python",
            "code_hash": f"hash-report-{v}", "exit_code": 0, "status": "succeeded",
            "started_at": f"2026-08-09T00:00:0{v}Z", "finished_at": f"2026-08-09T00:00:0{v}Z",
            "produced_artifacts": [{
                "artifact_id": AC_REPORT, "path": "report.md",
                "logical_name": "report.md", "version": v, "media_type": "text/markdown",
            }],
        }, headers=headers)
    # Declare an Evidence extracted from each Paper, then a Claim citing that
    # Evidence, stated_in report v2. The graph stores Paper links
    # lowercased (see persistence._normalize_link), so seed + look up the
    # lowercased form.
    paper_links = {"A": "https://x.test/paper-a", "B": "https://x.test/paper-b"}
    claim_ids: dict[str, str] = {}
    evidence_ids: dict[str, str] = {}
    for tag, link in paper_links.items():
        ev = live_client.post("/persist/evidence", json={
            "content": f"evidence {tag}", "source_paper_link": link,
            "locator": "abstract", "evidence_type": "QUOTE",
            "confidence": "HIGH", "strength": "MODERATE", "session_id": sid,
        }, headers=headers).json()
        assert ev["status"] == "ok", ev
        evidence_ids[tag] = ev["evidence_id"]
        claim = live_client.post("/persist/claim", json={
            "content": f"claim {tag}", "claim_type": "STATISTICAL",
            "confidence": "HIGH", "locator": tag,
            "cites_evidence_aliases": {"ev1": ev["evidence_id"]},
            "artifact_id": AC_REPORT, "artifact_version": 2,
            "session_id": sid,
        }, headers=headers).json()
        assert claim["status"] == "ok", claim
        claim_ids[tag] = claim["claim_id"]
    # Link both claims to report v2 via stated_in.
    live_client.post("/persist/stated_in", json={
        "artifact_id": AC_REPORT, "artifact_version": 2,
        "claim_ids": list(claim_ids.values()), "session_id": sid,
    }, headers=headers)
    # Resolve paper-A's graph id (the chain's node_id must be the graph id).
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    paper_a = next(n for n in sub["nodes"] if n["label"] == "Paper"
                  and n["extra"].get("link") == "https://x.test/paper-a")
    paper_b = next(n for n in sub["nodes"] if n["label"] == "Paper"
                  and n["extra"].get("link") == "https://x.test/paper-b")

    # chain_kind=artifact, selected node = paper-A: the chain is centered on
    # paper-A. paper-A's own Evidence (extracts out — Paper → Evidence) is
    # walked as the citation entry; paper-B sits on a sibling fork the walk
    # never crosses, so it (and its Evidence/Claim) stays out.
    art_chain = live_client.post("/query/chain", json={
        "node_id": paper_a["id"], "session_id": sid, "chain_kind": "artifact",
    }, headers=headers).json()
    art_ids = {n["id"] for n in art_chain["nodes"]}
    assert paper_a["id"] in art_ids, "selected node (the chain's center) must be present"
    assert paper_b["id"] not in art_ids, \
        "sibling Paper branch is unreachable from the selected node's center"
    # The Evidence/Claim on paper-B's fork must also be gone. extracts runs
    # Paper → Evidence, so paper-B is the edge source and its Evidence the
    # target (the inverse of the old extracted_from direction).
    ev_b = next(n for n in sub["nodes"] if n["label"] == "Evidence"
                and any(e["type"] == "extracts" and e["source"] == paper_b["id"]
                        and e["target"] == n["id"] for e in sub["edges"]))
    assert ev_b["id"] not in art_ids, "sibling Evidence must be absent"

    # --- Edge-direction verification: the rename+flip must orient each edge
    # source→target exactly. A rename that forgot to flip direction would
    # pass the node-presence asserts above (the same nodes appear either way)
    # but fail here, because source/target swap. This is the only place that
    # catches "renamed the edge but left it pointing the old way".
    report_v2 = next(n for n in sub["nodes"] if n["label"] == "Artifact"
                     and n["extra"]["artifact_id"] == AC_REPORT
                     and n["extra"]["version"] == 2)
    ev_a = next(n for n in sub["nodes"] if n["label"] == "Evidence"
                and n["id"] == evidence_ids["A"])
    claim_a = next(n for n in sub["nodes"] if n["label"] == "Claim"
                   and n["id"] == claim_ids["A"])
    # The artifact chain must surface paper-A's whole branch (Evidence + Claim
    # + report) so the edges below render — guard before asserting on edges.
    assert ev_a["id"] in art_ids, "paper-A's Evidence must be in its artifact chain"
    assert claim_a["id"] in art_ids, "paper-A's Claim must be in its artifact chain"
    assert report_v2["id"] in art_ids, "the report Artifact must be in paper-A's artifact chain"

    ac_edges = art_chain["edges"]
    # extracts: Paper → Evidence (Paper is source). Reaching paper-A's Evidence
    # from paper-A walks extracts *out*.
    ext = [e for e in ac_edges if e["type"] == "extracts"
           and e["source"] == paper_a["id"] and e["target"] == ev_a["id"]]
    assert len(ext) == 1, "extracts must point Paper → Evidence (Paper is source)"
    # supports: Evidence → Claim (Evidence is source). supports is walked *out*
    # from the Evidence just reached.
    sup = [e for e in ac_edges if e["type"] == "supports"
           and e["source"] == ev_a["id"] and e["target"] == claim_a["id"]]
    assert len(sup) == 1, "supports must point Evidence → Claim (Evidence is source)"
    # stated_in: Claim → report Artifact (Claim is source, report is target).
    stated = [e for e in ac_edges if e["type"] == "stated_in"
              and e["source"] == claim_a["id"] and e["target"] == report_v2["id"]]
    assert len(stated) == 1, "stated_in must point Claim → report Artifact"
    # Negative: the old edge names must not survive the rename anywhere in the
    # chain's edges (guards against a half-finished rename leaving both).
    assert not any(e["type"] in ("extracted_from", "cites", "states")
                   for e in ac_edges), "old edge names must not appear in the chain"

    # chain_kind=full (default), same selected node: full is the legacy
    # directional hop-walk from the source. From paper_a it reaches paper_a's
    # own Evidence (extracts in — walking against Paper → Evidence), the
    # producing SubTask + next-chain SubTasks/Goal (produces in + next in/out).
    # It does NOT cross to paper_b — paper_b sits on a sibling citation fork
    # reached only through the report's stated_in→Claim→supports→Evidence path,
    # which the full hops don't walk. So paper_b's absence here is structural,
    # not the result of pruning.
    full_chain = live_client.post("/query/chain", json={
        "node_id": paper_a["id"], "session_id": sid,
    }, headers=headers).json()
    full_ids = {n["id"] for n in full_chain["nodes"]}
    assert paper_a["id"] in full_ids, "selected node present in full chain"
    assert paper_b["id"] not in full_ids, \
        "paper_b's fork is unreachable from paper_a via the full hops"
    # paper_a's Evidence is on paper_a's own fork — full reaches it.
    ev_a = next(n for n in sub["nodes"] if n["label"] == "Evidence"
                and any(e["type"] == "extracts" and e["source"] == paper_a["id"]
                        and e["target"] == n["id"] for e in sub["edges"]))
    assert ev_a["id"] in full_ids, "paper_a's Evidence is on its own fork, full reaches it"


@needs_neo4j
def test_get_chain_artifact_kind_no_report_anchor_walks_centered_chain(live_client: TestClient) -> None:
    """chain_kind='artifact' is centered on the selected node itself — it does
    NOT depend on a session report anchor (no Claim-[:stated_in]->Artifact needed).
    An intermediate Paper produced mid-session (before any report exists) still
    resolves its own upstream tail (Paper <-[:produces]- SubTask), so "view
    artifact chain" works at any time, not only after a report is declared."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-noanchor"
    _wipe_session(sid)
    # Seed one Paper via mcp-search but NO report artifact / no stated_in edge —
    # there is no report anchor in this session at all.
    live_client.post("/observe/mcp-search", json={
        "invocation_id": "search-na", "session_id": sid, "turn_id": "turn-na",
        "source": "pubmed", "tool_type": "search", "retrieved_at": "2026-08-09T00:00:00Z",
        "records": [{"url": "https://x.test/paper-na", "title": "paper NA"}],
    }, headers=headers)
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    paper = next(n for n in sub["nodes"] if n["label"] == "Paper")
    chain = live_client.post("/query/chain", json={
        "node_id": paper["id"], "session_id": sid, "chain_kind": "artifact",
    }, headers=headers).json()
    # No anchor → the chain is NOT empty: the Paper's own upstream tail (the
    # SubTask that produced it via mcp-search) is still walked from the center.
    ids = {n["id"] for n in chain["nodes"]}
    assert paper["id"] in ids, "the selected Paper (the chain's center) must be present"
    labels = {n["label"] for n in chain["nodes"]}
    assert "SubTask" in labels, "the Paper's producing SubTask must be in the upstream tail"


@needs_neo4j
def test_get_chain_artifact_kind_anchor_itself_walks_own_derivation(live_client: TestClient) -> None:
    """Selecting a report Artifact ITSELF walks that Artifact's own produces/
    input derivation chain (Artifact <-[:produces]- Code <-[:input]- ...) AND
    its citation downstream (stated_in→Claim→supports→Evidence→extracts→Paper),
    both centered on the selected node. A reviewer sees the report's references
    alongside the inputs that produced it. Regression guard for the case where
    clicking a report Artifact's "view artifact chain" surfaced only
    the Artifact itself (anchor-centric collapse).
    """
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-anchor"
    _wipe_session(sid)
    # Two report versions; v2 is the report anchor (highest version with
    # stated_in→Claim). Session-unique artifact_id so the global (artifact_id,
    # version) uniqueness constraint doesn't MERGE-hit another test's report.
    ANC_REPORT = "art-report-anc"
    for v in (1, 2):
        live_client.post("/observe/execution", json={
            "execution_id": f"exec-anc-{v}", "session_id": sid,
            "turn_id": f"turn-anc-{v}", "tool": "run_python", "language": "python",
            "code_hash": f"hash-anc-{v}", "exit_code": 0, "status": "succeeded",
            "started_at": f"2026-08-09T00:00:0{v}Z", "finished_at": f"2026-08-09T00:00:0{v}Z",
            "produced_artifacts": [{
                "artifact_id": ANC_REPORT, "path": "report.md",
                "logical_name": "report.md", "version": v, "media_type": "text/markdown",
            }],
        }, headers=headers)
    live_client.post("/observe/mcp-search", json={
        "invocation_id": "search-anc", "session_id": sid, "turn_id": "turn-anc-s",
        "source": "pubmed", "tool_type": "search", "retrieved_at": "2026-08-09T00:00:00Z",
        "records": [{"url": "https://x.test/paper-anc", "title": "paper anc"}],
    }, headers=headers)
    ev = live_client.post("/persist/evidence", json={
        "content": "ev anc", "source_paper_link": "https://x.test/paper-anc",
        "locator": "abstract", "evidence_type": "QUOTE",
        "confidence": "HIGH", "strength": "MODERATE", "session_id": sid,
    }, headers=headers).json()
    claim = live_client.post("/persist/claim", json={
        "content": "claim anc", "claim_type": "STATISTICAL",
        "confidence": "HIGH", "locator": "c1",
        "cites_evidence_aliases": {"ev1": ev["evidence_id"]},
        "artifact_id": ANC_REPORT, "artifact_version": 2, "session_id": sid,
    }, headers=headers).json()
    live_client.post("/persist/stated_in", json={
        "artifact_id": ANC_REPORT, "artifact_version": 2,
        "claim_ids": [claim["claim_id"]], "session_id": sid,
    }, headers=headers)
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    report_v2 = next(n for n in sub["nodes"] if n["label"] == "Artifact"
                     and n["extra"]["artifact_id"] == ANC_REPORT
                     and n["extra"]["version"] == 2)
    # Selecting the report Artifact itself: the artifact chain is centered on
    # it, walking its own produces/input derivation (the Code that produced the
    # report, reached via <-[:produces]-) AND its citation downstream (the
    # Claims stated_in it, the Evidence/Artifacts those Claims cite, the Papers
    # the Evidence was extracted from). Both relationships belong on the
    # report's chain — a reviewer sees the report's references alongside the
    # inputs that produced it.
    chain = live_client.post("/query/chain", json={
        "node_id": report_v2["id"], "session_id": sid, "chain_kind": "artifact",
    }, headers=headers).json()
    ids = {n["id"] for n in chain["nodes"]}
    assert report_v2["id"] in ids, "the selected Artifact (the chain's center) must be present"
    labels = {n["label"] for n in chain["nodes"]}
    assert "Code" in labels, "the report's producing Code must be reached via <-[:produces]-"
    assert "Claim" in labels, "states→Claim: the report's cited Claims must appear"
    assert "Evidence" in labels, "supports→Evidence: the Evidence the Claims cite must appear"
    assert "Paper" in labels, "extracts→Paper: the source Papers must appear"


@needs_neo4j
def test_get_chain_artifact_kind_severed_paper_drops_orphan_anchor(live_client: TestClient) -> None:
    """An UNcited Paper (no Evidence/Claim path back to the report) is a severed
    source: it is NOT reachable from the report anchor via the artifact hops.
    The report anchor must NOT appear as an isolated orphan node in that chain —
    only the Paper itself plus its upstream task tail (Paper <-produces- SubTask)
    survives. Regression guard for the case where an uncited Paper's "view artifact
    chain" surfaced an isolated report Artifact that had no edges to anything else.
    """
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-orphan-paper"
    _wipe_session(sid)
    # Report anchor (stated_in->Claim) so there IS an anchor in the session — the
    # Paper below is severed from it precisely because nothing cites it. The
    # anchor's Claim must cite at least one target (a Claim with no cites is
    # rejected 422), so seed a SEPARATE cited Paper/Evidence for the anchor's
    # claim, and keep the orphan Paper itself uncited.
    ORP_REPORT = "art-report-orp"
    live_client.post("/observe/execution", json={
        "execution_id": "exec-orp-report", "session_id": sid,
        "turn_id": "turn-orp-report", "tool": "run_python", "language": "python",
        "code_hash": "hash-orp-report", "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-09T00:00:01Z", "finished_at": "2026-08-09T00:00:01Z",
        "produced_artifacts": [{
            "artifact_id": ORP_REPORT, "path": "report.md",
            "logical_name": "report.md", "version": 1, "media_type": "text/markdown",
        }],
    }, headers=headers)
    # A cited Paper the anchor's claim cites — distinct from the orphan Paper.
    live_client.post("/observe/mcp-search", json={
        "invocation_id": "search-cite", "session_id": sid, "turn_id": "turn-cite-s",
        "source": "pubmed", "tool_type": "search", "retrieved_at": "2026-08-09T00:00:00Z",
        "records": [{"url": "https://x.test/paper-cite", "title": "cite paper"}],
    }, headers=headers)
    ev = live_client.post("/persist/evidence", json={
        "content": "ev cite", "source_paper_link": "https://x.test/paper-cite",
        "locator": "abstract", "evidence_type": "QUOTE",
        "confidence": "HIGH", "strength": "MODERATE", "session_id": sid,
    }, headers=headers).json()
    claim = live_client.post("/persist/claim", json={
        "content": "claim orp", "claim_type": "STATISTICAL",
        "confidence": "HIGH", "locator": "c1",
        "cites_evidence_aliases": {"ev1": ev["evidence_id"]},
        "artifact_id": ORP_REPORT, "artifact_version": 1, "session_id": sid,
    }, headers=headers).json()
    live_client.post("/persist/stated_in", json={
        "artifact_id": ORP_REPORT, "artifact_version": 1,
        "claim_ids": [claim["claim_id"]], "session_id": sid,
    }, headers=headers)
    # The ORPHAN Paper — produced by a SubTask via mcp-search, but no Evidence
    # extracts from it (Paper→Evidence) and no Claim cites it, so it has no path back to the
    # report anchor (it is severed).
    live_client.post("/observe/mcp-search", json={
        "invocation_id": "search-orp", "session_id": sid, "turn_id": "turn-orp-s",
        "source": "pubmed", "tool_type": "search", "retrieved_at": "2026-08-09T00:00:00Z",
        "records": [{"url": "https://x.test/paper-orp", "title": "paper orphan"}],
    }, headers=headers)
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    paper = next(n for n in sub["nodes"] if n["label"] == "Paper"
                 and n["extra"].get("link") == "https://x.test/paper-orp")
    report = next(n for n in sub["nodes"] if n["label"] == "Artifact"
                 and n["extra"]["artifact_id"] == ORP_REPORT)

    chain = live_client.post("/query/chain", json={
        "node_id": paper["id"], "session_id": sid, "chain_kind": "artifact",
    }, headers=headers).json()
    ids = {n["id"] for n in chain["nodes"]}
    assert paper["id"] in ids, "severed Paper itself must be present"
    assert report["id"] not in ids, \
        "report anchor must NOT appear as an orphan in an uncited Paper's chain"
    # The Paper's upstream task tail must still be there — it reaches the
    # SubTask that produced it. (Reaching the ResearchGoal depends on the
    # `next` chain, which this minimal seed does not build; the real session
    # does, but the orphan-anchor guard does not hinge on it.)
    labels = {n["label"] for n in chain["nodes"]}
    assert "SubTask" in labels, "the Paper's producing SubTask must be in the tail"


@needs_neo4j
def test_get_chain_artifact_kind_walks_produces_input_backchain(live_client: TestClient) -> None:
    """An Artifact's artifact chain must include its derivation tail:
    figure <-produces- code_A <-input- input_art <-produces- code_B, i.e. the
    Code that produced the cited Artifact, the Artifact versions that Code read
    as inputs, and the Code that produced those inputs. The produces/input pair
    alternates recursively until the derivation bottoms out.

    A cited figure must ALSO surface the reverse citation (who cites it):
    figure -[:supports]-> Claim -[:stated_in]-> report, so the figure's own chain
    shows which report's which Claim references it, alongside its derivation.
    """
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-backchain"
    _wipe_session(sid)
    # Session-unique artifact_ids (see prunes test) — the global (artifact_id,
    # version) uniqueness constraint would otherwise MERGE-hit another test's
    # art-report/art-fig/art-base v1 and never write this session's copy.
    BC_REPORT, BC_BASE, BC_FIG = "art-report-bc", "art-base-bc", "art-fig-bc"
    # Seed the report anchor (stated_in→Claim) so the artifact chain has a start.
    live_client.post("/observe/execution", json={
        "execution_id": "exec-bc-report", "session_id": sid, "turn_id": "turn-bc-report",
        "tool": "run_python", "language": "python", "code_hash": "hash-bc-report",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-09T00:00:01Z", "finished_at": "2026-08-09T00:00:01Z",
        "produced_artifacts": [{
            "artifact_id": BC_REPORT, "path": "report.md",
            "logical_name": "report.md", "version": 1, "media_type": "text/markdown",
        }],
    }, headers=headers)
    # code_B produces the base input artifact (no inputs of its own → leaf).
    live_client.post("/observe/execution", json={
        "execution_id": "exec-bc-base", "session_id": sid, "turn_id": "turn-bc-base",
        "tool": "run_python", "language": "python", "code_hash": "hash-bc-base",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-09T00:00:02Z", "finished_at": "2026-08-09T00:00:02Z",
        "produced_artifacts": [{
            "artifact_id": BC_BASE, "path": "base.csv",
            "logical_name": "base.csv", "version": 1, "media_type": "text/csv",
        }],
    }, headers=headers)
    # code_A produces the figure AND reads art-base v1 as an input. It also
    # produces a sibling artifact (BC_SIB) that NO Claim cites — the chain must
    # NOT pull it in via produces (sibling branch pruning), even though the
    # same Code that produced the cited figure also produced it.
    BC_SIB = "art-sib-bc"
    live_client.post("/observe/execution", json={
        "execution_id": "exec-bc-fig", "session_id": sid, "turn_id": "turn-bc-fig",
        "tool": "run_python", "language": "python", "code_hash": "hash-bc-fig",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-09T00:00:03Z", "finished_at": "2026-08-09T00:00:03Z",
        "produced_artifacts": [
            {
                "artifact_id": BC_FIG, "path": "fig.svg",
                "logical_name": "fig.svg", "version": 1, "media_type": "image/svg+xml",
                "input_artifact_versions": [{"artifact_id": BC_BASE, "version": 1}],
            },
            {
                "artifact_id": BC_SIB, "path": "sib.svg",
                "logical_name": "sib.svg", "version": 1, "media_type": "image/svg+xml",
            },
        ],
    }, headers=headers)
    # A Claim cites the figure, stated_in the report → report is anchor.
    claim = live_client.post("/persist/claim", json={
        "content": "fig peaks at 50", "claim_type": "STATISTICAL",
        "confidence": "HIGH", "locator": "fig1",
        "cites_artifact_aliases": {"fig1": BC_FIG},
        "cites_artifact_versions": {"fig1": 1},
        "artifact_id": BC_REPORT, "artifact_version": 1, "session_id": sid,
    }, headers=headers).json()
    assert claim["status"] == "ok"
    live_client.post("/persist/stated_in", json={
        "artifact_id": BC_REPORT, "artifact_version": 1,
        "claim_ids": [claim["claim_id"]], "session_id": sid,
    }, headers=headers)
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    fig = next(n for n in sub["nodes"] if n["label"] == "Artifact"
              and n["extra"]["artifact_id"] == BC_FIG)
    chain = live_client.post("/query/chain", json={
        "node_id": fig["id"], "session_id": sid, "chain_kind": "artifact",
    }, headers=headers).json()
    nodes = {n["id"]: n for n in chain["nodes"]}
    edge_types = {e["type"] for e in chain["edges"]}
    # The cited figure + the Code that produced it (code_A).
    assert fig["id"] in nodes
    code_a = next(n for n in chain["nodes"] if n["label"] == "Code"
                 and n["extra"].get("code_hash") == "hash-bc-fig")
    # The input Artifact the producing Code read (art-base).
    base = next(n for n in chain["nodes"] if n["label"] == "Artifact"
               and n["extra"]["artifact_id"] == BC_BASE)
    # The Code that produced the input Artifact (code_B).
    code_b = next(n for n in chain["nodes"] if n["label"] == "Code"
                 and n["extra"].get("code_hash") == "hash-bc-base")
    # produces + input edges must both be present in the chain.
    assert "produces" in edge_types and "input" in edge_types, \
        "derivation tail must carry produces + input edges"
    # The sibling Artifact code_A also produced (BC_SIB, never cited) must NOT
    # appear in the chain — sibling branches off the cited figure's derivation
    # are pruned, and no produces edge to it renders.
    sib_in_chain = any(n["label"] == "Artifact"
                       and n["extra"].get("artifact_id") == BC_SIB
                       for n in chain["nodes"])
    assert not sib_in_chain, \
        "uncited sibling Artifact produced by the same Code must be pruned"
    # The figure is CITED by the report's Claim — the reverse citation walk
    # (fig <-[:cites]- Claim <-[:states]- report) must surface the citing
    # Claim AND the citing report Artifact on the figure's own chain, not just
    # its produces/input derivation. The supports + stated_in edges render too.
    report_in_chain = any(n["label"] == "Artifact"
                          and n["extra"].get("artifact_id") == BC_REPORT
                          for n in chain["nodes"])
    assert report_in_chain, \
        "the report Artifact that supports this figure must appear (reverse supports)"
    assert "supports" in edge_types, "the citing Claim's supports edge must render"
    assert "stated_in" in edge_types, "the report's stated_in edge must render"


@needs_neo4j
def test_get_chain_artifact_kind_uncited_artifact_walks_full_derivation(live_client: TestClient) -> None:
    """An UNcited Artifact (no Claim cites it) still walks its full produces/input
    derivation tail centered on itself — the artifact chain does not depend on
    being cited. The chain must be:

        fig <-produces- code_A <-input- base <-produces- code_B

    (code_B has no further inputs → leaf), with produces + input edges both
    present, and NO Claim/Evidence/Paper — the figure was never cited, so the
    citation downstream reaches nothing. Regression guard for the case where
    clicking an uncited intermediate product's "view artifact chain" surfaced
    only the Artifact itself (anchor-centric collapse) or an empty chain.
    """
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-uncited"
    _wipe_session(sid)
    # Session-unique artifact_ids (global composite-key constraint would
    # otherwise MERGE-hit another test's art-* v1).
    UN_BASE, UN_FIG = "art-base-unc", "art-fig-unc"
    # code_B produces the base input artifact (no inputs of its own → leaf).
    live_client.post("/observe/execution", json={
        "execution_id": "exec-unc-base", "session_id": sid, "turn_id": "turn-unc-base",
        "tool": "run_python", "language": "python", "code_hash": "hash-unc-base",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-09T00:00:02Z", "finished_at": "2026-08-09T00:00:02Z",
        "produced_artifacts": [{
            "artifact_id": UN_BASE, "path": "base.csv",
            "logical_name": "base.csv", "version": 1, "media_type": "text/csv",
        }],
    }, headers=headers)
    # code_A produces the figure AND reads art-base v1 as an input. This figure
    # is NEVER cited by any Claim — the chain below must still walk its full
    # input ancestry, centered on the figure itself.
    live_client.post("/observe/execution", json={
        "execution_id": "exec-unc-fig", "session_id": sid, "turn_id": "turn-unc-fig",
        "tool": "run_python", "language": "python", "code_hash": "hash-unc-fig",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-09T00:00:03Z", "finished_at": "2026-08-09T00:00:03Z",
        "produced_artifacts": [{
            "artifact_id": UN_FIG, "path": "fig.svg",
            "logical_name": "fig.svg", "version": 1, "media_type": "image/svg+xml",
            "input_artifact_versions": [{"artifact_id": UN_BASE, "version": 1}],
        }],
    }, headers=headers)
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    fig = next(n for n in sub["nodes"] if n["label"] == "Artifact"
              and n["extra"]["artifact_id"] == UN_FIG)
    chain = live_client.post("/query/chain", json={
        "node_id": fig["id"], "session_id": sid, "chain_kind": "artifact",
    }, headers=headers).json()
    nodes = {n["id"]: n for n in chain["nodes"]}
    edge_types = {e["type"] for e in chain["edges"]}
    # The uncited figure + the Code that produced it (code_A).
    assert fig["id"] in nodes
    code_a = next(n for n in chain["nodes"] if n["label"] == "Code"
                 and n["extra"].get("code_hash") == "hash-unc-fig")
    # The input Artifact the producing Code read (art-base) + the Code that
    # produced it (code_B).
    base = next(n for n in chain["nodes"] if n["label"] == "Artifact"
               and n["extra"]["artifact_id"] == UN_BASE)
    code_b = next(n for n in chain["nodes"] if n["label"] == "Code"
                 and n["extra"].get("code_hash") == "hash-unc-base")
    # produces + input edges must both be present — the full alternating
    # derivation tail was walked despite the figure being uncited.
    assert "produces" in edge_types and "input" in edge_types, \
        "uncited figure's derivation tail must carry produces + input edges"
    # No citation nodes — the figure was never cited, so states/cites/
    # extracts reach nothing.
    labels = {n["label"] for n in chain["nodes"]}
    assert "Claim" not in labels, "an uncited Artifact has no states→Claim citation"
    assert "Evidence" not in labels
    assert "Paper" not in labels


@needs_neo4j
def test_get_chain_artifact_kind_no_input_code_still_reaches_goal(live_client: TestClient) -> None:
    """A cited Artifact whose producing Code read NO inputs (a leaf Code) must
    still trace all the way to the ResearchGoal, not dead-end at the Code.

    This is the supports-connected Artifact path's symmetry guarantee with the
    Evidence path: the Evidence branch reaches the goal via the entry hops'
    ``produces in SubTask`` + ``next`` chain, but the Artifact derivation tail
    (_artifact_derivation_tail) only alternates produces/input between
    Artifact↔Code — and a leaf Code (no input edges) bottoms the alternation
    out at the Code itself. Before the tail anchored each producing Code to its
    SubTask→next→goal chain, clicking a Claim's "view chain" left the Artifact
    branch stuck at the Code node while the Evidence branch reached the goal —
    an asymmetric chain the reviewer reads as a broken citation.

    Topology (the minimal reproduction):
        ResearchGoal -[:next]-> SubTask_fig -[:produces]-> Code_fig
                                                Code_fig -[:produces]-> fig (no inputs)
        fig <-[:supports]- Claim -[:stated_in]-> report
    The figure's producing Code read no inputs, so without the SubTask→next→goal
    tail the Artifact path stops at Code_fig. The fix runs that tail from each
    newly-discovered producing Code, so fig now reaches the goal through the
    same SubTask/next spine the Evidence branch uses.
    """
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-leafcode"
    _wipe_session(sid)
    # Seed the ResearchGoal via the first-message fallback so the SubTask→goal
    # next spine exists (observe/execution alone builds SubTasks but only the
    # first-message/plan endpoints persist the ResearchGoal they link to).
    live_client.post("/observe/session-first-message", json={
        "session_id": sid, "goal_id": f"goal:session:{sid}",
        "core_objective": "analyze the figure", "domain": "Biology",
        "topic_scope": [], "created_at": "2026-08-19T00:00:00Z",
    }, headers=headers)
    # Session-unique artifact_ids (global composite-key constraint would
    # otherwise MERGE-hit another test's art-* v1).
    LC_REPORT, LC_FIG = "art-report-lc", "art-fig-lc"
    # The report execution seeds the report Artifact + its own SubTask.
    live_client.post("/observe/execution", json={
        "execution_id": "exec-lc-report", "session_id": sid,
        "turn_id": "turn-lc-report", "tool": "run_python", "language": "python",
        "code_hash": "hash-lc-report", "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-19T00:00:01Z", "finished_at": "2026-08-19T00:00:01Z",
        "produced_artifacts": [{
            "artifact_id": LC_REPORT, "path": "report.md",
            "logical_name": "report.md", "version": 1, "media_type": "text/markdown",
        }],
    }, headers=headers)
    # The figure execution: NO input_artifact_versions, so Code_fig is a leaf
    # (no input edges). This is the dead-end the tail must bridge.
    live_client.post("/observe/execution", json={
        "execution_id": "exec-lc-fig", "session_id": sid,
        "turn_id": "turn-lc-fig", "tool": "run_python", "language": "python",
        "code_hash": "hash-lc-fig", "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-19T00:00:02Z", "finished_at": "2026-08-19T00:00:02Z",
        "produced_artifacts": [{
            "artifact_id": LC_FIG, "path": "fig.svg",
            "logical_name": "fig.svg", "version": 1, "media_type": "image/svg+xml",
        }],
    }, headers=headers)
    # Claim cites the leaf-produced figure, stated_in the report → the figure
    # sits on the report's supports-connected Artifact path.
    claim = live_client.post("/persist/claim", json={
        "content": "fig peaks at 50", "claim_type": "STATISTICAL",
        "confidence": "HIGH", "locator": "fig1",
        "cites_artifact_aliases": {"fig1": LC_FIG},
        "cites_artifact_versions": {"fig1": 1},
        "artifact_id": LC_REPORT, "artifact_version": 1, "session_id": sid,
    }, headers=headers).json()
    assert claim["status"] == "ok"
    live_client.post("/persist/stated_in", json={
        "artifact_id": LC_REPORT, "artifact_version": 1,
        "claim_ids": [claim["claim_id"]], "session_id": sid,
    }, headers=headers)
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    fig = next(n for n in sub["nodes"] if n["label"] == "Artifact"
              and n["extra"]["artifact_id"] == LC_FIG)
    # Query the figure's artifact chain — the path the Artifact branch of a
    # Claim's "view chain" renders.
    chain = live_client.post("/query/chain", json={
        "node_id": fig["id"], "session_id": sid, "chain_kind": "artifact",
    }, headers=headers).json()
    nodes = {n["id"]: n for n in chain["nodes"]}
    labels = {n["label"] for n in chain["nodes"]}
    assert fig["id"] in nodes, "the selected figure must be present"
    assert "Code" in labels, "the figure's producing Code must be reached"
    # The producing SubTask AND the ResearchGoal must both be present — this
    # is the regression: before the tail bridged the leaf Code to its task
    # chain, neither appeared and the Artifact path stopped at the Code.
    assert "SubTask" in labels, \
        "the producing Code's SubTask must be reached (leaf-Code tail bridge)"
    assert "ResearchGoal" in labels, \
        "the Artifact path must reach the ResearchGoal, not stop at the Code"
    # The Artifact path must be REACHABLE to the goal through the chain's edges
    # (not just co-present) — proves the SubTask→next→goal spine actually links
    # the Code to the goal, mirroring the Evidence branch's reach.
    adj: dict[str, set[str]] = {n["id"]: set() for n in chain["nodes"]}
    for e in chain["edges"]:
        adj.setdefault(e["source"], set()).add(e["target"])
        adj.setdefault(e["target"], set()).add(e["source"])
    goal_id = next(n["id"] for n in chain["nodes"] if n["label"] == "ResearchGoal")
    seen = {fig["id"]}
    stack = [fig["id"]]
    while stack:
        x = stack.pop()
        for y in adj.get(x, ()):
            if y not in seen:
                seen.add(y)
                stack.append(y)
    assert goal_id in seen, \
        "the figure must be edge-reachable to the ResearchGoal through the chain"


@needs_neo4j
def test_get_chain_claim_source_cited_artifact_reaches_goal(live_client: TestClient) -> None:
    """Clicking a Claim's own "View chain" (chain_kind=artifact, source IS the
    Claim) must trace the supports-connected Artifact path all the way to the
    ResearchGoal — not dead-end it at the producing Code.

    This is the Claim-source counterpart of the leaf-Code regression. The
    Claim source routes through ``_ENTRY_HOPS["Claim"]`` whose ``supports in``
    reaches the cited Artifact AND whose ``produces in`` (run from the cited
    Artifact) reaches the producing Code in one hop. But that second ``produces``
    hop stops at the Code — the Code's OWN producing SubTask is a further
    ``produces`` hop the entry hops don't take, and a leaf Code sits on no
    ``next`` edge itself. So the SubTask→next→goal spine is reached ONLY if the
    cited Artifact is seeded into ``_artifact_derivation_tail`` (whose
    ``_CODE_TAIL_HOPS`` walks Code→produces→SubTask→next→goal). Before the fix,
    ``seed_arts`` was computed from ``keep={claim_eid}`` alone — the Claim is
    not an Artifact, so ``_cited_artifact_eids`` matched nothing, the
    derivation tail was skipped (the early-return branch), and the Artifact
    path stopped at the Code while the Evidence path reached the goal.

    Topology (minimal reproduction of the user's report):
        ResearchGoal -[:next]-> SubTask_fig -[:produces]-> Code_fig
                                                    Code_fig -[:produces]-> fig (leaf)
        fig -[:supports]-> Claim -[:stated_in]-> report
    Viewing the Claim's chain: the supports-connected fig's path must reach
    the goal through fig<-produces-Code<-produces-SubTask<-next-<-Goal, the
    same reach the Evidence branch has.
    """
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-claimsrc"
    _wipe_session(sid)
    live_client.post("/observe/session-first-message", json={
        "session_id": sid, "goal_id": f"goal:session:{sid}",
        "core_objective": "analyze the figure", "domain": "Biology",
        "topic_scope": [], "created_at": "2026-08-19T00:00:00Z",
    }, headers=headers)
    CL_REPORT, CL_FIG = "art-report-cs", "art-fig-cs"
    live_client.post("/observe/execution", json={
        "execution_id": "exec-cs-report", "session_id": sid,
        "turn_id": "turn-cs-report", "tool": "run_python", "language": "python",
        "code_hash": "hash-cs-report", "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-19T00:00:01Z", "finished_at": "2026-08-19T00:00:01Z",
        "produced_artifacts": [{
            "artifact_id": CL_REPORT, "path": "report.md",
            "logical_name": "report.md", "version": 1, "media_type": "text/markdown",
        }],
    }, headers=headers)
    # Leaf Code: produces the cited figure, reads NO inputs (no input edges).
    live_client.post("/observe/execution", json={
        "execution_id": "exec-cs-fig", "session_id": sid,
        "turn_id": "turn-cs-fig", "tool": "run_python", "language": "python",
        "code_hash": "hash-cs-fig", "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-19T00:00:02Z", "finished_at": "2026-08-19T00:00:02Z",
        "produced_artifacts": [{
            "artifact_id": CL_FIG, "path": "fig.svg",
            "logical_name": "fig.svg", "version": 1, "media_type": "image/svg+xml",
        }],
    }, headers=headers)
    claim = live_client.post("/persist/claim", json={
        "content": "fig peaks at 50", "claim_type": "STATISTICAL",
        "confidence": "HIGH", "locator": "fig1",
        "cites_artifact_aliases": {"fig1": CL_FIG},
        "cites_artifact_versions": {"fig1": 1},
        "artifact_id": CL_REPORT, "artifact_version": 1, "session_id": sid,
    }, headers=headers).json()
    assert claim["status"] == "ok"
    live_client.post("/persist/stated_in", json={
        "artifact_id": CL_REPORT, "artifact_version": 1,
        "claim_ids": [claim["claim_id"]], "session_id": sid,
    }, headers=headers)
    # Resolve the Claim's graph id, then view the CLAIM's own chain (this is
    # what "View chain" on a Claim node does — chain_kind=artifact).
    sub = live_client.get("/subgraph", params={"session_id": sid}, headers=headers).json()
    claim_node = next(n for n in sub["nodes"] if n["label"] == "Claim")
    chain = live_client.post("/query/chain", json={
        "node_id": claim_node["id"], "session_id": sid, "chain_kind": "artifact",
    }, headers=headers).json()
    nodes = {n["id"]: n for n in chain["nodes"]}
    labels = {n["label"] for n in chain["nodes"]}
    # The cited figure + its producing Code are reached by the entry hops.
    fig = next(n for n in chain["nodes"] if n["label"] == "Artifact"
              and n["extra"]["artifact_id"] == CL_FIG)
    assert fig["id"] in nodes, "the cited figure must be present"
    assert "Code" in labels, "the figure's producing Code must be reached"
    # The producing SubTask (Code<-produces-SubTask) AND the ResearchGoal must
    # both be present — the regression: before the cited Artifact was seeded
    # into the derivation tail, the entry hops reached the Code but NOT its
    # producing SubTask, the Artifact path dead-ended at the Code, and the
    # SubTask→Code produces edge did not render (one endpoint missing).
    assert "SubTask" in labels, \
        "the producing Code's SubTask must be reached (cited-Artifact seed fix)"
    assert "ResearchGoal" in labels, \
        "the Claim's supports-Artifact path must reach the ResearchGoal"
    # Edge-reachability: fig must connect to the goal through the chain's edges
    # (not just co-present) — the SubTask→produces→Code→produces→fig spine must
    # actually link the goal to the cited Artifact path.
    adj: dict[str, set[str]] = {n["id"]: set() for n in chain["nodes"]}
    for e in chain["edges"]:
        adj.setdefault(e["source"], set()).add(e["target"])
        adj.setdefault(e["target"], set()).add(e["source"])
    goal_id = next(n["id"] for n in chain["nodes"] if n["label"] == "ResearchGoal")
    seen = {fig["id"]}
    stack = [fig["id"]]
    while stack:
        x = stack.pop()
        for y in adj.get(x, ()):
            if y not in seen:
                seen.add(y)
                stack.append(y)
    assert goal_id in seen, \
        "the cited figure must be edge-reachable to the ResearchGoal via the Claim's chain"


# --- cleanup/session: soft-mark Artifact versions + physically delete private
#
# The core guarantee of the soft-mark design: deleting a session physically
# removes its private nodes (SubTask/Code/Paper/Evidence/Claim) but LEAVES
# that session's Artifact *version* nodes (soft-marked deleted_session=true) so
# a future cross-session run that reads one of those versions can still build
# an ``input`` edge against it (the version node must remain matchable). A
# hard delete would orphan the cross-session input edge forever.


@needs_neo4j
def test_cleanup_session_soft_marks_artifacts_and_deletes_private(live_client: TestClient) -> None:
    """delete_session_graph physically deletes a session's private nodes but
    soft-marks (does NOT delete) its Artifact version nodes, and severs the
    edges whose private endpoint was deleted (produces, stated_in)."""
    from science_agent_memory_graph.neo4j_driver import handle

    headers = {"authorization": "Bearer test-token"}
    sid = "sess-cleanup-soft"
    CL_REPORT, CL_FIG = "art-cl-report", "art-cl-fig"
    _wipe_session(sid)
    # Seed: one Code producing a report + one Evidence + one Claim citing the
    # figure, stated_in the report.
    live_client.post("/observe/execution", json={
        "execution_id": "exec-cl-fig", "session_id": sid, "turn_id": "turn-cl-fig",
        "tool": "run_python", "language": "python", "code_hash": "hash-cl-fig",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-20T00:00:01Z", "finished_at": "2026-08-20T00:00:01Z",
        "produced_artifacts": [{
            "artifact_id": CL_FIG, "path": "fig.svg", "logical_name": "fig.svg",
            "version": 1, "media_type": "image/svg+xml",
        }],
    }, headers=headers)
    live_client.post("/observe/execution", json={
        "execution_id": "exec-cl-report", "session_id": sid, "turn_id": "turn-cl-report",
        "tool": "run_python", "language": "python", "code_hash": "hash-cl-report",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-20T00:00:02Z", "finished_at": "2026-08-20T00:00:02Z",
        "produced_artifacts": [{
            "artifact_id": CL_REPORT, "path": "report.md", "logical_name": "report.md",
            "version": 1, "media_type": "text/markdown",
        }],
    }, headers=headers)
    claim = live_client.post("/persist/claim", json={
        "content": "fig peaks", "claim_type": "STATISTICAL", "confidence": "HIGH",
        "locator": "fig1", "cites_artifact_aliases": {"fig1": CL_FIG},
        "cites_artifact_versions": {"fig1": 1},
        "artifact_id": CL_REPORT, "artifact_version": 1, "session_id": sid,
    }, headers=headers).json()
    assert claim["status"] == "ok"
    live_client.post("/persist/stated_in", json={
        "artifact_id": CL_REPORT, "artifact_version": 1,
        "claim_ids": [claim["claim_id"]], "session_id": sid,
    }, headers=headers)

    # Before cleanup: the version node + Code + Claim + stated_in all present.
    with handle().session() as s:
        assert s.run("MATCH (a:Artifact {artifact_id:$a,version:1}) RETURN count(a) AS c",
                     a=CL_FIG).single()["c"] == 1
        assert s.run("MATCH (c:Code {code_hash:$h}) RETURN count(c) AS c",
                     h="hash-cl-fig").single()["c"] == 1
        assert s.run("MATCH (cl:Claim {claim_id:$cid}) RETURN count(cl) AS c",
                     cid=claim["claim_id"]).single()["c"] == 1
        assert s.run(
            "MATCH (a:Artifact {artifact_id:$a,version:1})-[:stated_in]-(cl:Claim {claim_id:$cid}) "
            "RETURN count(*) AS c", a=CL_REPORT, cid=claim["claim_id"]).single()["c"] == 1

    resp = live_client.post("/cleanup/session", json={"session_id": sid}, headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "healthy"
    assert body["marked"] >= 2, "both Artifact versions should be soft-marked"
    assert body["deleted"] >= 3, "SubTask/Code/Claim (at least) should be physically deleted"

    with handle().session() as s:
        # Artifact version nodes STILL THERE and soft-marked (the whole point).
        for aid in (CL_FIG, CL_REPORT):
            rec = s.run("MATCH (a:Artifact {artifact_id:$a,version:1}) "
                        "RETURN a.deleted_session AS d", a=aid).single()
            assert rec is not None, f"Artifact version {aid} must NOT be physically deleted"
            assert rec["d"] is True, f"Artifact version {aid} must be soft-marked"
        # Private nodes physically gone.
        assert s.run("MATCH (c:Code {code_hash:$h}) RETURN count(c) AS c",
                     h="hash-cl-fig").single()["c"] == 0
        assert s.run("MATCH (cl:Claim {claim_id:$cid}) RETURN count(cl) AS c",
                     cid=claim["claim_id"]).single()["c"] == 0
        # stated_in severed (Claim endpoint deleted; DETACH DELETE drops the edge).
        assert s.run(
            "MATCH (a:Artifact {artifact_id:$a,version:1})-[:stated_in]-(cl:Claim) "
            "RETURN count(*) AS c", a=CL_REPORT).single()["c"] == 0
        # The soft-marked version's produces edge is also gone (Code deleted).
        assert s.run(
            "MATCH (c:Code)-[:produces]->(a:Artifact {artifact_id:$a,version:1}) "
            "RETURN count(*) AS c", a=CL_FIG).single()["c"] == 0
    _wipe_session(sid)


@needs_neo4j
def test_cleanup_session_leaves_cross_session_input_edge_buildable(live_client: TestClient) -> None:
    """The soft-mark guarantee in action: AFTER session A is deleted (its
    Artifact version soft-marked), a NEW session D that reads A's old version
    as an input still builds the ``Artifact(v1)-[:input]->Code(D)`` edge —
    because the version node was retained (matchable), not hard-deleted. This
    is the regression a hard-delete design would break."""
    from science_agent_memory_graph.neo4j_driver import handle

    headers = {"authorization": "Bearer test-token"}
    sid_a = "sess-cleanup-a"
    sid_d = "sess-cleanup-d"
    SHARED = "art-cleanup-shared"
    _wipe_session(sid_a)
    _wipe_session(sid_d)
    # Session A produces version v1 of SHARED.
    live_client.post("/observe/execution", json={
        "execution_id": "exec-cl-a", "session_id": sid_a, "turn_id": "turn-cl-a",
        "tool": "run_python", "language": "python", "code_hash": "hash-cl-a",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-20T00:00:10Z", "finished_at": "2026-08-20T00:00:10Z",
        "produced_artifacts": [{
            "artifact_id": SHARED, "path": "shared.csv", "logical_name": "shared.csv",
            "version": 1, "media_type": "text/csv",
        }],
    }, headers=headers)
    # Delete session A → its SHARED v1 node is soft-marked (retained).
    live_client.post("/cleanup/session", json={"session_id": sid_a}, headers=headers)

    # Session D reads A's SHARED v1 as an input. The upsert's input-edge
    # Cypher does MATCH (inA:Artifact {artifact_id,version}) — the soft-marked
    # node is still there, so the edge builds.
    live_client.post("/observe/execution", json={
        "execution_id": "exec-cl-d", "session_id": sid_d, "turn_id": "turn-cl-d",
        "tool": "run_python", "language": "python", "code_hash": "hash-cl-d",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-20T00:00:20Z", "finished_at": "2026-08-20T00:00:20Z",
        "produced_artifacts": [{
            "artifact_id": "art-cl-d-out", "path": "out.csv", "logical_name": "out.csv",
            "version": 1, "media_type": "text/csv",
            "input_artifact_versions": [{"artifact_id": SHARED, "version": 1}],
        }],
    }, headers=headers)

    with handle().session() as s:
        # The cross-session input edge built against the soft-marked version.
        c = s.run(
            "MATCH (inA:Artifact {artifact_id:$a,version:1})-[:input]->(c:Code {code_hash:$h}) "
            "RETURN count(*) AS c", a=SHARED, h="hash-cl-d").single()["c"]
        assert c == 1, "cross-session input edge must build against the soft-marked version"
        # And the soft-mark survived the second session's upsert (ON MATCH only
        # refreshes path/logical_name/etc., it does NOT clear deleted_session).
        rec = s.run("MATCH (a:Artifact {artifact_id:$a,version:1}) RETURN a.deleted_session AS d",
                    a=SHARED).single()
        assert rec is not None and rec["d"] is True
    _wipe_session(sid_a)
    _wipe_session(sid_d)


@needs_neo4j
def test_cleanup_project_physically_deletes_all_nodes(live_client: TestClient) -> None:
    """delete_project_graph physically removes every node of a project's
    sessions (including Artifact versions — no soft-mark: the project is gone,
    there is no future cross-project reference)."""
    from science_agent_memory_graph.neo4j_driver import handle

    headers = {"authorization": "Bearer test-token"}
    sid1 = "sess-cleanup-p1"
    sid2 = "sess-cleanup-p2"
    for s in (sid1, sid2):
        _wipe_session(s)
    live_client.post("/observe/execution", json={
        "execution_id": "exec-cl-p1", "session_id": sid1, "turn_id": "turn-cl-p1",
        "tool": "run_python", "language": "python", "code_hash": "hash-cl-p1",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-20T00:00:30Z", "finished_at": "2026-08-20T00:00:30Z",
        "produced_artifacts": [{
            "artifact_id": "art-cl-p1", "path": "p1.svg", "logical_name": "p1.svg",
            "version": 1, "media_type": "image/svg+xml",
        }],
    }, headers=headers)
    live_client.post("/observe/execution", json={
        "execution_id": "exec-cl-p2", "session_id": sid2, "turn_id": "turn-cl-p2",
        "tool": "run_python", "language": "python", "code_hash": "hash-cl-p2",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-20T00:00:31Z", "finished_at": "2026-08-20T00:00:31Z",
        "produced_artifacts": [{
            "artifact_id": "art-cl-p2", "path": "p2.svg", "logical_name": "p2.svg",
            "version": 1, "media_type": "image/svg+xml",
        }],
    }, headers=headers)

    resp = live_client.post("/cleanup/project", json={
        "project_id": "proj-cleanup", "session_ids": [sid1, sid2],
    }, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"
    assert resp.json()["deleted"] >= 4  # 2 SubTask + 2 Code + 2 Artifact ≥ 6, be loose

    with handle().session() as s:
        c = s.run("MATCH (n) WHERE n.session_id IN $sids RETURN count(n) AS c",
                  sids=[sid1, sid2]).single()["c"]
        assert c == 0, "every node of the project's sessions must be physically deleted"
        # Artifact versions are gone (no soft-mark residue — unlike session cleanup).
        assert s.run("MATCH (a:Artifact {artifact_id:$a,version:1}) RETURN count(a) AS c",
                     a="art-cl-p1").single()["c"] == 0
    _wipe_session(sid1)
    _wipe_session(sid2)


@needs_neo4j
def test_get_subgraph_hides_soft_marked_artifact_versions(live_client: TestClient) -> None:
    """After a session is deleted (its Artifact version nodes soft-marked),
    ``GET /subgraph`` must NOT return those soft-marked nodes — the view the
    frontend renders should look empty even though the version nodes are
    physically retained (for cross-session input edges). This covers the
    ``get_subgraph`` node and edge Cypher, which filter
    ``NOT coalesce(n.deleted_session, false)``. The version nodes being
    retained (soft-mark, not hard-delete) is asserted separately below."""
    from science_agent_memory_graph.neo4j_driver import handle

    headers = {"authorization": "Bearer test-token"}
    sid = "sess-subgraph-soft"
    _wipe_session(sid)
    live_client.post("/observe/execution", json={
        "execution_id": "exec-subgraph-soft", "session_id": sid, "turn_id": "turn-subgraph-soft",
        "tool": "run_python", "language": "python", "code_hash": "hash-subgraph-soft",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-20T00:00:40Z", "finished_at": "2026-08-20T00:00:40Z",
        "produced_artifacts": [{
            "artifact_id": "art-subgraph-soft", "path": "out.csv", "logical_name": "out.csv",
            "version": 1, "media_type": "text/csv", "project_id": "proj-subgraph-soft",
        }],
    }, headers=headers)

    # Pre-delete: subgraph shows the Artifact (and the SubTask/Code that produced it).
    before = live_client.get(f"/subgraph?session_id={sid}", headers=headers).json()
    assert before["total"] > 0, "fixture should have written nodes"
    assert any(n["label"] == "Artifact" for n in before["nodes"])

    live_client.post("/cleanup/session", json={"session_id": sid}, headers=headers)

    after = live_client.get(f"/subgraph?session_id={sid}", headers=headers).json()
    # View looks empty: soft-marked Artifact filtered out, private nodes physically deleted.
    assert after["total"] == 0, "soft-marked Artifact versions must not leak into the subgraph view"
    assert after["nodes"] == []
    assert after["edges"] == []

    # But the version node is still physically there (soft-mark, not hard-delete).
    with handle().session() as s:
        rec = s.run("MATCH (a:Artifact {artifact_id:$a,version:1}) RETURN a.deleted_session AS d",
                    a="art-subgraph-soft").single()
        assert rec is not None and rec["d"] is True, "version node must be retained as soft-marked"
    _wipe_session(sid)


@needs_neo4j
def test_cleanup_project_falls_back_to_project_id_when_sessions_already_deleted(live_client: TestClient) -> None:
    """The session-sweep alone cannot clean Artifact version nodes whose
    session was deleted EARLIER: the store no longer knows that session, so
    ``deletion-impact`` returns an empty ``session_ids`` list, and the sweep
    matches nothing. The ``project_id`` fallback pass then sweeps those
    soft-marked Artifact leftovers by ``project_id`` so no orphans remain.
    This is the regression the single-pass (session_ids-only) design would
    leave behind."""
    from science_agent_memory_graph.neo4j_driver import handle

    headers = {"authorization": "Bearer test-token"}
    sid = "sess-proj-fallback"
    PID = "proj-fallback"
    _wipe_session(sid)
    live_client.post("/observe/execution", json={
        "execution_id": "exec-proj-fallback", "session_id": sid, "turn_id": "turn-proj-fallback",
        "tool": "run_python", "language": "python", "code_hash": "hash-proj-fallback",
        "exit_code": 0, "status": "succeeded",
        "started_at": "2026-08-20T00:00:50Z", "finished_at": "2026-08-20T00:00:50Z",
        "produced_artifacts": [{
            "artifact_id": "art-proj-fallback", "path": "out.csv", "logical_name": "out.csv",
            "version": 1, "media_type": "text/csv", "project_id": PID,
        }],
    }, headers=headers)
    # Delete the session first → Artifact v1 is soft-marked (retained).
    live_client.post("/cleanup/session", json={"session_id": sid}, headers=headers)

    # The store would now return session_ids=[] for this project (the session
    # is gone). Simulate that: pass an EMPTY session_ids list.
    resp = live_client.post("/cleanup/project", json={
        "project_id": PID, "session_ids": [],
    }, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"
    assert resp.json()["deleted"] == 1, "project_id fallback must sweep the soft-marked Artifact leftover"

    with handle().session() as s:
        c = s.run("MATCH (n:Artifact) WHERE n.project_id=$pid RETURN count(n) AS c",
                  pid=PID).single()["c"]
        assert c == 0, "no Artifact nodes for the project may remain after cleanup"
    _wipe_session(sid)
