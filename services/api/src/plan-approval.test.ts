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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SessionStore, SessionStoreHttpError } from "./store.js";

async function setup(context: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "sd-plan-approval-"));
  context.after(() => rm(dir, { force: true, recursive: true }));
  const store = new SessionStore(dir);
  store.setAvailableSkillIds([]);
  await store.load();
  const project = await store.createProject("Plan approval project");
  const session = await store.createSession(project.id, "Plan approval session", {}, {}, { allowUnconfiguredModel: true });
  return { session, store };
}

const PLAN = {
  feasibilityConfidence: "medium" as const,
  scope: "调研 IL-6 抑制剂耐药机制",
  steps: ["检索近五年综述", "抽取耐药相关通路", "综合对比表"],
};

test("approval-gated propose parks the plan; approve resumes it with a version-bound decision", async (context) => {
  const { session, store } = await setup(context);
  const plan = await store.proposeSessionPlan(session.id, PLAN, "run-1", { awaitingUser: true });
  assert.equal(plan.state, "awaiting_user");

  const outcome = await store.decideSessionPlanApproval(session.id, plan.id, { decision: "approve" });
  assert.equal(outcome.plan.state, "recorded");
  assert.equal(outcome.decision.actor, "user");
  assert.equal(outcome.decision.decision, "approved");
  assert.equal(outcome.decision.planVersion, 1, "the decision binds the exact version it approved");
  assert.equal(outcome.decision.runId, "run-1");
  assert.equal(store.listPlanApprovalDecisions(session.id).length, 1);
});

test("reject abandons the plan with the reason preserved; a second decision is a 409", async (context) => {
  const { session, store } = await setup(context);
  const plan = await store.proposeSessionPlan(session.id, PLAN, undefined, { awaitingUser: true });
  const outcome = await store.decideSessionPlanApproval(session.id, plan.id, { decision: "reject", reason: "范围太大" });
  assert.equal(outcome.plan.state, "abandoned");
  assert.equal(outcome.plan.abandonmentReason, "范围太大");
  assert.equal(outcome.decision.decision, "rejected");
  assert.equal(outcome.decision.reason, "范围太大");
  await assert.rejects(
    store.decideSessionPlanApproval(session.id, plan.id, { decision: "approve" }),
    (error: unknown) => error instanceof SessionStoreHttpError && error.statusCode === 409,
  );
});

test("agent revision of an approved plan re-enters review (vN approval never covers vN+1)", async (context) => {
  const { session, store } = await setup(context);
  const plan = await store.proposeSessionPlan(session.id, PLAN, "run-1", { awaitingUser: true });
  await store.decideSessionPlanApproval(session.id, plan.id, { decision: "approve" });

  // Agent path: markAwaitingUser re-parks the plan.
  const revised = await store.reviseSessionPlan(session.id, plan.id, {
    ...PLAN,
    expectedVersion: 1,
    steps: ["缩小范围：只查 NSCLC 适应症"],
  }, { markAwaitingUser: true });
  assert.equal(revised.state, "awaiting_user");
  assert.equal(revised.version, 2);

  // User path (REST edit): stays in whatever state it was — the user IS the reviewer.
  const userEdited = await store.reviseSessionPlan(session.id, plan.id, {
    ...PLAN,
    expectedVersion: 2,
    steps: ["用户亲手改过的步骤"],
  });
  assert.equal(userEdited.state, "awaiting_user");

  const outcome = await store.decideSessionPlanApproval(session.id, plan.id, { decision: "approve" });
  assert.equal(outcome.decision.planVersion, 3, "the second approval binds the edited version");
  assert.equal(store.listPlanApprovalDecisions(session.id, plan.id).length, 2);
});

test("always_allow auto-approval is logged with actor auto and the session's mode", async (context) => {
  const { session, store } = await setup(context);
  await store.setApprovalMode(session.id, "always_allow");
  const plan = await store.proposeSessionPlan(session.id, PLAN, "run-1");
  assert.equal(plan.state, "recorded");
  const decision = await store.recordAutoPlanApproval(plan);
  assert.equal(decision.actor, "auto");
  assert.equal(decision.approvalMode, "always_allow");
  assert.equal(decision.decision, "approved");
  assert.equal(store.listPlanApprovalDecisions(session.id).length, 1);
});

test("awaiting_user state survives a store reload (no silent auto-approval on restart)", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "sd-plan-approval-reload-"));
  context.after(() => rm(dir, { force: true, recursive: true }));
  const store = new SessionStore(dir);
  store.setAvailableSkillIds([]);
  await store.load();
  const project = await store.createProject("Reload project");
  const session = await store.createSession(project.id, "Reload session", {}, {}, { allowUnconfiguredModel: true });
  await store.proposeSessionPlan(session.id, PLAN, undefined, { awaitingUser: true });

  const reloaded = new SessionStore(dir);
  reloaded.setAvailableSkillIds([]);
  await reloaded.load();
  const plan = reloaded.latestSessionPlan(session.id);
  assert.equal(plan?.state, "awaiting_user", "a pending decision must still be pending after restart");
});

test("decision validation: bad decision value and unknown plan", async (context) => {
  const { session, store } = await setup(context);
  const plan = await store.proposeSessionPlan(session.id, PLAN, undefined, { awaitingUser: true });
  await assert.rejects(
    store.decideSessionPlanApproval(session.id, plan.id, { decision: "maybe" as "approve" }),
    (error: unknown) => error instanceof SessionStoreHttpError && error.statusCode === 400,
  );
  await assert.rejects(
    store.decideSessionPlanApproval(session.id, "no-such-plan", { decision: "approve" }),
    (error: unknown) => error instanceof SessionStoreHttpError && error.statusCode === 404,
  );
});

test("expectedVersion binds the decision: stale clicks fail 409", async (context) => {
  const { session, store } = await setup(context);
  const plan = await store.proposeSessionPlan(session.id, PLAN, "run-1", { awaitingUser: true });
  // User edits (v1 → v2), then clicks the stale "Approve v1" button.
  await store.reviseSessionPlan(session.id, plan.id, { ...PLAN, expectedVersion: 1, steps: ["改过的步骤"] });
  await assert.rejects(
    store.decideSessionPlanApproval(session.id, plan.id, { decision: "approve", expectedVersion: 1 }),
    (error: unknown) => error instanceof SessionStoreHttpError && error.statusCode === 409,
  );
  const outcome = await store.decideSessionPlanApproval(session.id, plan.id, { decision: "approve", expectedVersion: 2 });
  assert.equal(outcome.decision.planVersion, 2);
});

test("an awaiting_user plan can be abandoned (run-interrupt sweep path)", async (context) => {
  const { session, store } = await setup(context);
  const plan = await store.proposeSessionPlan(session.id, PLAN, "run-1", { awaitingUser: true });
  const abandoned = await store.abandonSessionPlan(session.id, {
    expectedVersion: 1,
    planId: plan.id,
    reason: "Run interrupted before the plan decision",
  });
  assert.equal(abandoned.state, "abandoned");
  assert.match(abandoned.abandonmentReason ?? "", /interrupted/);
});
