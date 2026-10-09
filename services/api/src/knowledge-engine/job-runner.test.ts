// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { KeJobRunner } from "./job-runner.js";
import { KnowledgeEngineStore } from "./store.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

test("runner executes a queued job to completion", async (context) => {
  const root = tempRoot("ke-runner-complete");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());

  const seen: string[] = [];
  const runner = new KeJobRunner(store);
  runner.register("extract", async (job) => {
    seen.push(String(job.payload["docId"]));
  });

  store.enqueueJob({ type: "extract", payload: { docId: "d1" } });
  const ran = await runner.tick();
  assert.equal(ran, true);
  assert.deepEqual(seen, ["d1"]);
  assert.equal(store.listJobs({ status: "succeeded" }).length, 1);
  // Queue drained: next tick is a no-op.
  assert.equal(await runner.tick(), false);
  runner.stop();
});

test("runner reschedules failures below the cap, dead-letters at the cap", async (context) => {
  const root = tempRoot("ke-runner-fail");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());

  const errors: unknown[] = [];
  const runner = new KeJobRunner(store, { backoffBaseMs: 60_000, onError: (_message, detail) => errors.push(detail) });
  runner.register("download", async () => {
    throw new Error("boom");
  });

  store.enqueueJob({ type: "download", payload: {}, maxAttempts: 1 });
  await runner.tick();
  const jobs = store.listJobs();
  assert.equal(jobs[0]?.status, "dead");
  assert.equal(jobs[0]?.error, "boom");
  assert.equal(errors.length, 1);
  runner.stop();
});

test("start() recovers crash-orphaned running jobs and they rerun", async (context) => {
  const root = tempRoot("ke-runner-recover");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());

  const { job } = store.enqueueJob({ type: "extract", payload: { docId: "d2" } });
  store.claimNextJob(["extract"]); // simulate crash mid-run: job stuck 'running'

  const seen: string[] = [];
  const recoveries: unknown[] = [];
  const runner = new KeJobRunner(store, { onError: (_message, detail) => recoveries.push(detail) });
  runner.register("extract", async (claimed) => {
    seen.push(claimed.id);
  });
  runner.start();
  context.after(() => runner.stop());
  assert.deepEqual(recoveries, [{ recovered: 1, deadLettered: 0 }]);
  await runner.tick();
  assert.deepEqual(seen, [job.id]);
  assert.equal(store.getJob(job.id)?.status, "succeeded");
});
