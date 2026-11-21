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

import type { SessionListState } from "../api/types.js";

/** Where the sidebar's 活跃 / 已归档 / 全部 choice is kept. The list default is
 *  `active`, so a Session archived elsewhere is invisible until the user asks
 *  for it; the choice has to outlive a reload or the archived rows they just
 *  found disappear again. */
export const SESSION_FILTER_STORAGE_KEY = "sciencediscovery-desktop:session-filter";

const STATES: readonly SessionListState[] = ["active", "archived", "all"];

export function isSessionListState(value: unknown): value is SessionListState {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

/** The stored choice, or `active` when nothing usable was written. */
export function readSessionFilter(storage: Pick<Storage, "getItem"> | undefined): SessionListState {
  if (!storage) return "active";
  try {
    const stored = storage.getItem(SESSION_FILTER_STORAGE_KEY);
    return isSessionListState(stored) ? stored : "active";
  } catch {
    return "active";
  }
}

export function writeSessionFilter(
  storage: Pick<Storage, "setItem"> | undefined,
  state: SessionListState,
): void {
  if (!storage) return;
  try {
    storage.setItem(SESSION_FILTER_STORAGE_KEY, state);
  } catch {
    // A storage that refuses the write (quota, private mode) must not break the
    // filter: the choice still applies for this visit.
  }
}

/**
 * What a listing read is allowed to conclude about Sessions it did not return.
 *
 * The artifact catalog spans Sessions, so it may only be pruned against whole
 * membership. An unfiltered read *is* that membership; a filtered read is a
 * subset, and pruning by it would drop the artifacts of every Session the filter
 * hides — on every refresh under that filter, not just the first one, because the
 * filtered map is all the reader ever sees while the filter is in force.
 *
 * Returns the snapshot to remember and whether the caller may prune, plus the ids
 * to keep when it may.
 */
export function membershipAfterRead(
  filter: SessionListState,
  sessionIds: readonly string[],
  previous: ReadonlySet<string> | undefined,
): { pruneAgainst?: readonly string[]; snapshot?: Set<string> } {
  if (filter === "all") {
    const snapshot = new Set(sessionIds);
    return { pruneAgainst: sessionIds, snapshot };
  }
  // A filtered read proves the ids it returned exist, so they join the snapshot:
  // otherwise a Session created after the last 全部 read would be pruned out of
  // the catalog and fetched again on every refresh under the filter.
  const known = new Set([...(previous ?? []), ...sessionIds]);
  // Anything the filter hides is still unknown, so nothing is pruned until an
  // unfiltered read has named the workspace.
  return previous === undefined ? { snapshot: known } : { pruneAgainst: [...known], snapshot: known };
}
