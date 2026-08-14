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

"""FastAPI app: health, write hooks, subgraph read, password push.

Routes:

- ``GET /health`` → ``{status}`` (healthy/degraded/disabled/needs-password)
- ``POST /observe/execution`` (Bearer) → upsert one execution's nodes + edges
- ``POST /observe/mcp-search`` (Bearer) → upsert one MCP search's SubTask + Papers
- ``POST /observe/session-first-message`` (Bearer) → upsert ResearchGoal from
  a session's first user message (passive fallback, one goal per session)
- ``POST /observe/session-plan`` (Bearer) → mirror a SessionPlan's steps into
  a SubTask skeleton + linear ``next`` chain, correcting the goal's scope/domain
- ``GET /subgraph?session_id=...`` (Bearer) → ``{nodes, edges, total, truncated}``
- ``POST /query/by-node-type`` (Bearer) → filter nodes by label(s)
- ``POST /query/by-edge-type`` (Bearer) → filter edges by type(s) + endpoint nodes
- ``POST /query/match`` (Bearer) → full-graph case-insensitive substring search
- ``POST /query/chain`` (Bearer) → preset upstream↔downstream chain from a node
- ``POST /trace/provenance`` (Bearer) → ordered provenance chain + ``broken``/``truncated``/``reason`` (reviewer authenticity check)
- ``GET /nodes/{label}/{id}`` (Bearer) → single-node detail (full ``extra``)
- ``POST /internal/neo4j-password`` (Bearer) → push plaintext password, run
  ``ensure_schema()`` if reachable

Loopback only. Bearer via ``SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN``.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from .auth import require_internal_token
from .constraints import ensure_schema
from .logging_config import get_logger
from .neo4j_driver import handle
from .persistence import (
    _normalize_link,
    declare_claim,
    declare_evidence,
    link_claims_to_report,
    upsert_execution,
    upsert_mcp_search,
    upsert_session_first_message,
    upsert_session_plan,
)
from .query import (
    by_edge_type,
    by_node_type,
    get_artifact_provenance,
    get_chain,
    get_node,
    get_subgraph,
    get_trace,
    query_match,
)

log = get_logger("server")

app = FastAPI(title="science-agent-memory-graph")

# Node/edge label vocabularies mirrored from ``packages/schema`` (7 + 7).
# Used for request validation so a bad_request response is returned before
# any Cypher runs. ``states`` links a report Artifact to the Claim it asserts
# (Artifact → Claim); the legacy ``presents``/Report hop has been removed in
# favor of ``states`` (a report Artifact states a Claim directly, no separate
# Report label).
_NODE_LABELS = {"ResearchGoal", "SubTask", "Paper", "Evidence", "Claim", "Code", "Artifact"}
_EDGE_TYPES = {"next", "produces", "extracted_from", "cites", "states", "supersedes", "input"}


def _error(code: str, http: int, message: str, instruction: str | None = None) -> None:
    """Raise an HTTPException with a uniform ``{code, message, instruction?}``
    envelope. Keeping one shape lets the Node API reverse-proxy and the frontend
    handle every validation failure the same way. ``instruction`` is an
    actionable next step surfaced to the LLM (absent for availability failures
    where there is nothing to fix at the call site).
    """
    detail: dict[str, Any] = {"code": code, "message": message}
    if instruction:
        detail["instruction"] = instruction
    raise HTTPException(status_code=http, detail=detail)


# --- Health -----------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, str]:
    driver = handle()
    if not driver.has_password:
        log.info("health: no Neo4j password yet, waiting for the API to push one")
        return {"status": "needs-password"}
    reachable = driver.is_reachable()
    status = "healthy" if reachable else "degraded"
    log.info("health: Neo4j %s, memory graph %s",
             "reachable" if reachable else "unreachable", status)
    return {"status": status}


# --- Write: observeExecution ------------------------------------------------

class ProducedArtifact(BaseModel):
    artifact_id: str
    path: str | None = None
    version: int | None = None
    media_type: str | None = None
    # Mirrors SessionStore's ScientificArtifact.logicalName onto the graph node
    # (UI renders "squares.csv" from this). Carries the same value as ``path``
    # today (Node-side logicalName == logicalPath) but is a distinct field for
    # schema alignment.
    logical_name: str | None = None
    project_id: str | None = None
    # Composite-key pairs ``{artifact_id, version}`` for the Artifact versions
    # this Code run read as inputs — drives the ``input`` edge (Artifact→Code)
    # in upsert_execution. Absent/None when the run read no other artifacts.
    # MUST be declared explicitly: Pydantic v2 defaults to extra="ignore", so
    # an undeclared field is silently dropped at validation — model_dump() then
    # omits it and the ``input`` edge never gets built (the bug this field fixes;
    # see docs/memory-graph-derived-from-impl.md §0.1). Declared as a list of
    # dict rather than a typed sub-model to match the loose ``art.get(...) or
    # []`` consumption in persistence.py.
    input_artifact_versions: list[dict[str, Any]] | None = None
    # The turn this version was produced in — review routing key (review is
    # filtered by version.turnId on the Node side). Mirrored onto the version
    # node so the provenance aggregate can return it without a store round-trip.
    turn_id: str | None = None
    # The produced artifact's CAS content hash — mirrored so the aggregate
    # returns the artifact body's addressing info (graph = directory, CAS =
    # warehouse; the blob itself stays in CAS).
    content_hash: str | None = None


class ObserveExecutionRequest(BaseModel):
    execution_id: str
    session_id: str
    turn_id: str
    tool: str
    language: str | None = None
    code_hash: str
    exit_code: int | None = None
    status: str
    started_at: str
    finished_at: str
    task_type: str = "code_execution"
    produced_artifacts: list[ProducedArtifact] = Field(default_factory=list)
    # Provenance addressing info mirrored onto the Code node (CAS hashes for
    # the executionLog/code/environments blocks). All None when the Node side
    # could not supply them (e.g. shell runs have no env snapshot).
    stdout_hash: str | None = None
    stderr_hash: str | None = None
    env_hash: str | None = None


@app.post("/observe/execution", dependencies=[Depends(require_internal_token)])
def observe_execution(req: ObserveExecutionRequest) -> dict[str, Any]:
    driver = handle()
    log.info("observe/execution in: execution=%s session=%s tool=%s status=%s produced=%d file(s)",
             req.execution_id, req.session_id, req.tool, req.status, len(req.produced_artifacts))
    if not driver.is_reachable():
        log.warning("observe/execution skipped: Neo4j not reachable, this run will not be mirrored")
        return {"status": "degraded", "written": 0}
    try:
        upsert_execution(
            execution_id=req.execution_id,
            session_id=req.session_id,
            turn_id=req.turn_id,
            tool=req.tool,
            language=req.language,
            code_hash=req.code_hash,
            exit_code=req.exit_code,
            status=req.status,
            started_at=req.started_at,
            finished_at=req.finished_at,
            task_type=req.task_type,
            produced_artifacts=[a.model_dump() for a in req.produced_artifacts],
            stdout_hash=req.stdout_hash,
            stderr_hash=req.stderr_hash,
            env_hash=req.env_hash,
        )
        written = 1 + len(req.produced_artifacts)
        log.info("observe/execution done: execution=%s wrote %d node(s)", req.execution_id, written)
        return {"status": "healthy", "written": written}
    except Exception as exc:  # pragma: no cover - belt-and-suspenders
        log.exception("observe/execution failed: execution=%s: %s", req.execution_id, exc)
        raise HTTPException(status_code=500, detail=f"upsert failed: {exc}")


# --- Write: observeMcpInvocation --------------------------------------------

class McpSearchRecord(BaseModel):
    """One record from a successful MCP literature-search invocation.

    Only records with a ``url`` contribute a Paper node (the link is the dedup
    key); records without a URL are dropped on the Python side.
    """

    url: str
    title: str | None = None
    identifier: str | None = None
    identifierType: str | None = None
    year: str | None = None
    authors: list[str] | None = None
    abstract: str | None = None
    source: str | None = None


class ObserveMcpSearchRequest(BaseModel):
    invocation_id: str
    session_id: str
    turn_id: str
    source: str
    tool_type: str
    retrieved_at: str
    records: list[McpSearchRecord] = Field(default_factory=list)


@app.post("/observe/mcp-search", dependencies=[Depends(require_internal_token)])
def observe_mcp_search(req: ObserveMcpSearchRequest) -> dict[str, Any]:
    driver = handle()
    log.info("observe/mcp-search in: invocation=%s session=%s source=%s records=%d",
             req.invocation_id, req.session_id, req.source, len(req.records))
    if not driver.is_reachable():
        log.warning("observe/mcp-search skipped: Neo4j not reachable, this search will not be mirrored")
        return {"status": "degraded", "written": 0}
    try:
        upsert_mcp_search(
            invocation_id=req.invocation_id,
            session_id=req.session_id,
            turn_id=req.turn_id,
            source=req.source,
            tool_type=req.tool_type,
            retrieved_at=req.retrieved_at,
            records=[r.model_dump() for r in req.records],
        )
        # 1 SubTask + N Papers (only those with a URL; the rest are dropped).
        papers_with_url = sum(1 for r in req.records if r.url)
        written = 1 + papers_with_url
        log.info("observe/mcp-search done: invocation=%s wrote %d node(s) (%d papers)",
                 req.invocation_id, written, papers_with_url)
        return {"status": "healthy", "written": written, "papers": papers_with_url}
    except Exception as exc:  # pragma: no cover - belt-and-suspenders
        log.exception("observe/mcp-search failed: invocation=%s: %s", req.invocation_id, exc)
        raise HTTPException(status_code=500, detail=f"upsert failed: {exc}")


# --- Read: subgraph ---------------------------------------------------------

@app.get("/subgraph", dependencies=[Depends(require_internal_token)])
def read_subgraph(session_id: str = Query(...)) -> dict[str, Any]:
    log.info("subgraph in: reading graph for session=%s", session_id)
    result = get_subgraph(session_id)
    if result.get("reason"):
        log.info("subgraph out: empty for session=%s (reason=%s)", session_id, result["reason"])
    else:
        log.info("subgraph out: session=%s returned %d node(s) and %d edge(s)%s",
                 session_id, result["total"], len(result["edges"]),
                 " [truncated at 500]" if result["truncated"] else "")
    return result


# --- Read: query/* (cross-session search + chain) ----------------------------

class ByNodeTypeRequest(BaseModel):
    node_types: list[str] = Field(default_factory=list)
    session_id: str | None = None


class ByEdgeTypeRequest(BaseModel):
    edge_types: list[str] = Field(default_factory=list)
    session_id: str | None = None


class MatchRequest(BaseModel):
    query: str
    session_id: str | None = None


class ChainRequest(BaseModel):
    node_id: str
    session_id: str | None = None
    # Pins an Artifact source to a specific version (composite key); ignored
    # for non-Artifact labels. Absent → latest version of that artifact_id.
    version: int | None = None
    # Which chain to walk: ``full`` (default, joint upstream↔downstream
    # subgraph — backward-compatible), ``task`` (pure next+produces spine),
    # or ``artifact`` (directed walk from the report anchor, pruned to the
    # path reaching the selected node). The frontend picks one per button.
    chain_kind: str = "full"


class TraceProvenanceRequest(BaseModel):
    node_id: str
    target_label: str | None = None
    max_hops: int = 8
    session_id: str | None = None


@app.post("/query/by-node-type", dependencies=[Depends(require_internal_token)])
def read_by_node_type(req: ByNodeTypeRequest) -> dict[str, Any]:
    invalid = [t for t in req.node_types if t not in _NODE_LABELS]
    if not req.node_types:
        _error("bad_request", 400, "node_types must be a non-empty list")
    if invalid:
        _error("bad_request", 400, f"unknown node types: {invalid}")
    log.info("by-node-type in: types=%s session=%s", req.node_types, req.session_id or "-")
    result = by_node_type(req.node_types, req.session_id)
    log.info("by-node-type out: %d hit(s)%s%s",
             result["total"],
             " [truncated at 500]" if result["truncated"] else "",
             f" (reason={result.get('reason')})" if result.get("reason") else "")
    return result


@app.post("/query/by-edge-type", dependencies=[Depends(require_internal_token)])
def read_by_edge_type(req: ByEdgeTypeRequest) -> dict[str, Any]:
    invalid = [t for t in req.edge_types if t not in _EDGE_TYPES]
    if not req.edge_types:
        _error("bad_request", 400, "edge_types must be a non-empty list")
    if invalid:
        _error("bad_request", 400, f"unknown edge types: {invalid}")
    log.info("by-edge-type in: types=%s session=%s", req.edge_types, req.session_id or "-")
    result = by_edge_type(req.edge_types, req.session_id)
    log.info("by-edge-type out: %d edge(s) / %d node(s)%s%s",
             result["total"], len(result["nodes"]),
             " [truncated at 500]" if result["truncated"] else "",
             f" (reason={result.get('reason')})" if result.get("reason") else "")
    return result


@app.post("/query/match", dependencies=[Depends(require_internal_token)])
def read_match(req: MatchRequest) -> dict[str, Any]:
    if not req.query.strip():
        _error("bad_request", 400, "query must be non-empty")
    log.info("match in: query=%s session=%s", req.query, req.session_id or "-")
    result = query_match(req.query, req.session_id)
    log.info("match out: %d hit(s)%s%s",
             result["total"],
             " [truncated at 500]" if result["truncated"] else "",
             f" (reason={result.get('reason')})" if result.get("reason") else "")
    return result


@app.post("/query/chain", dependencies=[Depends(require_internal_token)])
def read_chain(req: ChainRequest) -> dict[str, Any]:
    if not req.node_id.strip():
        _error("bad_request", 400, "node_id must be non-empty")
    if req.chain_kind not in {"full", "task", "artifact"}:
        _error("bad_request", 400, "chain_kind must be 'full', 'task', or 'artifact'")
    log.info("chain in: node_id=%s session=%s version=%s kind=%s",
             req.node_id, req.session_id or "-", req.version, req.chain_kind)
    result = get_chain(req.node_id, req.session_id, req.version, req.chain_kind)
    if result.get("reason") == "node_not_found":
        _error("not_found", 404, f"node not found: {req.node_id}")
    log.info("chain out: %d node(s) / %d edge(s)%s%s",
             result["total"], len(result["edges"]),
             " [truncated at 500]" if result["truncated"] else "",
             f" (reason={result.get('reason')})" if result.get("reason") else "")
    return result


@app.get("/query/artifact-provenance", dependencies=[Depends(require_internal_token)])
def read_artifact_provenance(
    artifact_id: str = Query(..., min_length=1),
    version: int = Query(..., ge=1),
    session_id: str | None = Query(None),
) -> dict[str, Any]:
    """Aggregate one Artifact version's derived-from dependencies via the
    ``input``/``produces`` 2-hop. Returns ``dependencies`` only (the other
    four provenance fields stay on the legacy SessionStore endpoint). Mirrors
    ``get_subgraph``'s defensive contract: an unreachable driver returns empty
    dependencies + a ``reason`` rather than erroring.
    """
    log.info("artifact-provenance in: artifact=%s v=%s session=%s", artifact_id, version, session_id or "-")
    result = get_artifact_provenance(artifact_id, version, session_id)
    log.info("artifact-provenance out: artifact=%s v=%s dependencies=%d%s",
             artifact_id, version, len(result["dependencies"]),
             f" (reason={result.get('reason')})" if result.get("reason") else "")
    return result


@app.post("/trace/provenance", dependencies=[Depends(require_internal_token)])
def trace_provenance(req: TraceProvenanceRequest) -> dict[str, Any]:
    # Validate before any Cypher runs so a bad request is a 400, not a 500.
    # target_label/max_hops bounds mirror docs/05 §3.1. Direction is fixed to
    # upstream (the walk always traces toward the origin — see get_trace).
    if not req.node_id.strip():
        _error("bad_request", 400, "node_id must be non-empty")
    target = req.target_label or "ResearchGoal"
    if target not in _NODE_LABELS:
        _error("bad_request", 400, f"unknown target label: {target}")
    if not (1 <= req.max_hops <= 32):
        _error("bad_request", 400, "max_hops must be in [1, 32]")
    log.info("trace in: node_id=%s target=%s max_hops=%d session=%s",
             req.node_id, target, req.max_hops, req.session_id or "-")
    result = get_trace(
        node_id=req.node_id,
        target_label=target,
        max_hops=req.max_hops,
        session_id=req.session_id,
    )
    if result.get("reason") == "start_node_not_found":
        _error("not_found", 404, f"node not found: {req.node_id}")
    log.info("trace out: hops=%d broken=%s truncated=%s%s",
             len(result["chain"]), result["broken"], result["truncated"],
             f" (reason={result.get('reason')})" if result.get("reason") else "")
    return result


# --- Read: node detail ------------------------------------------------------

@app.get("/nodes/{label}/{id}", dependencies=[Depends(require_internal_token)])
def read_node(label: str, id: str) -> dict[str, Any]:
    if label not in _NODE_LABELS:
        _error("bad_request", 400, f"unknown node label: {label}")
    log.info("node in: label=%s id=%s", label, id)
    result = get_node(label, id)
    if result is None:
        _error("not_found", 404, f"{label} not found: {id}")
    log.info("node out: label=%s id=%s", label, id)
    return result


# --- Write: declare_* (LLM tools, business errors surface as 422) -----------
#
# Unlike observe_*, these are called explicitly by the LLM and must return
# a structured {code, message} 422 on business errors (source_paper_not_found /
# no_cites_target / task_not_found / evidence_not_found / artifact_not_found)
# so the LLM can react (swap the Paper, add a cite, give up). _error raises the
# HTTPException with the {code, message} envelope; the Node client's
# postJsonWithBody parses it.

def _node_exists(label: str, id_field: str, value: str) -> bool:
    """Cheap existence probe before a declare Cypher runs."""
    driver = handle()
    if not driver.is_reachable():
        return False
    with driver.session() as session:
        result = session.run(
            f"MATCH (n:{label} {{{id_field}: $value}}) RETURN count(n) AS c",
            value=value,
        )
        rec = result.single()
        return bool(rec and rec["c"])


def _artifact_version_exists(artifact_id: str, version: int) -> bool:
    """Probe for a specific Artifact version node (composite key).

    Artifact is keyed on ``(artifact_id, version)`` — a bare artifact_id no
    longer identifies one node, so existence checks for the declare/states
    paths must pin the version.
    """
    driver = handle()
    if not driver.is_reachable():
        return False
    with driver.session() as session:
        result = session.run(
            "MATCH (a:Artifact {artifact_id: $aid, version: $v}) RETURN count(a) AS c",
            aid=artifact_id, v=version,
        )
        rec = result.single()
        return bool(rec and rec["c"])


def _latest_artifact_version(artifact_id: str) -> int | None:
    """Return the highest ``version`` of an artifact, or None if absent.

    Fallback for cite/states paths that were not given an explicit version
    (partial migration): pin to the latest so a missing version does not 422.
    The Node side is expected to always supply the explicit version.
    """
    driver = handle()
    if not driver.is_reachable():
        return None
    with driver.session() as session:
        result = session.run(
            "MATCH (a:Artifact {artifact_id: $aid}) "
            "RETURN max(a.version) AS v",
            aid=artifact_id,
        )
        rec = result.single()
        return rec["v"] if rec and rec["v"] is not None else None


def _await_node(label: str, id_field: str, value: str, attempts: int = 10, delay_s: float = 0.3) -> bool:
    """Poll for a node's existence with short sleeps.

    ``persist/states`` can land before ``observeExecution`` mirrors the report
    Artifact (the states call fires the instant the report version is
    persisted; the mirror runs after). Polling lets the states edge attach
    once the report node arrives instead of 422'ing on the race. Returns True
    once present, False if still absent after the attempts.
    """
    import time
    for i in range(attempts):
        if _node_exists(label, id_field, value):
            if i:
                log.info("_await_node: %s/%s appeared after %d poll(s)", label, value, i)
            return True
        if i < attempts - 1:
            time.sleep(delay_s)
    return False


def _await_artifact_version(artifact_id: str, version: int, attempts: int = 10, delay_s: float = 0.3) -> bool:
    """Poll for a specific Artifact version node (composite key).

    ``persist/states`` pins states to the report's exact version; the report
    version node may not be mirrored yet (same race ``_await_node`` was built
    for), so poll on the composite ``(artifact_id, version)`` until it arrives.
    """
    import time
    for i in range(attempts):
        if _artifact_version_exists(artifact_id, version):
            if i:
                log.info("_await_artifact_version: %s v%s appeared after %d poll(s)",
                         artifact_id, version, i)
            return True
        if i < attempts - 1:
            time.sleep(delay_s)
    return False


class DeclareEvidenceRequest(BaseModel):
    content: str
    source_paper_link: str
    locator: str
    evidence_type: str
    confidence: str
    strength: str
    session_id: str


@app.post("/persist/evidence", dependencies=[Depends(require_internal_token)])
def persist_evidence(req: DeclareEvidenceRequest) -> dict[str, Any]:
    driver = handle()
    log.info("persist/evidence in: session=%s paper=%s", req.session_id, req.source_paper_link)
    if not driver.is_reachable():
        return {"status": "degraded", "evidence_id": None, "reason": "memory_graph_unreachable"}
    # Validate the source Paper exists before creating an orphan Evidence.
    link = _normalize_link(req.source_paper_link)
    if not link or not _node_exists("Paper", "link", link):
        _error("source_paper_not_found", 422, "no Paper with that link")
    evidence_id = str(uuid4())
    try:
        declare_evidence(
            evidence_id=evidence_id,
            session_id=req.session_id,
            content=req.content,
            source_paper_link=link,
            locator=req.locator,
            evidence_type=req.evidence_type,
            confidence=req.confidence,
            strength=req.strength,
        )
        log.info("persist/evidence done: evidence=%s session=%s", evidence_id, req.session_id)
        return {"status": "ok", "evidence_id": evidence_id}
    except Exception as exc:  # pragma: no cover - belt-and-suspenders
        log.exception("persist/evidence failed: session=%s: %s", req.session_id, exc)
        raise HTTPException(status_code=500, detail=f"declare_evidence failed: {exc}")


class DeclareClaimRequest(BaseModel):
    content: str
    claim_type: str
    confidence: str
    locator: str
    # alias → evidence_id, e.g. {"ev1": "<uuid>"}; the alias is what the LLM
    # writes into the report body, the evidence_id resolves it to an Evidence
    # node. The cited Evidence must already exist (declare_evidence first).
    # This is the ONLY way to cite an Evidence — there is no separate
    # node-id list; an evidence_id not placed here is not cited and renders
    # no chip.
    cites_evidence_aliases: dict[str, str] = Field(default_factory=dict)
    # alias → artifact_id, e.g. {"a1": "<artifact_id>"}; the alias is what the
    # LLM writes into the report body, the artifact_id resolves it to an
    # Artifact this session's code produced. Used for code-execution findings
    # that have no source paper (so declare_evidence does not apply).
    cites_artifact_aliases: dict[str, str] = Field(default_factory=dict)
    # alias → version, e.g. {"a1": 1}; pins each cited artifact alias to the
    # EXACT version the LLM declared against (Artifact is keyed on the composite
    # (artifact_id, version), so the version is required to hit the right node —
    # a bare artifact_id is ambiguous across versions). Keys align with
    # ``cites_artifact_aliases``. Filled in by the Node side (the LLM never sees
    # versions — the declare callback looks them up from the store).
    cites_artifact_versions: dict[str, int] = Field(default_factory=dict)
    # The report Artifact this claim is asserted in; builds states (Artifact→Claim).
    artifact_id: str | None = None
    # The report Artifact's version; pins the states edge to the report's
    # specific version (same composite-key rationale as cites_artifact_versions).
    # The report version is only known once the report version lands, so states
    # via ``artifact_id``+``artifact_version`` here is best-effort (declare runs
    # in an earlier turn than the report write); the ``persist/states`` route
    # re-links with the authoritative version once the report lands.
    artifact_version: int | None = None
    session_id: str


@app.post("/persist/claim", dependencies=[Depends(require_internal_token)])
def persist_claim(req: DeclareClaimRequest) -> dict[str, Any]:
    driver = handle()
    log.info("persist/claim in: session=%s ev_aliases=%d art_aliases=%d artifact=%s",
             req.session_id,
             len(req.cites_evidence_aliases),
             len(req.cites_artifact_aliases),
             req.artifact_id or "-")
    # Business validation that needs no graph: a claim must cite something.
    # This surfaces to the LLM even when the graph is down (it's a logic error,
    # not an availability one), so it runs before the degraded branch. A Claim
    # no longer cites a Paper directly — to cite a paper the LLM declares an
    # Evidence extracted from it and cites the Evidence here. cites_evidence_
    # aliases / cites_artifact_aliases are the ONLY cite fields; there is no
    # separate node-id list anymore.
    if not (req.cites_evidence_aliases or req.cites_artifact_aliases):
        _error(
            "no_cites_target", 422,
            "at least one cite is required — pass cites_evidence_aliases or cites_artifact_aliases",
            "pass cites_evidence_aliases={\"evN\": \"<evidence_id>\"} for evidence, "
            "or cites_artifact_aliases={\"aN\": \"<artifact_id>\"} for a produced artifact.",
        )
    if not driver.is_reachable():
        return {"status": "degraded", "claim_id": None, "chip_map": {}, "reason": "memory_graph_unreachable"}
    # evidence alias → evidence_id; the cited Evidence must already exist
    # (declare_evidence ran in an earlier turn). An evidence_id that does not
    # resolve to an Evidence node is a caller bug — surface it as a 422 with an
    # actionable instruction instead of silently dropping the cite (which would
    # leave the [evN] token in the body with no matching chip).
    evidence_alias_map: dict[str, str] = {}
    cites_node_ids: list[str] = []
    for alias, eid in (req.cites_evidence_aliases or {}).items():
        if not eid:
            continue
        if not _node_exists("Evidence", "evidence_id", eid):
            _error(
                "evidence_not_found", 422,
                f"evidence_id {eid} is not declared in this session",
                f"re-call declare_evidence for the source paper, then re-call "
                f"declare_claim with the returned evidence_id under alias {alias}.",
            )
        evidence_alias_map[alias] = eid
        cites_node_ids.append(eid)
    # artifact alias → artifact_id + version; the cited Artifact version must
    # already exist (it was mirrored when the code run landed). Artifact is keyed
    # on the composite (artifact_id, version), so the cite is pinned to the exact
    # version the LLM declared against via a dedicated ``cites_artifact_refs``
    # batch (a bare artifact_id is ambiguous across versions, so it does NOT ride
    # cites_node_ids — which match Evidence only — anymore).
    artifact_alias_map: dict[str, str] = {}
    cites_artifact_refs: list[dict[str, Any]] = []
    for alias, aid in (req.cites_artifact_aliases or {}).items():
        if not aid:
            continue
        # The Node side fills cites_artifact_versions[alias] = <version>; a
        # missing version falls back to the latest so a partial migration does
        # not 422 — but the Node side is expected to always supply it.
        version = (req.cites_artifact_versions or {}).get(alias)
        if version is None:
            version = _latest_artifact_version(aid)
        if version is None or not _artifact_version_exists(aid, version):
            _error(
                "artifact_version_not_found", 422,
                f"artifact {aid} version {version} not found in this session",
                "call list_artifacts to resolve the correct artifact_id and version, "
                "then re-call declare_claim with the resolved id under the same alias.",
            )
        artifact_alias_map[alias] = aid
        cites_artifact_refs.append({"artifact_id": aid, "version": version})
    # De-dup so a ref that appears under multiple aliases is matched once.
    cites_node_ids = list(dict.fromkeys(cites_node_ids))
    seen_refs: set[tuple[str, int]] = set()
    cites_artifact_refs = [r for r in cites_artifact_refs
                           if (r["artifact_id"], r["version"]) not in seen_refs
                           and not seen_refs.add((r["artifact_id"], r["version"]))]
    # NOTE: the report Artifact (states target) is keyed on (artifact_id,
    # version) too, but it is NOT existence-checked here. declare_claim runs
    # in an EARLIER turn than the report write, so the report version node
    # has not been mirrored yet — 422'ing would reject every legitimate
    # declare. declare_claim's states subquery uses a FOREACH guard that is a
    # no-op when the Artifact is absent, and persist/states re-links the
    # states edge authoritatively once the report version lands.
    claim_id = str(uuid4())
    content_hash = hashlib.sha256(req.content.encode("utf-8")).hexdigest()
    try:
        cited_targets = declare_claim(
            claim_id=claim_id,
            session_id=req.session_id,
            content=req.content,
            claim_type=req.claim_type,
            confidence=req.confidence,
            locator=req.locator,
            content_hash=content_hash,
            cites_node_ids=cites_node_ids,
            cites_artifact_refs=cites_artifact_refs,
            artifact_id=req.artifact_id,
            artifact_version=req.artifact_version,
        )
    except Exception as exc:  # pragma: no cover - belt-and-suspenders
        log.exception("persist/claim failed: session=%s: %s", req.session_id, exc)
        raise HTTPException(status_code=500, detail=f"declare_claim failed: {exc}")

    # Assemble the chip_map: alias → {kind, id, label} so the frontend can turn
    # the LLM's prose aliases ([ev1] / [a1]) into clickable chips. Evidence and
    # Artifact aliases come from the request. There is NO fallback to a node id
    # when an alias is missing — an evidence/artifact not placed in the alias
    # maps is not cited and renders no chip (the 422s above catch the common
    # caller bugs; a missing alias is a prompt/schema concern, not a runtime
    # one).
    chip_map: dict[str, dict[str, Any]] = {}
    evidence_by_id = {t.get("evidence_id"): t for t in cited_targets if t.get("evidence_id")}
    for alias, eid in evidence_alias_map.items():
        if eid in evidence_by_id:
            chip_map[alias] = {"kind": "evidence", "id": eid, "label": alias}
    # artifact chip: id stays the bare artifact_id (the frontend's
    # handleChipClick still resolves logicalName from it via listArtifacts),
    # but ``version`` is carried alongside so opening the chip selects the
    # exact version the claim cited (not the latest, which would drift).
    artifact_by_id = {t.get("artifact_id"): t for t in cited_targets if t.get("artifact_id")}
    for alias, aid in artifact_alias_map.items():
        target = artifact_by_id.get(aid)
        if target:
            entry: dict[str, Any] = {"kind": "artifact", "id": aid, "label": alias}
            if target.get("version") is not None:
                entry["version"] = target["version"]
            chip_map[alias] = entry
    log.info("persist/claim done: claim=%s session=%s chip_map=%d cited=%d",
             claim_id, req.session_id, len(chip_map), len(cited_targets))
    return {"status": "ok", "claim_id": claim_id, "chip_map": chip_map,
            "cited_targets": cited_targets}


class LinkClaimsRequest(BaseModel):
    artifact_id: str
    # The report Artifact's version — pins the states edge to the report's
    # specific version (composite key). Required: the report version is known
    # when this fires (the report version has just landed — this call is the
    # drain step after recordGeneratedFiles).
    artifact_version: int
    claim_ids: list[str] = Field(default_factory=list)
    session_id: str


@app.post("/persist/states", dependencies=[Depends(require_internal_token)])
def persist_states(req: LinkClaimsRequest) -> dict[str, Any]:
    driver = handle()
    log.info("persist/states in: session=%s artifact=%s v%s claims=%d",
             req.session_id, req.artifact_id, req.artifact_version, len(req.claim_ids))
    if not driver.is_reachable():
        return {"status": "degraded", "linked": 0, "reason": "memory_graph_unreachable"}
    # The report Artifact version may not be mirrored yet — observeExecution
    # runs AFTER recordGeneratedFiles, which fires this states call the instant
    # the report version lands. Retry briefly (on the composite key) so the
    # states edge attaches once the report version node arrives, instead of
    # 422'ing on a race.
    artifact_ready = _await_artifact_version(req.artifact_id, req.artifact_version)
    if not artifact_ready:
        _error("artifact_not_found", 422, "Artifact version not found")
    for cid in req.claim_ids:
        if not _node_exists("Claim", "claim_id", cid):
            _error("claim_not_found", 422, f"Claim {cid} not found")
    try:
        linked = link_claims_to_report(
            artifact_id=req.artifact_id,
            artifact_version=req.artifact_version,
            claim_ids=req.claim_ids,
        )
        log.info("persist/states done: artifact=%s v%s claims=%d linked=%d",
                 req.artifact_id, req.artifact_version, len(req.claim_ids), linked)
        return {"status": "ok", "artifact_id": req.artifact_id, "linked": linked}
    except Exception as exc:  # pragma: no cover - belt-and-suspenders
        log.exception("persist/states failed: session=%s: %s", req.session_id, exc)
        raise HTTPException(status_code=500, detail=f"link_claims_to_report failed: {exc}")


# --- Write: observeSessionFirstMessage (ResearchGoal fallback) ----------------

class ObserveSessionFirstMessageRequest(BaseModel):
    session_id: str
    goal_id: str
    core_objective: str
    domain: str | None = None
    topic_scope: list[str] = Field(default_factory=list)
    created_at: str


@app.post("/observe/session-first-message", dependencies=[Depends(require_internal_token)])
def observe_session_first_message(req: ObserveSessionFirstMessageRequest) -> dict[str, Any]:
    driver = handle()
    log.info("observe/session-first-message in: session=%s goal=%s domain=%s",
             req.session_id, req.goal_id, req.domain or "<empty>")
    if not driver.is_reachable():
        log.warning("observe/session-first-message skipped: Neo4j not reachable, this goal will not be mirrored")
        return {"status": "degraded", "written": 0}
    try:
        upsert_session_first_message(
            session_id=req.session_id,
            goal_id=req.goal_id,
            core_objective=req.core_objective,
            domain=req.domain,
            topic_scope=req.topic_scope,
            created_at=req.created_at,
        )
        log.info("observe/session-first-message done: session=%s goal=%s", req.session_id, req.goal_id)
        return {"status": "healthy", "written": 1}
    except Exception as exc:  # pragma: no cover - belt-and-suspenders
        log.exception("observe/session-first-message failed: session=%s goal=%s: %s",
                      req.session_id, req.goal_id, exc)
        raise HTTPException(status_code=500, detail=f"upsert failed: {exc}")


# --- Write: observeSessionPlanProposed (SubTask DAG mirror) -------------------

class PlanStepMirror(BaseModel):
    id: str
    description: str


class ObserveSessionPlanRequest(BaseModel):
    session_id: str
    goal_id: str
    plan_id: str
    scope: str
    domain: str | None = None
    steps: list[PlanStepMirror] = Field(default_factory=list)


@app.post("/observe/session-plan", dependencies=[Depends(require_internal_token)])
def observe_session_plan(req: ObserveSessionPlanRequest) -> dict[str, Any]:
    driver = handle()
    log.info("observe/session-plan in: session=%s plan=%s goal=%s steps=%d",
             req.session_id, req.plan_id, req.goal_id, len(req.steps))
    if not driver.is_reachable():
        log.warning("observe/session-plan skipped: Neo4j not reachable, this plan will not be mirrored")
        return {"status": "degraded", "written": 0, "goal_corrected": False}
    try:
        # Corrects the ResearchGoal's scope/domain from plan.scope. Does NOT
        # mirror steps into SubTask nodes (the framework doesn't advance step
        # status, so a skeleton would stay PENDING and clutter the graph).
        result = upsert_session_plan(
            session_id=req.session_id,
            goal_id=req.goal_id,
            plan_id=req.plan_id,
            scope=req.scope,
            domain=req.domain,
            steps=[s.model_dump() for s in req.steps],
        )
        corrected = bool(result.get("goal_corrected", False))
        log.info("observe/session-plan done: session=%s plan=%s goal_corrected=%s",
                 req.session_id, req.plan_id, corrected)
        return {"status": "healthy", "written": 0, "goal_corrected": corrected}
    except Exception as exc:  # pragma: no cover - belt-and-suspenders
        log.exception("observe/session-plan failed: session=%s plan=%s: %s",
                      req.session_id, req.plan_id, exc)
        raise HTTPException(status_code=500, detail=f"upsert failed: {exc}")


# --- Password push ----------------------------------------------------------

class Neo4jPasswordRequest(BaseModel):
    """Plaintext Neo4j password pushed by the Node control API over loopback.

    The API reads the password from env (MVP: fixed deploy-time value) and
    posts it here so the plaintext never lives in this process's env.
    """

    password: str | None
    #: Optional HTTP URI / user override from System Settings. Either may be
    #: ``None`` to keep the current value; the API sends both when the user
    #: edits the connection fields.
    http_uri: str | None = None
    user: str | None = None


@app.post("/internal/neo4j-password", dependencies=[Depends(require_internal_token)])
def set_neo4j_password(req: Neo4jPasswordRequest) -> dict[str, str]:
    driver = handle()
    if req.http_uri is not None or req.user is not None:
        log.info("neo4j-password in: reconfiguring connection (http=%s, user=%s)",
                  "changed" if req.http_uri is not None else "same",
                  "changed" if req.user is not None else "same")
        driver.configure(req.http_uri, req.user)
    log.info("neo4j-password in: %s", "setting password" if req.password is not None else "clearing password")
    driver.set_password(req.password)
    reachable = driver.is_reachable()
    if req.password is not None and reachable:
        ensure_schema()
    status = "healthy" if reachable else "degraded"
    log.info("neo4j-password done: Neo4j %s, memory graph %s",
             "reachable" if reachable else "unreachable", status)
    return {"status": status}


def main() -> None:
    import uvicorn

    host = os.environ.get("SCIENCE_AGENT_MEMORY_GRAPH_HOST", "127.0.0.1")
    port = int(os.environ.get("SCIENCE_AGENT_MEMORY_GRAPH_PORT", "17674"))
    log.info("memory-graph service starting on %s:%s", host, port)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
