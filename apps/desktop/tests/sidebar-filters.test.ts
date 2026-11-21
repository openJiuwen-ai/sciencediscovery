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

// #1251: the session-list filters. The pure half is here; the render/click half
// is in `sidebar-filter-ui.test.tsx`.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { Session } from "../src/api/types.js";
import {
  DEFAULT_SIDEBAR_FILTERS,
  hasActiveFilter,
  readSidebarFilters,
  sessionInWindow,
  sessionMatchesFilters,
  windowStart,
  writeSidebarFilters,
} from "../src/app/sidebar-filters.js";
import { SIDEBAR_FILTERS_STORAGE_KEY, type ReadableStorage } from "../src/state/storage.js";

function memoryStorage(seed: Record<string, string> = {}): ReadableStorage & { values: Record<string, string> } {
  const values = { ...seed };
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = value; },
    values,
  };
}

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    createdAt: "2026-10-01T08:00:00.000Z",
    id,
    projectId: "p1",
    title: id,
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...over,
  } as Session;
}

test("nothing stored means every session is visible", () => {
  const storage = memoryStorage();
  assert.deepEqual(readSidebarFilters(storage), DEFAULT_SIDEBAR_FILTERS);
  assert.equal(hasActiveFilter(DEFAULT_SIDEBAR_FILTERS), false);
});

test("a written choice is read back under the namespaced key", () => {
  const storage = memoryStorage();
  const chosen = { hasArtifacts: true, onlyCurrentProject: false, onlyRunning: true, window: "week" as const };
  writeSidebarFilters(chosen, storage);
  assert.deepEqual(readSidebarFilters(storage), chosen);
  assert.ok(storage.values[SIDEBAR_FILTERS_STORAGE_KEY]?.includes("onlyRunning"));
});

test("a damaged or foreign value falls back field by field", () => {
  assert.deepEqual(
    readSidebarFilters(memoryStorage({ [SIDEBAR_FILTERS_STORAGE_KEY]: "not json" })),
    DEFAULT_SIDEBAR_FILTERS,
  );
  // Valid JSON of the wrong shape is damaged too, not a crash.
  assert.deepEqual(
    readSidebarFilters(memoryStorage({ [SIDEBAR_FILTERS_STORAGE_KEY]: "null" })),
    DEFAULT_SIDEBAR_FILTERS,
  );
  const partial = readSidebarFilters(memoryStorage({
    [SIDEBAR_FILTERS_STORAGE_KEY]: JSON.stringify({ onlyRunning: true, window: "fortnight" }),
  }));
  assert.equal(partial.onlyRunning, true);
  assert.equal(partial.window, "all");
  assert.equal(partial.hasArtifacts, false);
});

test("the time window uses the local day and the last seven days", () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  assert.equal(windowStart("all", now), undefined);
  assert.equal(windowStart("week", now), now - 7 * 24 * 60 * 60 * 1000);
  assert.equal(
    new Date(windowStart("today", now)!).getDate(),
    new Date(now).getDate(),
  );

  assert.equal(sessionInWindow(session("s1", { updatedAt: new Date(now - 60_000).toISOString() }), "today", now), true);
  assert.equal(sessionInWindow(session("s2", { updatedAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString() }), "today", now), false);
  assert.equal(sessionInWindow(session("s3", { updatedAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString() }), "week", now), true);
  assert.equal(sessionInWindow(session("s4", { updatedAt: "not a date" }), "week", now), false);
  assert.equal(sessionInWindow(session("s4", { updatedAt: "not a date" }), "all", now), true);
});

test("each filter narrows by its own fact, and the project filter scopes rows", () => {
  const running = new Set(["s1"]);
  const withArtifacts = new Set(["s2"]);
  const facts = { activeProjectId: "p1", running, withArtifacts, now: Date.parse("2026-10-08T12:00:00.000Z") };

  const mine = session("s1", { projectId: "p1" });
  const other = session("s2", { projectId: "p2" });
  assert.equal(sessionMatchesFilters(mine, DEFAULT_SIDEBAR_FILTERS, facts), true);
  assert.equal(sessionMatchesFilters(other, DEFAULT_SIDEBAR_FILTERS, facts), true);

  assert.equal(sessionMatchesFilters(mine, { ...DEFAULT_SIDEBAR_FILTERS, onlyCurrentProject: true }, facts), true);
  assert.equal(sessionMatchesFilters(other, { ...DEFAULT_SIDEBAR_FILTERS, onlyCurrentProject: true }, facts), false);

  assert.equal(sessionMatchesFilters(mine, { ...DEFAULT_SIDEBAR_FILTERS, onlyRunning: true }, facts), true);
  assert.equal(sessionMatchesFilters(other, { ...DEFAULT_SIDEBAR_FILTERS, onlyRunning: true }, facts), false);

  assert.equal(sessionMatchesFilters(other, { ...DEFAULT_SIDEBAR_FILTERS, hasArtifacts: true }, facts), true);
  assert.equal(sessionMatchesFilters(mine, { ...DEFAULT_SIDEBAR_FILTERS, hasArtifacts: true }, facts), false);
});

test("an unread fact hides rows until the on-demand read lands", () => {
  const mine = session("s1");
  assert.equal(sessionMatchesFilters(mine, { ...DEFAULT_SIDEBAR_FILTERS, onlyRunning: true }, {}), false);
  assert.equal(
    sessionMatchesFilters(mine, { ...DEFAULT_SIDEBAR_FILTERS, onlyRunning: true }, { running: new Set() }),
    false,
  );
});
