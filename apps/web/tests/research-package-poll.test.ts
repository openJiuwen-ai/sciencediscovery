// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { ApiClient } from "../src/api.js";
import { exportPollStep, EXPORT_POLL_FAILURE_LIMIT, type ExportPollText } from "../src/research-package/export-poll.js";
import { CONTINUATION_FAILURE_LIMIT, ContinuationTasks } from "../src/research-package/continuation-tasks.js";

const TEXT: ExportPollText = {
  exportCanceled: "canceled",
  exportFailed: "failed",
  exportMissing: "missing",
  exportPollingFailed: "gave up",
  legacyUnavailable: "retrying",
  retryBackgroundExport: "retry",
};

test("a pruned export is terminal instead of polled forever", () => {
  // #981 on the web: the monitor used to swallow this and retry every 2s.
  const outcome = exportPollStep(0, { ok: false, reason: Object.assign(new Error("gone"), { status: 404 }) }, TEXT);
  assert.equal(outcome.drop, true);
  assert.equal(outcome.notice?.title, "missing");
});

test("a legacy outage is announced once and stays bounded", () => {
  const legacy = Object.assign(new Error("legacy_unavailable"), { status: 502 });
  const first = exportPollStep(0, { ok: false, reason: legacy }, TEXT);
  assert.equal(first.drop, false);
  assert.equal(first.failures, 1);
  assert.equal(first.notice?.title, "retrying", "the user learns why it is slow");
  const second = exportPollStep(first.failures, { ok: false, reason: legacy }, TEXT);
  assert.equal(second.notice, undefined, "not a notice every two seconds");
  let failures = 0;
  let outcome = exportPollStep(failures, { ok: false, reason: legacy }, TEXT);
  for (let index = 1; index < EXPORT_POLL_FAILURE_LIMIT; index++) {
    failures = outcome.failures;
    outcome = exportPollStep(failures, { ok: false, reason: legacy }, TEXT);
  }
  assert.equal(outcome.drop, true, "the retry budget ends the poll");
  assert.equal(outcome.notice?.title, "gave up");
});

test("an answered poll resets the failure count", () => {
  assert.deepEqual(exportPollStep(4, { ok: true, status: "running" }, TEXT), { drop: false, failures: 0 });
});

test("terminal statuses stop the poll and say what happened", () => {
  assert.equal(exportPollStep(0, { ok: true, status: "failed", error: "boom" }, TEXT).notice?.detail, "boom");
  const canceled = exportPollStep(0, { ok: true, status: "canceled" }, TEXT);
  assert.equal(canceled.drop, true);
  assert.equal(canceled.notice?.title, "canceled");
  // `completed` is dropped by the poll; the caller still has to save the file.
  const completed = exportPollStep(0, { ok: true, status: "completed" }, TEXT);
  assert.deepEqual(completed, { drop: true, failures: 0 });
});

const flush = async () => { for (let index = 0; index < 25; index++) await Promise.resolve(); };
const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };

test("a continuation stops after the same bound of transient failures", async () => {
  let attempts = 0;
  let release!: () => void;
  const manager = new ContinuationTasks({
    createResearchContinuation: async () => { attempts++; throw new TypeError("fetch failed"); },
    getResearchContinuation: async () => { throw new Error("unused"); },
  }, storage(), () => assert.fail("a failed copy must not open"), () => new Promise<void>((resolve) => { release = resolve; }));
  manager.start("source");
  for (let round = 0; round < CONTINUATION_FAILURE_LIMIT; round++) { await flush(); release(); }
  await flush();
  assert.equal(manager.tasks[0]?.state, "failed", "an unreachable service ends as a visible failure");
  assert.match(manager.tasks[0]?.error ?? "", /retries have stopped/);
  assert.equal(attempts >= CONTINUATION_FAILURE_LIMIT, true);
  manager.dispose();
});

test("a 4xx still fails immediately without spending the retry budget", async () => {
  const manager = new ContinuationTasks({
    createResearchContinuation: async () => { throw Object.assign(new Error("gone"), { status: 404 }); },
    getResearchContinuation: async () => { throw new Error("unused"); },
  }, storage(), () => assert.fail("a failed copy must not open"), () => Promise.resolve());
  manager.start("source"); await flush();
  assert.equal(manager.tasks[0]?.state, "failed");
  assert.equal(manager.tasks[0]?.failures, undefined, "an answer is not a transient failure");
  manager.dispose();
});