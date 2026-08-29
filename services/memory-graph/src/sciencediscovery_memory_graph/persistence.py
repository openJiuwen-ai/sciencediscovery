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

"""Persistence helpers: upsert Task/ToolCall / Code / Artifact / Paper + ``produces`` edges.

Node labels: a subagent's scope is ``:Task`` (``task_type='subagent'``);
every execution/search node — whether session-main or a subagent's internal
child — is ``:ToolCall`` (``code_execution``/``literature_search``/…). MVP
scope: one ToolCall per execution (no DAG / ``inferred_subtask_types`` state
machine — dedup is intentionally DROPPED), one Code per execution
(``code_id = executionId``), one Artifact node per logical artifact id
(latest fields; versioning is v2). ``upsert_mcp_search`` adds one
auto-inferred ToolCall per MCP search invocation
(``task_id = "subtask:mcp:" + invocation_id``, NOT deduplicated — every
search is its own ToolCall) + Paper nodes deduped by normalized URL
(re-search only bumps ``retrieved_at`` / ``retrieval_count``) +
``ToolCall -produces-> Paper`` edges. All writes are ``MERGE`` on the unique
key so hooks are idempotent across retries.
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
    parent_subagent_id: str | None = None,
    input_source_files: list[dict[str, Any]] | None = None,
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

    ``parent_subagent_id`` selects the write shape. When ``None`` (main-agent
    context), a per-execution SubTask ``subtask:<execution_id>`` is built and
    produces the Code/Artifact — the original main behavior, unchanged. When
    set (this execution ran inside a subagent), a *child* SubTask
    ``subtask:subagent:<id>:exec:<execution_id>`` is built (task_type is the
    real ``code_execution`` — NOT ``subagent``), a ``contains`` edge links the
    subagent's scope node to this child, and produces edges run
    ``child → Code`` / ``child → Artifact`` (the scope never carries
    products). The child does not join the session temporal chain — only
    session-main SubTasks do.

    ``input_source_files`` is a distinct top-level input channel from the
    per-artifact ``input_artifact_versions`` above: it carries the SourceFile
    nodes (uploaded files) this Code run read, as ``{file_id}`` keys (SourceFile
    has no version, unlike Artifact). The recorder infers them by scanning the
    code text for uploaded-file paths (same grain as
    ``inferredArtifactInputs``). The ``input`` edge (SourceFile → Code) is built
    AFTER the produced_artifacts loop, anchored on the Code node — input is a
    property of the Code run ("what this run read"), not of any one produced
    artifact. MERGE on (file_id, code_id) keeps re-runs idempotent. Built only
    when the SourceFile node already exists (block 1's ``upsert_source_file``
    writes it fire-and-forget at upload time); a missing SourceFile MATCHes
    nothing and the edge is silently skipped — the same fire-and-forget
    degradation as the rest of the mirror.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("upsert skipped: Neo4j not reachable (execution=%s session=%s)", execution_id, session_id)
        return

    # Normalise the status string: the execution path reports lowercase
    # "succeeded"/"failed", the MCP search path reports uppercase "COMPLETED".
    # Unify on lowercase completed/failed so the frontend has one green label.
    status = _normalise_subtask_status(status)

    # Subagent child path: this execution ran inside a subagent, so it becomes
    # a child ToolCall (real task_type=code_execution) hung off the subagent's
    # scope node via contains. Products hang off the child, never the scope.
    if parent_subagent_id is not None:
        _upsert_execution_child(
            driver=driver,
            execution_id=execution_id,
            session_id=session_id,
            turn_id=turn_id,
            tool=tool,
            language=language,
            code_hash=code_hash,
            exit_code=exit_code,
            status=status,
            started_at=started_at,
            finished_at=finished_at,
            produced_artifacts=produced_artifacts,
            stdout_hash=stdout_hash,
            stderr_hash=stderr_hash,
            env_hash=env_hash,
            parent_subagent_id=parent_subagent_id,
            input_source_files=input_source_files,
        )
        return

    task_id = f"subtask:{execution_id}"
    log.debug("upsert starting: execution=%s session=%s artifacts=%d", execution_id, session_id, len(produced_artifacts))

    try:
        with driver.session() as session:
            # ToolCall (auto-inferred, one per execution). seq is assigned once
            # (ON CREATE) so the temporal chain orders by creation, not by
            # finished_at — a still-running execution would otherwise sort to
            # the front and pollute the chain head.
            seq = _next_session_seq(session, session_id)
            session.run(
                """
                MERGE (st:ToolCall {task_id: $task_id})
                  ON CREATE SET st.session_id  = $session_id,
                                st.status     = $status,
                                st.task_type  = $task_type,
                                st.created_at = datetime(),
                                st.finished_at = $finished_at,
                                st.turn_id    = $turn_id,
                                st.seq        = $seq
                """,
                task_id=task_id,
                session_id=session_id,
                status=status,
                task_type=task_type,
                finished_at=finished_at,
                turn_id=turn_id,
                seq=seq,
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
                MERGE (st:ToolCall {task_id: $task_id})
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
            # explicit dependency chain yet, link its auto-inferred SubTasks
            # (execution/mcp_search) by finished_at into a linear next chain,
            # only adding edges between consecutive orphans. Idempotent.
            _link_subtasks_by_finish_time(session, session_id)

            # SourceFile inputs — uploaded files this Code run read. Built
            # AFTER the produced_artifacts loop, anchored on the Code node:
            # input is a property of the Code run ("what this run read"), not
            # of any one produced artifact, so it is a distinct top-level
            # channel from the per-artifact ``input_artifact_versions`` above
            # (SourceFile has no version; its endpoint key is ``file_id``).
            # The Code node was MERGEd above (code_id=execution_id); the
            # SourceFile nodes are written fire-and-forget at upload time
            # (block 1's upsert_source_file) — a missing SourceFile MATCHes
            # nothing and the edge is silently skipped (fire-and-forget
            # degradation). MERGE on (file_id, code_id) keeps re-runs idempotent.
            _link_source_file_inputs(session, execution_id, input_source_files)

        log.info("upsert done: execution=%s session=%s wrote %d nodes and %d produces edges",
                 execution_id, session_id,
                 1 + 1 + len(produced_artifacts), 1 + len(produced_artifacts))
    except Exception as exc:
        log.exception("upsert failed: execution=%s session=%s: %s", execution_id, session_id, exc)
        raise


def _upsert_execution_child(
    *,
    driver: Any,
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
    produced_artifacts: list[dict[str, Any]],
    stdout_hash: str | None,
    stderr_hash: str | None,
    env_hash: str | None,
    parent_subagent_id: str,
    input_source_files: list[dict[str, Any]] | None = None,
) -> None:
    """Build a subagent child ToolCall for one execution.

    The child ``subtask:subagent:<id>:exec:<execution_id>`` carries the real
    ``code_execution`` task_type (NOT ``subagent`` — that label is the scope's),
    a ``parent_subtask_id`` pointing at the subagent's scope, and a session-level
    ``seq`` assigned once at creation. The scope node is matched (built
    separately by ``upsert_subagent``) and a ``contains`` edge links
    scope→child. Products (Code/Artifact) are hung off the CHILD via produces,
    never the scope — so trace-back from a product lands on the exact child.
    derived-from / supersedes edges stay on the Code node (unchanged from the
    main path). The child does not enter the session temporal chain.
    """
    scope_task_id = f"subtask:subagent:{parent_subagent_id}"
    task_id = f"subtask:subagent:{parent_subagent_id}:exec:{execution_id}"
    log.debug("upsert (child) starting: execution=%s session=%s artifacts=%d scope=%s",
              execution_id, session_id, len(produced_artifacts), scope_task_id)
    try:
        with driver.session() as session:
            # Child SubTask: real task_type=code_execution, parent_subtask_id
            # points at the scope, seq assigned once (ON CREATE only — never
            # overwritten on the terminal re-mirror). The scope is matched
            # (not MERGEd here — upsert_subagent owns it) and linked via contains.
            seq = _next_session_seq(session, session_id)
            session.run(
                """
                MERGE (st:ToolCall {task_id: $task_id})
                  ON CREATE SET st.session_id        = $session_id,
                                st.status           = $status,
                                st.task_type        = 'code_execution',
                                st.parent_subtask_id = $parent_subtask_id,
                                st.turn_id          = $turn_id,
                                st.created_at       = datetime(),
                                st.finished_at       = $finished_at,
                                st.seq               = $seq
                  ON MATCH  SET st.status      = $status,
                                st.finished_at = $finished_at,
                                st.turn_id     = $turn_id
                """,
                task_id=task_id,
                session_id=session_id,
                status=status,
                parent_subtask_id=scope_task_id,
                turn_id=turn_id,
                finished_at=finished_at,
                seq=seq,
            ).consume()
            # Rebuild the scope's internal child chain: contains→first child,
            # next→rest (in seq order). Idempotent (deletes then rebuilds).
            # Centralised here so both execution and mcp-search child writers
            # share one ordering path and never write contains themselves.
            _link_scope_children(session, session_id, scope_task_id)

            # Code node (code_id = executionId, unchanged). produces runs
            # child → Code (the child is the producer, not the scope).
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
                MERGE (st:ToolCall {task_id: $task_id})
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

            # Artifact versions; produces runs Code → Artifact, exactly as the
            # main path. The child is still the Code's producer (child → Code
            # via the produces edge above), so trace-back from an Artifact walks
            # Artifact ←[:produces]← Code ←[:produces]← child and lands on the
            # child — not the scope — while keeping the Code layer in the chain
            # so the view-chain derivation (Artifact ←produces← Code ←input←
            # Artifact) does not break. Hanging Artifact off the child ToolCall
            # directly (child → Artifact) skips the Code layer and the frontend's
            # provenance chain stops at SubTask, dropping the Code node.
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
                # derived-from and supersedes stay anchored on the Code node,
                # exactly as the main path — only the producer of the Code
                # itself changed (child instead of per-exec SubTask).
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

            # SourceFile inputs for the subagent-child path: the child's Code
            # node (code_id=execution_id) was MERGEd above. Same input-is-Code-
            # property rationale + fire-and-forget degradation as the main path.
            _link_source_file_inputs(session, execution_id, input_source_files)

        log.info("upsert (child) done: execution=%s session=%s scope=%s wrote child + Code + %d Artifact(s)",
                 execution_id, session_id, scope_task_id, len(produced_artifacts))
    except Exception as exc:
        log.exception("upsert (child) failed: execution=%s session=%s: %s", execution_id, session_id, exc)
        raise


def _link_source_file_inputs(
    session: Any, execution_id: str, refs: list[dict[str, Any]] | None,
) -> None:
    """MERGE ``SourceFile -[:input]-> Code`` edges for one execution.

    Distinct from the per-artifact ``input_artifact_versions`` loop: SourceFile
    is a user-uploaded file (block 1's ``upsert_source_file`` writes it at
    upload time), has no version, and its endpoint key is ``file_id``. The
    edge is anchored on the Code node (``code_id = execution_id``), not on any
    produced artifact, because input is a property of the Code run ("what this
    run read"), not of a product. Built from the payload's ``input_source_files``
    list (the recorder infers it by scanning the code text for uploaded-file
    paths, same grain as ``inferredArtifactInputs``). The SourceFile node must
    already exist; a missing one MATCHes nothing and the edge is silently
    skipped — the same fire-and-forget degradation as the rest of the mirror.
    MERGE on (file_id, code_id) keeps re-runs idempotent. Runs inside the
    caller's open session/tx.
    """
    for ref in refs or []:
        file_id = ref.get("file_id")
        if not file_id:
            continue
        session.run(
            """
            MATCH (sf:SourceFile {file_id: $fid})
            MATCH (c:Code {code_id: $code_id})
            MERGE (sf)-[:input]->(c)
            """,
            fid=file_id,
            code_id=execution_id,
        ).consume()


def upsert_mcp_search(
    *,
    invocation_id: str,
    session_id: str,
    turn_id: str,
    source: str,
    tool_type: str,
    retrieved_at: str,
    records: list[dict[str, Any]],
    parent_subagent_id: str | None = None,
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

    ``parent_subagent_id`` (subagent context) reshapes the write exactly like
    ``upsert_execution``: a *child* SubTask
    ``subtask:subagent:<id>:exec:<invocation_id>`` (task_type=literature_search)
    is built, ``contains`` links the subagent scope to it, and produces runs
    ``child → Paper`` (the scope carries no papers). The child stays out of the
    session temporal chain. Main-agent context (``None``) is unchanged.
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

    if not papers:
        log.info("upsert_mcp_search: invocation=%s had no records with a URL; writing SubTask only",
                 invocation_id)

    # Subagent child path: this search ran inside a subagent → child ToolCall
    # (real task_type=literature_search) hung off the scope via contains, with
    # produces child→Paper.
    if parent_subagent_id is not None:
        _upsert_mcp_search_child(
            driver=driver,
            invocation_id=invocation_id,
            session_id=session_id,
            turn_id=turn_id,
            source=source,
            tool_type=tool_type,
            papers=papers,
            parent_subagent_id=parent_subagent_id,
        )
        return

    task_id = f"subtask:mcp:{invocation_id}"
    log.debug("upsert_mcp_search starting: invocation=%s session=%s papers=%d",
              invocation_id, session_id, len(papers))

    try:
        with driver.session() as session:
            # ToolCall (auto-inferred, one per MCP search; NOT deduped). seq
            # assigned once (ON CREATE) so the temporal chain orders by creation.
            seq = _next_session_seq(session, session_id)
            session.run(
                """
                MERGE (st:ToolCall {task_id: $task_id})
                  ON CREATE SET st.session_id  = $session_id,
                                st.status     = $status,
                                st.task_type  = 'literature_search',
                                st.source     = $source,
                                st.tool_type  = $tool_type,
                                st.created_at = datetime(),
                                st.finished_at = datetime(),
                                st.result_count = $result_count,
                                st.seq        = $seq
                """,
                task_id=task_id,
                session_id=session_id,
                source=source,
                tool_type=tool_type,
                result_count=len(papers),
                status="completed",
                seq=seq,
            ).consume()

            # Temporal-chain fallback: when this session has no
            # explicit dependency chain yet, link its auto-inferred SubTasks
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
                    MERGE (st:ToolCall { task_id: $task_id })
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


def _upsert_mcp_search_child(
    *,
    driver: Any,
    invocation_id: str,
    session_id: str,
    turn_id: str,
    source: str,
    tool_type: str,
    papers: list[dict[str, Any]],
    parent_subagent_id: str,
) -> None:
    """Build a subagent child ToolCall for one MCP literature search.

    Mirrors ``_upsert_execution_child``: child
    ``subtask:subagent:<id>:exec:<invocation_id>`` (task_type=literature_search),
    ``contains`` scope→child, ``produces`` child→Paper. The scope is owned by
    ``upsert_subagent`` and only matched here. The child stays out of the
    session temporal chain.
    """
    scope_task_id = f"subtask:subagent:{parent_subagent_id}"
    task_id = f"subtask:subagent:{parent_subagent_id}:exec:{invocation_id}"
    log.debug("upsert_mcp_search (child) starting: invocation=%s session=%s papers=%d scope=%s",
              invocation_id, session_id, len(papers), scope_task_id)
    try:
        with driver.session() as session:
            seq = _next_session_seq(session, session_id)
            session.run(
                """
                MERGE (st:ToolCall {task_id: $task_id})
                  ON CREATE SET st.session_id        = $session_id,
                                st.status           = 'completed',
                                st.task_type        = 'literature_search',
                                st.parent_subtask_id = $parent_subtask_id,
                                st.source           = $source,
                                st.tool_type        = $tool_type,
                                st.turn_id          = $turn_id,
                                st.created_at       = datetime(),
                                st.finished_at      = datetime(),
                                st.result_count      = $result_count,
                                st.seq              = $seq
                  ON MATCH  SET st.result_count = $result_count
                """,
                task_id=task_id,
                session_id=session_id,
                parent_subtask_id=scope_task_id,
                source=source,
                tool_type=tool_type,
                turn_id=turn_id,
                result_count=len(papers),
                seq=seq,
            ).consume()
            # Rebuild the scope's internal child chain (contains→first,
            # next→rest) — shared with the execution child writer.
            _link_scope_children(session, session_id, scope_task_id)

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
                    MERGE (st:ToolCall { task_id: $task_id })
                    MERGE (st)-[:produces]->(p)
                    """,
                    papers=papers,
                    session_id=session_id,
                    task_id=task_id,
                ).consume()

        log.info("upsert_mcp_search (child) done: invocation=%s session=%s scope=%s wrote child + %d Paper(s)",
                 invocation_id, session_id, scope_task_id, len(papers))
    except Exception as exc:
        log.exception("upsert_mcp_search (child) failed: invocation=%s session=%s: %s",
                       invocation_id, session_id, exc)
        raise


# Normalise a subagent's lifecycle status onto the graph's vocabulary. timed_out
# collapses to ``failed`` (one red label) but is tagged separately in
# ``failure_reason`` so it is not confused with a plain error. cancelled and
# completed pass through verbatim. running is only ever written by the start
# phase (status="running" never reaches here from a terminal call).
_SUBAGENT_TERMINAL_STATUSES = {"completed", "failed", "cancelled", "timed_out"}


def _normalise_subagent_status(status: str) -> tuple[str, str | None]:
    """Map a raw subagent status onto (graph_status, failure_reason).

    ``timed_out`` → (``failed``, ``"timed_out"``); the graph stores one
    ``failed`` label but the structured ``failure_reason`` keeps the cause
    distinct from a plain error. ``completed``/``cancelled``/``failed`` map to
    themselves with failure_reason only set on ``failed`` (``"error"``) and
    ``cancelled`` (``"aborted"``). Unknown statuses pass through unchanged.
    """
    if status == "timed_out":
        return "failed", "timed_out"
    if status == "failed":
        return "failed", "error"
    if status == "cancelled":
        return "cancelled", "aborted"
    return status, None


def upsert_subagent(
    *,
    subagent_id: str,
    session_id: str,
    turn_id: str,
    objective: str,
    task_type: str,
    subagent_type: str | None,
    created_at: str,
    status: str,
    finished_at: str | None = None,
    summary: str | None = None,
) -> None:
    """Mirror a subagent's lifecycle into one scope SubTask node.

    Two phases, both MERGEd on ``task_id = subtask:subagent:<subagentId>``:

    - **Start phase** (``status="running"``): writes the stable identity fields
      — ``objective``, ``task_type`` (the coarse scope label, normally
      ``subagent``), ``subagent_type`` (role), ``created_at``, ``session_id``,
      ``turn_id``, and a session-level ``seq`` assigned once at creation. The
      terminal fields (``finished_at`` / ``summary`` / ``failure_reason``) are
      NOT written — they are absent while running.
    - **Terminal phase** (``status`` in completed/failed/cancelled/timed_out):
      ON MATCH only fills the gaps — writes ``status``, ``finished_at``,
      ``summary``, ``failure_reason``. It does NOT overwrite the start-phase
      ``objective`` / ``subagent_type`` / ``created_at`` / ``seq`` (and
      ``session_id`` is written only on CREATE, so the scope's session is the
      one that created it — a later re-mirror cannot hijack it).

    ``timed_out`` is normalised to ``failed`` (one red label) with
    ``failure_reason="timed_out"`` kept distinct. ``summary`` is guaranteed
    non-empty: on a successful terminal call with no text, the deterministic
    fallback ``"Subagent completed without a text response."`` is used (matches
    the placeholder the run itself publishes) so the scope node never carries
    an empty summary. The scope never carries products — each internal toolcall
    is a separate child ToolCall built by ``upsert_execution`` /
    ``upsert_mcp_search`` (with ``parent_subagent_id``) and hung off this scope
    via ``contains``. The scope does join the session temporal chain (ordered
    by ``seq``); its children do not.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("upsert_subagent skipped: Neo4j not reachable (subagent=%s session=%s)",
                    subagent_id, session_id)
        return

    task_id = f"subtask:subagent:{subagent_id}"
    is_terminal = status in _SUBAGENT_TERMINAL_STATUSES and status != "running"
    log.debug("upsert_subagent starting: subagent=%s session=%s status=%s terminal=%s",
              subagent_id, session_id, status, is_terminal)

    try:
        with driver.session() as session:
            if not is_terminal:
                # Start phase: write identity + seq, leave terminal fields absent.
                seq = _next_session_seq(session, session_id)
                session.run(
                    """
                    MERGE (st:Task {task_id: $task_id})
                      ON CREATE SET st.session_id     = $session_id,
                                    st.objective      = $objective,
                                    st.task_type       = $task_type,
                                    st.subagent_type   = $subagent_type,
                                    st.created_at      = $created_at,
                                    st.turn_id         = $turn_id,
                                    st.status          = $status,
                                    st.seq             = $seq
                      ON MATCH  SET st.status  = $status,
                                    st.turn_id = $turn_id
                    """,
                    task_id=task_id,
                    session_id=session_id,
                    objective=objective,
                    task_type=task_type,
                    subagent_type=subagent_type,
                    created_at=created_at,
                    turn_id=turn_id,
                    status=status,
                    seq=seq,
                ).consume()
            else:
                # Terminal phase: normalise status, guarantee non-empty summary,
                # then ON MATCH fill only the terminal gaps. session_id and seq
                # are NOT touched on MATCH (ON CREATE owns them; a terminal
                # re-mirror cannot rehome the scope or bump its seq). If the
                # start phase never ran (terminal arrives first), ON CREATE
                # builds the node with the identity fields + a fresh seq, so the
                # node still has a creation order for the chain.
                graph_status, failure_reason = _normalise_subagent_status(status)
                terminal_summary: str | None = summary
                if graph_status == "completed" and not (summary and summary.strip()):
                    terminal_summary = "Subagent completed without a text response."
                seq = _next_session_seq(session, session_id)
                session.run(
                    """
                    MERGE (st:Task {task_id: $task_id})
                      ON CREATE SET st.session_id     = $session_id,
                                    st.objective      = $objective,
                                    st.task_type       = $task_type,
                                    st.subagent_type   = $subagent_type,
                                    st.created_at      = $created_at,
                                    st.turn_id         = $turn_id,
                                    st.status          = $graph_status,
                                    st.seq             = $seq
                      ON MATCH  SET st.status         = $graph_status,
                                    st.finished_at    = $finished_at,
                                    st.summary         = $terminal_summary,
                                    st.failure_reason  = $failure_reason
                    """,
                    task_id=task_id,
                    session_id=session_id,
                    objective=objective,
                    task_type=task_type,
                    subagent_type=subagent_type,
                    created_at=created_at,
                    turn_id=turn_id,
                    graph_status=graph_status,
                    seq=seq,
                    finished_at=finished_at,
                    terminal_summary=terminal_summary,
                    failure_reason=failure_reason,
                ).consume()

            # Rebuild the session temporal chain so this scope takes its place
            # (ordered by seq). Children are excluded from the main chain.
            _link_subtasks_by_finish_time(session, session_id)

        log.info("upsert_subagent done: subagent=%s session=%s status=%s",
                 subagent_id, session_id, status)
    except Exception as exc:
        log.exception("upsert_subagent failed: subagent=%s session=%s: %s",
                      subagent_id, session_id, exc)
        raise


def _next_session_seq(session: Any, session_id: str) -> int:
    """Allocate the next session-level ``seq`` for a SubTask.

    ``seq`` is a per-session monotonic ordering key assigned once at a node's
    creation (ON CREATE only — never overwritten on a re-mirror). The session
    temporal chain orders by ``seq`` instead of ``finished_at`` so a SubTask
    still running (no ``finished_at``) does not sort to the front and pollute
    the chain head. Children (``subtask:subagent:...:exec:...``) are excluded
    from the session main chain (they form their own scope-internal chain) but
    still consume a seq so the allocation stays monotonic across all nodes.

    Read-then-write inside the caller's open session/tx: writes are
    fire-and-forget and concurrency is best-effort (two concurrent subagent
    starts in one session can draw the same seq — acceptable for ordering
    fallback; the chain rebuild is idempotent). Returns the next seq (>= 1).
    """
    result = session.run(
        "MATCH (st) WHERE (st:Task OR st:ToolCall) AND st.session_id = $sid "
        "RETURN coalesce(max(st.seq), 0) AS m",
        sid=session_id,
    )
    rec = result.single()
    return int(rec["m"] if rec else 0) + 1


def _link_scope_children(session: Any, session_id: str, scope_task_id: str) -> None:
    """Rebuild one subagent scope's internal child chain: ``contains`` → the
    *first* child only, then ``next`` links consecutive children in ``seq``
    order so the scope's internal run reads as an ordered chain rather than a
    star fanning off ``contains`` edges:

        Task(scope) -[:contains]-> ToolCall₁ -[:next]-> ToolCall₂ -> … -> ToolCallₙ

    Children are ``:ToolCall`` nodes carrying ``parent_subtask_id`` pointing at
    the scope's ``task_id`` (written by ``_upsert_execution_child`` /
    ``_upsert_mcp_search_child``). The scope itself is a ``:Task`` (built by
    ``upsert_subagent``) — matched, not MERGEd here. Idempotent: it first
    deletes this scope's existing ``scope_chain`` ``contains`` + ``next``
    edges and rebuilds the whole chain. A scope with 0 or 1 children produces
    at most the single ``contains`` edge (no ``next``). Runs inside the
    caller's open session/tx; fire-and-forget, best-effort concurrency.

    The ``contains``-only-first rule (需求1) keeps ``contains`` as the
    *entry* marker into a scope's child run; ordering between siblings is
    ``next``'s job — mirroring the session main chain's goal→head→…→last shape.
    """
    # Drop this scope's prior scope-internal chain so it can be rebuilt from
    # scratch as children land / re-order. Only edges where the scope is the
    # contains source OR where both endpoints are this scope's children are
    # in scope (a child's task_id pins it to this scope via parent_subtask_id).
    session.run(
        """
        MATCH (scope:Task {task_id: $tid})
        OPTIONAL MATCH (scope)-[rc:contains]->(:ToolCall)
        DELETE rc
        WITH scope
        MATCH (child:ToolCall {parent_subtask_id: $tid})
        WHERE child.session_id = $sid
        OPTIONAL MATCH (child)-[rn:next {method: 'scope_chain'}]->(:ToolCall)
        DELETE rn
        """,
        tid=scope_task_id,
        sid=session_id,
    ).consume()

    # Order this scope's children by seq (monotonic across the session,
    # assigned once at creation). contains → the first; next → each
    # consecutive pair. method='scope_chain' marks these as visibility
    # fallbacks (same convention as the session temporal_chain) so the
    # frontend can de-emphasise them.
    session.run(
        """
        MATCH (child:ToolCall {parent_subtask_id: $tid, session_id: $sid})
        WITH child ORDER BY coalesce(child.seq, 0), child.finished_at
        WITH collect(child) AS ordered
        // First child (if any) hangs off the scope via contains.
        WITH ordered, ordered[0] AS first
        CALL (first) {
          MATCH (scope:Task {task_id: $tid})
          MERGE (scope)-[:contains]->(first)
        }
        // Consecutive pairs (first → second → … → last) via next.
        WITH ordered
        UNWIND range(0, size(ordered) - 2) AS i
        WITH ordered[i] AS a, ordered[i + 1] AS b
        MERGE (a)-[r:next]->(b)
          ON CREATE SET r.inferred = true,
                        r.basis    = 'seq',
                        r.method   = 'scope_chain'
          ON MATCH  SET r.inferred = true,
                        r.basis    = 'seq',
                        r.method   = 'scope_chain'
        """,
        tid=scope_task_id,
        sid=session_id,
    ).consume()


def _link_subtasks_by_finish_time(session: Any, session_id: str) -> int:
    """Connect a session's main-chain ToolCalls/Tasks by ``seq`` into a single
    linear ``next`` chain hanging off the ResearchGoal:

        ResearchGoal -[:next]-> ToolCall₁ -[:next]-> … -> Task(scope) -[:next]-> … -> ToolCallₙ

    The goal connects to the *first* node only; each node then links to the
    next by ``seq``. Ordering by ``seq`` (not ``finished_at``) means a node
    still running (no ``finished_at`` — e.g. a subagent scope mirrored at its
    start) is NOT sorted to the front and does not pollute the chain head; it
    sits at its creation order. ``r.method='temporal_chain'`` +
    ``basis='seq'`` on every edge marks it as a visibility fallback, not a real
    dependency, so the frontend can de-emphasize it. Legacy nodes created
    before ``seq`` existed fall back to ``finished_at`` as a tiebreaker so the
    chain stays stable.

    Scope-internal child ToolCalls (``subtask:subagent:<id>:exec:...``) do NOT
    enter the session main chain — they are hung off their scope via
    ``contains`` (first child) + ``next`` (rest, via ``_link_scope_children``)
    and ordered internally by their own ``seq``. Only session-main nodes
    (main-agent execution ``subtask:<execId>``, main-agent mcp search
    ``subtask:mcp:<invId>``, and subagent scopes ``subtask:subagent:<id>``)
    are selected. Idempotent: it first deletes this session's existing
    ``temporal_chain`` ``next`` edges and rebuilds the whole
    chain. Real (non-temporal) ``next`` edges are left untouched. Returns the
    number of edges added. Runs inside the caller's open session/tx.
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
    # the next upsert once the goal exists. A child never qualifies as head —
    # the WHERE clause excludes ``subtask:subagent:...:exec:...`` ids so the
    # main chain's head is always a session-main node (scope / main exec / main
    # mcp). seq orders the chain; finished_at is only a legacy tiebreaker.
    session.run(
        """
        MATCH (st)
        WHERE (st:Task OR st:ToolCall)
          AND st.session_id = $sid
          AND st.task_id STARTS WITH 'subtask:'
          AND NOT st.task_id CONTAINS ':exec:'
        WITH st ORDER BY coalesce(st.seq, 0), st.finished_at
        WITH collect(st)[0] AS head
        CALL (head) {
          OPTIONAL MATCH (g:ResearchGoal {goal_id: $goal_id})
          WITH g, head
          WHERE g IS NOT NULL
          MERGE (g)-[r:next]->(head)
            ON CREATE SET r.inferred = true,
                          r.basis     = 'seq',
                          r.method    = 'temporal_chain'
            ON MATCH  SET r.inferred = true,
                          r.basis     = 'seq',
                          r.method    = 'temporal_chain'
        }
        """,
        sid=session_id,
        goal_id=f"goal:session:{session_id}",
    ).consume()

    # head → next → ... → last (consecutive pairs in seq order).
    result = session.run(
        """
        MATCH (st)
        WHERE (st:Task OR st:ToolCall)
          AND st.session_id = $sid
          AND st.task_id STARTS WITH 'subtask:'
          AND NOT st.task_id CONTAINS ':exec:'
        WITH st ORDER BY coalesce(st.seq, 0), st.finished_at
        WITH collect(st) AS ordered
        UNWIND range(0, size(ordered) - 2) AS i
        WITH ordered[i] AS a, ordered[i + 1] AS b
        MERGE (a)-[r:next]->(b)
          ON CREATE SET r.inferred = true,
                        r.basis    = 'seq',
                        r.method   = 'temporal_chain'
          ON MATCH  SET r.inferred = true,
                        r.basis    = 'seq',
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
    project. After MERGEing the goal it attaches every still-dangling
    SourceFile of the session with a ``feeds`` edge — files uploaded before
    the first message have a node but no goal to feed yet (the upload path
    must not create a placeholder goal). Returns ``goal_id`` on success,
    ``None`` when skipped.
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
                WITH g
                MATCH (f:SourceFile {session_id: $sid})
                MERGE (f)-[:feeds]->(g)
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


def upsert_source_file(
    *,
    file_id: str,
    session_id: str,
    name: str,
    path: str,
    media_type: str | None,
    size: int | None,
    content_hash: str | None,
    created_at: str,
) -> str | None:
    """Idempotent: MERGE a SourceFile node + a ``feeds`` edge when the goal exists.

    ``file_id`` is the deterministic business key
    (``"source_file:session:" + session_id + ":" + path``), so re-uploading the
    same file hits the existing node and creates no duplicate — one SourceFile
    per uploaded file per session. ON CREATE writes every field; ON MATCH
    refreshes the mutable ones (``name``/``path``/``size``/``content_hash``)
    so an overwrite re-upload keeps the graph in sync with the CAS, while
    ``media_type`` only fills forward (``coalesce``): a re-upload whose type
    can't be inferred (``inferMediaType`` returns undefined for unknown
    extensions) must not erase the type an earlier upload did set.
    The ``feeds`` edge links the file to the
    session's ResearchGoal (``goal_id = "goal:session:" + session_id``), but a
    file uploaded before the first message must NOT create a placeholder goal:
    the edge is attached only when the goal already exists (upload after the
    first message); otherwise the file stays dangling and is linked later by
    ``upsert_session_first_message``, which MERGEs the goal from the real
    first message and then attaches every still-dangling SourceFile of the
    session. Idempotent MERGE on both sides. Written fire-and-forget by the
    upload handler; returns ``file_id`` on success, ``None`` when skipped.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("upsert_source_file skipped: Neo4j not reachable (session=%s file=%s)",
                    session_id, file_id)
        return None

    goal_id = "goal:session:" + session_id
    log.debug("upsert_source_file starting: session=%s file=%s name=%s",
              session_id, file_id, name)
    try:
        with driver.session() as session:
            session.run(
                """
                MERGE (f:SourceFile {file_id: $file_id})
                  ON CREATE SET f.session_id    = $sid,
                                f.name          = $name,
                                f.path          = $path,
                                f.media_type    = $media_type,
                                f.size          = $size,
                                f.content_hash  = $content_hash,
                                f.origin        = 'user_upload',
                                f.created_at    = datetime($created_at)
                  ON MATCH  SET f.size          = $size,
                                f.content_hash  = $content_hash,
                                f.name          = $name,
                                f.path          = $path,
                                f.media_type    = coalesce($media_type, f.media_type)
                WITH f
                CALL (f) {
                  OPTIONAL MATCH (g:ResearchGoal {goal_id: $goal_id})
                  WITH f, g
                  WHERE g IS NOT NULL
                  MERGE (f)-[:feeds]->(g)
                }
                RETURN f.file_id AS file_id
                """,
                sid=session_id,
                goal_id=goal_id,
                file_id=file_id,
                name=name,
                path=path,
                media_type=media_type,
                size=size,
                content_hash=content_hash,
                created_at=created_at,
            ).consume()
        log.info("upsert_source_file done: session=%s file=%s", session_id, file_id)
        return file_id
    except Exception as exc:
        log.exception("upsert_source_file failed: session=%s file=%s: %s",
                      session_id, file_id, exc)
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
    source_paper_link: str | None,
    locator: str,
    evidence_type: str,
    confidence: str,
    strength: str,
    source_file_id: str | None = None,
) -> str | None:
    """CREATE one Evidence + ``extracts`` (Paper/PDF-SourceFile → Evidence).

    Two source branches, mutually exclusive:

    - ``source_paper_link`` set → the Paper branch (legacy): MATCH the Paper
      by normalized link and store ``source_paper_link`` on the Evidence
      node. ``source_file_id`` is left null.
    - ``source_file_id`` set → the SourceFile-PDF branch (block 3): MATCH the
      SourceFile by ``file_id`` and store ``source_file_id`` on the Evidence
      node (NOT ``source_paper_link`` — see omission-1 note below).
      ``source_paper_link`` is left null.

    The caller (server.py /persist/evidence) validates the source exists AND
    enforces that a SourceFile used here is a PDF (``media_type=
    application/pdf``): a non-PDF data file is rejected at the server layer
    with ``source_file_not_pdf`` because data files are not "arguments
    extracted from a document" and must instead directly support a Claim via
    ``declare_claim``'s ``cites_source_file_refs``. This function assumes the
    caller already did that media_type gate.

    Omission-1 note: ``source_file_id`` is stored in its own field, never in
    ``source_paper_link``. ``_normalize_link`` would mangle a file_id
    (``source_file:session:abc:upload.pdf`` → ``https://source_file:...`` —
    urlsplit treats a scheme-less string as a path and prepends ``https``),
    and the frontend's EvidenceDetail renders ``source_paper_link`` as a
    clickable URL — a file_id is not a valid URL. A dedicated
    ``source_file_id`` field bypasses both.

    Evidence is not deduped — each declaration gets its own fresh
    ``evidence_id`` (Evidence has no content-based dedup rule). Returns the
    evidence_id, or ``None`` when skipped (graph disabled/unreachable).
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("declare_evidence skipped: Neo4j not reachable (evidence=%s session=%s)",
                     evidence_id, session_id)
        return None

    link = _normalize_link(source_paper_link) if source_paper_link else None
    log.debug("declare_evidence starting: evidence=%s session=%s paper=%s source_file=%s",
              evidence_id, session_id, link, source_file_id or "-")
    try:
        with driver.session() as session:
            # Branch in Python, not Cypher: the caller (server.py) already
            # 422'd on both-empty / both-set, so exactly one of (link,
            # source_file_id) is set here. The two branches CREATE the same
            # Evidence shape — only source_paper_link / source_file_id differ
            # and which source the extracts edge points from — so keeping them
            # as two focused Cypher strings is clearer than a parameter-routed
            # single query and avoids the subquery-variable-shadowing that a
            # UNION/CALL approach would need.
            if source_file_id:
                # SourceFile-PDF branch: MATCH by file_id, store source_file_id
                # (NOT source_paper_link — see omission-1 note in the docstring).
                session.run(
                    """
                    MATCH (sf:SourceFile { file_id: $source_file_id })
                    CREATE (e:Evidence {
                      evidence_id:       $evidence_id,
                      content:           $content,
                      source_paper_link:  null,
                      source_file_id:     $source_file_id,
                      locator:            $locator,
                      evidence_type:      $evidence_type,
                      confidence:        $confidence,
                      strength:           $strength,
                      session_id:         $session_id,
                      created_at:         datetime()
                    })
                    MERGE (sf)-[:extracts]->(e)
                    RETURN e.evidence_id AS evidence_id
                    """,
                    evidence_id=evidence_id,
                    session_id=session_id,
                    content=content,
                    locator=locator,
                    evidence_type=evidence_type,
                    confidence=confidence,
                    strength=strength,
                    source_file_id=source_file_id,
                ).consume()
            else:
                # Paper branch: MATCH by (session_id, link), store the
                # normalized link (legacy behavior, unchanged).
                session.run(
                    """
                    MATCH (p:Paper { session_id: $session_id, link: $link })
                    CREATE (e:Evidence {
                      evidence_id:       $evidence_id,
                      content:           $content,
                      source_paper_link:  $link,
                      source_file_id:     null,
                      locator:            $locator,
                      evidence_type:      $evidence_type,
                      confidence:        $confidence,
                      strength:           $strength,
                      session_id:         $session_id,
                      created_at:         datetime()
                    })
                    MERGE (p)-[:extracts]->(e)
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
        log.info("declare_evidence done: evidence=%s session=%s paper=%s source_file=%s",
                 evidence_id, session_id, link or "-", source_file_id or "-")
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
    cites_source_file_refs: list[dict[str, Any]],
    artifact_id: str | None,
    artifact_version: int | None,
) -> list[dict[str, Any]]:
    """CREATE one Claim + ``supports`` edges (Evidence/Artifact/SourceFile →
    Claim) + optional ``stated_in`` (Claim → report Artifact).

    Claim is not deduped — each declaration gets a fresh ``claim_id`` (the
    canonical pattern uses ``CREATE``, and content_hash is stored only for
    indexing / future dedup). ``cites_node_ids`` are Evidence(evidence_id) —
    a Claim no longer cites a Paper directly (that edge was removed: a Claim
    reaches a Paper only via ``supports Evidence → extracts Paper``, walked
    backward). To cite a paper the LLM must first ``declare_evidence`` then
    cite the Evidence here. ``cites_artifact_refs`` is a list of
    ``{artifact_id, version}`` dicts — Artifact is keyed on the composite
    ``(artifact_id, version)`` (one node per version), so a cited figure/dataset
    is pinned to the exact version the LLM declared against (not the latest,
    which would drift as the product is regenerated). ``cites_source_file_refs``
    is a list of ``{file_id}`` dicts for uploaded non-PDF data files
    (CSV/image/etc) that directly support the claim — ``SourceFile -[:supports]->
    Claim`` — mirroring the Artifact path (data files are not "arguments
    extracted from a document", so they skip the Evidence layer). The caller
    (server.py) enforces that only non-PDF SourceFiles take this path (a PDF
    must go via declare_evidence first); this function assumes that gate ran.
    ``artifact_id`` + ``artifact_version`` (the report Artifact + its version)
    build the ``stated_in`` edge (Claim → report Artifact) so the graph can
    navigate "which claim is stated in which report"; the caller verified the
    Artifact exists.

    Returns the cited targets ``[{evidence_id?, artifact_id?, version?,
    file_id?, labels?}]`` so the caller can assemble the chip_map (alias →
    node) returned to the LLM. The chip_map itself is not persisted here —
    it lives on the report Artifact version's ``references`` (Node side).
    Empty list when skipped.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("declare_claim skipped: Neo4j not reachable (claim=%s session=%s)",
                     claim_id, session_id)
        return []

    log.debug("declare_claim starting: claim=%s session=%s cites=%d art_refs=%d sf_refs=%d artifact=%s",
              claim_id, session_id, len(cites_node_ids),
              len(cites_artifact_refs), len(cites_source_file_refs), artifact_id or "-")
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
                // return. The edge is Evidence → Claim (supports: the cited
                // evidence supports the claim), so it points target → cl.
                CALL {
                  WITH cl
                  UNWIND $cites_node_ids AS ev_id
                  MATCH (target:Evidence { evidence_id: ev_id })
                  MERGE (target)-[:supports]->(cl)
                }
                WITH cl
                // cites_artifact_refs: Artifact pinned to (artifact_id, version)
                // — the exact version the LLM declared against, not the latest.
                // The edge is Artifact → Claim (supports: the cited artifact
                // supports the claim), so it points target → cl.
                CALL {
                  WITH cl
                  UNWIND $cites_artifact_refs AS ref
                  MATCH (target:Artifact { artifact_id: ref.artifact_id, version: ref.version })
                  MERGE (target)-[:supports]->(cl)
                }
                WITH cl
                // cites_source_file_refs: uploaded non-PDF data files (CSV/image/
                // etc) that directly support the claim — SourceFile → Claim
                // (supports), so it points target → cl. Mirrors the artifact
                // batch; an empty list is a no-op (guarded subquery). The caller
                // (server.py) already gated media_type: only non-PDF SourceFiles
                // reach here — a PDF must go via declare_evidence (extracts →
                // Evidence → supports → Claim), not this direct edge.
                CALL {
                  WITH cl
                  UNWIND $cites_source_file_refs AS ref
                  MATCH (target:SourceFile { file_id: ref.file_id })
                  MERGE (target)-[:supports]->(cl)
                }
                WITH cl
                // optional stated_in from the Claim to the report Artifact
                // (Claim → report Artifact: this claim is stated in this report),
                // pinned to the report's version. The caller verified the
                // Artifact exists; the FOREACH guard is a belt-and-suspenders
                // no-op when artifact_id/version is None or the Artifact is
                // missing.
                OPTIONAL MATCH (a:Artifact { artifact_id: $artifact_id, version: $artifact_version })
                FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | MERGE (cl)-[:stated_in]->(a))
                WITH cl
                OPTIONAL MATCH (cl)<-[:supports]-(cited)
                RETURN cl.claim_id AS claim_id,
                       collect(DISTINCT {
                         evidence_id: cited.evidence_id,
                         artifact_id: cited.artifact_id,
                         version: cited.version,
                         file_id: cited.file_id,
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
                cites_source_file_refs=cites_source_file_refs,
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
    """MERGE ``stated_in`` edges from each Claim to one report Artifact version.

    Builds the ``Claim -[:stated_in]-> Artifact`` link so the graph can
    navigate "which claim is stated in which report", pinned to the report's
    specific version (Artifact is keyed on the composite
    ``(artifact_id, version)``, so the version is required to hit the right
    node). The caller verified the Artifact version and every Claim already
    exist; empty ``claim_ids`` is a no-op. Returns the number of edges merged.
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
                MERGE (cl)-[:stated_in]->(a)
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


# --- Cleanup: session/project deletion mirrors --------------------------------
#
# Called by the sidecar's ``/cleanup/session`` and ``/cleanup/project``
# routes, which the Node API's deleteSession / deleteProject handlers invoke
# AFTER the store deletion has committed. Mirrors the upsert/declare contract:
# ``is_reachable()`` guard + ``with driver.session()`` + try/except log, and a
# degraded (unreachable) graph returns a ``{status:"degraded"}`` shell rather
# than erroring — the HTTP deletion response must never be blocked by a
# mirror-layer cleanup (the store op already succeeded; the graph is a
# directory, the store is the warehouse).


def delete_session_graph(*, session_id: str) -> dict[str, Any]:
    """Delete a session's graph footprint.

    Session-private nodes (ResearchGoal / SubTask / Code / Paper / Evidence /
    Claim) are physically ``DETACH DELETE``d. That session's Artifact
    *version* nodes are SOFT-MARKED (``deleted_session = true``) instead: the
    Artifact is a project-scoped asset that survives in the store, and a
    future cross-session run may still reference this version via an ``input``
    edge or walk the ``supersedes`` chain — so the version node must remain
    matchable. Evidence / Claim use fresh uuids (never deduped), so a
    physical delete is permanent and intended (a declaration has no meaning
    once its producing session's transcript is gone).

    ``DETACH DELETE`` on the private nodes drops their in/out edges too,
    including the Claim endpoint of ``stated_in`` (the report version node is
    soft-marked but its stated_in inbound edge is severed — expected: the
    version node is retained for input/supersedes, not stated_in). Returns
    ``{status, marked, deleted}``; ``status="degraded"`` when Neo4j is
    unreachable.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("delete_session_graph skipped: Neo4j not reachable (session=%s)", session_id)
        return {"status": "degraded", "reason": "memory_graph_unreachable", "marked": 0, "deleted": 0}
    log.debug("delete_session_graph starting: session=%s", session_id)
    try:
        with driver.session() as session:
            marked_rec = session.run(
                """
                MATCH (a:Artifact {session_id: $sid})
                SET a.deleted_session = true
                RETURN count(a) AS marked
                """,
                sid=session_id,
            ).single()
            deleted_rec = session.run(
                """
                MATCH (n)
                WHERE n.session_id = $sid AND NOT (n:Artifact)
                DETACH DELETE n
                RETURN count(n) AS deleted
                """,
                sid=session_id,
            ).single()
            marked = int(marked_rec["marked"]) if marked_rec else 0
            deleted = int(deleted_rec["deleted"]) if deleted_rec else 0
        log.info("delete_session_graph done: session=%s marked=%d artifacts, deleted=%d private nodes",
                 session_id, marked, deleted)
        return {"status": "healthy", "marked": marked, "deleted": deleted}
    except Exception as exc:
        log.exception("delete_session_graph failed: session=%s: %s", session_id, exc)
        raise


def delete_project_graph(*, project_id: str, session_ids: list[str]) -> dict[str, Any]:
    """Physically delete every node belonging to a project.

    Two-pass: first sweep every node whose ``session_id`` is in the project's
    pre-deletion session-id snapshot (active + archived) from the Node side's
    ``getProjectDeletionImpact`` — private nodes (SubTask / Code / Paper /
    Evidence / Claim / ResearchGoal) carry no ``project_id``, so the
    ``session_ids`` set is their complete footprint. Then a ``project_id``
    fallback deletes any Artifact version nodes that survived the first sweep:
    Artifact is project-scoped and carries ``project_id``, but a version node
    may persist after its session was deleted earlier (soft-marked) — the
    store no longer knows that session, so the snapshot misses it. Store-side
    artifacts / versions are physically deleted by ``deleteProject``, so graph
    mirrors must go too — no soft-mark: the project is gone, there is no
    future cross-project reference. An empty ``session_ids`` with a known
    ``project_id`` still sweeps Artifact leftovers. Returns
    ``{status, deleted}``; ``status="degraded"`` when Neo4j is unreachable.
    """
    driver = handle()
    if not driver.is_reachable():
        log.warning("delete_project_graph skipped: Neo4j not reachable (project=%s sessions=%d)", project_id, len(session_ids))
        return {"status": "degraded", "reason": "memory_graph_unreachable", "deleted": 0}
    log.debug("delete_project_graph starting: project=%s sessions=%d", project_id, len(session_ids))
    try:
        with driver.session() as session:
            sid_deleted = 0
            if session_ids:
                sid_rec = session.run(
                    """
                    UNWIND $sids AS sid
                    MATCH (n) WHERE n.session_id = sid
                    DETACH DELETE n
                    RETURN count(n) AS deleted
                    """,
                    sids=session_ids,
                ).single()
                sid_deleted = int(sid_rec["deleted"]) if sid_rec else 0
            # Fallback: Artifact version nodes are project-scoped (carry
            # project_id) and may survive the session sweep when their session
            # was deleted earlier (soft-marked). Sweep by project_id to leave
            # no orphans. Idempotent with the session sweep above.
            pid_rec = session.run(
                """
                MATCH (n:Artifact) WHERE n.project_id = $pid
                DETACH DELETE n
                RETURN count(n) AS deleted
                """,
                pid=project_id,
            ).single()
            pid_deleted = int(pid_rec["deleted"]) if pid_rec else 0
            deleted = sid_deleted + pid_deleted
        log.info("delete_project_graph done: project=%s deleted=%d nodes (sessions=%d, artifact-fallback=%d)",
                 project_id, deleted, sid_deleted, pid_deleted)
        return {"status": "healthy", "deleted": deleted}
    except Exception as exc:
        log.exception("delete_project_graph failed: project=%s sessions=%d: %s", project_id, len(session_ids), exc)
        raise
