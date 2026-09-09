// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { ContextContributor } from "@sciencediscovery/context";
import { ToolRegistry } from "@sciencediscovery/tools";

import {
  createPlanBatchPolicy,
  createPlanContextFactory,
  createPlanTool,
  observePlanProgress,
  type PlanStore,
} from "./index.js";

test("update_plan replaces the complete snapshot", async () => {
  let latest: Awaited<ReturnType<PlanStore["latest"]>>;
  const store: PlanStore = {
    async latest() { return latest; },
    async update(input, toolCallId) {
      latest = {
        agentId: "main",
        ...(input.explanation ? { explanation: input.explanation } : {}),
        items: input.plan,
        toolCallId,
        turn: 2,
        updatedAt: "now",
      };
      return structuredClone(latest);
    },
  };
  const result = await createPlanTool({ store }).execute("call-1", {
    explanation: "add validation",
    plan: [
      { status: "completed", step: "search" },
      { status: "in_progress", step: "validate" },
    ],
  }, new AbortController().signal);
  assert.deepEqual(result.details, latest);
  assert.deepEqual(latest?.items, [
    { status: "completed", step: "search" },
    { status: "in_progress", step: "validate" },
  ]);
});

test("plan batch policy keeps only the final model-declared update", () => {
  assert.deepEqual(createPlanBatchPolicy().decide([
    { args: {}, id: "first", name: "update_plan" },
    { args: {}, id: "search", name: "web_search" },
    { args: {}, id: "last", name: "update_plan" },
  ]), [{ byCallId: "last", callId: "first", kind: "supersede" }]);
});

test("same-step plan writes commit last-declared while ordinary tools still run", async () => {
  const committed: string[][] = [];
  const ordinaryCalls: string[] = [];
  const store: PlanStore = {
    async latest() { return undefined; },
    async update(input, toolCallId) {
      committed.push(input.plan.map((item) => item.step));
      return { agentId: "main", items: input.plan, toolCallId, turn: 1, updatedAt: "now" };
    },
  };
  const registry = new ToolRegistry([
    createPlanTool({ store }),
    {
      description: "ordinary", label: "ordinary", name: "ordinary", parameters: Type.Object({}),
      async execute(id) {
        ordinaryCalls.push(id);
        return { content: [{ text: "done", type: "text" as const }], details: {} };
      },
    },
  ], {
    batchPolicies: [createPlanBatchPolicy()],
    createResultMessage: (call, content) => ({ content, name: call.name, role: "tool" }),
  });
  const calls = [
    { args: { plan: [{ status: "pending", step: "old" }] }, id: "old", name: "update_plan" },
    { args: {}, id: "work", name: "ordinary" },
    { args: { plan: [{ status: "in_progress", step: "new" }] }, id: "new", name: "update_plan" },
  ];
  const batch = registry.prepareBatch(calls);
  const signal = new AbortController().signal;
  const results = await Promise.all(calls.map((call) => batch.execute(call, signal)));
  assert.deepEqual(committed, [["new"]]);
  assert.deepEqual(ordinaryCalls, ["work"]);
  assert.equal(results[0]?.isError, false);
  assert.equal(results[2]?.isError, false);
});

test("plan progress observation counts only work after the declaring model step", () => {
  const snapshot = {
    agentId: "main",
    items: [{ status: "in_progress" as const, step: "Analyze evidence" }],
    toolCallId: "plan-1",
    turn: 1,
    updatedAt: "2026-09-09T00:00:00.000Z",
  };
  const observation = observePlanProgress(snapshot, [
    { role: "assistant", tool_calls: [{ id: "plan-1", function: { name: "update_plan" } }] },
    { role: "tool", name: "update_plan", tool_call_id: "plan-1" },
    { role: "assistant", tool_calls: [{ id: "search-1", function: { name: "web_search" } }] },
    { role: "tool", name: "web_search", tool_call_id: "search-1" },
    { role: "assistant", content: "Interim reasoning" },
  ], 3);
  assert.deepEqual(observation, {
    agentId: "main",
    anchorFound: true,
    currentModelTurn: 3,
    modelStepsSinceUpdate: 2,
    toolCallId: "plan-1",
    toolResultsSinceUpdate: 1,
    updatedAt: "2026-09-09T00:00:00.000Z",
  });
});

test("plan context traces an unobservable history anchor without guessing staleness", async () => {
  const store: PlanStore = {
    async latest() {
      return {
        agentId: "subagent:1",
        items: [{ status: "in_progress", step: "Read papers" }],
        toolCallId: "compacted-away",
        turn: 4,
        updatedAt: "2026-09-09T00:00:00.000Z",
      };
    },
    async update() { throw new Error("not used"); },
  };
  const contributor = createPlanContextFactory(store, ["subagent"]).create({
    contextId: "run-1",
    scope: "subagent",
  }) as ContextContributor;
  const contribution = await contributor.contribute({
    contextId: "run-1",
    history: [{ role: "user", content: "continue" }],
    latestUserInput: "continue",
    scope: "subagent",
    signal: new AbortController().signal,
    turn: 8,
  });
  assert.match(contribution.systemSections?.[0]?.content ?? "", /Before a substantive tool call/u);
  assert.deepEqual(contribution.diagnostics?.[0]?.details, {
    agentId: "subagent:1",
    anchorFound: false,
    currentModelTurn: 8,
    toolCallId: "compacted-away",
    updatedAt: "2026-09-09T00:00:00.000Z",
  });
});
