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

/** Where the sidebar's 活动 / 已归档 / 全部 choice is kept. The list default is
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
