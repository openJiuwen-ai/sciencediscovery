// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ApiClient } from "../src/api.js";
import { ApiRequestError } from "../src/api/auth.js";
import type { ResearchPackageExportTaskView } from "../src/api/plugins.js";
import { exportCompletionStep, exportPollStep, EXPORT_POLL_FAILURE_LIMIT, type ExportPollText } from "../src/research-package/export-poll.js";
import { CONTINUATION_FAILURE_LIMIT, ContinuationTasks } from "../src/research-package/continuation-tasks.js";
import { ResearchPackageExportMonitor, trackResearchPackageExport } from "../src/research-package/ResearchPackageExportTasks.js";

const TEXT: ExportPollText = {
  exportCanceled: "canceled",
  exportDownloadFailed: "download failed",
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
  // The real client throws ApiRequestError, and the shared rule in api/auth.ts
  // is what recognises the adapter's 502; a bare Error must not match it.
  const legacy = new ApiRequestError("legacy_unavailable", 502);
  assert.equal(exportPollStep(0, { ok: false, reason: new Error("legacy_unavailable") }, TEXT).notice, undefined,
    "a plain Error with the same message is not the adapter's outage");
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

test("a completed export whose download keeps failing gives up instead of re-downloading forever", () => {
  // F1 on #1013: the completion path used to share the status poll's counter,
  // and every `completed` answer reset it to zero, so a failing archive fetch
  // could never reach the limit. This drives the two steps in the monitor's
  // order — status first, then download — for ten ticks.
  let failures = 0;
  let dropped = false;
  let notices = 0;
  const downloadError = Object.assign(new Error("Failed to fetch"), { status: 500 });
  for (let tick = 0; tick < 10 && !dropped; tick += 1) {
    const status = exportPollStep(failures, { ok: true, status: "completed" }, TEXT);
    assert.equal(status.drop, true, "a completed status ends the status poll");
    // The monitor must not adopt `status.failures` here: doing so is the bug.
    const save = exportCompletionStep(failures, { ok: false, reason: downloadError }, TEXT);
    failures = save.failures;
    dropped = save.drop;
    if (save.notice) notices += 1;
  }
  assert.equal(dropped, true, "the task is released instead of retried forever");
  assert.equal(failures, EXPORT_POLL_FAILURE_LIMIT);
  assert.equal(notices, 1, "the user is told once, not every two seconds");
});

test("a successful download ends the task with no failure count", () => {
  const done = exportCompletionStep(3, { ok: true }, TEXT);
  assert.deepEqual(done, { drop: true, failures: 0 });
});

test("a completed status does not reset the download budget", () => {
  // The distinct assertion for the sequencing bug: whatever the status step
  // returns for `completed`, it must not carry the download's counter.
  const status = exportPollStep(4, { ok: true, status: "completed" }, TEXT);
  assert.equal(status.failures, 0, "the status step answers about the status, not the save");
  const save = exportCompletionStep(4, { ok: false, reason: new Error("again") }, TEXT);
  assert.equal(save.drop, true, "the fourth download failure still reaches the limit");
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

test("a ready copy with no session information reaches the limit instead of polling forever", async () => {
  // zhaozhaozz on 20a2cb53: the count was reset before this guard threw, so the
  // branch could never spend the budget and the copy poll ran unbounded there.
  // Both routes answer the same malformed operation, so the shape guard is what
  // throws on every poll — the branch that used to reset its own counter.
  let attempts = 0;
  let release!: () => void;
  const malformed = async () => { attempts += 1; return { state: "ready" } as never; };
  const manager = new ContinuationTasks({
    createResearchContinuation: malformed,
    getResearchContinuation: malformed,
  }, storage(), () => assert.fail("a copy with no session information must not open"), () => new Promise<void>((resolve) => { release = resolve; }));
  manager.start("source");
  for (let round = 0; round < CONTINUATION_FAILURE_LIMIT; round++) { await flush(); release(); }
  await flush();
  assert.equal(manager.tasks[0]?.state, "failed", "the shape failure is bounded like any other transient one");
  assert.match(manager.tasks[0]?.error ?? "", /retries have stopped/);
  assert.equal(attempts >= CONTINUATION_FAILURE_LIMIT, true, "it really did spend the whole budget first");
  manager.dispose();
});

/** The monitor reads `window` for its interval and its task storage; a node test
 *  has neither, so it gets the smallest one that lets the real effect run. */
function installWindow(): () => void {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearInterval: (id: unknown) => clearInterval(id as ReturnType<typeof setInterval>),
      sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } },
      setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
    },
  });
  return () => { delete (globalThis as { window?: unknown }).window; };
}

const taskView = (id: string): ResearchPackageExportTaskView => ({
  id, filename: `${id}.sdresearch`, createdAt: "2026-11-10T00:00:00.000Z",
  status: "running", updatedAt: "2026-11-10T00:00:00.000Z",
} as ResearchPackageExportTaskView);

test("a failed export shows the server's reason instead of the generic retry line", async (context) => {
  // zhaozhaozz on 20a2cb53: the caller built `{ ok: true, status }` and dropped
  // `status.error`, so a failed export lost the reason the base line showed.
  const restore = installWindow();
  context.after(restore);
  const id = "export-reason-passthrough";
  trackResearchPackageExport("project-1", taskView(id));
  const toasts: Array<{ detail?: string; title: string }> = [];
  const client = {
    downloadResearchPackageExport: async () => { throw new Error("unused"); },
    getResearchPackageExport: async () => ({ ...taskView(id), error: "archive limit exceeded", status: "failed" }),
  } as unknown as ApiClient;
  const onToast = (_tone: string, title: string, detail?: string) => { toasts.push({ detail, title }); };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ResearchPackageExportMonitor, { client, onToast })); });
  await act(async () => { await flush(); });
  assert.equal(toasts.length, 1, "a terminal failure is announced once");
  assert.equal(toasts[0]?.detail, "archive limit exceeded", "the server's reason reaches the user");
  await act(async () => { renderer.unmount(); });
});

test("a download failure keeps its own budget instead of inheriting the status poll's", async (context) => {
  // zhaozhaozz on 20a2cb53: the completion step read the same map entry the
  // status poll writes, so four transient status failures plus one failed
  // download dropped a finished export after a single attempt.
  const restore = installWindow();
  context.after(restore);
  const id = "export-download-budget";
  trackResearchPackageExport("project-1", taskView(id));
  const toasts: string[] = [];
  let delivering = false;
  const makeClient = () => ({
    downloadResearchPackageExport: async () => { throw Object.assign(new Error("stream aborted"), { status: 500 }); },
    getResearchPackageExport: async () => {
      if (!delivering) throw Object.assign(new Error("network down"), { status: 500 });
      return { ...taskView(id), status: "completed" };
    },
  } as unknown as ApiClient);
  const onToast = (_tone: string, title: string) => { toasts.push(title); };
  let renderer!: ReactTestRenderer;
  // A new client identity re-runs the monitor's effect, which is one poll tick.
  const tick = async () => {
    await act(async () => { renderer.update(createElement(ResearchPackageExportMonitor, { client: makeClient(), onToast })); });
    await act(async () => { await flush(); });
  };
  await act(async () => { renderer = create(createElement(ResearchPackageExportMonitor, { client: makeClient(), onToast })); });
  await act(async () => { await flush(); });
  // The mount itself is the first status failure; three more make four.
  for (let round = 0; round < EXPORT_POLL_FAILURE_LIMIT - 2; round++) await tick();
  assert.deepEqual(toasts, [], "four transient status failures are still retryable, silently");
  delivering = true;
  await tick();
  assert.deepEqual(toasts, [], "one failed download must not end an export that only survived four status failures");
  for (let round = 0; round < EXPORT_POLL_FAILURE_LIMIT - 1; round++) await tick();
  assert.equal(toasts.length, 1, "the download's own budget ends it after five attempts, once");
  assert.match(toasts[0] ?? "", /could not be downloaded/i);
  await act(async () => { renderer.unmount(); });
});