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

import type { WorkbenchSearchResult } from "../api/types.js";

/**
 * How the search results are narrowed.
 *
 * These narrow what a query returns, not which Sessions the column lists: the
 * sidebar keeps showing every active Session while a query is narrowed. The
 * three presets count back from `now` in hours — "24 小时内" is a rolling day,
 * which is what the label says — and `custom` takes the range the reader picked.
 */
export type SearchWindow = "all" | "day" | "three-days" | "week" | "custom";

/** The custom range, inclusive, as epoch milliseconds. */
export interface SearchWindowRange {
  from: number;
  to: number;
}

export interface SearchNarrowing {
  /** Projects the session and artifact results are limited to. Empty means all. */
  projectIds: string[];
  /** Only results that belong to the Session with a run in flight. */
  onlyRunning: boolean;
  /** Only results whose artifacts the panel has already read. */
  onlyWithArtifacts: boolean;
  window: SearchWindow;
  /** Read only when `window` is `custom`; a missing range narrows nothing. */
  custom?: SearchWindowRange;
}

export const DEFAULT_SEARCH_NARROWING: SearchNarrowing = {
  onlyRunning: false,
  onlyWithArtifacts: false,
  projectIds: [],
  window: "all",
};

/** What the workspace knows about one Session, for judging a hit that names it. */
export interface SearchSessionFacts {
  archived: boolean;
  /** `Date.parse` of the row's stamp, or `undefined` when it could not be read. */
  stamp?: number;
}

export interface SearchNarrowContext {
  now: number;
  runningSessionId?: string;
  /** Session ids whose artifact outputs the panel has already read. */
  withArtifacts: ReadonlySet<string>;
  /** The facts of a Session by id; `undefined` when this page does not hold it. */
  sessionFacts: (sessionId: string) => SearchSessionFacts | undefined;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const WINDOW_MS: Record<Exclude<SearchWindow, "all" | "custom">, number> = {
  day: DAY_MS,
  "three-days": 3 * DAY_MS,
  week: 7 * DAY_MS,
};

/** Whether a stamp falls inside the window. A window drops what it cannot show
 *  to be inside it; `all` keeps everything. */
export function inWindow(window: SearchWindow, stamp: number | undefined, now: number,
  custom?: SearchWindowRange): boolean {
  if (window === "all") return true;
  if (stamp === undefined || Number.isNaN(stamp)) return false;
  if (window === "custom") {
    if (custom === undefined) return true;
    return stamp >= custom.from && stamp <= custom.to;
  }
  return now - stamp < WINDOW_MS[window];
}

/** Whether anything is narrowed at all: the results say so instead of looking
 *  empty because the workspace is. */
export function hasActiveNarrowing(narrowing: SearchNarrowing): boolean {
  return narrowing.projectIds.length > 0 || narrowing.onlyRunning || narrowing.onlyWithArtifacts
    || narrowing.window !== "all";
}

/**
 * Apply the same narrowing to the Session column.
 *
 * The column's half of `narrowResults`: the same four dimensions — the Project
 * selection, 运行中, 有产物 and 指定时间 — over the Sessions a fold holds.
 * Archived Sessions are dropped first, because the column is the active set;
 * 有产物 drops a Session whose artifacts the page has not read, because the
 * `withArtifacts` set is all the page knows about them.
 */
export function narrowSessions<T extends { archivedAt?: string; createdAt: string;
  id: string; projectId?: string; updatedAt?: string }>(
  sessions: readonly T[],
  narrowing: SearchNarrowing,
  context: SearchNarrowContext,
): T[] {
  const projects = new Set(narrowing.projectIds);
  return sessions.filter((session) => {
    if (session.archivedAt !== undefined) return false;
    if (projects.size > 0 && !projects.has(session.projectId ?? "")) return false;
    if (narrowing.onlyRunning && session.id !== context.runningSessionId) return false;
    if (narrowing.onlyWithArtifacts && !context.withArtifacts.has(session.id)) return false;
    const stamp = Date.parse(session.updatedAt ?? session.createdAt);
    return inWindow(narrowing.window, Number.isNaN(stamp) ? undefined : stamp, context.now, narrowing.custom);
  });
}

/**
 * Apply the narrowing to the route's answer.
 *
 * Two rules come before the reader's own choices, because they are properties of
 * "search" rather than of a filter:
 *
 * - **Archived Sessions are not searchable, and neither are their artifacts.**
 *   The route may still return them; the column is the active set, so a hit that
 *   resolves to an archived Session is dropped. Artifacts carry no archived flag
 *   of their own, so they are judged through the Session that wrote them.
 * - **An imported read-only snapshot is active.** It cannot be written to, but it
 *   is a live entry in the column and the owner's reading of 活跃 is archived
 *   versus live, not writable versus read-only.
 *
 * A Session this page does not hold (`sessionFacts` answers `undefined`) is kept:
 * the route found it, and dropping a result the workspace merely has not read
 * would hide Sessions from another Project.
 */
export function narrowResults(
  results: readonly WorkbenchSearchResult[],
  narrowing: SearchNarrowing,
  context: SearchNarrowContext,
): WorkbenchSearchResult[] {
  const projects = new Set(narrowing.projectIds);
  return results.filter((result) => {
    if (result.kind === "project") {
      // A stated Project selection already answers "which Projects": project
      // rows would be a second, contradictory answer.
      return projects.size === 0;
    }
    const sessionId = result.sessionId;
    const facts = sessionId === undefined ? undefined : context.sessionFacts(sessionId);
    if (result.archived === true || facts?.archived === true) return false;
    if (projects.size > 0 && !projects.has(result.projectId)) return false;
    if (narrowing.onlyRunning && sessionId !== context.runningSessionId) return false;
    if (narrowing.onlyWithArtifacts) {
      // An artifact hit is its own evidence; a Session hit is not.
      if (result.kind !== "artifact" && (sessionId === undefined || !context.withArtifacts.has(sessionId))) {
        return false;
      }
    }
    return inWindow(narrowing.window, facts?.stamp, context.now, narrowing.custom);
  });
}
