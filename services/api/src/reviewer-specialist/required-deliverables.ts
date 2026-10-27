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
 * Reviewer input for delivery completeness. `undefined` means the Session
 * declared no structured deliverable, and the review must say the scope was
 * limited rather than present the citation check as an overall pass.
 */
export function sessionRequiredDeliverables(
  store: SessionStore,
  sessionId: string,
  parentRunId?: string,
): { paths: string[]; source: "brief" } | undefined {
  const subagents = store.listSubagents(sessionId);
  // A Session accumulates subagents from every task it ever ran. Enforcing an
  // earlier task's requirement against this report would invent failures, so the
  // set is scoped to the reviewed run when the caller knows it.
  // A subagent that stopped keeps its Brief, and its requirement would then be
  // demanded of every later report in the Session: the mirror image of trusting a
  // declaration too little. `running` stays, because a review can run beside it.
  const usable = subagents.filter((subagent) => ALIVE_SUBAGENT_STATUSES.has(subagent.status));
  const scoped = parentRunId
    ? usable.filter((subagent) => subagent.parentTurnId === parentRunId)
    : usable;
  // A later run that only rewrites the report has no subagent of its own; falling
  // back to the Session's live declarations keeps that report checked instead of
  // silently unverified.
  const declared = declaredDeliverablePaths(scoped.length ? scoped : usable);
  return declared.length ? { paths: declared, source: "brief" } : undefined;
}

/**
 * The run whose Briefs produced the reviewed Artifacts. The Reviewer audit task
 * only carries a synthetic tool-call id (`automatic-review:<uuid>`), which is
 * never a run id, so the run is read from the Artifact versions it reviews.
 */
export function reviewedRunId(
  store: Pick<SessionStore, "getArtifactVersion">,
  sessionId: string,
  artifactVersionIds: readonly string[] | undefined,
): string | undefined {
  for (const versionId of artifactVersionIds ?? []) {
    const turnId = store.getArtifactVersion(sessionId, versionId)?.turnId;
    if (turnId) return turnId;
  }
  return undefined;
}
