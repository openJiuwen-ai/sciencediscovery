// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  DEFAULT_SESSION_FILTERS, filterSessions, hasActiveFilters, keepsSession,
  type SessionListFilters,
} from "../src/app/session-filters.js";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
function session(id: string, updatedAt: string) {
  return { createdAt: updatedAt, id, updatedAt };
}
const context = { now: NOW, runningSessionId: "run", withArtifacts: new Set(["art"]) };

test("the default filters keep everything", () => {
  const rows = [session("a", "2026-01-01T00:00:00.000Z"), session("run", "2026-11-21T11:00:00.000Z")];
  assert.deepEqual(filterSessions(rows, DEFAULT_SESSION_FILTERS, context).map((row) => row.id), ["a", "run"]);
  assert.equal(hasActiveFilters(DEFAULT_SESSION_FILTERS), false);
  assert.equal(hasActiveFilters({ ...DEFAULT_SESSION_FILTERS, window: "today" }), true);
});

test("仅运行中 keeps the Session with a run in flight, and nothing when none is", () => {
  const filters: SessionListFilters = { ...DEFAULT_SESSION_FILTERS, onlyRunning: true };
  const rows = [session("a", "2026-11-21T11:00:00.000Z"), session("run", "2026-11-21T11:00:00.000Z")];
  assert.deepEqual(filterSessions(rows, filters, context).map((row) => row.id), ["run"]);
  assert.deepEqual(filterSessions(rows, filters, { ...context, runningSessionId: undefined }), []);
});

test("有产物 keeps only Sessions whose outputs are already cached", () => {
  const filters: SessionListFilters = { ...DEFAULT_SESSION_FILTERS, onlyWithArtifacts: true };
  const rows = [session("art", "2026-11-21T11:00:00.000Z"), session("plain", "2026-11-21T11:00:00.000Z")];
  assert.deepEqual(filterSessions(rows, filters, context).map((row) => row.id), ["art"]);
});

test("the time window counts back from now over the row's own stamp", () => {
  const today = session("today", "2026-11-21T09:00:00.000Z");
  const week = session("week", "2026-11-18T09:00:00.000Z");
  const old = session("old", "2026-10-01T09:00:00.000Z");
  const rows = [today, week, old];
  assert.deepEqual(
    filterSessions(rows, { ...DEFAULT_SESSION_FILTERS, window: "today" }, context).map((row) => row.id),
    ["today"]);
  assert.deepEqual(
    filterSessions(rows, { ...DEFAULT_SESSION_FILTERS, window: "week" }, context).map((row) => row.id),
    ["today", "week"]);
  assert.equal(keepsSession({ createdAt: "not-a-date", id: "x" } as never,
    { ...DEFAULT_SESSION_FILTERS, window: "today" }, context), false,
  "an unparseable stamp is excluded rather than shown as fresh");
});

test("today is the calendar day on the reader's clock, not a rolling 24 hours", () => {
  // 00:10 local on the 22nd: a Session written at 23:50 the night before is under
  // 24 hours old, and it is still yesterday — the window follows the clock the
  // rows print, so it must not be kept.
  const justAfterMidnight = new Date(2026, 10, 22, 0, 10, 0).getTime();
  const lastNight = new Date(2026, 10, 21, 23, 50, 0).toISOString();
  const thisMorning = new Date(2026, 10, 22, 0, 1, 0).toISOString();
  const rows = [session("yesterday", lastNight), session("today", thisMorning)];
  const at = { ...context, now: justAfterMidnight };

  assert.deepEqual(
    filterSessions(rows, { ...DEFAULT_SESSION_FILTERS, window: "today" }, at).map((row) => row.id),
    ["today"], "23:50 the night before is yesterday even though it is under 24h");
  assert.deepEqual(
    filterSessions(rows, { ...DEFAULT_SESSION_FILTERS, window: "week" }, at).map((row) => row.id),
    ["yesterday", "today"], "and it is inside the week the calendar day ends");
});
