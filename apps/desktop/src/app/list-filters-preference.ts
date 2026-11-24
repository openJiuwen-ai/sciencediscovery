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

import { LIST_FILTERS_STORAGE_KEY, readStoredText, writeStoredText, type ReadableStorage } from "../state/storage.js";
import { DEFAULT_SESSION_FILTERS, type SessionListFilters } from "./session-filters.js";

/**
 * How the reader last narrowed the session list (#1251).
 *
 * The acceptance list asks for the choice to survive a reload, so the four chips
 * are a stored preference rather than transient state: written on every change,
 * read before the first paint. Only values this build understands are accepted —
 * a stored scope from a future build must not leave the list narrowed in a way
 * nothing on screen explains.
 */
const SCOPES: readonly SessionListFilters["scope"][] = ["all", "current"];
const WINDOWS: readonly SessionListFilters["window"][] = ["all", "today", "week"];

function browserStorage(): ReadableStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // A blocked storage (private mode, a restrictive webview) means "no stored
    // preference", not a failed render: the default filters still apply.
    return undefined;
  }
}

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

/** The stored filters, or the defaults when nothing valid was stored. */
export function readListFilters(storage: ReadableStorage | undefined = browserStorage()): SessionListFilters {
  const raw = storage ? readStoredText(storage, LIST_FILTERS_STORAGE_KEY) : null;
  if (!raw) return DEFAULT_SESSION_FILTERS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SESSION_FILTERS;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_SESSION_FILTERS;
  const stored = parsed as Partial<Record<keyof SessionListFilters, unknown>>;
  return {
    onlyRunning: isBoolean(stored.onlyRunning) ? stored.onlyRunning : DEFAULT_SESSION_FILTERS.onlyRunning,
    onlyWithArtifacts: isBoolean(stored.onlyWithArtifacts)
      ? stored.onlyWithArtifacts : DEFAULT_SESSION_FILTERS.onlyWithArtifacts,
    scope: SCOPES.includes(stored.scope as SessionListFilters["scope"])
      ? stored.scope as SessionListFilters["scope"] : DEFAULT_SESSION_FILTERS.scope,
    window: WINDOWS.includes(stored.window as SessionListFilters["window"])
      ? stored.window as SessionListFilters["window"] : DEFAULT_SESSION_FILTERS.window,
  };
}

/** Remember the filters; a blocked storage simply keeps the choice for this run. */
export function rememberListFilters(
  filters: SessionListFilters,
  storage: ReadableStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  writeStoredText(storage, LIST_FILTERS_STORAGE_KEY, JSON.stringify(filters));
}

/** Tests only: drop the stored preference. */
export function resetListFilters(storage: ReadableStorage | undefined = browserStorage()): void {
  try { storage?.removeItem?.(LIST_FILTERS_STORAGE_KEY); } catch { /* nothing to reset */ }
}
