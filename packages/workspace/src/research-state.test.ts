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

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createResearchStatePort,
  RESEARCH_STATE_MAX_RULED_OUT,
  RESEARCH_STATE_MAX_TRIED_ACTIONS,
  researchStatePath,
} from "./research-state.js";

test("research state: goal + plan lifecycle round-trip", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "research-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  let tick = 0;
  const port = createResearchStatePort(() => new Date(2026, 0, 1 + tick++));

  const goal = await port.setGoal({ workspaceRoot: root, goal: "Map Ebola GP neutralization breadth" });
  assert.equal(goal.updated, false);
  assert.deepEqual(goal.truncated, []);
  const reGoal = await port.setGoal({ workspaceRoot: root, goal: "Map Ebola GP + MPER breadth" });
  assert.equal(reGoal.updated, true);

  const added = await port.addPlanItems({ workspaceRoot: root, items: ["Seed GP corpus", " Grow spike ", ""] });
  assert.deepEqual(added.added, ["p1", "p2"]);
  assert.equal(added.total, 2);

  // Ref by exact id and by unique substring both work.
  const updated = await port.updatePlanItem({ workspaceRoot: root, ref: "p1", status: "in_progress" });
  assert.equal(updated.itemId, "p1");
  const done = await port.updatePlanItem({ workspaceRoot: root, ref: "Grow spike", status: "done", note: "10 papers ingested" });
  assert.equal(done.itemId, "p2");

  const summary = await port.summary({ workspaceRoot: root });
  assert.equal(summary.goal, "Map Ebola GP + MPER breadth");
  assert.deepEqual(summary.plan, { total: 2, pending: 0, inProgress: 1, done: 1, dropped: 0 });
  assert.deepEqual(summary.currentItems, [{ id: "p1", text: "Seed GP corpus" }]);
  assert.equal(summary.corrupt, false);
});

test("research state: questions + ruled-out lifecycle", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "research-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const port = createResearchStatePort(() => new Date(2026, 0, 2));

  const question = await port.addQuestion({ workspaceRoot: root, text: "Does mAb114 bind the GP stalk or head?" });
  assert.equal(question.questionId, "q1");
  const answered = await port.resolveQuestion({ workspaceRoot: root, ref: "mAb114", status: "answered", answer: "Head — DCP-all epitope" });
  assert.equal(answered.questionId, "q1");

  await port.addQuestion({ workspaceRoot: root, text: "Speculative dead end?" });
  const dropped = await port.resolveQuestion({ workspaceRoot: root, ref: "q2", status: "dropped" });
  assert.equal(dropped.status, "dropped");

  await assert.rejects(
    () => port.resolveQuestion({ workspaceRoot: root, ref: "nope-no-such-question", status: "answered", answer: "x" }),
    /matched nothing/,
  );

  const ruled = await port.addRuledOut({ workspaceRoot: root, what: "Crowdsourced docking route", why: "No receptor structure", source: "doc9" });
  assert.equal(ruled.ruledOutId, "r1");
  assert.equal(ruled.evicted, 0);

  const summary = await port.summary({ workspaceRoot: root });
  assert.deepEqual(summary.openQuestions, { total: 2, open: 0, answered: 1, dropped: 1 });
  assert.equal(summary.ruledOut.total, 1);
  assert.equal(summary.ruledOut.recent[0]!.what, "Crowdsourced docking route");
});

test("research state: tried-action dedup index", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "research-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const port = createResearchStatePort(() => new Date(2026, 0, 3));

  const first = await port.markTried({ workspaceRoot: root, action: "kb_search 'IC50 mAb114'", tool: "kb_search", result: "3 hits" });
  assert.equal(first.alreadyTried, false);
  // Normalization: case/whitespace-insensitive dedup.
  const second = await port.markTried({ workspaceRoot: root, action: "  KB_SEARCH   'ic50 mab114' " });
  assert.equal(second.alreadyTried, true);
  assert.equal(second.count, 2);
  assert.equal(second.previousResult, "3 hits");
  assert.equal(second.previousTool, "kb_search");

  // A re-try supplying a NEW result still reports the FIRST try's outcome.
  const third = await port.markTried({ workspaceRoot: root, action: "kb_search 'IC50 mAb114'", result: "now 5 hits" });
  assert.equal(third.previousResult, "3 hits");
  // …but the stored record carries the latest result.
  const checked = await port.checkTried({ workspaceRoot: root, action: "kb_search 'IC50 mAb114'" });
  assert.deepEqual(checked, { tried: true, count: 3, previousResult: "now 5 hits" });

  const unchecked = await port.checkTried({ workspaceRoot: root, action: "kb_search 'epitope'" });
  assert.deepEqual(unchecked, { tried: false, count: 0 });

  const summary = await port.summary({ workspaceRoot: root });
  assert.deepEqual(summary.triedActions, { total: 1, repeated: 1 });
});

test("research state: malformed elements are sanitized on read, flagged corrupt", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "research-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const port = createResearchStatePort(() => new Date(2026, 0, 4));

  const path = researchStatePath(root);
  await mkdir(join(root, ".research"), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      plan: [null, { id: "p1", text: "valid", status: "pending", createdAt: "x", updatedAt: "x" }, { broken: true }],
      openQuestions: [],
      ruledOut: [],
      triedActions: [],
      lastUpdated: "x",
    }),
    "utf8",
  );

  // Sanitized reads must not crash subsequent ops.
  const summary = await port.summary({ workspaceRoot: root });
  assert.equal(summary.corrupt, true);
  assert.equal(summary.plan.total, 1);
  const added = await port.addPlanItems({ workspaceRoot: root, items: ["next step"] });
  assert.deepEqual(added.added, ["p2"]);
});

test("research state: empty ref is rejected instead of matching everything", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "research-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const port = createResearchStatePort(() => new Date(2026, 0, 4));

  await port.addPlanItems({ workspaceRoot: root, items: ["only item"] });
  await assert.rejects(
    () => port.updatePlanItem({ workspaceRoot: root, ref: "  ", status: "done" }),
    /non-empty/,
  );
});

test("research state: corrupt file degrades to empty state (fail-soft)", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "research-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const port = createResearchStatePort(() => new Date(2026, 0, 4));

  const path = researchStatePath(root);
  await mkdir(join(root, ".research"), { recursive: true });
  await writeFile(path, "{not json", "utf8");

  const summary = await port.summary({ workspaceRoot: root });
  assert.equal(summary.corrupt, true);
  assert.equal(summary.plan.total, 0);

  // Writes still work on top of the corrupt file.
  await port.setGoal({ workspaceRoot: root, goal: "recover" });
  const after = await port.summary({ workspaceRoot: root });
  assert.equal(after.goal, "recover");
  assert.equal(after.corrupt, false);
});

test("research state: caps evict oldest instead of dead-ending", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "research-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  let tick = 0;
  const port = createResearchStatePort(() => new Date(2026, 0, 5 + tick++));

  for (let i = 0; i < RESEARCH_STATE_MAX_RULED_OUT + 3; i += 1) {
    await port.addRuledOut({ workspaceRoot: root, what: `direction ${i}`, why: "no" });
  }
  const summary = await port.summary({ workspaceRoot: root });
  assert.equal(summary.ruledOut.total, RESEARCH_STATE_MAX_RULED_OUT);
  // Oldest (direction 0..2) evicted; direction 3 is now the oldest surviving.
  assert.equal(summary.ruledOut.recent[0]!.what, `direction ${3 + RESEARCH_STATE_MAX_RULED_OUT - 10}`);

  for (let i = 0; i < RESEARCH_STATE_MAX_TRIED_ACTIONS + 2; i += 1) {
    await port.markTried({ workspaceRoot: root, action: `action ${i}` });
  }
  const after = await port.summary({ workspaceRoot: root });
  assert.equal(after.triedActions.total, RESEARCH_STATE_MAX_TRIED_ACTIONS);
  // LRU, not FIFO: re-marking an early action bumps its lastTriedAt, so the
  // NEXT overflow must evict the true oldest (action 2), not action 5.
  await port.markTried({ workspaceRoot: root, action: "action 5" });
  await port.markTried({ workspaceRoot: root, action: "action overflow" });
  assert.equal((await port.checkTried({ workspaceRoot: root, action: "action 5" })).tried, true);
  assert.equal((await port.checkTried({ workspaceRoot: root, action: "action 2" })).tried, false);
});

test("research state: active-only plan cap releases done/dropped slots", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "research-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const port = createResearchStatePort(() => new Date(2026, 0, 6));

  await port.addPlanItems({ workspaceRoot: root, items: ["a", "b"] });
  await port.updatePlanItem({ workspaceRoot: root, ref: "p1", status: "done" });
  // p2 stays active; adding up to the 50-active cap must not count p1.
  const added = await port.addPlanItems({ workspaceRoot: root, items: Array.from({ length: 49 }, (_, i) => `step ${i}`) });
  assert.equal(added.total, 51);
  await assert.rejects(
    () => port.addPlanItems({ workspaceRoot: root, items: ["one too many"] }),
    /exceed the cap/,
  );
});

test("research state: clear removes the file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "research-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const port = createResearchStatePort(() => new Date(2026, 0, 7));

  await port.setGoal({ workspaceRoot: root, goal: "to be cleared" });
  const cleared = await port.clear({ workspaceRoot: root });
  assert.equal(cleared.cleared, true);
  const summary = await port.summary({ workspaceRoot: root });
  assert.equal(summary.goal, undefined);
  // Clearing again is fine.
  await port.clear({ workspaceRoot: root });
});
