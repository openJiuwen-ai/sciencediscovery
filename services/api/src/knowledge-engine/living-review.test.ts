// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * Z7 tests: the convergedAt sticky latch (first convergence timestamp
 * survives later converged cycles; a diverging cycle clears it) and the
 * living-review monitor semantics (grace window, novelty floor, entity-only
 * counting handled by the caller).
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { LIVING_REVIEW_MIN_DAYS, monitorConvergence } from "@sciencediscovery/knowledge-engine";

import { KnowledgeEngineStore } from "./store.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

const DAY = 86_400_000;

test("monitorConvergence: grace window, novelty floor, honest reasons", () => {
  const convergedAt = new Date(Date.now() - 30 * DAY).toISOString();

  // Not converged → no-op.
  assert.deepEqual(
    monitorConvergence({ convergedAt: null, newEntities: 99 }),
    { reopen: false, reason: "not-converged", newEntities: 0, daysSinceConverged: 0 },
  );

  // Inside the grace window → too-recent regardless of novelty.
  const recent = monitorConvergence({
    convergedAt: new Date(Date.now() - 3 * DAY).toISOString(),
    newEntities: 50,
  });
  assert.equal(recent.reason, "too-recent");
  assert.equal(recent.reopen, false);

  // Past the window, novelty rate above the floor (0.5/day) → reopen.
  const hot = monitorConvergence({ convergedAt, newEntities: 30 }); // 30/30 = 1.0/day
  assert.deepEqual(
    { ...hot, newEntities: hot.newEntities, daysSinceConverged: hot.daysSinceConverged },
    { reopen: true, reason: "novelty-recovery", newEntities: 30, daysSinceConverged: hot.daysSinceConverged },
  );
  assert.equal(hot.reopen, true);

  // Below the floor → stable.
  const stable = monitorConvergence({ convergedAt, newEntities: 5 }); // 5/30 ≈ 0.17/day
  assert.equal(stable.reopen, false);
  assert.equal(stable.reason, "stable");
  assert.equal(LIVING_REVIEW_MIN_DAYS, 14);
});

test("store: convergedAt latch keeps the FIRST convergence, resets on divergence", async (context) => {
  const root = tempRoot("ke-latch");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });

  // Diverging cycle → no latch.
  store.updateEngineState(kb.id, { converged: false, cycleId: "c1" });
  let state = store.getKnowledgeBase(kb.id)!.engineState as Record<string, unknown>;
  assert.equal("convergedAt" in state, false);

  // First convergence → stamped.
  store.updateEngineState(kb.id, { converged: true, cycleId: "c2" });
  const first = store.getKnowledgeBase(kb.id)!.engineState as Record<string, unknown>;
  const firstAt = first["convergedAt"] as string;
  assert.equal(typeof firstAt, "string");

  // Later converged cycle → SAME timestamp (sticky).
  await new Promise((r) => setTimeout(r, 5));
  store.updateEngineState(kb.id, { converged: true, cycleId: "c3" });
  const second = store.getKnowledgeBase(kb.id)!.engineState as Record<string, unknown>;
  assert.equal(second["convergedAt"], firstAt);

  // Divergence → latch cleared; re-convergence stamps fresh.
  store.updateEngineState(kb.id, { converged: false, cycleId: "c4" });
  store.updateEngineState(kb.id, { converged: true, cycleId: "c5" });
  const third = store.getKnowledgeBase(kb.id)!.engineState as Record<string, unknown>;
  assert.notEqual(third["convergedAt"], firstAt);

  // countEntitiesCreatedSince backs the novelty rate.
  store.upsertEntity({ kbId: kb.id, name: "late entity", type: "protein" });
  assert.equal(store.countEntitiesCreatedSince(kb.id, new Date(Date.now() + DAY).toISOString()), 0);
  assert.equal(store.countEntitiesCreatedSince(kb.id, new Date(0).toISOString()), 1);
});
