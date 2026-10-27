// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { Subagent } from "@sciencediscovery/schema";

import type { SessionStore } from "../store.js";

/**
 * A deliverable declaration is only trusted when it is an explicit relative
 * file path. Free-text requirements ("a short summary", "JSON with fields …"),
 * absolute host paths and URLs are not deliverable identities and are ignored:
 * the Reviewer then reports completeness as unconfirmed instead of guessing.
 */
/**
 * Scientific deliverables span formats no product list can enumerate (`.fasta`,
 * `.vcf`, `.nc`, `.cif`, `.ipynb` …), so the extension is not whitelisted: a
 * short alphanumeric suffix is enough, and a missing extension is what makes a
 * requirement prose rather than a file.
 */
const DELIVERABLE_EXTENSION = /\.[A-Za-z0-9]{1,10}$/u;
const WINDOWS_SEPARATOR = /\\/gu;
const DEAD_SUBAGENT_STATUSES = new Set(["cancelled", "failed", "timed_out"]);
const ALIVE_SUBAGENT_STATUSES = new Set(["completed", "running"]);
const MAX_DECLARED_PATH_LENGTH = 200;

export function declaredDeliverablePath(requirement: string): string | undefined {
  const trimmed = requirement.trim();
  if (!trimmed || trimmed.length > MAX_DECLARED_PATH_LENGTH) return undefined;
  // Free-text requirements contain spaces or prose punctuation; a deliverable is one token.
  if (/[\s,;:()[\]{}*?<>|"'`]/u.test(trimmed)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return undefined;
  // An absolute host path identifies a machine location, not a task deliverable.
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(trimmed)) return undefined;
  const path = trimmed.replace(WINDOWS_SEPARATOR, "/").replace(/^\.\//u, "").replace(/^\/+/u, "").replace(/\/+$/u, "");
  // A relative path may not climb: `outputs/../predictions.npy` is a notation,
  // not the file the Reviewer will look for, and it never matches a real path.
  if (!path || path.split("/").some((segment) => segment === "..")) return undefined;
  if (!DELIVERABLE_EXTENSION.test(path)) return undefined;
  // A bare name is allowed and matched exactly (see deliverableMatchScore): the
  // lead Agent's root-level deliverables keep their gate, while `predictions.npy`
  // can no longer stand in for `output/cl3/predictions.npy`.
  return path;
}

/** Structured delivery declarations a task made through its subagent Briefs. */
export function declaredDeliverablePaths(subagents: readonly Subagent[]): string[] {
  const paths = new Set<string>();
  for (const subagent of subagents) {
    for (const requirement of subagent.input?.brief?.outputRequirements ?? []) {
      const path = declaredDeliverablePath(requirement);
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

/**
 * Reviewer input for delivery completeness. `undefined` means neither the
 * reviewed run(s) nor the Session declared a structured deliverable, and the
 * review must say the scope was limited rather than present the citation check
 * as an overall pass.
 *
 * `source` distinguishes an authoritative run-scoped requirement (`brief`) from
 * a Session-wide fallback (`session-fallback`). The Reviewer only re-derives a
 * reused verdict for `brief`: a fallback set belongs to other runs, and letting
 * it decide would wash a real REVISE into an ACCEPT.
 */
export interface ReviewDeliverableRequirements {
  paths: string[];
  scope: "run" | "session";
  source: "brief" | "session-fallback";
}

export function sessionRequiredDeliverables(
  store: Pick<SessionStore, "listSubagents">,
  sessionId: string,
  parentRunIds?: readonly string[],
): ReviewDeliverableRequirements | undefined {
  const subagents = store.listSubagents(sessionId);
  // A subagent that stopped keeps its Brief, and its requirement would then be
  // demanded of every later report in the Session: the mirror image of trusting a
  // declaration too little. `running` stays, because a review can run beside it.
  const alive = subagents.filter((subagent) => !DEAD_SUBAGENT_STATUSES.has(subagent.status));
  const runIds = new Set(parentRunIds ?? []);
  if (runIds.size) {
    // A Session accumulates subagents from every task it ever ran. Enforcing an
    // earlier task's requirement against this report would invent failures, so the
    // set is scoped to the reviewed run(s) when the caller knows them.
    const owned = subagents.filter((subagent) => runIds.has(subagent.parentTurnId));
    const declared = declaredDeliverablePaths(
      owned.filter((subagent) => !DEAD_SUBAGENT_STATUSES.has(subagent.status)),
    );
    if (declared.length) return { paths: declared, scope: "run", source: "brief" };
    // Nothing authoritative was found for the reviewed run(s). Only a run that ran
    // no subagent at all falls back to the Session's live declarations (a later run
    // that just rewrites the report). A run whose subagents were cancelled or timed
    // out must NOT borrow another run's list: that would enforce a different task's
    // deliverables, so it stays unconfirmed instead.
    if (owned.length) return undefined;
  }
  const fallback = declaredDeliverablePaths(alive);
  return fallback.length
    ? { paths: fallback, scope: "session", source: "session-fallback" }
    : undefined;
}

/**
 * Everything a Reviewer audit task needs about the run(s) it reviews. Both real
 * paths (automatic Artifact registration and the manual re-review) hand the
 * runner a synthetic tool-call id, so this is the one place that turns it back
 * into a run context — a caller must not do that conversion itself.
 */
export function auditReviewContext(
  store: Pick<SessionStore, "getArtifactVersion" | "listSubagents">,
  task: { artifactVersionIds: readonly string[]; sessionId: string; toolCallId: string },
): {
  /** The newest reviewed run, for APIs that take one; the synthetic id otherwise. */
  parentRunId: string;
  parentRunIds: string[];
  requiredDeliverables?: ReviewDeliverableRequirements;
} {
  const parentRunIds = reviewedRunIds(store, task.sessionId, task.artifactVersionIds);
  const requiredDeliverables = sessionRequiredDeliverables(store, task.sessionId, parentRunIds);
  return {
    parentRunId: parentRunIds[0] ?? task.toolCallId,
    parentRunIds,
    ...(requiredDeliverables ? { requiredDeliverables } : {}),
  };
}

/**
 * The root run(s) behind the Artifacts a review covers. A Reviewer audit task
 * only carries a synthetic tool-call id (`automatic-review:<uuid>` /
 * `manual-review:<messageId>`), which is never a run id, so the run is read
 * from the reviewed Artifact versions instead.
 *
 * A version records the turn that wrote it. For a main-Agent file that is the
 * run itself; for a subagent's file it is the subagent's own id
 * (`childExecution.identity.executionId`), which never equals its
 * `parentTurnId`. Those turns are mapped back to the run that started the
 * subagent, so its Briefs are found and the gate does not quietly fall back to
 * the whole Session.
 *
 * One audit can cover versions produced by different runs: the coordinator
 * merges a newly registered version into the pending checkpoint. Every distinct
 * run is returned, newest first, so the check covers all of them — judging a
 * run-A report with only run-B's Brief would invent a missing deliverable or
 * drop a real one.
 */
export function reviewedRunIds(
  store: Pick<SessionStore, "getArtifactVersion" | "listSubagents">,
  sessionId: string,
  artifactVersionIds: readonly string[] | undefined,
): string[] {
  const runOfSubagent = new Map(store.listSubagents(sessionId)
    .map((subagent) => [subagent.id, subagent.parentTurnId]));
  const versions = (artifactVersionIds ?? [])
    .map((versionId) => store.getArtifactVersion(sessionId, versionId))
    .filter((version): version is NonNullable<typeof version> => Boolean(version?.turnId))
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const runIds = versions.map((version) => runOfSubagent.get(version.turnId!) ?? version.turnId!);
  return [...new Set(runIds)];
}
