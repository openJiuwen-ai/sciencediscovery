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

"""Persistence helpers: upsert SubTask / Code / Artifact / Paper + ``produces`` edges.

MVP scope: one SubTask per execution (no DAG / ``inferred_subtask_types``
state machine — SubTask dedup is intentionally DROPPED), one Code per
execution (``code_id = executionId``), one Artifact node per logical artifact
id (latest fields; versioning is v2). ``upsert_mcp_search`` adds one
auto-inferred SubTask per MCP search invocation
(``task_id = "subtask:mcp:" + invocation_id``, NOT deduplicated — every
search is its own SubTask) + Paper nodes deduped by normalized URL (re-search
only bumps ``retrieved_at`` / ``retrieval_count``) + ``SubTask -produces->
Paper`` edges. All writes are ``MERGE`` on the unique key so hooks are
idempotent across retries.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .external_urls import format_external_url
from .logging_config import get_logger
from .neo4j_driver import handle

log = get_logger("persistence")
def _normalize_link(url: str) -> str:
    """Normalize a Paper URL into a stable dedup key.

    Collapses the common same-paper variants so they MERGE instead of creating
    duplicate Paper nodes:
    - scheme: ``http`` → ``https`` (case-insensitive)
    - host: lowercased, trailing dot stripped
    - path: trailing slash dropped
    - query: dropped (UTM params, tracking, pagination) — a Paper is the same
      regardless of ``?utm_source=...`` or ``?page=2``
    - fragment: dropped (``#abstract``, ``#fig1``)
    A bare DOI (``10.x/...`` or ``doi:10.x/...``) is canonicalized to the
    configured canonical DOI URL form so it merges with its URL equivalent.
    """
    raw = url.strip()
    if not raw:
        return ""
    # Bare DOI → canonical doi.org URL so it merges with URL forms.
    lowered = raw.lower()
    if lowered.startswith("doi:"):
        return format_external_url("data_sources.doi.canonical_template", doi=raw[4:].strip().lower())
    if lowered.startswith("doi.org/"):
        return format_external_url(
            "data_sources.doi.canonical_template", doi=raw[len("doi.org/"):].strip().lower()
        )
    if lowered.startswith("10.") and "/" in raw:
        # Looks like a bare DOI (e.g. 10.1038/abc); canonicalize.
        return format_external_url("data_sources.doi.canonical_template", doi=raw.lower())
    # Lowercase the scheme before urlsplit: Python's urlsplit mis-parses the
    # host when the scheme is uppercase (e.g. "HTTPS://" can eat the first host
    # char). Normalizing the scheme first sidesteps that.
    scheme_sep = raw.find("://")
    if scheme_sep > 0:
        raw = f"{raw[:scheme_sep].lower()}{raw[scheme_sep:]}"
    parts = urlsplit(raw)
    scheme = parts.scheme.lower() or "https"
    if scheme == "http":
        scheme = "https"
    # Use netloc (raw) not parts.hostname — Python's urlsplit mis-parses
    # mixed-case hosts via .hostname (it can drop a leading capital letter),
    # e.g. "EuroPmc.org" → "uropmc.org". Lower the netloc ourselves instead.
    netloc_raw = parts.netloc or ""
    # Strip userinfo@ if present before lowering the host.
    if "@" in netloc_raw:
        netloc_raw = netloc_raw.rsplit("@", 1)[1]
    netloc_raw = netloc_raw.lower().rstrip(".")
    # Split host:port so we can drop default ports that carry no identity.
    if ":" in netloc_raw:
        host, _, port_str = netloc_raw.rpartition(":")
        if port_str.isdigit():
            port_num = int(port_str)
            if (scheme == "https" and port_num == 443) or (scheme == "http" and port_num == 80):
                netloc_raw = host
    path = parts.path.rstrip("/")
    # Reassemble without query/fragment; lower the path too (academic article
    # paths like /article/MED/ are case-insensitive and we want them to merge).
    return urlunsplit((scheme, netloc_raw, path, "", "")).lower()

def _normalise_subtask_status(status: str) -> str:
    """Map the caller's status string onto the graph's lowercase
    completed/failed vocabulary.

    The execution path reports ``succeeded``/``failed`` (lowercase) while the
    MCP-search path reports ``completed`` (lowercase) — unify on
    ``completed``/``failed`` so the frontend renders one green label instead
    of ``COMPLETED`` vs ``succeeded`` both showing green. Anything else is
    passed through untouched (future statuses surface verbatim).
    """
    if status == "succeeded":
        return "completed"
    return status


def upsert_execution(
    *,
    execution_id: str,
    session_id: str,
    turn_id: str,
    tool: str,
    language: str | None,
    code_hash: str,
    exit_code: int | None,
    status: str,
    started_at: str,
    finished_at: str,
    task_type: str,
    produced_artifacts: list[dict[str, Any]],
    stdout_hash: str | None = None,
    stderr_hash: str | None = None,
    env_hash: str | None = None,
) -> None:
    """Upsert one execution's worth of nodes (SubTask → Code → Artifacts).

    ``produced_artifacts`` items carry ``artifact_id`` (the logical
    ScientificArtifact id), ``path``, ``version``, ``media_type``,
    ``logical_name``, ``turn_id`` (review routing key for the version node),
    ``content_hash`` (the produced artifact's CAS hash), and optionally
    ``input_artifact_versions`` — a list of ``{artifact_id, version}``
    composite-key pairs for the Artifact versions this Code run read as inputs
    (used to build ``input`` edges; absent when no inputs were read). All
    writes are MERGE; safe to retry.

    The five provenance fields' addressing info lands here: Code mirrors
    ``stdout_hash``/``stderr_hash``/``env_hash`` (CAS hashes for the
    executionLog/environments/code blocks) + ``turn_id``; SubTask mirrors
    ``turn_id`` (messages routing key — store filters manifests by turnId, the
    same key review uses, since manifest_ids would race manifest persistence at
    mirror time); each Artifact version node mirrors ``turn_id`` (review
    routing key) + ``content_hash``. None of these store content blobs — only
    hashes / routing keys, per the "graph = directory, CAS/store = warehouse"
    layering (see docs/memory-graph-provenance-fields.md §2).
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("upsert skipped: Neo4j not reachable (execution=%s session=%s)", execution_id, session_id)
        return

    # Normalise the status string: the execution path reports lowercase
    # "succeeded"/"failed", the MCP search path reports uppercase "COMPLETED".
    # Unify on lowercase completed/failed so the frontend has one green label.
    status = _normalise_subtask_status(status)

    task_id = f"subtask:{execution_id}"
    log.debug("upsert starting: execution=%s session=%s artifacts=%d", execution_id, session_id, len(produced_artifacts))

    try:
        with driver.session() as session:
            # SubTask (auto-inferred, one per execution).
            session.run(
                """
                MERGE (st:SubTask {task_id: $task_id})
                  ON CREATE SET st.session_id  = $session_id,
                                st.status     = $status,
                                st.task_type  = $task_type,
                                st.created_at = datetime(),
                                st.finished_at = $finished_at,
                                st.turn_id    = $turn_id
                """,
                task_id=task_id,
                session_id=session_id,
                status=status,
                task_type=task_type,
                finished_at=finished_at,
                turn_id=turn_id,
            ).consume()

            # Code node; code_id is the executionId (1:1 with ExecutionRun.id).
            session.run(
                """
                MERGE (c:Code {code_id: $code_id})
                  ON CREATE SET c.session_id  = $session_id,
                                c.tool        = $tool,
                                c.language    = $language,
                                c.code_hash   = $code_hash,
                                c.exit_code   = $exit_code,
                                c.status      = $status,
                                c.started_at  = $started_at,
                                c.finished_at = $finished_at,
                                c.stdout_hash = $stdout_hash,
                                c.stderr_hash = $stderr_hash,
                                c.env_hash    = $env_hash,
                                c.turn_id     = $turn_id
                MERGE (st:SubTask {task_id: $task_id})
                MERGE (st)-[:produces]->(c)
                """,
                code_id=execution_id,
                session_id=session_id,
                tool=tool,
                language=language,
                code_hash=code_hash,
                exit_code=exit_code,
                status=status,
                started_at=started_at,
                finished_at=finished_at,
                stdout_hash=stdout_hash,
                stderr_hash=stderr_hash,
                env_hash=env_hash,
                turn_id=turn_id,
                task_id=task_id,
            ).consume()

            # One Artifact node per produced artifact version + Code -produces->
            # Artifact. MERGE key is the composite (artifact_id, version) so a
            # re-run that overwrites the file produces a NEW version node
            # instead of clobbering the previous one (ON CREATE would not fire
            # on a MERGE hit, so v2's fields would never land and v1 would be
            # silently lost — see docs/memory-graph-artifact-versioning.md).
            # logical_name is mirrored alongside path; the two carry the same
            # value today (Node-side logicalName == logicalPath) but the field
            # aligns the graph node with SessionStore's ScientificArtifact.
            # logicalName for UI rendering.
            for art in produced_artifacts:
                session.run(
                    """
                    MERGE (a:Artifact {artifact_id: $artifact_id, version: $version})
                      ON CREATE SET a.session_id   = $session_id,
                                    a.project_id   = $project_id,
                                    a.path          = $path,
                                    a.logical_name  = $logical_name,
                                    a.media_type    = $media_type,
                                    a.created_at    = datetime(),
                                    a.turn_id       = $turn_id,
                                    a.content_hash  = $content_hash
                      ON MATCH  SET a.path          = $path,
                                    a.project_id    = $project_id,
                                    a.logical_name  = $logical_name,
                                    a.media_type    = $media_type,
                                    a.turn_id       = $turn_id,
                                    a.content_hash  = $content_hash
                    MERGE (c:Code {code_id: $code_id})
                    MERGE (c)-[:produces]->(a)
                    """,
                    artifact_id=art.get("artifact_id"),
                    session_id=session_id,
                    project_id=art.get("project_id"),
                    path=art.get("path"),
                    logical_name=art.get("logical_name"),
                    version=art.get("version"),
                    media_type=art.get("media_type"),
                    turn_id=art.get("turn_id"),
                    content_hash=art.get("content_hash"),
                    code_id=execution_id,
                ).consume()
                # derived-from: the Artifact versions this Code run read as
                # inputs — (read version) -[:input]-> (this Code). Built only
                # when this run actually read some other Artifact version, so
                # it never overlaps with ``supersedes`` semantics (supersedes =
                # "replaces", input = "read"). The endpoint lands on the
                # specific version node (composite key); the edge itself
                # carries no version property — the version is borne by the
                # endpoint. payload passes (artifact_id, version) composite-key
                # pairs, not UUIDs (see docs/memory-graph-derived-from-impl.md
                # §3.3 for why the graph uses composite keys, not SessionStore
                # UUIDs).
                for ref in art.get("input_artifact_versions") or []:
                    session.run(
                        """
                        MATCH (inA:Artifact {artifact_id: $aid, version: $v})
                        MERGE (c:Code {code_id: $code_id})
                        MERGE (inA)-[:input]->(c)
                        """,
                        aid=ref.get("artifact_id"),
                        v=ref.get("version"),
                        code_id=execution_id,
                    ).consume()
                # supersedes (new→old): vN replaces v(N-1). Built whenever a
                # version > 1 is produced, regardless of whether the run read
                # the previous version (a from-scratch recompute still
                # supersedes its predecessor). The data-dependency ``input``
                # edge is a separate derived-from concern and is not handled here.
                version = art.get("version")
                if isinstance(version, int) and version > 1:
                    session.run(
                        """
                        MATCH (cur:Artifact {artifact_id: $artifact_id, version: $version})
                        MATCH (prev:Artifact {artifact_id: $artifact_id, version: $prev_version})
                        MERGE (cur)-[:supersedes]->(prev)
                        """,
                        artifact_id=art.get("artifact_id"),
                        version=version,
                        prev_version=version - 1,
                    ).consume()

            # Temporal-chain fallback: when this session has no
            # SessionPlan-derived chain yet, link its auto-inferred SubTasks
            # (execution/mcp_search) by finished_at into a linear next chain,
            # only adding edges between consecutive orphans. Idempotent.
            _link_subtasks_by_finish_time(session, session_id)

        log.info("upsert done: execution=%s session=%s wrote %d nodes and %d produces edges",
                 execution_id, session_id,
                 1 + 1 + len(produced_artifacts), 1 + len(produced_artifacts))
    except Exception as exc:
        log.exception("upsert failed: execution=%s session=%s: %s", execution_id, session_id, exc)
        raise


def upsert_mcp_search(
    *,
    invocation_id: str,
    session_id: str,
    turn_id: str,
    source: str,
    tool_type: str,
    retrieved_at: str,
    records: list[dict[str, Any]],
) -> None:
    """Upsert one MCP literature search's worth of nodes (SubTask → Papers).

    One auto-inferred SubTask per search invocation (``task_type =
    "literature_search"``, ``task_id = "subtask:mcp:" + invocation_id``,
    ``source``/``tool_type`` record the MCP source/tool). NOT
    deduplicated across searches — every search is its own SubTask (same-type
    SubTasks run multiple times with different content, each must be retained).
    Papers are deduped by lowercased ``link`` (the normalized URL/DOI); a
    re-search of the same paper only bumps ``retrieved_at`` and
    ``retrieval_count``. Each Paper gets a ``SubTask -produces-> Paper`` edge.
    All writes are MERGE; safe to retry.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("upsert_mcp_search skipped: Neo4j not reachable (invocation=%s session=%s)",
                    invocation_id, session_id)
        return

    # Only records with a URL contribute a Paper node; records without a URL
    # are dropped (no unique key to dedup on for link-based dedup).
    papers: list[dict[str, Any]] = []
    for rec in records:
        url = rec.get("url")
        if not url:
            continue
        link = _normalize_link(str(url))
        if not link:
            continue
        papers.append({
            "link": link,
            "title": rec.get("title"),
            "identifier": rec.get("identifier"),
            "identifier_type": rec.get("identifierType"),
            "year": rec.get("year"),
            "authors": rec.get("authors"),
            "abstract": rec.get("abstract"),
            "source": rec.get("source"),
        })

    task_id = f"subtask:mcp:{invocation_id}"
    log.debug("upsert_mcp_search starting: invocation=%s session=%s papers=%d",
              invocation_id, session_id, len(papers))

    if not papers:
        log.info("upsert_mcp_search: invocation=%s had no records with a URL; writing SubTask only",
                 invocation_id)

    try:
        with driver.session() as session:
            # SubTask (auto-inferred, one per MCP search; NOT deduped).
            session.run(
                """
                MERGE (st:SubTask {task_id: $task_id})
                  ON CREATE SET st.session_id  = $session_id,
                                st.status     = $status,
                                st.task_type  = 'literature_search',
                                st.source     = $source,
                                st.tool_type  = $tool_type,
                                st.created_at = datetime(),
                                st.finished_at = datetime(),
                                st.result_count = $result_count
                """,
                task_id=task_id,
                session_id=session_id,
                source=source,
                tool_type=tool_type,
                result_count=len(papers),
                status="completed",
            ).consume()

            # Temporal-chain fallback: when this session has no
            # SessionPlan-derived chain yet, link its auto-inferred SubTasks
            # (execution/mcp_search) by finished_at into a linear next chain,
            # only adding edges between consecutive orphans. Idempotent.
            _link_subtasks_by_finish_time(session, session_id)

            # Batch upsert all Papers in one Cypher (UNWIND). Papers are scoped
            # per session (MERGE on session_id + link) so a session's subgraph
            # always shows every paper it retrieved, even if another session
            # searched the same URL first — cross-session sharing of a single
            # node made papers invisible to all but the first session via the
            # session_id filter in get_subgraph. Re-search within the same
            # session bumps retrieval_count.
            if papers:
                session.run(
                    """
                    UNWIND $papers AS paper
                    MERGE (p:Paper { session_id: $session_id, link: paper.link })
                      ON CREATE SET p.title           = paper.title,
                                    p.identifier      = paper.identifier,
                                    p.identifier_type = paper.identifier_type,
                                    p.year            = paper.year,
                                    p.authors         = paper.authors,
                                    p.abstract        = paper.abstract,
                                    p.source          = paper.source,
                                    p.retrieval_count = 1,
                                    p.created_at      = datetime()
                      ON MATCH SET   p.retrieved_at     = datetime(),
                                    p.retrieval_count  = coalesce(p.retrieval_count, 0) + 1
                    WITH paper, p
                    MERGE (st:SubTask { task_id: $task_id })
                    MERGE (st)-[:produces]->(p)
                    """,
                    papers=papers,
                    session_id=session_id,
                    task_id=task_id,
                ).consume()

        log.info("upsert_mcp_search done: invocation=%s session=%s wrote 1 SubTask + %d Paper(s) + %d produces edges",
                 invocation_id, session_id, len(papers), len(papers))
    except Exception as exc:
        log.exception("upsert_mcp_search failed: invocation=%s session=%s: %s",
                       invocation_id, session_id, exc)
        raise


def _link_subtasks_by_finish_time(session: Any, session_id: str) -> int:
    """Connect a session's auto-inferred SubTasks (execution/mcp_search) by
    ``finished_at`` into a single linear ``next`` chain hanging off the
    ResearchGoal:

        ResearchGoal -[:next]-> SubTask₁ -[:next]-> SubTask₂ -> ... -> SubTaskₙ

    The goal connects to the *first* SubTask only; each SubTask then links to
    the next by finish time. ``r.method='temporal_chain'`` +
    ``basis='finish_time'`` on every edge marks it as a visibility fallback,
    not a real dependency, so the frontend can de-emphasize it. Auto-inferred
    SubTasks are selected by their ``task_id`` prefix (``subtask:`` for
    execution-mirrored, ``subtask:mcp:`` for MCP-search-mirrored).

    Idempotent: it first deletes this session's existing ``temporal_chain``
    ``next`` edges (both goal→head and subtask→subtask) and rebuilds the whole
    chain from the current set of auto-inferred SubTasks, so adding a new
    SubTask mid-chain re-links everything in the right order. Real
    (non-temporal) ``next`` edges are left untouched. Returns the number of
    edges added. Runs inside the caller's open session/tx.
    """
    # Drop the previous temporal_chain so the chain can be rebuilt from
    # scratch in the correct order as new SubTasks land. Only edges this
    # session's own SubTasks are involved in (as either endpoint) are in
    # scope — a SubTask's session_id pins it to this session.
    session.run(
        """
        MATCH (a)-[r:next]->(b)
        WHERE r.method = 'temporal_chain'
          AND (a.session_id = $sid OR b.session_id = $sid)
        DELETE r
        """,
        sid=session_id,
    ).consume()

    # goal → first SubTask (head of the chain). OPTIONAL MATCH so a session
    # whose first-message hook hasn't run (no ResearchGoal yet) still gets
    # the SubTask→SubTask chain below — the goal→head link is added later by
    # the next upsert once the goal exists.
    session.run(
        """
        MATCH (st:SubTask)
        WHERE st.session_id = $sid
          AND st.task_id STARTS WITH 'subtask:'
        WITH st ORDER BY st.finished_at
        WITH collect(st)[0] AS head
        CALL (head) {
          OPTIONAL MATCH (g:ResearchGoal {goal_id: $goal_id})
          WITH g, head
          WHERE g IS NOT NULL
          MERGE (g)-[r:next]->(head)
            ON CREATE SET r.inferred = true,
                          r.basis     = 'finish_time',
                          r.method    = 'temporal_chain'
            ON MATCH  SET r.inferred = true,
                          r.basis     = 'finish_time',
                          r.method    = 'temporal_chain'
        }
        """,
        sid=session_id,
        goal_id=f"goal:session:{session_id}",
    ).consume()

    # head → next → ... → last (consecutive pairs in finish order).
    result = session.run(
        """
        MATCH (st:SubTask)
        WHERE st.session_id = $sid
          AND st.task_id STARTS WITH 'subtask:'
        WITH st ORDER BY st.finished_at
        WITH collect(st) AS ordered
        UNWIND range(0, size(ordered) - 2) AS i
        WITH ordered[i] AS a, ordered[i + 1] AS b
        MERGE (a)-[r:next]->(b)
          ON CREATE SET r.inferred = true,
                        r.basis    = 'finish_time',
                        r.method   = 'temporal_chain'
          ON MATCH  SET r.inferred = true,
                        r.basis    = 'finish_time',
                        r.method   = 'temporal_chain'
        RETURN count(r) AS added
        """,
        sid=session_id,
    )
    added = int(result.single()["added"]) if result.peek() else 0
    if added:
        log.info("temporal_chain rebuilt: goal→head + %d subtask→subtask edge(s) (session=%s)",
                 added, session_id)
    return added


def upsert_session_first_message(
    *,
    session_id: str,
    goal_id: str,
    core_objective: str,
    domain: str | None,
    topic_scope: list[str],
    created_at: str,
) -> str | None:
    """Idempotent: MERGE ResearchGoal(goal_id) for a session.

    ``goal_id = "goal:session:" + session_id`` is deterministic (Node side),
    so re-sending the first message of a session hits the existing goal and
    creates no duplicate — one ResearchGoal per session. ``domain`` is
    inferred by the Node hook from the message keywords, not read from any
    project. Returns ``goal_id`` on success, ``None`` when skipped.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("upsert_session_first_message skipped: Neo4j not reachable (session=%s goal=%s)",
                    session_id, goal_id)
        return None

    log.debug("upsert_session_first_message starting: session=%s goal=%s domain=%s",
              session_id, goal_id, domain or "<empty>")
    try:
        with driver.session() as session:
            session.run(
                """
                MERGE (g:ResearchGoal {goal_id: $goal_id})
                  ON CREATE SET g.session_id      = $sid,
                                g.core_objective  = $core_objective,
                                g.domain         = $domain,
                                g.topic_scope     = $topic_scope,
                                g.created_at      = datetime()
                RETURN g.goal_id AS goal_id
                """,
                sid=session_id,
                goal_id=goal_id,
                core_objective=core_objective,
                domain=domain,
                topic_scope=topic_scope,
            ).consume()
        log.info("upsert_session_first_message done: session=%s goal=%s", session_id, goal_id)
        return goal_id
    except Exception as exc:
        log.exception("upsert_session_first_message failed: session=%s goal=%s: %s",
                      session_id, goal_id, exc)
        raise


def upsert_session_plan(
    *,
    session_id: str,
    goal_id: str,
    plan_id: str,
    scope: str,
    domain: str | None,
    steps: list[dict[str, Any]],
) -> dict[str, Any]:
    """Correct the ResearchGoal's ``core_objective`` / ``domain`` from
    ``plan.scope`` (the LLM's explicit scope overwrites the first-message
    fallback).

    The plan's steps are NOT mirrored into SubTask nodes: the framework does
    not advance ``PlanStep.status`` (a plan is a progress record, not an
    approval-gated schedule), so a step skeleton would stay PENDING forever
    and clutter the graph. SubTasks come from actual execution / MCP search
    instead, linked by a finish-time fallback chain when no real dependency
    is known. ``steps`` is accepted for API stability but unused here.

    Correct Goal: MERGE ResearchGoal(goal_id); SET core_objective=scope,
    domain=inferDomain(scope), method += ';corrected_by_plan' (the suffix is
    added at most once so re-mirroring the same plan doesn't pile it up).
    Returns ``{goal_corrected: bool}``.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("upsert_session_plan skipped: Neo4j not reachable (session=%s plan=%s)",
                    session_id, plan_id)
        return {"goal_corrected": False}

    log.debug("upsert_session_plan starting: session=%s plan=%s steps=%d", session_id, plan_id, len(steps))
    try:
        with driver.session() as session:
            # Correct the ResearchGoal from plan.scope (overwrite, not ON CREATE,
            # so a revised plan's changed scope refreshes the goal).
            session.run(
                """
                MERGE (g:ResearchGoal {goal_id: $goal_id})
                  ON CREATE SET g.session_id = $sid, g.created_at = datetime()
                SET g.core_objective = $scope,
                    g.domain         = $domain
                """,
                goal_id=goal_id,
                sid=session_id,
                scope=scope,
                domain=domain,
            ).consume()

        log.info("upsert_session_plan done: session=%s plan=%s goal=%s (goal corrected, no step skeleton)",
                 session_id, plan_id, goal_id)
        return {"goal_corrected": True}
    except Exception as exc:
        log.exception("upsert_session_plan failed: session=%s plan=%s: %s",
                      session_id, plan_id, exc)
        raise


# --- declare_* (LLM-driven Claim + Evidence writes) -------------------------
#
# Unlike the upsert_* passive mirrors, these run only when the LLM explicitly
# calls the declare_evidence / declare_claim tools.
# They CREATE fresh nodes (Evidence/Claim are not deduped — every explicit
# declaration is a high-value assertion worth keeping) and MERGE the edges that
# connect them. The caller (server.py /persist/* routes) validates existence of
# referenced Paper/SubTask/Artifact first and returns a structured 422
# (source_paper_not_found / task_not_found / evidence_not_found /
# artifact_not_found) before these run, so the MATCHes here expect the nodes to
# already exist.


def declare_evidence(
    *,
    evidence_id: str,
    session_id: str,
    content: str,
    source_paper_link: str,
    locator: str,
    evidence_type: str,
    confidence: str,
    strength: str,
) -> str | None:
    """CREATE one Evidence + ``extracted_from`` → Paper.

    The caller already verified the Paper exists (by normalized link); this
    MATCHes it directly. Evidence is not deduped — each declaration gets its
    own fresh ``evidence_id`` (Evidence has no content-based dedup rule).
    Returns the evidence_id, or ``None`` when skipped (graph
    disabled/unreachable).
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("declare_evidence skipped: Neo4j not reachable (evidence=%s session=%s)",
                     evidence_id, session_id)
        return None

    link = _normalize_link(source_paper_link)
    log.debug("declare_evidence starting: evidence=%s session=%s paper=%s",
              evidence_id, session_id, link)
    try:
        with driver.session() as session:
            session.run(
                """
                MATCH (p:Paper { session_id: $session_id, link: $link })
                CREATE (e:Evidence {
                  evidence_id:      $evidence_id,
                  content:           $content,
                  source_paper_link: $link,
                  locator:           $locator,
                  evidence_type:     $evidence_type,
                  confidence:        $confidence,
                  strength:          $strength,
                  session_id:        $session_id,
                  created_at:        datetime()
                })
                WITH e, p
                MERGE (e)-[:extracted_from]->(p)
                RETURN e.evidence_id AS evidence_id
                """,
                evidence_id=evidence_id,
                session_id=session_id,
                content=content,
                link=link,
                locator=locator,
                evidence_type=evidence_type,
                confidence=confidence,
                strength=strength,
            ).consume()
        log.info("declare_evidence done: evidence=%s session=%s paper=%s",
                 evidence_id, session_id, link)
        return evidence_id
    except Exception as exc:
        log.exception("declare_evidence failed: evidence=%s session=%s: %s",
                       evidence_id, session_id, exc)
        raise


def declare_claim(
    *,
    claim_id: str,
    session_id: str,
    content: str,
    claim_type: str,
    confidence: str,
    locator: str,
    content_hash: str,
    cites_node_ids: list[str],
    cites_artifact_refs: list[dict[str, Any]],
    artifact_id: str | None,
    artifact_version: int | None,
) -> list[dict[str, Any]]:
    """CREATE one Claim + ``cites`` edges (Evidence/Artifact) + optional
    ``states`` (Artifact→Claim).

    Claim is not deduped — each declaration gets a fresh ``claim_id`` (the
    canonical pattern uses ``CREATE``, and content_hash is stored only for
    indexing / future dedup). ``cites_node_ids`` are Evidence(evidence_id) —
    a Claim no longer cites a Paper directly (that edge was removed: a Claim
    reaches a Paper only via ``cites Evidence → extracted_from Paper``). To
    cite a paper the LLM must first ``declare_evidence`` then cite the
    Evidence here. ``cites_artifact_refs`` is a list of
    ``{artifact_id, version}`` dicts — Artifact is keyed on the composite
    ``(artifact_id, version)`` (one node per version), so a cited figure/dataset
    is pinned to the exact version the LLM declared against (not the latest,
    which would drift as the product is regenerated). ``artifact_id`` +
    ``artifact_version`` (the report Artifact + its version) build the
    ``states`` edge so the graph can navigate "which report asserts which
    claim"; the caller verified the Artifact exists.

    Returns the cited targets ``[{evidence_id?, artifact_id?, version?,
    labels?}]`` so the caller can assemble the chip_map (alias → node) returned
    to the LLM. The chip_map itself is not persisted here — it lives on the
    report Artifact version's ``references`` (Node side). Empty list when
    skipped.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("declare_claim skipped: Neo4j not reachable (claim=%s session=%s)",
                     claim_id, session_id)
        return []

    log.debug("declare_claim starting: claim=%s session=%s cites=%d art_refs=%d artifact=%s",
              claim_id, session_id, len(cites_node_ids),
              len(cites_artifact_refs), artifact_id or "-")
    try:
        with driver.session() as session:
            # MERGE on claim_id (not CREATE) so a retry is idempotent: the
            # HTTP session's execute_write runs the unit in the enclosing
            # explicit transaction (no Bolt managed-retry on TransientError,
            # which HTTP has no equivalent of), and a fresh Claim per
            # declaration is preserved (claim_id is a fresh uuid, so ON CREATE
            # runs and ON MATCH is a no-op on a replay of the same tx).
            result = session.execute_write(lambda tx: tx.run(
                """
                MERGE (cl:Claim { claim_id: $claim_id })
                  ON CREATE SET cl.content      = $content,
                                cl.claim_type  = $claim_type,
                                cl.confidence  = $confidence,
                                cl.locator     = $locator,
                                cl.content_hash = $content_hash,
                                cl.session_id  = $session_id,
                                cl.created_at  = datetime()
                WITH cl
                // cites_node_ids: Evidence(evidence_id) only. A Claim no longer
                // cites a Paper directly — to cite a paper the LLM declares an
                // Evidence extracted from it and cites that Evidence here. Each
                // cite batch runs in its own subquery so an empty list never
                // drops the claim row — an empty UNWIND would otherwise zero
                // out the rest of the query and lose the later cited_targets
                // return.
                CALL {
                  WITH cl
                  UNWIND $cites_node_ids AS ev_id
                  MATCH (target:Evidence { evidence_id: ev_id })
                  MERGE (cl)-[:cites]->(target)
                }
                WITH cl
                // cites_artifact_refs: Artifact pinned to (artifact_id, version)
                // — the exact version the LLM declared against, not the latest.
                CALL {
                  WITH cl
                  UNWIND $cites_artifact_refs AS ref
                  MATCH (target:Artifact { artifact_id: ref.artifact_id, version: ref.version })
                  MERGE (cl)-[:cites]->(target)
                }
                WITH cl
                // optional states from the report Artifact (Artifact→Claim: this
                // report asserts this claim), pinned to the report's version. The
                // caller verified the Artifact exists; the FOREACH guard is a
                // belt-and-suspenders no-op when artifact_id/version is None or
                // the Artifact is missing.
                OPTIONAL MATCH (a:Artifact { artifact_id: $artifact_id, version: $artifact_version })
                FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | MERGE (a)-[:states]->(cl))
                WITH cl
                OPTIONAL MATCH (cl)-[:cites]->(cited)
                RETURN cl.claim_id AS claim_id,
                       collect(DISTINCT {
                         evidence_id: cited.evidence_id,
                         artifact_id: cited.artifact_id,
                         version: cited.version,
                         labels: labels(cited)
                       }) AS cited_targets
                """,
                claim_id=claim_id,
                session_id=session_id,
                content=content,
                claim_type=claim_type,
                confidence=confidence,
                locator=locator,
                content_hash=content_hash,
                cites_node_ids=cites_node_ids,
                cites_artifact_refs=cites_artifact_refs,
                artifact_id=artifact_id,
                artifact_version=artifact_version,
            ).single())
            rec = result
        cited = list(rec["cited_targets"]) if rec else []
        log.info("declare_claim done: claim=%s session=%s cites=%d artifact=%s",
                 claim_id, session_id, len(cited), artifact_id or "-")
        return cited
    except Exception as exc:
        log.exception("declare_claim failed: claim=%s session=%s: %s",
                       claim_id, session_id, exc)
        raise


def link_claims_to_report(*, artifact_id: str, artifact_version: int, claim_ids: list[str]) -> int:
    """MERGE ``states`` edges from one report Artifact version to each Claim.

    Builds the ``Artifact -[:states]-> Claim`` link so the graph can navigate
    "which report asserts which claim", pinned to the report's specific
    version (Artifact is keyed on the composite ``(artifact_id, version)``,
    so the version is required to hit the right node). The caller verified the
    Artifact version and every Claim already exist; empty ``claim_ids`` is a
    no-op. Returns the number of edges merged.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("link_claims_to_report skipped: Neo4j not reachable (artifact=%s v%s)",
                    artifact_id, artifact_version)
        return 0
    if not claim_ids:
        return 0
    log.debug("link_claims_to_report starting: artifact=%s v%s claims=%d",
              artifact_id, artifact_version, len(claim_ids))
    try:
        with driver.session() as session:
            result = session.run(
                """
                MATCH (a:Artifact { artifact_id: $artifact_id, version: $artifact_version })
                UNWIND ($claim_ids + []) AS cid
                MATCH (cl:Claim { claim_id: cid })
                MERGE (a)-[:states]->(cl)
                RETURN count(cl) AS linked
                """,
                artifact_id=artifact_id,
                artifact_version=artifact_version,
                claim_ids=claim_ids,
            )
            linked = int((result.single() or {}).get("linked") or 0)
        log.info("link_claims_to_report done: artifact=%s v%s claims=%d linked=%d",
                 artifact_id, artifact_version, len(claim_ids), linked)
        return linked
    except Exception as exc:
        log.exception("link_claims_to_report failed: artifact=%s v%s: %s",
                       artifact_id, artifact_version, exc)
        raise
