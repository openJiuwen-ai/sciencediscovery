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

/** The window the session list is narrowed to. */
export type SessionWindow = "all" | "today" | "week";

export interface SessionListFilters {
  /** `current` keeps the open Project and hides the other folds. */
  scope: "all" | "current";
  /** Only the Session that is running right now. */
  onlyRunning: boolean;
  /** Only Sessions whose artifacts are already cached for the panel. */
  onlyWithArtifacts: boolean;
  window: SessionWindow;
}

export const DEFAULT_SESSION_FILTERS: SessionListFilters = {
  onlyRunning: false,
  onlyWithArtifacts: false,
  scope: "all",
  window: "all",
};

export interface FilterContext {
  /** The Session with a run in flight, when there is one. */
  runningSessionId?: string;
  /** Session ids with at least one cached artifact output. */
  withArtifacts: ReadonlySet<string>;
  /** `Date.now()` at the moment the page rendered; a parameter so a test can pin it. */
  now: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether one Session survives the filters.
 *
 * The window counts back from `now` over `updatedAt`, which is what the row
 * prints: a Session written to this morning is "today" even if it was created
 * last month.
 */
export function keepsSession(
  session: Pick<Session, "id" | "updatedAt" | "createdAt">,
  filters: SessionListFilters,
  context: FilterContext,
): boolean {
  if (filters.onlyRunning && session.id !== context.runningSessionId) return false;
  if (filters.onlyWithArtifacts && !context.withArtifacts.has(session.id)) return false;
  if (filters.window === "all") return true;
  const stamp = Date.parse(session.updatedAt ?? session.createdAt);
  if (Number.isNaN(stamp)) return false;
  const age = context.now - stamp;
  return filters.window === "today" ? age < DAY_MS : age < 7 * DAY_MS;
}

/** The same rule over a list, keeping the order the caller had. */
export function filterSessions<T extends Pick<Session, "id" | "updatedAt" | "createdAt">>(
  sessions: readonly T[],
  filters: SessionListFilters,
  context: FilterContext,
): T[] {
  return sessions.filter((session) => keepsSession(session, filters, context));
}

/** Whether anything is narrowed at all: the list says so instead of looking empty
 *  because the workspace is. */
export function hasActiveFilters(filters: SessionListFilters): boolean {
  return filters.scope === "current" || filters.onlyRunning || filters.onlyWithArtifacts
    || filters.window !== "all";
}
