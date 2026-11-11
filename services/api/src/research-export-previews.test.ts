// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ResearchExportPreviews, type ExportPreviewOptions } from "./research-export-previews.js";
import { ApiStatusError } from "./http/api-status-error.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
const statusError = (status: number, code: string) => (error: unknown) =>
  error instanceof ApiStatusError && error.statusCode === status && error.code === code;

test("deletion aborts active and queued project previews while other projects continue", async () => {
  let started!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const calls: string[] = [];
  const previews = new ResearchExportPreviews(async () => "r1", async (options, revision, signal) => {
    calls.push(options.sessionId!);
    if (options.sessionId === "active") {
      started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return { revision, estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [] };
  });
  const options = { projectId: "p", sessionId: "active", level: "necessary" as const, includeFullTrajectory: false };
  const active = previews.get(options);
  const rejected = assert.rejects(active, statusError(404, "EXPORT_PREVIEW_RESOURCE_DELETED"));
  await admitted;
  const queued = previews.get({ ...options, sessionId: "dependent" });
  // Ensure the second request has finished admission and entered the queue.
  await new Promise<void>(resolve => setImmediate(resolve));
  previews.cancel("p", "active");
  await rejected;
  assert.equal((await queued).revision, "r1", "a surviving sibling retries without a caller-visible failure");
  await previews.get({ ...options, projectId: "other", sessionId: "other" });
  await previews.get({ ...options, sessionId: "replacement" });
  assert.deepEqual(calls, ["active", "dependent", "other", "replacement"]);
  await previews.close();
});

test("deleting a sibling restarts active default previews at the new revision", async () => {
  let started!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  let revision = "r1", calls = 0;
  const previews = new ResearchExportPreviews(async () => revision, async (_options, current, signal) => {
    if (++calls === 1) {
      started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("concurrent store read failed")), { once: true }));
    }
    return { revision: current, estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [] };
  });
  try {
    const pending = previews.defaults("p", "survivor", true);
    await admitted;
    revision = "r2";
    previews.cancel("p", "deleted-sibling");
    const result = await pending;
    assert.equal(result.revision, "r2");
    assert.equal(calls, 6, "one cancelled calculation and all five fresh profiles");
    assert.equal((await previews.defaults("p", "survivor", true)).revision, "r2");
    assert.equal(calls, 6, "only the fresh results are cached");
  } finally { await previews.close(); }
});

test("repeated sibling invalidation is bounded and a later request can recover", async () => {
  let admitted!: () => void;
  let ready = new Promise<void>(resolve => { admitted = resolve; });
  let interrupt = true, calls = 0;
  const previews = new ResearchExportPreviews(async () => "r", async (_options, revision, signal) => {
    calls++;
    if (interrupt) {
      admitted();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return { revision, estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [] };
  });
  const options = { projectId: "p", level: "complete" as const, includeFullTrajectory: true };
  try {
    const pending = assert.rejects(previews.get(options), statusError(409, "EXPORT_PREVIEW_PENDING"));
    await ready;
    ready = new Promise<void>(resolve => { admitted = resolve; });
    previews.cancel("p", "sibling-a");
    await ready;
    previews.cancel("p", "sibling-b");
    await pending;
    assert.equal(calls, 2, "only one automatic retry per request");
    interrupt = false;
    assert.equal((await previews.get(options)).revision, "r");
    assert.equal(calls, 3, "a rejected calculation must not poison the cache");
  } finally { await previews.close(); }
});

test("project deletion does not retry its active preview", async () => {
  let started!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const previews = new ResearchExportPreviews(async () => "r", async (_options, _revision, signal) => {
    calls++; started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    throw new Error("unreachable");
  });
  try {
    const pending = assert.rejects(previews.get({ projectId: "p", level: "complete", includeFullTrajectory: true }),
      statusError(404, "EXPORT_PREVIEW_RESOURCE_DELETED"));
    await admitted; previews.cancel("p"); await pending;
    assert.equal(calls, 1);
  } finally { await previews.close(); }
});

test("shutdown signals an admitted calculation before waiting for its completion", async () => {
  let started!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const previews = new ResearchExportPreviews(async () => "r", async (_options, _revision, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    throw new Error("unreachable");
  });
  const pending = assert.rejects(previews.get({ projectId: "p", level: "complete", includeFullTrajectory: true }),
    statusError(503, "EXPORT_PREVIEW_SERVICE_CLOSED"));
  await admitted; await previews.close(); await pending;
});

test("background warming preheats only the necessary profile, not all five", async () => {
  const calls: ExportPreviewOptions[] = [];
  const previews = new ResearchExportPreviews(async () => "r1", async (options, revision) => {
    calls.push(options);
    return { revision, estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [] };
  });
  try {
    previews.watch("p", "s");
    await previews.tick();
    assert.equal(calls.length, 1, "the background warm runs one profile");
    assert.equal(calls[0]!.level, "necessary");
    assert.equal(calls[0]!.includeFullTrajectory, false);
    assert.equal(calls[0]!.includeFullMemoryGraph, false);
    // The explicit defaults request still computes all five on demand.
    await previews.defaults("p", "s");
    assert.equal(calls.length, 5);
  } finally { await previews.close(); }
});

test("default preview sizes cache, invalidate on evidence revisions and serialize work", async () => {
  let revision = "r1", active = 0, peak = 0;
  const calls: ExportPreviewOptions[] = [];
  const previews = new ResearchExportPreviews(async () => revision, async (options, current) => {
    calls.push(options); active++; peak = Math.max(active, peak);
    await new Promise<void>((resolve) => setImmediate(resolve)); active--;
    return { revision: current, estimatedBytes: calls.length, estimateKind: "uncompressed", files: [], omissions: [] };
  });
  previews.watch("p", "s");
  const warmed = await previews.defaults("p", "s");
  assert.equal(calls.length, 5); assert.equal(peak, 1);
  await previews.tick();
  assert.deepEqual(await previews.defaults("p", "s"), warmed); assert.equal(calls.length, 5);
  revision = "r2"; await previews.tick();
  const next = await previews.defaults("p", "s");
  assert.equal(next.revision, "r2"); assert.equal(calls.length, 10);
  assert.equal(next.completeWithTrajectory.revision, next.necessary.revision);
  assert.equal(next.completeWithMemoryGraph.revision, next.necessary.revision);
  assert.equal(next.completeWithTrajectoryAndMemoryGraph.revision, next.necessary.revision);
  const custom = { projectId: "p", sessionId: "s", level: "necessary" as const, selectedFiles: new Set(["b", "a"]), includeFullTrajectory: false };
  await Promise.all([previews.get(custom), previews.get({ ...custom, selectedFiles: new Set(["a", "b"]) })]);
  assert.equal(calls.length, 11);
  previews.close(); await previews.tick(); assert.equal(calls.length, 11);
});

test("background warming defers active sessions and resumes at their terminal revision", async () => {
  let busy = true, revision = "running", reads = 0, calculations = 0;
  const previews = new ResearchExportPreviews(async () => { reads++; return revision; }, async (_options, current) => {
    calculations++;
    return { revision: current, estimatedBytes: calculations, estimateKind: "uncompressed", files: [], omissions: [] };
  }, async () => !busy);
  try {
    previews.watch("p", "s");
    await previews.tick();
    assert.equal(reads, 0, "background work must not read changing run evidence");
    assert.equal(calculations, 0);
    // Explicit user requests still work while automatic warming is deferred.
    const requested = await previews.get({ projectId: "p", sessionId: "s", level: "necessary", includeFullTrajectory: false });
    assert.equal(requested.revision, "running");
    busy = false; revision = "completed";
    await previews.tick();
    const warmed = await previews.defaults("p", "s");
    assert.equal(warmed.revision, "completed");
    assert.equal(calculations, 6, "one explicit request, the terminal warm, then the four on-demand complete profiles");
  } finally { await previews.close(); }
});

test("a run starting after admission stops queued default profiles and stale retries", async () => {
  let busy = false, revision = "idle", calculations = 0;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  const previews = new ResearchExportPreviews(async () => revision, async (_options, current) => {
    calculations++;
    if (calculations === 1) { started(); await gate; }
    return { revision: current, estimatedBytes: calculations, estimateKind: "uncompressed", files: [], omissions: [] };
  }, async () => !busy);
  try {
    const pending = previews.defaults("p", "s", true);
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "EXPORT_PREVIEW_PENDING");
    await admitted;
    busy = true; revision = "running"; release();
    await rejected;
    // Drain the automatic queue with an explicit request, which remains usable.
    await previews.get({ projectId: "p", sessionId: "s", level: "necessary", includeFullTrajectory: false });
    assert.equal(calculations, 2, "queued profiles and the stale first profile must not run during chat");
    busy = false; revision = "completed";
    assert.equal((await previews.defaults("p", "s", true)).revision, "completed");
    assert.equal(calculations, 7, "all five profiles resume for the terminal revision");
  } finally { release(); await previews.close(); }
});

test("idle preview watchers expire until the next explicit visit", async () => {
  let now = 0, calls = 0;
  const previews = new ResearchExportPreviews(async () => "r1", async () => {
    calls++;
    return { revision: "r1", estimatedBytes: calls, estimateKind: "uncompressed", files: [], omissions: [] };
  }, async () => true, () => now);
  try {
    previews.watch("p", "s");
    await previews.defaults("p", "s");
    assert.equal(calls, 5);
    now = 30_001;
    await previews.tick();
    assert.equal(calls, 5, "an abandoned dialog must stop background warming");
    previews.watch("p", "s");
    await previews.tick();
    assert.equal(calls, 5, "the explicit visit reuses the cached terminal revision");
  } finally { await previews.close(); }
});

test("default previews share one busy-state check for the admitted revision", async () => {
  let checks = 0;
  const previews = new ResearchExportPreviews(async () => "r1", async (_options, revision) => ({ revision, estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [] }), async () => { checks++; return true; });
  try {
    await previews.defaults("p", "s", true);
    assert.equal(checks, 1);
  } finally { await previews.close(); }
});

test("busy default previews expose a retryable API status", async () => {
  const previews = new ResearchExportPreviews(async () => "r1", async (_options, revision) => ({ revision, estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [] }), async () => false);
  try {
    await assert.rejects(previews.defaults("p", "s", true), (error: unknown) => {
      const status = error as { statusCode?: number; code?: string };
      return status.statusCode === 409 && status.code === "EXPORT_PREVIEW_PENDING";
    });
  } finally { await previews.close(); }
});

test("default previews expose a retryable status when a run races file publication", async () => {
  let busy = false;
  const previews = new ResearchExportPreviews(async () => "running", async () => {
    busy = true;
    const error = new Error("trajectory is not published yet") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }, async () => !busy);
  const options = { projectId: "p", sessionId: "s", level: "necessary" as const, includeFullTrajectory: false };
  try {
    await assert.rejects(previews.get(options, true), statusError(409, "EXPORT_PREVIEW_PENDING"));
  } finally { await previews.close(); }
});

test("explicit previews preserve missing-file errors", async () => {
  const previews = new ResearchExportPreviews(async () => "r1", async () => {
    const error = new Error("trajectory is not published yet") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  });
  const options = { projectId: "p", sessionId: "s", level: "necessary" as const, includeFullTrajectory: false };
  try {
    await assert.rejects(previews.get(options), (error: unknown) =>
      error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally { await previews.close(); }
});

test("failed and stale calculations are retried instead of caching an obsolete size", async () => {
  let revision = "r1", calls = 0, fail = true;
  const previews = new ResearchExportPreviews(async () => revision, async (_options, current) => {
    calls++; if (fail) throw new Error("offline");
    if (current === "r1") revision = "r2";
    return { revision: current, estimatedBytes: calls, estimateKind: "uncompressed", files: [], omissions: [] };
  });
  const options = { projectId: "p", sessionId: "s", level: "complete" as const, includeFullTrajectory: true };
  await assert.rejects(previews.get(options), /offline/);
  fail = false; const fresh = await previews.get(options);
  assert.equal(fresh.revision, "r2"); assert.equal(calls, 3);
  assert.deepEqual(await previews.get(options), fresh); assert.equal(calls, 3);
  previews.close();
});

test("revision changes exhausting calculation retries expose the pending status and can recover", async () => {
  let revision = 0, changing = true, calculations = 0;
  const previews = new ResearchExportPreviews(async () => String(revision), async (_options, current) => {
    calculations++;
    if (changing) revision++;
    return { revision: current, estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [] };
  });
  const options = { projectId: "p", sessionId: "s", level: "necessary" as const, includeFullTrajectory: false };
  try {
    await assert.rejects(previews.get(options), (error: unknown) =>
      error instanceof ApiStatusError && error.statusCode === 409 && error.code === "EXPORT_PREVIEW_PENDING");
    assert.equal(calculations, 3);
    changing = false;
    assert.equal((await previews.get(options)).revision, String(revision));
    assert.equal(calculations, 4, "a pending result must not poison the preview cache");
  } finally { await previews.close(); }
});

test("default profiles exhausting consistency retries expose the pending status", async (context) => {
  const previews = new ResearchExportPreviews(async () => "r1", async (_options, revision) => ({
    revision, estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [],
  }));
  let requests = 0;
  context.mock.method(previews, "get", async () => ({
    revision: `r${++requests}`, estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [],
  }));
  try {
    await assert.rejects(previews.defaults("p", "s"), (error: unknown) =>
      error instanceof ApiStatusError && error.statusCode === 409 && error.code === "EXPORT_PREVIEW_PENDING");
    assert.equal(requests, 15, "all five profiles are retried three times");
  } finally { await previews.close(); }
});

test("queued requests coalesce superseded revisions without recalculating the latest evidence", async () => {
  let revision = "r1", calls = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  const previews = new ResearchExportPreviews(async () => revision, async (_options, current) => {
    calls++;
    if (calls === 1) { started(); await gate; }
    return { revision: current, estimatedBytes: calls, estimateKind: "uncompressed", files: [], omissions: [] };
  });
  const options = { projectId: "p", sessionId: "s", level: "complete" as const, includeFullTrajectory: true };
  const first = previews.get(options);
  await admitted;
  revision = "r2";
  const second = previews.get(options);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.revision, "r2");
  assert.deepEqual(right, left);
  assert.equal(calls, 2, "only the initial and latest revisions are calculated");
  previews.close();
});

test("shutdown waits for admitted preview work and rejects new work", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  const previews = new ResearchExportPreviews(async () => "r1", async () => {
    started(); await gate;
    return { revision: "r1", estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [] };
  });
  const options = { projectId: "p", sessionId: "s", level: "necessary" as const, includeFullTrajectory: false };
  const pending = previews.get(options);
  const rejected = assert.rejects(pending, /closed/);
  await admitted;
  let drained = false;
  const closing = previews.close().then(() => { drained = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  await assert.rejects(previews.get(options), /closed/);
  release(); await closing; await rejected;
  assert.equal(drained, true);
});
