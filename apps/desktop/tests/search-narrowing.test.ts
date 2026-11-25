// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { WorkbenchSearchResult } from "../src/api/types.js";
import {
  DEFAULT_SEARCH_NARROWING, hasActiveNarrowing, inWindow, narrowResults, narrowSessions,
  type SearchNarrowing,
} from "../src/app/search-narrowing.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

const NOW = Date.parse("2026-11-21T12:00:00.000Z");

function hit(kind: WorkbenchSearchResult["kind"], over: Partial<WorkbenchSearchResult> = {}): WorkbenchSearchResult {
  return { detail: "", id: `${kind}:x`, kind, label: kind, projectId: "p1", ...over };
}

const context = {
  now: NOW,
  runningSessionId: "run",
  withArtifacts: new Set(["art"]),
  sessionFacts: (sessionId: string) => {
    const facts: Record<string, { archived: boolean; stamp?: number }> = {
      art: { archived: false, stamp: Date.parse("2026-11-21T11:00:00.000Z") },
      run: { archived: false, stamp: Date.parse("2026-11-21T11:30:00.000Z") },
      plain: { archived: false, stamp: Date.parse("2026-10-01T11:00:00.000Z") },
      gone: { archived: true, stamp: Date.parse("2026-11-21T11:00:00.000Z") },
    };
    return facts[sessionId];
  },
};

test("the default narrowing keeps everything the route found", () => {
  const rows = [hit("project"), hit("session", { sessionId: "plain" }), hit("artifact", { sessionId: "plain" })];
  assert.deepEqual(narrowResults(rows, DEFAULT_SEARCH_NARROWING, context).map((row) => row.kind),
    ["project", "session", "artifact"]);
  assert.equal(hasActiveNarrowing(DEFAULT_SEARCH_NARROWING), false);
});

test("an archived Session and its artifacts are not searchable, and a read-only snapshot is", () => {
  // "Covers 活跃 sessions" is archived-versus-live: an imported read-only snapshot
  // has facts of its own and stays searchable.
  const rows = [
    hit("session", { archived: true, sessionId: "gone" }),
    hit("session", { sessionId: "gone" }),
    hit("artifact", { sessionId: "gone" }),
    hit("session", { sessionId: "snapshot" }),
  ];
  const facts = (sessionId: string) => sessionId === "gone" ? { archived: true }
    : sessionId === "snapshot" ? { archived: false, stamp: NOW } : undefined;
  const kept = narrowResults(rows, DEFAULT_SEARCH_NARROWING, { ...context, sessionFacts: facts });
  assert.deepEqual(kept.map((row) => row.kind), ["session"], "only the live snapshot survives");
  assert.equal(kept[0]!.sessionId, "snapshot");
});

test("a stated Project selection limits the hits and drops the Project rows", () => {
  const rows = [
    hit("project", { projectId: "p1" }),
    hit("session", { projectId: "p1", sessionId: "plain" }),
    hit("session", { projectId: "p2", sessionId: "plain" }),
    hit("artifact", { projectId: "p2", sessionId: "plain" }),
  ];
  const narrowing: SearchNarrowing = { ...DEFAULT_SEARCH_NARROWING, projectIds: ["p1"] };
  const kept = narrowResults(rows, narrowing, context);
  assert.deepEqual(kept.map((row) => row.kind), ["session"], "no Project rows, and only p1's hit");
  assert.equal(kept[0]!.projectId, "p1");
});

test("运行中, 有产物 and the time presets narrow the hits they can judge", () => {
  const rows = [
    hit("session", { sessionId: "run" }),
    hit("session", { sessionId: "art" }),
    hit("session", { sessionId: "plain" }),
    hit("artifact", { sessionId: "plain" }),
  ];

  assert.deepEqual(
    narrowResults(rows, { ...DEFAULT_SEARCH_NARROWING, onlyRunning: true }, context)
      .map((row) => `${row.kind}:${row.sessionId}`), ["session:run"], "only the running Session");

  // An artifact hit is its own evidence of having outputs; a Session hit is not.
  assert.deepEqual(
    narrowResults(rows, { ...DEFAULT_SEARCH_NARROWING, onlyWithArtifacts: true }, context)
      .map((row) => `${row.kind}:${row.sessionId}`), ["session:art", "artifact:plain"]);

  assert.deepEqual(
    narrowResults(rows, { ...DEFAULT_SEARCH_NARROWING, window: "day" }, context)
      .map((row) => `${row.kind}:${row.sessionId}`), ["session:run", "session:art"],
    "the October rows are outside the last 24 hours");

  assert.deepEqual(
    narrowResults(rows, { ...DEFAULT_SEARCH_NARROWING, window: "custom",
      custom: { from: Date.parse("2026-10-01T00:00:00.000Z"), to: Date.parse("2026-10-02T00:00:00.000Z") } }, context)
      .map((row) => row.sessionId), ["plain", "plain"], "the custom range is inclusive and picks only October");
});

function session(id: string, over: { archivedAt?: string; projectId?: string; updatedAt?: string } = {}) {
  return { createdAt: "2026-11-21T11:00:00.000Z", id, projectId: "p1", updatedAt: "2026-11-21T11:00:00.000Z", ...over };
}

test("with no query the same narrowing filters the column itself", () => {
  // #1251's fourth criterion: the list can be narrowed without a search.
  const rows = [
    session("art"),
    session("run"),
    session("plain"),
    session("gone", { archivedAt: "2026-11-20T00:00:00.000Z" }),
    session("other-project", { projectId: "p2" }),
    session("old", { updatedAt: "2026-10-01T11:00:00.000Z" }),
  ];

  assert.deepEqual(narrowSessions(rows, DEFAULT_SEARCH_NARROWING, context).map((row) => row.id),
    ["art", "run", "plain", "other-project", "old"], "the default keeps every active Session");

  assert.deepEqual(
    narrowSessions(rows, { ...DEFAULT_SEARCH_NARROWING, onlyRunning: true }, context).map((row) => row.id),
    ["run"]);
  assert.deepEqual(
    narrowSessions(rows, { ...DEFAULT_SEARCH_NARROWING, onlyWithArtifacts: true }, context).map((row) => row.id),
    ["art"]);
  assert.deepEqual(
    narrowSessions(rows, { ...DEFAULT_SEARCH_NARROWING, projectIds: ["p2"] }, context).map((row) => row.id),
    ["other-project"], "a Project selection limits the folds, which is the old 仅当前项目 in its new shape");
  assert.deepEqual(
    narrowSessions(rows, { ...DEFAULT_SEARCH_NARROWING, window: "day" }, context).map((row) => row.id),
    ["art", "run", "plain", "other-project"], "the October row is outside the window");

  // An archived Session never comes back, whatever the narrowing says.
  assert.equal(narrowSessions(rows, DEFAULT_SEARCH_NARROWING, context).some((row) => row.id === "gone"), false);
});

test("the column keeps the open Session, and one whose artifacts are unread", () => {
  // 有产物 narrows on a set the prefetch fills *after* the listing answers, so on
  // the first paint every Session is unread — dropping those would empty the
  // column until the reads land. The open Session is kept for the same reason:
  // narrowing must not hide the row the reader is looking at.
  const rows = [
    session("open", { projectId: "p2" }),
    session("unread", { projectId: "p2" }),
    session("read-empty", { projectId: "p2" }),
  ];
  const narrowed = narrowSessions(
    rows,
    { ...DEFAULT_SEARCH_NARROWING, onlyWithArtifacts: true, projectIds: ["p2"] },
    { ...context, artifactsUnread: new Set(["unread"]), keepSessionId: "open" },
  );
  assert.deepEqual(narrowed.map((row) => row.id), ["open", "unread"],
    "an unread list is not an empty one, and the open row stays visible");
});
test("a hit this page cannot judge is kept rather than hidden", () => {
  const rows = [hit("session", { sessionId: "unknown-project" })];
  assert.deepEqual(narrowResults(rows, DEFAULT_SEARCH_NARROWING, context).length, 1);
  assert.equal(inWindow("day", undefined, NOW), false, "a window drops what it cannot show to be inside");
  assert.equal(inWindow("all", undefined, NOW), true, "and 不限时间 keeps it");
});
