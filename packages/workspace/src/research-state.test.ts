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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("project ledger: promote merges durable findings; hydrate fills a fresh session", async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "research-project-"));
  const sessionA = await mkdtemp(join(tmpdir(), "research-session-a-"));
  const sessionB = await mkdtemp(join(tmpdir(), "research-session-b-"));
  context.after(() => Promise.all([projectRoot, sessionA, sessionB].map((root) => rm(root, { force: true, recursive: true }))).then(() => undefined));
  const port = createResearchStatePort(() => new Date(2026, 1, 1));

  // Session A builds a world model.
  await port.setGoal({ workspaceRoot: sessionA, goal: "Map EBOV nucleocapsid assembly" });
  await port.addPlanItems({ workspaceRoot: sessionA, items: ["Seed corpus", "Extract helical parameters"] });
  await port.updatePlanItem({ workspaceRoot: sessionA, ref: "p1", status: "done", note: "5 papers" });
  await port.addQuestion({ workspaceRoot: sessionA, text: "What is the in-cell twist?" });
  await port.resolveQuestion({ workspaceRoot: sessionA, ref: "q1", status: "answered", answer: "-30.35 degrees", evidence: "cc2dd513:figure:1" });
  await port.addRuledOut({ workspaceRoot: sessionA, what: "Treat VP24 as passive scaffold", why: "contradicted by two-phase model", source: "04d3a509" });
  const promote = await port.promote({ projectRoot, workspaceRoot: sessionA });
  assert.deepEqual(promote.promoted, { goal: true, planItems: 1, questions: 1, ruledOut: 1 }, "done plan item + answered question + ruled-out promoted; pending plan item stays local");

  // Promoting again is a no-op (dedup by text).
  const again = await port.promote({ projectRoot, workspaceRoot: sessionA });
  assert.deepEqual(again.promoted, { goal: false, planItems: 0, questions: 0, ruledOut: 0 });

  // A fresh session hydrates on first read: goal + question + ruled-out arrive.
  const hydrate = await port.hydrate({ projectRoot, workspaceRoot: sessionB });
  assert.equal(hydrate.had, true);
  assert.deepEqual(hydrate.hydrated, { goal: true, planItems: 1, questions: 1, ruledOut: 1 });
  const summaryB = await port.summary({ workspaceRoot: sessionB });
  assert.equal(summaryB.goal, "Map EBOV nucleocapsid assembly");
  assert.equal(summaryB.openQuestions.answered, 1);
  assert.equal(summaryB.ruledOut.total, 1);
  const full = await port.get({ workspaceRoot: sessionB });
  const q = full.state.openQuestions.find((question) => question.text === "What is the in-cell twist?");
  assert.equal(q?.evidence, "cc2dd513:figure:1", "the uncertainty-ledger evidence pointer survives the round trip");

  // projectSummary exposes the ledger digest.
  const ledgerView = await port.projectSummary({ projectRoot });
  assert.equal(ledgerView.had, true);
  assert.equal(ledgerView.goal, "Map EBOV nucleocapsid assembly");

  // An empty project hydrates nothing and writes nothing.
  const emptyProject = await mkdtemp(join(tmpdir(), "research-project-empty-"));
  context.after(() => rm(emptyProject, { force: true, recursive: true }));
  const sessionC = await mkdtemp(join(tmpdir(), "research-session-c-"));
  context.after(() => rm(sessionC, { force: true, recursive: true }));
  const none = await port.hydrate({ projectRoot: emptyProject, workspaceRoot: sessionC });
  assert.equal(none.had, false);
  const stateC = await port.get({ workspaceRoot: sessionC });
  assert.equal(stateC.state.plan.length, 0, "no-op hydrate must not create state");
});

test("project ledger: hydrate never overwrites the session's own goal or entries", async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "research-project2-"));
  const sessionA = await mkdtemp(join(tmpdir(), "research-session-a2-"));
  const sessionB = await mkdtemp(join(tmpdir(), "research-session-b2-"));
  context.after(() => Promise.all([projectRoot, sessionA, sessionB].map((root) => rm(root, { force: true, recursive: true }))).then(() => undefined));
  const port = createResearchStatePort(() => new Date(2026, 1, 2));

  await port.setGoal({ workspaceRoot: sessionA, goal: "Project goal from A" });
  await port.addRuledOut({ workspaceRoot: sessionA, what: "Direction X", why: "failed twice" });
  await port.promote({ projectRoot, workspaceRoot: sessionA });

  // Session B already has its own goal and the same ruled-out text recorded.
  await port.setGoal({ workspaceRoot: sessionB, goal: "B's own goal" });
  await port.addRuledOut({ workspaceRoot: sessionB, what: "Direction X", why: "B's independent reason" });
  const hydrate = await port.hydrate({ projectRoot, workspaceRoot: sessionB });
  assert.equal(hydrate.hydrated.goal, false, "the session's own goal is never overwritten");
  assert.equal(hydrate.hydrated.ruledOut, 0, "same-what entries do not duplicate");
  const summaryB = await port.summary({ workspaceRoot: sessionB });
  assert.equal(summaryB.goal, "B's own goal");
});

test("project ledger: the newer goal wins, and dropped questions close ledger entries instead of resurrecting", async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "research-project3-"));
  const sessionA = await mkdtemp(join(tmpdir(), "research-session-a3-"));
  const sessionB = await mkdtemp(join(tmpdir(), "research-session-b3-"));
  context.after(() => Promise.all([projectRoot, sessionA, sessionB].map((root) => rm(root, { force: true, recursive: true }))).then(() => undefined));

  // A sets goal v1 at an earlier time and promotes; B refines to v2 later.
  const portA = createResearchStatePort(() => new Date(2026, 2, 1, 10));
  await portA.setGoal({ workspaceRoot: sessionA, goal: "v1: broad survey" });
  await portA.promote({ projectRoot, workspaceRoot: sessionA });
  const portB = createResearchStatePort(() => new Date(2026, 2, 1, 12));
  await portB.setGoal({ workspaceRoot: sessionB, goal: "v2: focus on helical params" });
  await portB.promote({ projectRoot, workspaceRoot: sessionB });
  // A (still holding v1, older goalSetAt) promotes again — must not roll back.
  await portA.promote({ projectRoot, workspaceRoot: sessionA });
  const ledgerView = await portA.projectSummary({ projectRoot });
  assert.equal(ledgerView.goal, "v2: focus on helical params", "an older session must not roll the project goal back");

  // Dropped questions close the ledger's open entry and never get pushed fresh.
  await portA.addQuestion({ workspaceRoot: sessionA, text: "Is VP24 passive?" });
  await portA.promote({ projectRoot, workspaceRoot: sessionA });
  await portA.resolveQuestion({ workspaceRoot: sessionA, ref: "Is VP24 passive?", status: "dropped" });
  const dropped = await portA.promote({ projectRoot, workspaceRoot: sessionA });
  assert.equal(dropped.promoted.questions, 1, "the drop closes the open ledger entry");
  await portA.addQuestion({ workspaceRoot: sessionA, text: "Noise question" });
  await portA.resolveQuestion({ workspaceRoot: sessionA, ref: "Noise question", status: "dropped" });
  const noise = await portA.promote({ projectRoot, workspaceRoot: sessionA });
  assert.equal(noise.promoted.questions, 0, "a question dropped before ever being promoted is not pushed");
  const full = await portA.projectSummary({ projectRoot });
  assert.equal(full.openQuestions.open, 0);
});

test("project ledger: concurrent promotes serialize — no merge is lost", async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "research-project4-"));
  context.after(() => rm(projectRoot, { force: true, recursive: true }));
  const port = createResearchStatePort(() => new Date(2026, 2, 2));
  const sessions: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const session = await mkdtemp(join(tmpdir(), `research-session-c${i}-`));
    context.after(() => rm(session, { force: true, recursive: true }));
    sessions.push(session);
    await port.addRuledOut({ workspaceRoot: session, what: `Direction ${i}`, why: `reason ${i}` });
  }
  // Five concurrent promotes from five sessions of the same project.
  const results = await Promise.all(sessions.map((workspaceRoot) => port.promote({ projectRoot, workspaceRoot })));
  assert.equal(results.filter((result) => result.promoted.ruledOut === 1).length, 5);
  const view = await port.projectSummary({ projectRoot });
  assert.equal(view.ruledOut.total, 5, "every concurrent merge landed exactly once");
});
