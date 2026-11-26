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

import type {
  SessionArtifactOutput,
  WorkbenchSearchResponse,
  WorkbenchSearchResult,
  WorkbenchSearchResultKind,
} from "../api/types.js";
import { outputSessionId } from "./artifact-groups.js";

/** How long the field waits after the last keystroke before it asks the route.
 *  The web palette uses the same figure. */
export const SEARCH_DEBOUNCE_MS = 250;

/** The order the three groups appear in: what the user names first, then what
 *  they wrote, then what the work produced. */
export const SEARCH_KINDS: readonly WorkbenchSearchResultKind[] = ["project", "session", "artifact"];

export interface SearchGroup {
  kind: WorkbenchSearchResultKind;
  results: WorkbenchSearchResult[];
}

/**
 * Split a response into the three groups the page draws.
 *
 * Empty groups are dropped rather than drawn with a heading and nothing under
 * it, and the order is fixed by `SEARCH_KINDS` rather than by the server's
 * ranking, so a result list does not reshuffle as the query changes.
 */
export function groupSearchResults(results: readonly WorkbenchSearchResult[]): SearchGroup[] {
  return SEARCH_KINDS
    .map((kind) => ({ kind, results: results.filter((result) => result.kind === kind) }))
    .filter((group) => group.results.length > 0);
}

/**
 * The line under a result: the Project it lives in, and for an artifact the
 * Session that produced it. Absent parts are left out rather than blanked, so a
 * project result does not print "undefined".
 */
export function searchDetail(result: WorkbenchSearchResult): string {
  const parts = [result.projectName, result.sessionTitle].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return parts.join(" · ");
}

/** Whether a query is worth sending: the route searches on a term, and an
 *  empty one would return the whole workspace. */
export function isSearchable(query: string): boolean {
  return query.trim().length > 0;
}

/** The flat order the arrow keys walk: the grouped order, top to bottom. */
export function flatResults(results: readonly WorkbenchSearchResult[]): WorkbenchSearchResult[] {
  return groupSearchResults(results).flatMap((group) => group.results);
}

/**
 * Where `ArrowDown` / `ArrowUp` land.
 *
 * It wraps, because a result list is short and a key that stops dead at the last
 * row reads as broken. `-1` means "nothing selected yet": down goes to the first
 * row and up to the last, so the first keypress always selects something.
 */
export function moveHit(index: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return delta === 1 ? 0 : count - 1;
  return (index + delta + count) % count;
}

/** An artifact result whose document is not open yet: the panel lists its
 *  Session's artifacts after the read that `openSession` starts, and the click
 *  completes once that list holds it. */
export interface PendingArtifact {
  artifactId: string;
  sessionId: string;
}

/**
 * The bare id a result names.
 *
 * `GET /api/search` composes each hit's `id` from its kind — `project:<id>`,
 * `session:<id>`, `artifact:<id>` — so the list can tell two hits with the same
 * uuid apart. Everything that acts on a hit takes the bare id the rest of the
 * API uses, which is the part after the first colon.
 */
export function bareSearchId(id: string): string {
  const colon = id.indexOf(":");
  return colon === -1 ? id : id.slice(colon + 1);
}

/**
 * The listed output a pending artifact result names.
 *
 * A hit carries an id; opening a document needs the whole output — its newest
 * version and the path the preview reads. The panel lists every Session's
 * output, so the result is matched against that list rather than fetched again.
 *
 * Output written before the Session field existed belongs to no Session and is
 * shown under the open one, so it counts as a match for the Session we opened.
 * An id listed only under a different Session is not opened: the reader would
 * land on a document the panel shows somewhere else.
 */
export function pendingArtifactHit(
  outputs: readonly SessionArtifactOutput[],
  pending: PendingArtifact,
): SessionArtifactOutput | undefined {
  return outputs.find((output) => {
    if (output.artifact.id !== pending.artifactId) return false;
    const owner = outputSessionId(output);
    return owner === pending.sessionId || owner === "";
  });
}

/**
 * What a clicked artifact hit can do right now.
 *
 * A hit for another Session has to wait: the panel lists a Session's artifacts
 * only after `openSession` reads it. A hit for the Session that is **already
 * open** is the case that used to open nothing — `openSession` is a no-op there,
 * so neither the Session nor its outputs change, and an effect keyed on those
 * would never run. When that list is already in hand the document opens at once;
 * when it is not, the wait is registered the same way and the caller's ticket
 * makes the effect re-read it.
 */
export function artifactHitPlan(
  outputs: readonly SessionArtifactOutput[],
  result: { id: string; sessionId: string },
  openSessionId: string | undefined,
): { open: SessionArtifactOutput } | { pending: PendingArtifact } {
  const pending: PendingArtifact = { artifactId: bareSearchId(result.id), sessionId: result.sessionId };
  if (result.sessionId === openSessionId) {
    const listed = pendingArtifactHit(outputs, pending);
    if (listed !== undefined) return { open: listed };
  }
  return { pending };
}

/** Newest first inside a group. Each row carries its own `updatedAt`; a row
 *  without one sorts last rather than first, so an unknown stamp cannot
 *  outrank a known one. */
function newestFirst(results: readonly WorkbenchSearchResult[]): WorkbenchSearchResult[] {
  const at = (result: WorkbenchSearchResult) => {
    const stamp = result.updatedAt === undefined ? NaN : Date.parse(result.updatedAt);
    return Number.isNaN(stamp) ? Number.NEGATIVE_INFINITY : stamp;
  };
  return [...results].sort((left, right) => at(right) - at(left));
}

/**
 * The route's answer with the rule a search keeps: an archived Session is not
 * searchable, and neither are its artifacts, while an imported read-only snapshot
 * is — 活跃 is archived versus live, not writable versus read-only.
 *
 * The route does answer archived hits (the `archived` flag is there for a client
 * that marks them), so the page drops them here. `dropped` says how many this
 * page threw away: the answer's `total` still counts them, so a caller printing
 * "N more" has to take them off before it promises hits it will never draw.
 */
export function withoutArchivedHits(
  answer: WorkbenchSearchResponse,
  archived: ReadonlySet<string>,
): { answer: WorkbenchSearchResponse; dropped: number } {
  const results = archived.size === 0
    ? answer.results
    : answer.results.filter((result) => result.sessionId === undefined || !archived.has(result.sessionId));
  const dropped = answer.results.length - results.length;
  if (dropped === 0) return { answer, dropped };
  return { answer: { ...answer, results, total: answer.total - dropped }, dropped };
}

/** The dialog's rows: 全部 groups every kind, a kind shows only itself, and
 *  every group is newest first. */
export function groupsFor(
  results: readonly WorkbenchSearchResult[],
  kind: "all" | WorkbenchSearchResultKind,
): SearchGroup[] {
  const kept = kind === "all" ? results : results.filter((result) => result.kind === kind);
  return groupSearchResults(kept).map((group) => ({ ...group, results: newestFirst(group.results) }));
}
