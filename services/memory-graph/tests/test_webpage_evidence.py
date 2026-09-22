"""WebPage evidence chain (WebPage -[:extracts]-> Evidence).

Search mirrors only a snippet, so the sidecar gates the page's ``content``
field on a CAS ``content_hash``: a snippet-only page cannot back an Evidence.
The fixture sessions below never fetch a body, which is why the WebPage-source
chain kinds read as dormant *for those fixtures* — not because the edge is
unreachable in general. Once a page has been fetched (get_page / web_fetch
landing a body), ``WebPage -[:extracts]-> Evidence`` is written and the hop is
live; ``test_evidence_source_chain_returns_the_backing_webpage`` pins that
direction over a real fetched page.

These tests pin both sides of the content gate plus the corner cases:
three-way source routing (paper / file / webpage), the not-found branch, the
dormancy gate, the content-present happy path, the identifier-vs-url match
forms, and the ``_BUTTON_CHAIN_HOPS`` kinds for both WebPage source and
Evidence source. They mirror the layout of ``test_smoke.py`` (degraded + live
variants).
"""

from __future__ import annotations

import importlib
import os
from typing import Any

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))
from fastapi.testclient import TestClient


# --- fixtures (mirror test_smoke.py) ---------------------------------------

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
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_ENABLED", "1")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN", "test-token")
    from sciencediscovery_memory_graph import neo4j_driver, persistence, query, server
    importlib.reload(neo4j_driver)
    importlib.reload(persistence)
    importlib.reload(query)
    importlib.reload(server)
    return TestClient(server.app)


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


# --- three-way source routing (degraded — only auth/no-source paths run) ---

_BASE = {
    "content": "x",
    "locator": "abstract",
    "evidence_type": "QUOTE",
    "confidence": "HIGH",
    "strength": "MODERATE",
    "session_id": "sess-wev-1",
}


def test_webpage_source_degrades_without_neo4j(client: TestClient) -> None:
    """The new source_webpage_link field is accepted at the wire layer; the
    body shape parses cleanly. Without Neo4j the endpoint degrades before
    any gate runs, so we only pin that the new field doesn't 422 on
    validation."""
    response = client.post(
        "/persist/evidence",
        json={
            **_BASE,
            "source_webpage_link": "https://example.com/page",
        },
        headers={"authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["evidence_id"] is None


# --- live tests: three-way source routing + WebPage gates -------------------

@needs_neo4j
def test_persist_evidence_three_way_source_routing_no_source(live_client: TestClient) -> None:
    """All three sources empty → 422 no_source. The new field must appear in
    the instruction so the LLM learns about source_webpage_link."""
    headers = {"authorization": "Bearer test-token"}
    r = live_client.post("/persist/evidence", json={**_BASE, "session_id": "sess-wev-nosrc"},
                         headers=headers)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "no_source"
    assert "source_webpage_link" in detail["instruction"]


@needs_neo4j
def test_persist_evidence_three_way_source_routing_ambiguous_paper_webpage(
    live_client: TestClient,
) -> None:
    """paper + webpage → 422 ambiguous_source (the dual case the prompt calls
    out). The instruction MUST name all three sources so the LLM picks one."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-amb-pw"
    _wipe_session(sid)
    # Seed a Paper so the paper-only branch WOULD succeed; the dual-source
    # request must still 422 before any source validation runs (the routing
    # gate fires first).
    _cypher(
        "CREATE (p:Paper { session_id: $sid, link: 'https://example.com/p1', "
        "title: 'p1', identifier: 'p1', source: 'manual' })",
        sid=sid,
    )
    r = live_client.post(
        "/persist/evidence",
        json={
            **_BASE,
            "session_id": sid,
            "source_paper_link": "https://example.com/p1",
            "source_webpage_link": "https://example.com/page",
        },
        headers=headers,
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "ambiguous_source"
    # The wording now lists three sources (paper / file / webpage).
    for key in ("source_paper_link", "source_file_id", "source_webpage_link"):
        assert key in detail["instruction"], f"{key} missing from ambiguous_source instruction"


@needs_neo4j
def test_persist_evidence_three_way_source_routing_ambiguous_file_webpage(
    live_client: TestClient,
) -> None:
    """file + webpage → 422 ambiguous_source. Same wording as paper+webpage."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-amb-fw"
    _wipe_session(sid)
    fid = f"source_file:session:{sid}:paper.pdf"
    live_client.post(
        "/observe/upload-file",
        json={
            "session_id": sid,
            "file_id": fid,
            "name": "paper.pdf",
            "path": "paper.pdf",
            "media_type": "application/pdf",
            "size": 100,
            "content_hash": "h",
            "created_at": "2026-09-12T00:00:00Z",
        },
        headers=headers,
    )
    r = live_client.post(
        "/persist/evidence",
        json={
            **_BASE,
            "session_id": sid,
            "source_file_id": fid,
            "source_webpage_link": "https://example.com/page",
        },
        headers=headers,
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "ambiguous_source"


@needs_neo4j
def test_persist_evidence_three_way_source_routing_ambiguous_all_three(
    live_client: TestClient,
) -> None:
    """paper + file + webpage → 422 ambiguous_source."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-amb-all"
    _wipe_session(sid)
    fid = f"source_file:session:{sid}:paper.pdf"
    live_client.post(
        "/observe/upload-file",
        json={
            "session_id": sid,
            "file_id": fid,
            "name": "paper.pdf",
            "path": "paper.pdf",
            "media_type": "application/pdf",
            "size": 100,
            "content_hash": "h",
            "created_at": "2026-09-12T00:00:00Z",
        },
        headers=headers,
    )
    r = live_client.post(
        "/persist/evidence",
        json={
            **_BASE,
            "session_id": sid,
            "source_paper_link": "https://example.com/p1",
            "source_file_id": fid,
            "source_webpage_link": "https://example.com/page",
        },
        headers=headers,
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "ambiguous_source"


# --- WebPage branches: not-found, dormancy gate, content-present, id form --

@needs_neo4j
def test_persist_evidence_webpage_not_found(live_client: TestClient) -> None:
    """A page that doesn't exist in the graph → 422 source_webpage_not_found,
    with an actionable instruction (use query_graph to find the page, or fall
    back to Paper/PDF)."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-nf"
    _wipe_session(sid)
    r = live_client.post(
        "/persist/evidence",
        json={**_BASE, "session_id": sid,
              "source_webpage_link": "https://example.com/missing"},
        headers=headers,
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "source_webpage_not_found"
    assert "query_graph" in detail["instruction"]


@needs_neo4j
def test_persist_evidence_webpage_dormancy_gate_blocks_snippet_only(
    live_client: TestClient,
) -> None:
    """The dormancy gate: a WebPage whose ``content_hash`` is missing (the
    current norm — search returns snippets, no body landed in the CAS data
    pool) is rejected with source_webpage_no_content, with an instruction
    pointing the LLM at Paper/PDF sources. The gate's field swapped from
    ``content`` to ``content_hash`` (the body lives in the CAS data pool —
    nothing is stored on the node), but the behavior is unchanged."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-snippet"
    _wipe_session(sid)
    # Seed a url-only WebPage (web_search style). content_hash is absent (the
    # search mirror only writes snippet; the broker never populates content_
    # hash on a search hit).
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:wev-snippet-1",
            "session_id": sid,
            "turn_id": "turn-wev-snippet-1",
            "tool_name": "web_search",
            "tool_type": "web_search",
            "products": [
                {"product_type": "web_page",
                 "url": "https://example.com/article",
                 "title": "Example article",
                 "snippet": "a brief excerpt"},
            ],
        },
        headers=headers,
    )
    # Sanity: the page exists with no content_hash (snippet-only).
    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid, url: 'https://example.com/article'}) "
        "RETURN w.content_hash AS content_hash",
        sid=sid,
    )
    assert len(rows) == 1
    assert rows[0]["content_hash"] is None

    r = live_client.post(
        "/persist/evidence",
        json={**_BASE, "session_id": sid,
              "source_webpage_link": "https://example.com/article"},
        headers=headers,
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "source_webpage_no_content"
    # The instruction should point the LLM at the supported alternatives.
    instruction = detail["instruction"] or ""
    assert "source_paper_link" in instruction
    assert "source_file_id" in instruction
    # The headline assertion of the PR: the gate is open, not bypassed —
    # nothing was created.
    rows_after = _cypher(
        "MATCH (:WebPage {session_id: $sid})-[:extracts]->(e:Evidence) "
        "RETURN count(e) AS c",
        sid=sid,
    )
    assert rows_after[0]["c"] == 0, "dormancy gate must NOT create any Evidence"


@needs_neo4j
def test_persist_evidence_webpage_content_present_lets_through(
    live_client: TestClient,
) -> None:
    """When the page's ``content_hash`` is populated (simulating get_page /
    web_fetch landing the body in the CAS data pool), the gate passes and
    the Evidence + extracts edge land. The Evidence's ``source_webpage_link``
    is the normalised link; ``source_paper_link`` and ``source_file_id`` are
    explicit null (uniform shape across the three branches)."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-content"
    _wipe_session(sid)
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:wev-content-1",
            "session_id": sid,
            "turn_id": "turn-wev-content-1",
            "tool_name": "web_search",
            "tool_type": "web_search",
            "products": [
                {"product_type": "web_page",
                 "url": "https://example.com/article",
                 "title": "Example article"},
            ],
        },
        headers=headers,
    )
    # Simulate a page-fetch populating the body in the CAS data pool (the
    # only the hash lives on the node; the text lives off-graph).
    _cypher(
        "MATCH (w:WebPage {session_id: $sid, url: 'https://example.com/article'}) "
        "SET w.content_hash = $h",
        sid=sid,
        h="a" * 64,
    )

    r = live_client.post(
        "/persist/evidence",
        json={**_BASE, "session_id": sid,
              "source_webpage_link": "https://example.com/article"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    evidence_id = body["evidence_id"]
    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid})-[:extracts]->(e:Evidence "
        "{evidence_id: $eid}) "
        "RETURN w.url AS url, e.source_paper_link AS spl, "
        "e.source_file_id AS sfi, e.source_webpage_link AS swl",
        sid=sid, eid=evidence_id,
    )
    assert len(rows) == 1
    row = rows[0]
    # source_paper_link and source_file_id are explicit null on this branch.
    assert row["spl"] is None
    assert row["sfi"] is None
    # source_webpage_link stores the normalised link (lowercased, etc.).
    assert row["swl"] == row["url"]


@needs_neo4j
def test_persist_evidence_webpage_identifier_form_matches(
    live_client: TestClient,
) -> None:
    """An llm-wiki page has ``identifier`` (= the wiki path) but the LLM
    may pass that identifier as ``source_webpage_link``. The server's MATCH
    must accept either form (url or identifier)."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-idform"
    _wipe_session(sid)
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:wev-idform-1",
            "session_id": sid,
            "turn_id": "turn-wev-idform-1",
            "tool_name": "mcp__llm-wiki__search",
            "tool_type": "web_search",
            "source": "llm-wiki",
            "products": [
                {"product_type": "web_page", "identifier": "wiki/BRCA1",
                 "identifier_type": "wiki-path",
                 "url": "http://wiki.local/BRCA1", "title": "BRCA1"},
            ],
        },
        headers=headers,
    )
    _cypher(
        "MATCH (w:WebPage {session_id: $sid, identifier: 'wiki/BRCA1'}) "
        "SET w.content_hash = $h",
        sid=sid,
        h="b" * 64,
    )
    # Pass the identifier form (NOT a url). _normalize_link would mangle it
    # (wiki/BRCA1 → https://wiki/brca1), so the probe and the write must
    # BOTH match the raw form — the historical bug here was the probe
    # matching raw while the persistence Cypher matched only the normalised
    # value, silently creating nothing (Cypher CREATE is a no-op when the
    # preceding MATCH has no rows) while the endpoint still returned ok.
    r = live_client.post(
        "/persist/evidence",
        json={**_BASE, "session_id": sid,
              "source_webpage_link": "wiki/BRCA1"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok"
    evidence_id = r.json()["evidence_id"]
    # The Evidence MUST actually exist, with the extracts edge from the page
    # and the page's own key stored (url when present, else identifier).
    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid, identifier: 'wiki/BRCA1'})"
        "-[:extracts]->(e:Evidence {evidence_id: $eid}) "
        "RETURN coalesce(w.url, w.identifier) AS page_key, "
        "e.source_webpage_link AS swl, e.source_paper_link AS spl, "
        "e.source_file_id AS sfi",
        sid=sid, eid=evidence_id,
    )
    assert len(rows) == 1, "Evidence must be created with the extracts edge"
    assert rows[0]["swl"] == rows[0]["page_key"]
    assert rows[0]["spl"] is None
    assert rows[0]["sfi"] is None


# --- chain hops for WebPage -----------------------------------------------

@needs_neo4j
def test_webpage_chain_dormant_extracts_and_live_searching_task(
    live_client: TestClient,
) -> None:
    """The four WebPage chain kinds: extracts / citing-claim / citing-artifact
    are empty for THIS fixture (its page never fetched a body, so no extracts
    edge was written), while searching-task is live (every WebPage has a
    produces<-ToolCall from the search that surfaced it).

    Use an llm-wiki-style WebPage here so the source resolves via
    ``n.identifier = $id``. The url-only form resolves too (it has its own
    branch in ``_resolve_source_node``) — that path is pinned separately by
    ``test_webpage_url_keyed_source_resolves_its_chain_buttons``, so this test
    keeps covering the identifier form."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-chains"
    _wipe_session(sid)
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:wev-chains-1",
            "session_id": sid,
            "turn_id": "turn-wev-chains-1",
            "tool_name": "mcp__llm-wiki__search",
            "tool_type": "web_search",
            "source": "llm-wiki",
            "products": [
                {"product_type": "web_page", "identifier": "wiki/X",
                 "identifier_type": "wiki-path",
                 "url": "http://wiki.local/X", "title": "X"},
            ],
        },
        headers=headers,
    )
    # The chain source resolves via the WebPage's identifier (the
    # _resolve_source_node MATCH is on n.identifier = $id, not n.url).
    candidate = "wiki/X"
    # Search-tool chain: live today (the ToolCall produces<-).
    r = live_client.post(
        "/query/chain-exists",
        json={"node_id": candidate, "session_id": sid,
              "kinds": ["viewSearchingTaskForWebPage"]},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["viewSearchingTaskForWebPage"] is True
    # Dormant chains: nothing writes WebPage -[:extracts]-> Evidence yet.
    for kind in ("viewExtractedEvidenceForWebPage",
                 "viewCitingClaimForWebPage",
                 "viewCitingArtifactForWebPage"):
        r = live_client.post(
            "/query/chain-exists",
            json={"node_id": candidate, "session_id": sid, "kinds": [kind]},
            headers=headers,
        )
        assert r.status_code == 200
        assert r.json()[kind] is False, (
            f"{kind} should be dormant for a page with no extracts edge")


@needs_neo4j
def test_webpage_url_keyed_source_resolves_its_chain_buttons(
    live_client: TestClient,
) -> None:
    """A url-only WebPage (a web_search / web_fetch hit: no ``identifier``)
    must resolve as a chain source from the id the canvas actually sends —
    ``"url:<url>"`` — and light its chain buttons.

    Regression: ``_resolve_source_node`` matched ``n.identifier = $id`` only.
    A url-keyed page carries no identifier, so it resolved to nothing and
    every chain endpoint degraded *silently* rather than erroring —
    ``get_chain`` answered ``node_not_found`` and ``chain_exists`` reported
    all-False for all four kinds. Clicking such a node on the canvas showed no
    buttons at all, even for a page that really had ``extracts``→Evidence in
    the graph (the live session had six). The ``"url:"`` encoding that
    ``_node_identity`` emits (and ``get_web_page_content_hash`` already
    decoded) was simply never decoded here.

    The fixture deliberately has NO identifier: that is the whole point.
    """
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-urlsource"
    _wipe_session(sid)
    page_url = "https://example.com/url-keyed-page"
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:wev-urlsource-1",
            "session_id": sid,
            "turn_id": "turn-wev-urlsource-1",
            "tool_name": "web_search",
            "tool_type": "web_search",
            "products": [
                {"product_type": "web_page", "url": page_url,
                 "title": "Url-keyed page"},
            ],
        },
        headers=headers,
    )
    # No identifier on this node — assert the fixture rather than trust it.
    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid}) "
        "RETURN w.identifier AS identifier, w.url AS url", sid=sid,
    )
    assert len(rows) == 1
    assert rows[0]["identifier"] is None, "fixture must be a url-only WebPage"
    assert rows[0]["url"] == page_url
    # Body present → the content gate lets the evidence through, so the
    # extracts hop has something to walk.
    _cypher(
        "MATCH (w:WebPage {session_id: $sid}) SET w.content_hash = $h",
        sid=sid, h="c" * 64,
    )
    ev = live_client.post(
        "/persist/evidence",
        json={**_BASE, "session_id": sid, "source_webpage_link": page_url},
        headers=headers,
    )
    assert ev.status_code == 200, ev.text
    assert ev.json()["status"] == "ok", ev.text
    # The canvas sends the subgraph node id — the "url:" form.
    sub = live_client.get("/subgraph", params={"session_id": sid},
                          headers=headers).json()
    page_node = next(n for n in sub["nodes"] if n["label"] == "WebPage")
    assert page_node["id"] == f"url:{page_url}", page_node["id"]

    kinds = ["viewExtractedEvidenceForWebPage", "viewCitingClaimForWebPage",
             "viewCitingArtifactForWebPage", "viewSearchingTaskForWebPage"]
    exists = live_client.post(
        "/query/chain-exists",
        json={"node_id": page_node["id"], "session_id": sid, "kinds": kinds},
        headers=headers,
    ).json()
    # extracts is live (the evidence landed) and the search ToolCall is live;
    # the two longer kinds are empty only because this Claim-less fixture has
    # no supports→Claim edge — not because the source failed to resolve. So
    # assert those two explicitly as False and the first + last as True.
    assert exists["viewExtractedEvidenceForWebPage"] is True, exists
    assert exists["viewSearchingTaskForWebPage"] is True, exists
    assert exists["viewCitingClaimForWebPage"] is False, exists
    assert exists["viewCitingArtifactForWebPage"] is False, exists

    # get_chain must resolve the same id (it shares _resolve_source_node) and
    # return the source WebPage plus the evidence it extracted.
    chain = live_client.post(
        "/query/chain",
        json={"node_id": page_node["id"], "session_id": sid,
              "kind": "viewExtractedEvidenceForWebPage"},
        headers=headers,
    ).json()
    labels = sorted(n["label"] for n in chain["nodes"])
    assert labels == ["Evidence", "WebPage"], labels
    assert ev.json()["evidence_id"] in {n["id"] for n in chain["nodes"]}

    # Negative control: an id in the "url:" form that matches no page still
    # degrades to all-False rather than 404-ing the batch (a 404 here would
    # take down every button on the node — see chain_exists's contract).
    missing = live_client.post(
        "/query/chain-exists",
        json={"node_id": "url:https://example.com/absent", "session_id": sid,
              "kinds": kinds},
        headers=headers,
    )
    assert missing.status_code == 200
    assert set(missing.json().values()) == {False}
    _wipe_session(sid)


@needs_neo4j
def test_evidence_source_chain_returns_the_backing_webpage(
    live_client: TestClient,
) -> None:
    """The ``viewSourcePaper`` hop from an Evidence reaches a WebPage.

    This is the hop EvidenceModal walks to fill its Provenance tab. The hop
    tuple names the label "Paper", but ``target_label`` is documentation only
    — ``_walk_hops`` matches any node of the ``extracts`` edge type — so an
    Evidence backed by a fetched page really does surface that WebPage over
    this kind. The modal used to collect only Paper/SourceFile nodes and
    printed "no source recorded" for a WebPage-only provenance, discarding a
    node the API had already handed it.

    The ``extra.content_hash`` assertion is what lets the modal's source card
    read the page body: the reused WebPageDetail gates its CAS fetch on that
    field arriving in the chain payload, and ``_to_hit`` is what carries it.

    Note the difference in direction from the tests above: this one walks
    *into* the Evidence (``extracts`` in) rather than out of a WebPage, so it
    is live whenever a page-backed Evidence exists."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-srcpaper"
    _wipe_session(sid)
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:wev-srcpaper-1",
            "session_id": sid,
            "turn_id": "turn-wev-srcpaper-1",
            "tool_name": "web_search",
            "tool_type": "web_search",
            "products": [
                {"product_type": "web_page",
                 "url": "https://example.com/target-page",
                 "title": "Target page"},
            ],
        },
        headers=headers,
    )
    page_hash = "b" * 64
    _cypher(
        "MATCH (w:WebPage {session_id: $sid, url: 'https://example.com/target-page'}) "
        "SET w.content_hash = $h, w.has_full_content = true",
        sid=sid,
        h=page_hash,
    )
    r = live_client.post(
        "/persist/evidence",
        json={**_BASE, "session_id": sid,
              "source_webpage_link": "https://example.com/target-page"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    evidence_id = r.json()["evidence_id"]

    # chain_exists and get_chain must agree — same walk, same non-empty verdict.
    r = live_client.post(
        "/query/chain-exists",
        json={"node_id": evidence_id, "session_id": sid,
              "kinds": ["viewSourcePaper"]},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["viewSourcePaper"] is True, (
        "a WebPage-backed Evidence has a source, so the button must be live")

    r = live_client.post(
        "/query/chain",
        json={"node_id": evidence_id, "session_id": sid, "kind": "viewSourcePaper"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    pages = [n for n in body["nodes"] if n["label"] == "WebPage"]
    assert len(pages) == 1, (
        f"the chain must carry the backing WebPage; got "
        f"{[(n['label'], n['id']) for n in body['nodes']]}")
    # id is the url-keyed form (`url:<url>`) since this node carries no
    # identifier — see _node_identity.
    assert pages[0]["id"] == "url:https://example.com/target-page"
    assert pages[0]["extra"].get("content_hash") == page_hash, (
        "the body address must survive into the chain payload, or the "
        "modal's source card cannot fetch the page text")


@needs_neo4j
def test_webpage_chain_get_chain_matches_chain_exists(live_client: TestClient) -> None:
    """``chain_exists`` and ``get_chain`` MUST share the same walk (the
    existing per-button rule). For the live searching-task chain, get_chain
    returns at least one node; the dormant chains return an empty list."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wev-getchain"
    _wipe_session(sid)
    live_client.post(
        "/observe/tool-call",
        json={
            "task_id": "subtask:mcp:wev-getchain-1",
            "session_id": sid,
            "turn_id": "turn-wev-getchain-1",
            "tool_name": "mcp__llm-wiki__search",
            "tool_type": "web_search",
            "source": "llm-wiki",
            "products": [
                {"product_type": "web_page", "identifier": "wiki/Y",
                 "identifier_type": "wiki-path",
                 "url": "http://wiki.local/Y", "title": "Y"},
            ],
        },
        headers=headers,
    )
    candidate = "wiki/Y"
    # Live chain.
    r = live_client.post(
        "/query/chain",
        json={"node_id": candidate, "session_id": sid,
              "kind": "viewSearchingTaskForWebPage"},
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 1
    assert any(n["label"] == "ToolCall" for n in body["nodes"])
    # Dormant chains.
    for kind in ("viewExtractedEvidenceForWebPage",
                 "viewCitingClaimForWebPage",
                 "viewCitingArtifactForWebPage"):
        r = live_client.post(
            "/query/chain",
            json={"node_id": candidate, "session_id": sid, "kind": kind},
            headers=headers,
        )
        assert r.status_code == 200
        assert r.json()["total"] == 0, f"{kind} must be empty this iteration"


# --- unified url key + O(1) content-hash lookup -----------------------------

@needs_neo4j
def test_webpage_single_url_key_no_cross_collision(live_client: TestClient) -> None:
    """WebPage now keys on url alone: a url-only web_search result followed by
    an identifier+url get_page result for the SAME url must MERGE onto one node
    instead of colliding, and the ON MATCH COALESCE must backfill the
    identifier the search-first node was missing (otherwise the node id stays
    stuck on ``url:…`` and chip/evidence lookups by bare identifier break).
    The old two-key design (MERGE on identifier, url set on CREATE) would
    CREATE a second node here and hit the (session_id, url) unique constraint
    → 500."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wp-singlekey"
    _wipe_session(sid)
    url = "https://example.com/brca1"
    # 1. url-only (web_search).
    r1 = live_client.post("/observe/tool-call", json={
        "task_id": "subtask:mcp:wk-1", "session_id": sid, "turn_id": "t1",
        "tool_name": "web_search", "tool_type": "web_search",
        "products": [{"product_type": "web_page", "url": url, "title": "BRCA1"}],
    }, headers=headers)
    assert r1.status_code == 200
    # 2. identifier + same url (get_page) — must NOT 500 on a constraint clash,
    #    and must backfill the identifier onto the merged node.
    r2 = live_client.post("/observe/tool-call", json={
        "task_id": "subtask:mcp:wk-2", "session_id": sid, "turn_id": "t2",
        "tool_name": "get_page", "tool_type": "web_search",
        "products": [{"product_type": "web_page", "url": url,
                      "identifier": "wiki/BRCA1", "title": "BRCA1 full"}],
    }, headers=headers)
    assert r2.status_code == 200, r2.text
    # One merged WebPage node, not two, with the identifier backfilled.
    rows = _cypher(
        "MATCH (w:WebPage {session_id: $sid}) RETURN count(w) AS n, w.identifier AS id",
        sid=sid)
    assert rows[0]["n"] == 1, "url-only + identifier writes must merge to one node"
    assert rows[0]["id"] == "wiki/BRCA1", "search→fetch must backfill the identifier"
    _wipe_session(sid)


@needs_neo4j
def test_webpage_content_hash_endpoint_resolves_both_id_forms(
    live_client: TestClient,
) -> None:
    """GET /web-pages/content-hash resolves a WebPage's CAS hash for both id
    forms the subgraph emits — ``url:<url>`` (web_search) and the bare
    identifier (llm-wiki) — and returns null for absent / hash-less nodes.
    This is the O(1) replacement for pulling the whole /subgraph to read one
    node's hash."""
    headers = {"authorization": "Bearer test-token"}
    sid = "sess-wp-hash"
    _wipe_session(sid)
    # url-only node with a body hash.
    live_client.post("/observe/tool-call", json={
        "task_id": "subtask:mcp:wh-1", "session_id": sid, "turn_id": "t1",
        "tool_name": "web_search", "tool_type": "web_search",
        "products": [{"product_type": "web_page", "url": "https://example.com/a",
                      "content_hash": "a" * 64}],
    }, headers=headers)
    # identifier node with a body hash (llm-wiki shape).
    live_client.post("/observe/tool-call", json={
        "task_id": "subtask:mcp:wh-2", "session_id": sid, "turn_id": "t2",
        "tool_name": "get_page", "tool_type": "web_search",
        "products": [{"product_type": "web_page", "url": "https://wiki.local/b",
                      "identifier": "wiki/b", "content_hash": "b" * 64}],
    }, headers=headers)

    def lookup(web_page_id: str) -> str | None:
        r = live_client.get("/web-pages/content-hash",
                            params={"session_id": sid, "web_page_id": web_page_id},
                            headers=headers)
        assert r.status_code == 200, r.text
        return r.json()["content_hash"]

    assert lookup("url:https://example.com/a") == "a" * 64
    assert lookup("wiki/b") == "b" * 64
    assert lookup("url:https://example.com/ghost") is None
    assert lookup("wiki/ghost") is None
    _wipe_session(sid)
