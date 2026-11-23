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

import type { Session } from "../api/types.js";
import {
  SIDEBAR_FILTERS_STORAGE_KEY,
  readStoredJson,
  writeStoredJson,
  type ReadableStorage,
} from "../state/storage.js";

/** The time windows the filter row offers over `Session.updatedAt`. */
export type SidebarWindow = "all" | "today" | "week";

export interface SidebarFilters {
  /** Only sessions that already have an artifact output. */
  hasArtifacts: boolean;
  /** Scope the session rows to the open Session's Project. The Project folds
   *  stay: this narrows rows, not navigation (review F3). */
  onlyCurrentProject: boolean;
  /** Only sessions with an unfinished run (`ACTIVE_RUN_STATUSES`). */
  onlyRunning: boolean;
  window: SidebarWindow;
}

export const DEFAULT_SIDEBAR_FILTERS: SidebarFilters = {
  hasArtifacts: false,
  onlyCurrentProject: false,
  onlyRunning: false,
  window: "all",
};

const WINDOWS: readonly SidebarWindow[] = ["all", "today", "week"];

function isWindow(value: unknown): value is SidebarWindow {
  return typeof value === "string" && (WINDOWS as readonly string[]).includes(value);
}

function browserStorage(): ReadableStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // A blocked storage (private mode, a restrictive webview) means "no
    // preference", not a failed render: the unfiltered list still works.
    return undefined;
  }
}

/** The stored filters, dropping any field a damaged value could not prove. */
export function readSidebarFilters(storage: ReadableStorage | undefined = browserStorage()): SidebarFilters {
  if (storage === undefined) return DEFAULT_SIDEBAR_FILTERS;
  const stored = readStoredJson<unknown>(storage, SIDEBAR_FILTERS_STORAGE_KEY, {});
  // A key that holds valid JSON of another shape (null, a list, a string) is
  // as damaged as invalid JSON: read it as "nothing stored".
  const record = typeof stored === "object" && stored !== null
    ? stored as Record<string, unknown>
    : {};
  return {
    hasArtifacts: record.hasArtifacts === true,
    onlyCurrentProject: record.onlyCurrentProject === true,
    onlyRunning: record.onlyRunning === true,
    window: isWindow(record.window) ? record.window : "all",
  };
}

export function writeSidebarFilters(
  filters: SidebarFilters,
  storage: ReadableStorage | undefined = browserStorage(),
): void {
  if (storage === undefined) return;
  writeStoredJson(storage, SIDEBAR_FILTERS_STORAGE_KEY, filters);
}

export function hasActiveFilter(filters: SidebarFilters): boolean {
  return filters.hasArtifacts || filters.onlyCurrentProject || filters.onlyRunning || filters.window !== "all";
}

/**
 * The first moment a window includes, or `undefined` for 全部时间.
 *
 * `today` is the local calendar day, not "24 hours ago": a conversation from
 * yesterday evening is not "today" to the person reading the list.
 */
export function windowStart(window: SidebarWindow, now: number = Date.now()): number | undefined {
  if (window === "all") return undefined;
  if (window === "week") return now - 7 * 24 * 60 * 60 * 1000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/** A Session's last activity inside the window; a damaged date is not inside
 *  any bounded window, so it is only shown by 全部时间. */
export function sessionInWindow(session: Session, window: SidebarWindow, now: number = Date.now()): boolean {
  const start = windowStart(window, now);
  if (start === undefined) return true;
  const time = Date.parse(session.updatedAt ?? session.createdAt);
  return !Number.isNaN(time) && time >= start;
}

export interface SessionVisibility {
  activeProjectId?: string;
  /** Run facts are unknown until the filter's on-demand reads land; `undefined`
   *  means "still checking", which shows no row rather than every row. */
  running?: ReadonlySet<string>;
  /** The same for artifact outputs. */
  withArtifacts?: ReadonlySet<string>;
  now?: number;
}

/**
 * Whether one session row passes every filter.
 *
 * `DEFAULT_SIDEBAR_FILTERS` is everything visible. `onlyCurrentProject` compares the Session's
 * `projectId`; with no open Project there is nothing to scope to, so it is a
 * no-op rather than an empty column.
 */
export function sessionMatchesFilters(
  session: Session,
  filters: SidebarFilters,
  facts: SessionVisibility = {},
): boolean {
  if (filters.onlyCurrentProject && facts.activeProjectId !== undefined
    && session.projectId !== facts.activeProjectId) return false;
  if (filters.onlyRunning && facts.running?.has(session.id) !== true) return false;
  if (filters.hasArtifacts && facts.withArtifacts?.has(session.id) !== true) return false;
  return sessionInWindow(session, filters.window, facts.now ?? Date.now());
}

