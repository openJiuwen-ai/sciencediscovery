// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { ApiClient } from "../src/api.js";
import { ContinuationTasks } from "../src/research-package/continuation-tasks.js";
import { ExportPreviewCache } from "../src/research-package/export-preview-cache.js";

const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };

test("continuation survives button unsubscribe, deduplicates requests and recovers tracking after reload", async () => {
  const saved = storage();
  let creates = 0, gets = 0, ready = 0;
  let release!: () => void;
  const pause = () => new Promise<void>((resolve) => { release = resolve; });
  const operation = { id: "operation", sourceSessionId: "source", state: "copying" as const, createdAt: "2026-10-26" };
  const client = {
    createResearchContinuation: async () => { creates++; return operation; },
    getResearchContinuation: async () => { gets++; return { ...operation, state: "ready" as const, entrySessionId: "copy", sessionIds: ["copy"] }; },
  };
  const manager = new ContinuationTasks(client, saved, () => { ready++; }, pause);
  manager.resume();
  const unsubscribe = manager.subscribe(() => undefined);
  const task = manager.start("source");
  assert.equal(manager.start("source"), task);
  unsubscribe();
  await flush();
  assert.equal(creates, 1);
  manager.dispose(); release(); await flush();
  const restored = new ContinuationTasks(client, saved, () => { ready++; });
  restored.resume(); await flush();
  assert.equal(creates, 1, "reload queries the original operation without creating another copy");
  assert.equal(gets, 1); assert.equal(ready, 1);
  assert.equal(restored.tasks[0]?.operation?.entrySessionId, "copy");
  restored.dismiss(task.requestId); assert.equal(restored.tasks.length, 0); restored.dispose();
});

test("a lost creation response retries the same identity; terminal failure allows an independent retry", async () => {
  const ids: string[] = [];
  let release!: () => void;
  const manager = new ContinuationTasks({
    createResearchContinuation: async (_source, id) => {
      ids.push(id);
      if (ids.length === 1) throw new TypeError("fetch failed");
      return { id: "operation", sourceSessionId: "source", state: "failed", error: "memory unavailable", createdAt: "2026-10-26" };
    }, getResearchContinuation: async () => { throw new Error("unused"); },
  }, storage(), () => assert.fail("must not open failed copy"), () => new Promise<void>((resolve) => { release = resolve; }));
  manager.start("source"); await flush();
  assert.equal(manager.tasks[0]?.state, "copying");
  release(); await flush();
  assert.equal(ids[0], ids[1]); assert.equal(manager.tasks[0]?.state, "failed");
  manager.start("source"); await flush();
  assert.notEqual(ids[1], ids[2]); manager.dispose();
});

test("preview cache separates revisions and clients, shares in-flight work, canonicalizes files and retries failures", async () => {
  let calls = 0, fail = false;
  const client = { previewResearchPackage: async () => {
    calls++; if (fail) throw new Error("offline");
    return { estimatedBytes: calls, files: [], omissions: [] };
  } } as unknown as ApiClient;
  const cache = new ExportPreviewCache(client);
  const necessary = cache.get("p", "s", "necessary");
  assert.equal(cache.get("p", "s", "necessary"), necessary);
  await necessary; await cache.get("p", "s", "complete");
  await cache.get("p", "s", "necessary"); assert.equal(calls, 2);
  const custom = cache.get("p", "s", "necessary", ["b", "a", "a"]);
  assert.equal(cache.get("p", "s", "necessary", ["a", "b"]), custom); await custom;
  await cache.get("p", "s", "necessary"); assert.equal(calls, 3, "no TTL invalidation without a content change");
  await cache.get("p", "s", "necessary", undefined, false, "new-revision"); assert.equal(calls, 4);
  fail = true; await assert.rejects(cache.get("p", "s", "complete", undefined, false, "new-revision"));
  fail = false; await cache.get("p", "s", "complete", undefined, false, "new-revision"); assert.equal(calls, 6);
  const otherClient = { previewResearchPackage: client.previewResearchPackage } as ApiClient;
  await new ExportPreviewCache(otherClient).get("p", "s", "necessary"); assert.equal(calls, 7);
});

test("background defaults warm all export variants and notify an open dialog only when content changes", async () => {
  let revision = "r1", calls = 0, updates = 0;
  const preview = (estimatedBytes: number) => ({ revision, estimatedBytes, files: [], omissions: [] });
  const client = {
    previewResearchPackage: async () => { throw new Error("default previews should already be warm"); },
    getResearchPackagePreviews: async () => { calls++; return { revision, necessary: preview(1), complete: preview(2), completeWithTrajectory: preview(3), completeWithMemoryGraph: preview(4), completeWithTrajectoryAndMemoryGraph: preview(5) }; },
  } as unknown as ApiClient;
  const background = new ExportPreviewCache(client);
  const dialog = new ExportPreviewCache(client);
  const unsubscribe = dialog.subscribe(() => { updates++; });
  await Promise.all([background.refreshDefaults("p", "s"), dialog.refreshDefaults("p", "s")]);
  assert.equal(calls, 1); assert.equal(updates, 1);
  assert.equal((await dialog.get("p", "s", "necessary")).estimatedBytes, 1);
  assert.equal((await dialog.get("p", "s", "complete")).estimatedBytes, 2);
  assert.equal((await dialog.get("p", "s", "complete", undefined, true)).estimatedBytes, 3);
  assert.equal((await dialog.get("p", "s", "complete", undefined, false, undefined, true)).estimatedBytes, 4);
  assert.equal((await dialog.get("p", "s", "complete", undefined, true, undefined, true)).estimatedBytes, 5);
  await background.refreshDefaults("p", "s"); assert.equal(updates, 1);
  revision = "r2"; await background.refreshDefaults("p", "s"); assert.equal(updates, 2);
  assert.equal((await dialog.get("p", "s", "necessary")).revision, "r2");
  unsubscribe();
});

test("content changes discard cached sizes immediately and cannot republish an older in-flight result", async () => {
  const responses: Array<(value: unknown) => void> = [];
  const client = {
    getResearchPackagePreviews: () => new Promise((resolve) => { responses.push(resolve); }),
  } as unknown as ApiClient;
  const cache = new ExportPreviewCache(client);
  const defaults = (revision: string) => {
    const preview = { revision, estimatedBytes: 1, files: [], omissions: [] };
    return { revision, necessary: preview, complete: preview, completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview };
  };
  cache.notifySessionRevision("p", "s", "session-1");
  const first = cache.refreshDefaults("p", "s");
  responses[0]!(defaults("evidence-1")); await first;
  assert.equal(cache.peekDefaults("p", "s")?.revision, "evidence-1");
  const obsolete = cache.refreshDefaults("p", "s");
  cache.notifySessionRevision("p", "s", "session-2");
  assert.equal(cache.peekDefaults("p", "s"), undefined, "show calculation state instead of a stale size");
  const latest = cache.refreshDefaults("p", "s");
  responses[2]!(defaults("evidence-2")); await latest;
  responses[1]!(defaults("evidence-1")); await obsolete;
  assert.equal(cache.peekDefaults("p", "s")?.revision, "evidence-2");
});
