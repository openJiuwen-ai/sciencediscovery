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

/**
 * Living-review runner tests: the opt-in switch, drift detection over the
 * sticky convergedAt latch, and the top-up grow hand-off (query reuse,
 * budget shape, per-KB dedup tolerance).
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { CrawlBudget, GrowCycleHandle } from "./grow.js";
import { KeLivingReviewRunner, resolveLivingReviewEnabled } from "./living-review-runner.js";
import type { KeOrchestrator } from "./orchestrator.js";
import { KnowledgeEngineStore } from "./store.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

const DAY = 86_400_000;

interface StartGrowCall {
  kbId: string;
  query: string;
  budget?: CrawlBudget;
}

function orchestratorSpy(reused = false): { calls: StartGrowCall[]; orchestrator: KeOrchestrator } {
  const calls: StartGrowCall[] = [];
  const orchestrator = {
    startGrow: (kbId: string, query: string, budget?: CrawlBudget): GrowCycleHandle => {
      calls.push({ kbId, query, budget });
      return { jobId: "j1", cycleId: "c1", reused };
    },
  } as unknown as KeOrchestrator;
  return { calls, orchestrator };
}

function convergedKb(store: KnowledgeEngineStore, daysAgo: number, query = "ebola glycoprotein"): string {
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  // Setup must bypass the convergedAt latch (it stamps `now` on converged
  // updates), so write the aged engine state directly.
  const engineState = {
    converged: true,
    convergedAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
    query,
    cycleId: "cycle-old",
  };
  (store as unknown as { database: { prepare(sql: string): { run(...args: unknown[]): void } } })
    .database.prepare("UPDATE knowledge_bases SET engine_state = ? WHERE id = ?")
    .run(JSON.stringify(engineState), kb.id);
  return kb.id;
}

test("living review is OFF by default (env/setting unset) and honors both switches", (context) => {
  const root = tempRoot("ke-living-switch");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const previous = process.env.SCIENCE_AGENT_KE_LIVING_REVIEW;
  delete process.env.SCIENCE_AGENT_KE_LIVING_REVIEW;
  try {
    assert.equal(resolveLivingReviewEnabled(store), false);
    store.setSetting("ke_living_review_enabled", "on");
    assert.equal(resolveLivingReviewEnabled(store), true);
    process.env.SCIENCE_AGENT_KE_LIVING_REVIEW = "off";
    assert.equal(resolveLivingReviewEnabled(store), false); // env wins over the setting
    process.env.SCIENCE_AGENT_KE_LIVING_REVIEW = "on";
    assert.equal(resolveLivingReviewEnabled(store), true);
  } finally {
    if (previous === undefined) delete process.env.SCIENCE_AGENT_KE_LIVING_REVIEW;
    else process.env.SCIENCE_AGENT_KE_LIVING_REVIEW = previous;
  }
});

test("tick: a drifted converged KB is auto-reopened with its last query and the top-up budget", async (context) => {
  const root = tempRoot("ke-living-reopen");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kbId = convergedKb(store, 30);
  // Novelty above the floor: 20 new entities over 30 days > 0.5/day.
  for (let index = 0; index < 20; index += 1) {
    store.upsertEntity({ kbId, name: `entity-${index}`, type: "protein" });
  }
  const { calls, orchestrator } = orchestratorSpy();
  const runner = new KeLivingReviewRunner({ store, orchestrator, enabled: () => true });

  const result = await runner.tick();
  assert.deepEqual(result, { checked: 1, reopened: [kbId] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.query, "ebola glycoprotein");
  assert.equal(calls[0]?.budget?.maxPapers, 15);
  assert.equal(calls[0]?.budget?.maxDepth, 1);
});

test("tick: stable / not-converged / disabled cases never start a cycle", async (context) => {
  const root = tempRoot("ke-living-stable");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  // Converged but no drift.
  convergedKb(store, 30);
  // Not converged at all.
  store.createKnowledgeBase({ name: "Fresh" });
  const { calls, orchestrator } = orchestratorSpy();
  const enabledRunner = new KeLivingReviewRunner({ store, orchestrator, enabled: () => true });
  const stable = await enabledRunner.tick();
  assert.deepEqual(stable, { checked: 1, reopened: [] });
  // Disabled: nothing is even checked.
  const disabledRunner = new KeLivingReviewRunner({ store, orchestrator, enabled: () => false });
  assert.deepEqual(await disabledRunner.tick(), { checked: 0, reopened: [] });
  assert.equal(calls.length, 0);
});

test("tick: an already-active cycle (reused) is tolerated, not double-started", async (context) => {
  const root = tempRoot("ke-living-reused");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kbId = convergedKb(store, 30);
  for (let index = 0; index < 20; index += 1) {
    store.upsertEntity({ kbId, name: `entity-${index}`, type: "protein" });
  }
  const { calls, orchestrator } = orchestratorSpy(true);
  const runner = new KeLivingReviewRunner({ store, orchestrator, enabled: () => true });
  const result = await runner.tick();
  // startGrow was consulted (dedup is the guard) but nothing counts as reopened.
  assert.equal(calls.length, 1);
  assert.deepEqual(result, { checked: 1, reopened: [] });
});

test("tick: a just-fired top-up cannot re-trigger on the next tick (cooldown)", async (context) => {
  const root = tempRoot("ke-living-cooldown");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kbId = convergedKb(store, 30);
  for (let index = 0; index < 20; index += 1) {
    store.upsertEntity({ kbId, name: `entity-${index}`, type: "protein" });
  }
  const { calls, orchestrator } = orchestratorSpy();
  const runner = new KeLivingReviewRunner({ store, orchestrator, enabled: () => true });

  // First tick fires and watermarks; the second tick (same conditions —
  // convergedAt unchanged, entities still novel) is silenced by the cooldown.
  assert.deepEqual(await runner.tick(), { checked: 1, reopened: [kbId] });
  assert.deepEqual(await runner.tick(), { checked: 1, reopened: [] });
  assert.equal(calls.length, 1);

  // An aged watermark lets the monitor fire again.
  store.setSetting(`living_review_reopened_at:${kbId}`, new Date(Date.now() - 25 * 3_600_000).toISOString());
  assert.deepEqual(await runner.tick(), { checked: 1, reopened: [kbId] });
  assert.equal(calls.length, 2);
});
