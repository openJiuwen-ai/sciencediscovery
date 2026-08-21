// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextContributorRegistry,
  ContextCollectionError,
  StaticSystemPromptContributor,
  TaskStateContributor,
  loadedSkillIds,
  registerContextContributorFactories,
} from "./contributor.js";

test("contributors are scope-filtered and sections have deterministic render priorities", async () => {
  const registry = new ContextContributorRegistry()
    .register({
      id: "plan",
      scopes: ["main"],
      async contribute(request) {
        assert.equal(request.latestUserInput, "question");
        return { systemSections: [{ content: "plan", id: "plan.current", slot: "task_state" }] };
      },
    })
    .register({
      id: "governance",
      scopes: ["main", "reviewer"],
      async contribute() {
        return { systemSections: [{ content: "rules", id: "governance.rules", order: 5, slot: "governance" }] };
      },
    })
    .freeze();
  const context = await registry.collect({
    contextId: "run-1",
    history: [{ role: "user", content: "question" }],
    scope: "main",
    signal: new AbortController().signal,
    turn: 1,
  });
  assert.deepEqual(context.sections.map((section) => [section.id, section.priority]), [
    ["governance.rules", 205],
    ["plan.current", 400],
  ]);
});

test("duplicate sections fail instead of silently overriding authority", async () => {
  const registry = new ContextContributorRegistry()
    .register({ id: "first", scopes: ["main"], async contribute() {
      return { systemSections: [{ content: "a", id: "plan.current", slot: "task_state" }] };
    } })
    .register({ id: "second", scopes: ["main"], async contribute() {
      return { systemSections: [{ content: "b", id: "plan.current", slot: "task_state" }] };
    } })
    .freeze();
  await assert.rejects(
    registry.collect({ contextId: "run-1", history: [], scope: "main", signal: new AbortController().signal, turn: 1 }),
    /Duplicate context section: plan\.current/u,
  );
});

test("optional contributor failure is traced while required failure is terminal", async () => {
  const optional = new ContextContributorRegistry()
    .register({ id: "memory", required: false, scopes: ["main"], async contribute() { throw new Error("offline"); } })
    .freeze();
  const context = await optional.collect({
    contextId: "run-1", history: [], scope: "main", signal: new AbortController().signal, turn: 1,
  });
  assert.equal(context.diagnostics[0]?.code, "CONTRIBUTOR_FAILED");

  const required = new ContextContributorRegistry()
    .register({ id: "contract", scopes: ["main"], async contribute() { throw new Error("missing"); } })
    .freeze();
  await assert.rejects(async () => {
    try {
      await required.collect({ contextId: "run-1", history: [], scope: "main", signal: new AbortController().signal, turn: 1 });
    } catch (error) {
      assert(error instanceof ContextCollectionError);
      assert.equal(error.report.contributors[0]?.status, "failed");
      assert.equal(error.report.contributors[0]?.error, "missing");
      throw error;
    }
  }, /missing/u);
});

test("detailed collection records raw output and contributor duration", async () => {
  const registry = new ContextContributorRegistry()
    .register({ id: "package.memory", scopes: ["main"], async contribute() {
      return { attachments: [{ content: "graph facts", id: "memory.snapshot", source: "memory", trust: "trusted_data" }] };
    } })
    .freeze();
  const report = await registry.collectDetailed({
    contextId: "run-1", history: [], scope: "main", signal: new AbortController().signal, turn: 1,
  });
  assert.equal(report.contributors[0]?.contributorId, "package.memory");
  assert.equal(report.contributors[0]?.status, "contributed");
  assert.ok((report.contributors[0]?.durationMs ?? -1) >= 0);
  assert.equal(report.contributors[0]?.contribution?.attachments?.[0]?.content, "graph facts");
  assert.equal(report.collected.attachments[0]?.content, "graph facts");
});

test("capability packages register factories against a run scope before freeze", async () => {
  const seen: Array<{ contextId: string; scope: string }> = [];
  const registry = registerContextContributorFactories(new ContextContributorRegistry(), [{
    id: "memory.context",
    create(request) {
      seen.push(request);
      return {
        id: "memory.snapshot",
        scopes: [request.scope],
        async contribute() {
          return { systemSections: [{ content: "memory", id: "memory.snapshot", slot: "working_context" }] };
        },
      };
    },
  }], { contextId: "session-1", scope: "subagent" }).freeze();
  const output = await registry.collect({
    contextId: "session-1", history: [], scope: "subagent", signal: new AbortController().signal, turn: 1,
  });
  assert.deepEqual(seen, [{ contextId: "session-1", scope: "subagent" }]);
  assert.equal(output.sections[0]?.content, "memory");
  assert.throws(() => registry.register(new StaticSystemPromptContributor("late")), /frozen/u);
});

test("static contributor preserves the legacy prompt as one protected section", async () => {
  const registry = new ContextContributorRegistry()
    .register(new StaticSystemPromptContributor("exact legacy prompt"))
    .freeze();
  const context = await registry.collect({
    contextId: "run-1", history: [], scope: "subagent", signal: new AbortController().signal, turn: 1,
  });
  assert.deepEqual(context.sections.map(({ content, id, protected: isProtected }) => ({ content, id, protected: isProtected })), [{
    content: "exact legacy prompt",
    id: "legacy.system-prompt",
    protected: true,
  }]);
});

test("task state reflects only committed plan and skill tool results", async () => {
  const history = [
    { role: "tool", name: "read_skill", content: "Selected skill literature-review@1.0.0 (revision 1)" },
    { role: "tool", name: "propose_plan", content: "{\"steps\":[\"search\"]}" },
  ];
  assert.deepEqual([...loadedSkillIds(history)], ["literature-review"]);
  const registry = new ContextContributorRegistry()
    .register(new TaskStateContributor())
    .freeze();
  const output = await registry.collect({
    contextId: "run-1", history, scope: "main", signal: new AbortController().signal, turn: 2,
  });
  assert.match(output.sections[0]?.content ?? "", /Loaded skills: literature-review/u);
  assert.match(output.sections[0]?.content ?? "", /Latest committed plan tool result/u);
});
