"""WebPage content_hash + CAS data pool + has_full_content.

The page body lives in the CAS data pool (graph = directory, CAS = warehouse).
The WebPage node carries only ``content_hash`` (the address) and the boolean
``has_full_content`` flag for fast reads. Search-only products carry no hash;
fetch / get_page products land the body and set the hash. The Cypher's ON
MATCH COALESCE protects an existing hash when a snippet-only product arrives
later (search after fetch must not drop the body).
"""

from __future__ import annotations

import importlib
import os
from typing import Any

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))
from fastapi.testclient import TestClient


# --- fixtures (mirror test_smoke.py / test_webpage_evidence.py) -----------

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


def _cypher(query: str, **params: Any) -> list[dict[str, Any]]:
    from sciencediscovery_memory_graph.backend import handle
    with handle().session() as s:
        result = s.run(query, **params)
        return [dict(r.items()) for r in result]


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


# --- the four contract cases ---------------------------------------------

@needs_neo4j
def test_webpage_product_with_content_hash_writes_node_state(live_client: TestClient) -> None:
    """A fetched product (content_hash present) lands: ``content_hash`` set,
    ``has_full_content = true``."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-pr9-with-hash"
    _wipe_session(sid)
    fetch_hash = "f" * 64
    r = live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:web-fetch:pr9-with-hash",
            "session_id": sid,
            "turn_id": "turn-pr9-with-hash",
            "tool_name": "web_fetch",
            "tool_type": "web_search",
            "products": [{
                "product_type": "web_page",
                "url": "https://example.com/a",
                "title": "A",
                "content_hash": fetch_hash,
            }],
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text

    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid}) "
        "RETURN w.content_hash AS content_hash, "
        "       w.has_full_content AS has_full_content",
        sid=sid,
    )
    assert len(rows) == 1
    assert rows[0]["content_hash"] == fetch_hash
    assert rows[0]["has_full_content"] is True


@needs_neo4j
def test_webpage_product_without_content_hash_stays_snippet_only(
    live_client: TestClient,
) -> None:
    """A snippet-only search product carries no content_hash; ``has_full_content``
    is false and the hash stays null. Migrated search nodes from the cutover stay in
    this state until a fetch tool lands the body."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-pr9-snippet"
    _wipe_session(sid)
    r = live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:pr9-snippet",
            "session_id": sid,
            "turn_id": "turn-pr9-snippet",
            "tool_name": "web_search",
            "tool_type": "web_search",
            "products": [{
                "product_type": "web_page",
                "url": "https://example.com/b",
                "title": "B",
                "snippet": "snippet",
            }],
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text

    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid}) "
        "RETURN w.content_hash AS content_hash, "
        "       coalesce(w.has_full_content, false) AS has_full_content",
        sid=sid,
    )
    assert len(rows) == 1
    assert rows[0]["content_hash"] is None
    assert rows[0]["has_full_content"] is False


@needs_neo4j
def test_on_match_coalesce_keeps_existing_hash(live_client: TestClient) -> None:
    """Search-then-fetch on the same URL: a fetch lands content_hash first,
    then a snippet-only search must NOT overwrite it (ON MATCH COALESCE).
    The single node still carries the original hash."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-pr9-coalesce"
    _wipe_session(sid)
    fetch_hash = "1" * 64
    # Step 1: fetch lands the body.
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:web-fetch:pr9-coalesce-1",
            "session_id": sid,
            "turn_id": "turn-pr9-coalesce-1",
            "tool_name": "web_fetch",
            "tool_type": "web_search",
            "products": [{
                "product_type": "web_page",
                "url": "https://example.com/c",
                "content_hash": fetch_hash,
            }],
        },
        headers=headers,
    )
    # Step 2: same URL surfaces again via plain search (snippet only) — must
    # not drop the body.
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:pr9-coalesce-2",
            "session_id": sid,
            "turn_id": "turn-pr9-coalesce-2",
            "tool_name": "web_search",
            "tool_type": "web_search",
            "products": [{
                "product_type": "web_page",
                "url": "https://example.com/c",
                "title": "C",
                "snippet": "fresh snippet",
            }],
        },
        headers=headers,
    )

    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid, url: 'https://example.com/c'}) "
        "RETURN count(w) AS c, w.content_hash AS content_hash, "
        "       w.has_full_content AS has_full_content",
        sid=sid,
    )
    assert len(rows) == 1
    assert rows[0]["c"] == 1, "ON MATCH must not create a duplicate WebPage"
    assert rows[0]["content_hash"] == fetch_hash, (
        "ON MATCH COALESCE must keep the existing hash when the new product is hash-less"
    )
    assert rows[0]["has_full_content"] is True


@needs_neo4j
def test_declare_evidence_gate_field_is_content_hash(live_client: TestClient) -> None:
    """The dormancy gate now keys on ``content_hash`` (not the legacy
    ``content`` field):

    - absent content_hash → 422 source_webpage_no_content
    - present content_hash → 200 ok with the Evidence created
    """
    headers = {"authorization": "Bearer test-token"}
    base = {
        "content": "x",
        "locator": "abstract",
        "evidence_type": "QUOTE",
        "confidence": "HIGH",
        "strength": "MODERATE",
    }

    # Case A: snippet-only page → 422
    sid_a = "sess-pr9-gate-no"
    _wipe_session(sid_a)
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:pr9-gate-no",
            "session_id": sid_a,
            "turn_id": "turn-pr9-gate-no",
            "tool_name": "web_search",
            "tool_type": "web_search",
            "products": [{
                "product_type": "web_page",
                "url": "https://example.com/gate",
                "title": "G",
            }],
        },
        headers=headers,
    )
    r = live_client.post(
        "/persist/evidence",
        json={
            **base,
            "session_id": sid_a,
            "source_webpage_link": "https://example.com/gate",
        },
        headers=headers,
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "source_webpage_no_content"

    # Case B: fetched page → 200 ok
    sid_b = "sess-pr9-gate-yes"
    _wipe_session(sid_b)
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:web-fetch:pr9-gate-yes",
            "session_id": sid_b,
            "turn_id": "turn-pr9-gate-yes",
            "tool_name": "web_fetch",
            "tool_type": "web_search",
            "products": [{
                "product_type": "web_page",
                "url": "https://example.com/gate",
                "content_hash": "9" * 64,
            }],
        },
        headers=headers,
    )
    r = live_client.post(
        "/persist/evidence",
        json={
            **base,
            "session_id": sid_b,
            "source_webpage_link": "https://example.com/gate",
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok"
    evidence_id = r.json()["evidence_id"]
    rows = _cypher(
        "MATCH (:WebPage {session_id: $sid})-[:extracts]->(e:Evidence "
        "{evidence_id: $eid}) RETURN e.source_webpage_link AS swl",
        sid=sid_b, eid=evidence_id,
    )
    assert len(rows) == 1
    assert rows[0]["swl"] is not None


@needs_neo4j
def test_identifier_form_page_also_carries_content_hash(live_client: TestClient) -> None:
    """The llm-wiki identifier-keyed WebPage path must write content_hash
    identically to the url-only path — the gate and the read side both
    resolve via identifier or url."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-pr9-idform"
    _wipe_session(sid)
    fetch_hash = "7" * 64
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:pr9-idform",
            "session_id": sid,
            "turn_id": "turn-pr9-idform",
            "tool_name": "mcp__llm-wiki__get_page",
            "tool_type": "web_search",
            "source": "llm-wiki",
            "products": [{
                "product_type": "web_page",
                "identifier": "wiki/BRCA1",
                "identifier_type": "wiki-path",
                "url": "http://wiki.local/BRCA1",
                "title": "BRCA1",
                "content_hash": fetch_hash,
            }],
        },
        headers=headers,
    )
    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid, identifier: 'wiki/BRCA1'}) "
        "RETURN w.content_hash AS content_hash, "
        "       w.has_full_content AS has_full_content",
        sid=sid,
    )
    assert len(rows) == 1
    assert rows[0]["content_hash"] == fetch_hash
    assert rows[0]["has_full_content"] is True
