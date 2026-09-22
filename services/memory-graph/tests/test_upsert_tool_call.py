# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
"""Unified write ticket — ``upsert_tool_call``.

This is the only search write path (broker/recorder emit here; the legacy
``/observe/mcp-search`` was retired), so this file's job is to pin the write
path end-to-end on a live Neo4j and gate the no-Neo4j behaviour for the
FastAPI shell. Live-Neo4j tests mirror the smoke suite's ``@needs_neo4j``
pattern; non-Neo4j tests assert the unreachable-degraded contract.
"""

from __future__ import annotations

import importlib
import os
from typing import Any

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))
from fastapi.testclient import TestClient


# --- helpers (mirror test_smoke.py) ---------------------------------------


def _live_neo4j_config() -> tuple[str, str] | None:
    if os.environ.get("SCIENCE_AGENT_MEMORY_GRAPH_TEST_BACKEND") == "local":
        return "local", ""
    http_uri = os.environ.get("SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J")
    password = os.environ.get("SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J_PASSWORD")
    if http_uri and password:
        return http_uri, password
    return None


needs_neo4j = pytest.mark.science_tags(status="external")


def _wipe_session(session_id: str) -> None:
    from sciencediscovery_memory_graph.backend import handle
    if not handle().is_reachable():
        return
    with handle().session() as s:
        s.run("MATCH (n) WHERE n.session_id = $sid DETACH DELETE n", sid=session_id).consume()


@pytest.fixture()
def live_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    cfg = _live_neo4j_config()
    if cfg is None:
        pytest.fail("needs a live Neo4j")
    http_uri, password = cfg
    if http_uri == "local":
        monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_BACKEND", "local")
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
        pytest.fail("configured Neo4j not reachable")
    ensure_schema()
    return TestClient(server.app)


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_ENABLED", "1")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test-token")
    from sciencediscovery_memory_graph import neo4j_driver, persistence, query, server
    importlib.reload(neo4j_driver)
    importlib.reload(persistence)
    importlib.reload(query)
    importlib.reload(server)
    return TestClient(server.app)


def _cypher(query: str, **params: Any) -> list[dict[str, Any]]:
    from sciencediscovery_memory_graph.backend import handle
    with handle().session() as s:
        result = s.run(query, **params)
        return [dict(r.items()) for r in result]


# --- degraded / auth guards (no Neo4j needed) ----------------------------


def test_observe_tool_call_degrades_without_neo4j(client: TestClient) -> None:
    """Without a password, ``/observe/tool-call`` returns ``degraded`` (the
    legacy endpoints' contract; current callers must treat this the same way)."""
    response = client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:tc-1",
            "session_id": "sess-tc-1",
            "turn_id": "turn-tc-1",
            "tool_name": "mcp__llm-wiki__search",
            "tool_type": "search",
            "source": "llm-wiki",
            "products": [
                {"product_type": "web_page", "identifier": "wiki/BRCA1",
                 "url": "http://wiki.local/BRCA1", "title": "BRCA1"},
            ],
        },
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["written"] == 0


def test_observe_tool_call_rejects_missing_token(client: TestClient) -> None:
    response = client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:tc-2",
            "session_id": "sess-tc-2",
            "turn_id": "turn-tc-2",
            "tool_name": "x",
            "tool_type": "y",
            "products": [],
        },
    )
    assert response.status_code == 401


def test_observe_tool_call_rejects_unknown_product_type(client: TestClient) -> None:
    """The Literal guard rejects unknown product types with a 422 before any
    Cypher runs (``ToolCallProduct`` validation)."""
    response = client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:tc-3",
            "session_id": "sess-tc-3",
            "turn_id": "turn-tc-3",
            "tool_name": "x",
            "tool_type": "y",
            "products": [{"product_type": "bogus"}],
        },
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 422


# --- live Neo4j: write + dedup + child path ------------------------------


@needs_neo4j
def test_tool_call_paper_product_round_trip(live_client: TestClient) -> None:
    """A ``product_type=paper`` lands a Paper + produces edge, the same write
    the MCP broker performs for a literature search."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-tc-paper"
    _wipe_session(sid)
    response = live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:tc-paper-1",
            "session_id": sid,
            "turn_id": "turn-tc-paper-1",
            "tool_name": "mcp__arxiv__search",
            "tool_type": "search",
            "source": "arxiv",
            "products": [
                {"product_type": "paper",
                 "link": "https://arxiv.org/abs/2401.01234",
                 "title": "On multi-agent systems",
                 "identifier": "2401.01234", "identifier_type": "arXiv",
                 "year": "2024", "authors": ["Smith, J."],
                 "abstract": "We study ...",
                 "source": "arxiv"},
            ],
        },
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    assert body["written"] == 2  # 1 ToolCall + 1 product
    # Paper node + produces edge landed.
    rows = _cypher(
        "MATCH (t:ToolCall {task_id: $tid})-[:produces]->(p:Paper) "
        "RETURN p.link AS link, p.retrieval_count AS rc",
        tid="subtask:mcp:tc-paper-1",
    )
    assert len(rows) == 1
    assert rows[0]["link"] == "https://arxiv.org/abs/2401.01234"
    assert rows[0]["rc"] == 1


@needs_neo4j
def test_tool_call_web_page_identifier_dedups(live_client: TestClient) -> None:
    """A second upsert with the same (session_id, identifier) bumps
    retrieval_count and stays one WebPage node."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-tc-web-id"
    _wipe_session(sid)
    payload = {
        "task_id": "subtask:mcp:tc-web-id-1",
        "session_id": sid,
        "turn_id": "turn-tc-web-id-1",
        "tool_name": "mcp__llm-wiki__search",
        "tool_type": "search",
        "source": "llm-wiki",
        "products": [
            {"product_type": "web_page", "identifier": "wiki/BRCA1",
             "identifier_type": "wiki-path",
             "url": "http://wiki.local/BRCA1", "title": "BRCA1",
             "snippet": "tumor suppressor",
             "source_refs": ["ref1", "ref2"]},
        ],
    }
    live_client.post("/observe/tool-call", json=payload, headers=headers)
    # Same task_id re-fire (mirror's idempotency): the same node, count=1.
    live_client.post("/observe/tool-call", json=payload, headers=headers)
    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid, identifier: 'wiki/BRCA1'}) "
        "RETURN w.retrieval_count AS rc, w.source_refs AS srcs, "
        "w.identifier_type AS itype, w.title AS title",
        sid=sid,
    )
    assert len(rows) == 1, "WebPage identifier is the dedup key (single node)"
    assert rows[0]["rc"] == 2, "second upsert bumps retrieval_count"
    assert rows[0]["itype"] == "wiki-path"
    assert rows[0]["title"] == "BRCA1"
    assert list(rows[0]["srcs"]) == ["ref1", "ref2"]


@needs_neo4j
def test_tool_call_web_page_url_only_dedups(live_client: TestClient) -> None:
    """A url-only WebPage (web_search result) keys on (session_id, url).
    Re-firing with a trailing-slash URL normalises to the same key."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-tc-web-url"
    _wipe_session(sid)
    payload = {
        "task_id": "subtask:mcp:tc-web-url-1",
        "session_id": sid,
        "turn_id": "turn-tc-web-url-1",
        "tool_name": "web_search",
        "tool_type": "search",
        "products": [
            {"product_type": "web_page", "url": "https://example.com/a/b/",
             "title": "Example B"},
        ],
    }
    live_client.post("/observe/tool-call", json=payload, headers=headers)
    # Re-fire with a non-trailing-slash URL → normalised dedup hits the same node.
    payload2 = dict(payload)
    payload2["products"] = [{
        "product_type": "web_page",
        "url": "HTTPS://Example.com/a/b",
        "title": "Example B (revisit)",
    }]
    live_client.post("/observe/tool-call", json=payload2, headers=headers)
    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid}) "
        "RETURN w.url AS url, w.retrieval_count AS rc",
        sid=sid,
    )
    assert len(rows) == 1, "URL-normalisation merges to one WebPage"
    assert rows[0]["rc"] == 2


@needs_neo4j
def test_tool_call_db_record_composite_key(live_client: TestClient) -> None:
    """DbRecord's dedup key is (session_id, source, identifier). Two records
    with the same identifier but different sources stay distinct; two records
    sharing (session_id, source, identifier) bump retrieval_count."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-tc-db"
    _wipe_session(sid)
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:tc-db-1",
            "session_id": sid,
            "turn_id": "turn-tc-db-1",
            "tool_name": "mcp__uniprot__search",
            "tool_type": "search",
            "source": "uniprot",
            "products": [
                {"product_type": "db_record", "source": "uniprot",
                 "identifier": "P38398", "identifier_type": "uniprot-id",
                 "title": "BRCA1_HUMAN", "snippet": "DNA repair"},
                {"product_type": "db_record", "source": "pdb",
                 "identifier": "1J7X", "identifier_type": "pdb-id",
                 "title": "BRCA1 fragment"},
            ],
        },
        headers=headers,
    )
    # Re-fire the uniprot record — same (sid, source, identifier), count=2.
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:tc-db-2",
            "session_id": sid,
            "turn_id": "turn-tc-db-2",
            "tool_name": "mcp__uniprot__search",
            "tool_type": "search",
            "source": "uniprot",
            "products": [
                {"product_type": "db_record", "source": "uniprot",
                 "identifier": "P38398", "title": "BRCA1_HUMAN"},
            ],
        },
        headers=headers,
    )
    rows = _cypher(
        "MATCH (d:DbRecord {session_id: $sid}) "
        "RETURN d.source AS src, d.identifier AS ident, d.retrieval_count AS rc "
        "ORDER BY d.source, d.identifier",
        sid=sid,
    )
    assert len(rows) == 2, "two distinct DbRecord nodes (different source)"
    assert (rows[0]["src"], rows[0]["ident"], rows[0]["rc"]) == ("pdb", "1J7X", 1)
    assert (rows[1]["src"], rows[1]["ident"], rows[1]["rc"]) == ("uniprot", "P38398", 2)


@needs_neo4j
def test_tool_call_subagent_child_path(live_client: TestClient) -> None:
    """A tool call inside a subagent builds a child ToolCall hung off the
    scope via contains, with produces running child→product (the same child
    path the broker uses with ``parent_subagent_id``)."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-tc-sub"
    _wipe_session(sid)
    sub_id = "sub-tc-1"
    # Start the subagent so the scope exists.
    live_client.post(
        "/observe/subagent",
        json={
            "subagent_id": sub_id, "session_id": sid, "turn_id": "turn-sub-tc",
            "objective": "research BRCA1", "task_type": "subagent",
            "subagent_type": "researcher",
            "created_at": "2026-09-10T00:00:00Z",
            "status": "running",
        },
        headers=headers,
    )
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:tc-child-1",
            "session_id": sid,
            "turn_id": "turn-sub-tc",
            "tool_name": "web_search",
            "tool_type": "search",
            "parent_subagent_id": sub_id,
            "products": [
                {"product_type": "web_page",
                 "url": "https://example.com/brca1",
                 "title": "BRCA1 article"},
            ],
        },
        headers=headers,
    )
    scope_tid = f"subtask:subagent:{sub_id}"
    # The scheme prefix on the posted task_id is stripped when composing the
    # child id — the child keeps the exec:<invocation id> shape (the same
    # contract as the execution child path), not exec:subtask:mcp:<id>.
    child_tid = f"subtask:subagent:{sub_id}:exec:tc-child-1"
    child = _cypher("MATCH (c:ToolCall {task_id: $t}) RETURN c", t=child_tid)
    assert len(child) == 1
    cprops = child[0]["c"]
    assert cprops["tool_type"] == "search"
    assert cprops["parent_subtask_id"] == scope_tid
    # contains: scope → child.
    contains = _cypher(
        "MATCH (s:Task {task_id: $s})-[:contains]->(c:ToolCall {task_id: $c}) "
        "RETURN count(*) AS n", s=scope_tid, c=child_tid,
    )
    assert contains[0]["n"] == 1
    # produces: child → WebPage.
    produces = _cypher(
        "MATCH (c:ToolCall {task_id: $c})-[:produces]->(w:WebPage) "
        "RETURN w.url AS url", c=child_tid,
    )
    assert len(produces) == 1
    assert produces[0]["url"] == "https://example.com/brca1"


@needs_neo4j
def test_tool_call_empty_products_writes_only_toolcall(live_client: TestClient) -> None:
    """An empty products list still creates the ToolCall — paper/web/db paths
    are optional. The session temporal chain linker still runs."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-tc-empty"
    _wipe_session(sid)
    response = live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:tc-empty-1",
            "session_id": sid,
            "turn_id": "turn-tc-empty-1",
            "tool_name": "mcp__chembl__search",
            "tool_type": "search",
            "source": "chembl",
            "products": [],
        },
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    assert body["written"] == 1
    # ToolCall landed, no product nodes attached.
    rows = _cypher(
        "MATCH (t:ToolCall {task_id: $tid}) RETURN t.seq AS seq", tid="subtask:mcp:tc-empty-1"
    )
    assert len(rows) == 1
    assert rows[0]["seq"] is not None


# --- pure-function checks (no Neo4j) -------------------------------------


def test_upsert_tool_call_skips_when_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    """is_reachable() False → warn + return, never raise into the caller."""
    from sciencediscovery_memory_graph import persistence
    calls: list[tuple[str, dict]] = []

    class _UnreachableDriver:
        def is_reachable(self) -> bool:
            return False

        def session(self):  # pragma: no cover - never reached
            raise AssertionError("session() must not be called when unreachable")

    monkeypatch.setattr(persistence, "handle", lambda: _UnreachableDriver())
    monkeypatch.setattr(persistence.log, "warning", lambda *a, **kw: calls.append(("warn", a)))

    persistence.upsert_tool_call(
        task_id="t1", session_id="s1", turn_id="u1",
        tool_name="web_search", tool_type="search",
        products=[{"product_type": "web_page", "url": "https://x.test/"}],
    )
    assert calls and calls[0][0] == "warn", "warn logged on unreachable"


@needs_neo4j
def test_pre_collapse_tool_type_is_stored_verbatim_not_rejected(
    live_client: TestClient,
) -> None:
    """A value from the old vocabulary is written as-is, never a 422.

    ``tool_type`` is deliberately a free string, not a ``Literal``: during a
    rolling deploy an older API instance still sends ``literature_search`` /
    ``db_search`` / ``web_search``. Rejecting those would fail the WHOLE
    request — the ToolCall *and* its Paper/WebPage/DbRecord products — over a
    label. Storing the label costs a chip the web app already folds
    (``LEGACY_CLASSIFICATION_ALIASES``); dropping the products costs evidence.
    The graph therefore holds both vocabularies at once, and that is the
    contract this pins — not an oversight.
    """
    sid = "sess-tc-legacy-vocab"
    _wipe_session(sid)
    for task_id, tool_name, legacy_type in [
        ("subtask:mcp:tc-legacy-lit", "mcp__pubmed__search", "literature_search"),
        ("subtask:mcp:tc-legacy-web", "mcp__llm-wiki__search", "web_search"),
        ("subtask:mcp:tc-legacy-db", "mcp__uniprot__search", "db_search"),
    ]:
        response = live_client.post(
            "/observe/tool-call",
            json={
                "task_id": task_id,
                "session_id": sid,
                "turn_id": "turn-tc-legacy",
                "tool_name": tool_name,
                "tool_type": legacy_type,
                "source": "pubmed",
                "products": [{
                    "product_type": "paper", "link": f"https://x.test/{task_id}",
                    "title": "t", "identifier": task_id, "identifierType": "PMID",
                }],
            },
            headers={"authorization": "Bearer test-token"},
        )
        assert response.status_code == 200, response.text
        assert response.json().get("status") != "degraded", response.text
    rows = _cypher(
        "MATCH (n:ToolCall) WHERE n.session_id = $sid "
        "RETURN n.task_id AS task_id, n.tool_type AS tool_type",
        sid=sid,
    )
    stored = {r["task_id"]: r["tool_type"] for r in rows}
    assert stored == {
        "subtask:mcp:tc-legacy-lit": "literature_search",
        "subtask:mcp:tc-legacy-web": "web_search",
        "subtask:mcp:tc-legacy-db": "db_search",
    }, f"legacy values must survive verbatim, got {stored}"
    # The products landed too — the point of tolerating the label.
    papers = _cypher(
        "MATCH (:ToolCall {session_id: $sid})-[:produces]->(p:Paper) RETURN count(p) AS n",
        sid=sid,
    )
    assert papers[0]["n"] == 3, "every tolerated call still produced its Paper"
    _wipe_session(sid)
