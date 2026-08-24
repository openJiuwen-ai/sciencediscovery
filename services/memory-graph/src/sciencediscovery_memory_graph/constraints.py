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

"""Idempotent schema bootstrap for the node set.

Covers SubTask / Code / Artifact (MVP) plus Paper. Paper's business key is
the lowercased URL (link-based dedup), scoped per session, so the UNIQUE
constraint is on ``(session_id, link)``. A legacy link-only uniqueness
constraint (``link`` alone) is dropped at boot — it blocked cross-session
same-URL writes (MERGE found no exact match on ``(session_id, link)`` and
tried to create, colliding with the legacy constraint → 500, silently
dropping every Paper after the first session that saw the URL). The drop is
done by listing constraints and dropping the link-only one by name, because
Neo4j 5 names constraints with a random token (e.g. ``constraint_b7736a6d``)
and ``DROP CONSTRAINT`` only accepts a name (there is no ``DROP ... FOR ...
REQUIRE ... IF EXISTS`` form). Uses ``CREATE CONSTRAINT IF NOT EXISTS`` so
re-runs are safe. Called once after a password is set and the driver is
reachable (inside the ``/internal/neo4j-password`` handler), and safe to
call again on every boot.
"""

from __future__ import annotations

from typing import Any

from .logging_config import get_logger
from .neo4j_driver import handle

log = get_logger("constraints")

_SCHEMA = [
    "CREATE CONSTRAINT IF NOT EXISTS FOR (n:SubTask)  REQUIRE n.task_id IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Code)     REQUIRE n.code_id IS UNIQUE",
    # Artifact is keyed on (artifact_id, version): one node per version of a
    # logical artifact. A re-run that overwrites the file produces a new
    # version node linked to the previous one by a ``supersedes`` edge (see
    # persistence.upsert_execution). The legacy ``artifact_id``-only unique
    # constraint is dropped at boot — see _drop_legacy_artifact_id_constraint.
    "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Artifact) REQUIRE (n.artifact_id, n.version) IS UNIQUE",
    # Paper scoped per session — see _drop_legacy_paper_link_constraint below.
    "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Paper) REQUIRE (n.session_id, n.link) IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (n:ResearchGoal) REQUIRE n.goal_id IS UNIQUE",
    # Claim / Evidence (declare tools). UNIQUE on the fresh UUID business
    # key; session_id index scopes reads; content_hash indexes Claim for
    # future dedup (declare_claim uses CREATE, not MERGE-on-hash, today).
    "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Evidence) REQUIRE n.evidence_id IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Claim)    REQUIRE n.claim_id    IS UNIQUE",
    "CREATE INDEX IF NOT EXISTS FOR (n:SubTask)  ON (n.session_id)",
    "CREATE INDEX IF NOT EXISTS FOR (n:Code)     ON (n.session_id)",
    "CREATE INDEX IF NOT EXISTS FOR (n:Artifact) ON (n.session_id)",
    "CREATE INDEX IF NOT EXISTS FOR (n:Paper)    ON (n.session_id)",
    "CREATE INDEX IF NOT EXISTS FOR (n:Paper)    ON (n.retrieved_at)",
    "CREATE INDEX IF NOT EXISTS FOR (n:ResearchGoal) ON (n.session_id)",
    "CREATE INDEX IF NOT EXISTS FOR (n:SubTask)      ON (n.status)",
    "CREATE INDEX IF NOT EXISTS FOR (n:SubTask)      ON (n.task_type)",
    "CREATE INDEX IF NOT EXISTS FOR (n:Evidence)     ON (n.session_id)",
    "CREATE INDEX IF NOT EXISTS FOR (n:Claim)        ON (n.session_id)",
    "CREATE INDEX IF NOT EXISTS FOR (n:Claim)        ON (n.content_hash)",
]


def _drop_legacy_paper_link_constraint(session: Any) -> int:
    """Drop any legacy link-only uniqueness on ``:Paper``.

    The current schema keys Paper on ``(session_id, link)``; a leftover
    ``link``-only unique constraint would make cross-session same-URL writes
    fail (MERGE on the composite key finds no match and tries to create,
    colliding with the legacy one → 500, dropping every Paper). ``DROP
    CONSTRAINT`` only accepts a name, and Neo4j 5 names auto-created
    constraints with a random token, so we list + drop by name rather than
    DROP-by-definition (no ``DROP ... IF EXISTS FOR ... REQUIRE`` form exists).
    Returns the number dropped.
    """
    names = [
        rec["name"]
        for rec in session.run(
            "SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties, entityType "
            "WHERE entityType = 'NODE' AND 'Paper' IN labelsOrTypes "
            "AND properties = ['link'] "
            "RETURN name"
        )
    ]
    for name in names:
        session.run(f"DROP CONSTRAINT `{name}`").consume()
    return len(names)


def _drop_legacy_artifact_id_constraint(session: Any) -> int:
    """Drop any legacy ``artifact_id``-only uniqueness on ``:Artifact``.

    Artifact is now keyed on the composite ``(artifact_id, version)`` so each
    version is its own node; a leftover ``artifact_id``-only unique constraint
    would make v2 (and later) writes fail — MERGE on the composite key finds no
    exact match and tries to create, colliding with the legacy single-field
    constraint → 500, dropping every version after the first. Same list +
    drop-by-name approach as ``_drop_legacy_paper_link_constraint`` (Neo4j 5
    auto-names constraints with a random token; no DROP-by-definition form).
    Returns the number dropped.
    """
    names = [
        rec["name"]
        for rec in session.run(
            "SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties, entityType "
            "WHERE entityType = 'NODE' AND 'Artifact' IN labelsOrTypes "
            "AND properties = ['artifact_id'] "
            "RETURN name"
        )
    ]
    for name in names:
        session.run(f"DROP CONSTRAINT `{name}`").consume()
    return len(names)


def ensure_schema() -> None:
    """Run each schema statement. Failures are logged but non-fatal so a
    partially-reachable DB doesn't wedge the boot path."""
    driver = handle()
    if not driver.is_reachable():
        log.info("schema bootstrap skipped: Neo4j not reachable")
        return
    log.info("schema bootstrap: running %d constraint/index statements", len(_SCHEMA))
    ok = 0
    failed = 0
    with driver.session() as session:
        dropped = _drop_legacy_paper_link_constraint(session)
        if dropped:
            log.info("dropped %d legacy link-only Paper constraint(s)", dropped)
        dropped = _drop_legacy_artifact_id_constraint(session)
        if dropped:
            log.info("dropped %d legacy artifact_id-only Artifact constraint(s)", dropped)
        for statement in _SCHEMA:
            try:
                session.run(statement).consume()
                ok += 1
            except Exception as exc:
                # Idempotent best-effort: a constraint existing under a
                # slightly different form will error; ignore and continue.
                log.debug("schema statement skipped (already exists / non-fatal): %s", exc)
                failed += 1
    log.info("schema bootstrap done: %d ok, %d skipped", ok, failed)
