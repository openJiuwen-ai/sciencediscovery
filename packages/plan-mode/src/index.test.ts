// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { ProposePlanRequest, SessionPlan } from "@sciencediscovery/schema";

import { createPlanLifecycleTools, type PlanRepository } from "./index.js";

class MemoryPlans implements PlanRepository {
  plan: SessionPlan | undefined;
  async propose(input: ProposePlanRequest): Promise<SessionPlan> {
    this.plan = {
      caveats: input.caveats ?? [], createdAt: "now", feasibilityConfidence: input.feasibilityConfidence,
      id: "plan-1", mode: "recorded", scope: input.scope, sessionId: "session-1", state: "recorded",
      steps: input.steps.map((description, index) => ({ description, id: `step-${index + 1}`, status: "pending" })),
      updatedAt: "now", version: 1,
    };
    return structuredClone(this.plan);
  }
  async latest(): Promise<SessionPlan | undefined> { return this.plan && structuredClone(this.plan); }
  async revise(): Promise<SessionPlan> { throw new Error("not used"); }
  async updateStep(input: { expectedVersion: number; planId: string; status: "blocked" | "completed" | "in_progress" | "pending"; stepId: string }): Promise<SessionPlan> {
    if (!this.plan || this.plan.version !== input.expectedVersion) throw new Error("version changed");
    this.plan.steps.find((step) => step.id === input.stepId)!.status = input.status;
    this.plan.version += 1;
    if (this.plan.steps.every((step) => step.status === "completed")) this.plan.state = "completed";
    return structuredClone(this.plan);
  }
  async abandon(): Promise<SessionPlan> { throw new Error("not used"); }
}

test("plan lifecycle tools record and complete step state", async () => {
  const repository = new MemoryPlans();
  const tools = createPlanLifecycleTools({ repository });
  const propose = tools.find((tool) => tool.name === "propose_plan")!;
  await propose.execute("1", { caveats: [], feasibilityConfidence: "high", scope: "test", steps: ["one"] }, new AbortController().signal);
  const update = tools.find((tool) => tool.name === "update_plan_step")!;
  await update.execute("2", { expectedVersion: 1, planId: "plan-1", status: "completed", stepId: "step-1" }, new AbortController().signal);
  assert.equal(repository.plan?.state, "completed");
  assert.equal(repository.plan?.version, 2);
});

test("approvalMayBlock rewrites propose/revise descriptions honestly", () => {
  const repository = {
    abandon: async () => { throw new Error("not used"); },
    latest: async () => undefined,
    propose: async () => { throw new Error("not used"); },
    revise: async () => { throw new Error("not used"); },
    updateStep: async () => { throw new Error("not used"); },
  };
  const open = createPlanLifecycleTools({ repository });
  assert.match(open.find((tool) => tool.name === "propose_plan")!.description, /does not require user approval/);

  const gated = createPlanLifecycleTools({ approvalMayBlock: true, repository });
  const propose = gated.find((tool) => tool.name === "propose_plan")!;
  assert.match(propose.description, /user for review/);
  assert.match(propose.description, /BLOCKS/);
  assert.doesNotMatch(propose.description, /does not require user approval/);
  const revise = gated.find((tool) => tool.name === "revise_plan")!;
  assert.match(revise.description, /re-enters user review/);
});
