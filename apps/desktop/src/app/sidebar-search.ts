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

import type { Session, WorkbenchSearchResult, WorkbenchSearchResultKind } from "../api/types.js";

/** The web palette's interval; typing for less than this does not spend a
 *  request, and one settled query spends exactly one. */
export const SEARCH_DEBOUNCE_MS = 250;

export type SearchGroups = Record<WorkbenchSearchResultKind, WorkbenchSearchResult[]>;

/** The order the panel shows: 项目, then 会话, then 产物. */
export const SEARCH_GROUP_ORDER: readonly WorkbenchSearchResultKind[] = ["project", "session", "artifact"];

export function groupSearchResults(results: readonly WorkbenchSearchResult[]): SearchGroups {
  const groups: SearchGroups = { artifact: [], project: [], session: [] };
  for (const result of results) groups[result.kind].push(result);
  return groups;
}

/** The flattened order arrow keys walk, which must match the rendered order. */
export function flattenedSearchResults(results: readonly WorkbenchSearchResult[]): WorkbenchSearchResult[] {
  const groups = groupSearchResults(results);
  return SEARCH_GROUP_ORDER.flatMap((kind) => groups[kind]);
}

/**
 * The server's rows followed by the rows it could not return — the inbox's
 * Sessions and artifacts (see `inbox-search.ts`). Ids are unique across kinds
 * (`session:` / `artifact:` / `project:`), so the same row cannot appear twice.
 */
export function mergeSearchResults(
  results: readonly WorkbenchSearchResult[],
  extras: readonly WorkbenchSearchResult[],
): WorkbenchSearchResult[] {
  const known = new Set(results.map((result) => result.id));
  return [...results, ...extras.filter((result) => !known.has(result.id))];
}

/**
 * The artifact id a result names.
 *
 * The server builds `artifact:${artifact.id}` and puts the artifact's *name* in
 * `path`, so the id prefix is the only place the dialog's key can come from.
 * A result without it is not an artifact this client can open, and the panel
 * says so instead of guessing by name.
 */
export function artifactIdFromResult(result: WorkbenchSearchResult): string | undefined {
  if (result.kind !== "artifact") return undefined;
  const prefix = "artifact:";
  if (!result.id.startsWith(prefix)) return undefined;
  const id = result.id.slice(prefix.length);
  return id === "" ? undefined : id;
}

/** Whether a result can be opened at all. A Session needs its id; a Project
 *  its project id; an artifact its parsed id and the Session that wrote it. */
export function resultIsOpenable(result: WorkbenchSearchResult): boolean {
  if (result.kind === "session") return result.sessionId !== undefined;
  if (result.kind === "artifact") {
    return artifactIdFromResult(result) !== undefined && result.sessionId !== undefined;
  }
  return true;
}
