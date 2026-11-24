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

import { SEARCH_NARROWING_STORAGE_KEY, readStoredText, writeStoredText,
  type ReadableStorage } from "../state/storage.js";
import { DEFAULT_SEARCH_NARROWING, type SearchNarrowing, type SearchWindow } from "./search-narrowing.js";

/**
 * How the reader last narrowed the search results (#1251).
 *
 * The acceptance list asks for the choice to survive a reload, so the `⋯` settings
 * are a stored preference rather than transient state: written on every change,
 * read before the first paint. Only values this build understands are accepted —
 * a window from a build that knew more must not leave the results narrowed in a
 * way nothing on screen explains.
 */
const WINDOWS: readonly SearchWindow[] = ["all", "day", "three-days", "week", "custom"];

function browserStorage(): ReadableStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // A blocked storage (private mode, a restrictive webview) means "no stored
    // preference", not a failed render: the defaults still apply.
    return undefined;
  }
}

function flag(value: unknown): boolean {
  return value === true;
}

function range(value: unknown): { from: number; to: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { from?: unknown; to?: unknown };
  if (typeof candidate.from !== "number" || typeof candidate.to !== "number") return undefined;
  if (!Number.isFinite(candidate.from) || !Number.isFinite(candidate.to)) return undefined;
  return { from: candidate.from, to: candidate.to };
}

/** The stored narrowing, or the defaults when nothing valid was stored. */
export function readSearchNarrowing(storage: ReadableStorage | undefined = browserStorage()): SearchNarrowing {
  const raw = storage ? readStoredText(storage, SEARCH_NARROWING_STORAGE_KEY) : null;
  if (!raw) return DEFAULT_SEARCH_NARROWING;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SEARCH_NARROWING;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_SEARCH_NARROWING;
  const stored = parsed as Partial<Record<keyof SearchNarrowing, unknown>>;
  const projectIds = Array.isArray(stored.projectIds)
    ? stored.projectIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : DEFAULT_SEARCH_NARROWING.projectIds;
  const window = WINDOWS.includes(stored.window as SearchWindow)
    ? stored.window as SearchWindow : DEFAULT_SEARCH_NARROWING.window;
  const custom = window === "custom" ? range(stored.custom) : undefined;
  return {
    onlyRunning: flag(stored.onlyRunning),
    onlyWithArtifacts: flag(stored.onlyWithArtifacts),
    projectIds,
    window,
    ...(custom === undefined ? {} : { custom }),
  };
}

/** Remember the narrowing; a blocked storage keeps the choice for this run. */
export function rememberSearchNarrowing(
  narrowing: SearchNarrowing,
  storage: ReadableStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  writeStoredText(storage, SEARCH_NARROWING_STORAGE_KEY, JSON.stringify(narrowing));
}

/** Tests only: drop the stored preference. */
export function resetSearchNarrowing(storage: ReadableStorage | undefined = browserStorage()): void {
  try { storage?.removeItem?.(SEARCH_NARROWING_STORAGE_KEY); } catch { /* nothing to reset */ }
}
