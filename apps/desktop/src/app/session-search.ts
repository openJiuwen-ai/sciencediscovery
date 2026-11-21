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

import type { WorkbenchSearchResult, WorkbenchSearchResultKind } from "../api/types.js";

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
