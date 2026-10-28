// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ResearchExportPreviews, type ExportPreviewOptions } from "./research-export-previews.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("background warming caches all default sizes, invalidates on evidence revisions and serializes work", async () => {
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
