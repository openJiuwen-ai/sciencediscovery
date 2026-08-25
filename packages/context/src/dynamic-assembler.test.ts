// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import { resolveContextBudget } from "./budget.js";
import { ContextContributorRegistry, StaticSystemPromptContributor } from "./contributor.js";
import { DynamicContextAssembler, type DynamicContextTrace } from "./dynamic-assembler.js";
import { HistoryCompactor } from "./history-compactor.js";
import { resolveContextAssemblyMode } from "./mode.js";

type Message = RuntimeMessage & { content?: string };

function assembler(mode: "dynamic" | "shadow", options: {
  budget?: NodeJS.ProcessEnv;
  registry?: ContextContributorRegistry<Message>;
  trace?(value: DynamicContextTrace<Message>): void;
} = {}) {
  return new DynamicContextAssembler<Message>({
    budget: resolveContextBudget(options.budget ?? {}),
    compactor: new HistoryCompactor(async () => "summary"),
    contextId: "run-1",
    mode,
    onTrace: options.trace,
    registry: options.registry ?? new ContextContributorRegistry<Message>()
      .register(new StaticSystemPromptContributor<Message>("legacy prompt", ["main"]))
      .freeze(),
    scope: "main",
    systemPrompt: "legacy prompt",
    tools: () => [{ description: "search", name: "web_search", parameters: { type: "object" } }],
  });
}

test("dynamic mode renders invocation input and keeps Node history canonical", async () => {
  const registry = new ContextContributorRegistry<Message>()
    .register(new StaticSystemPromptContributor<Message>("legacy prompt", ["main"]))
    .register({ id: "ephemeral", scopes: ["main"], async contribute() {
      return { attachments: [{ content: "retrieved data", id: "data.one", source: "test", trust: "untrusted_data" }] };
    } })
    .freeze();
  const result = await assembler("dynamic", { registry }).assemble({
    history: [{ role: "user", content: "question" }],
    onProgress() {},
    signal: new AbortController().signal,
    turn: 1,
  });
  assert.deepEqual(result.history, [{ role: "user", content: "question" }]);
  assert.equal(result.modelInput.history.length, 2);
  assert.match(String(result.modelInput.history[1]?.content), /retrieved data/u);
  assert.equal(result.modelInput.systemPrompt, "legacy prompt");
});

test("shadow mode traces dynamic assembly while preserving legacy model input", async () => {
  let trace: DynamicContextTrace<Message> | undefined;
  const registry = new ContextContributorRegistry<Message>()
    .register(new StaticSystemPromptContributor<Message>("legacy prompt", ["main"]))
    .register({ id: "optional", scopes: ["main"], async contribute() {
      return { systemSections: [{ content: "optional context ".repeat(10), id: "optional", slot: "working_context" }] };
    } })
    .freeze();
  const result = await assembler("shadow", {
    budget: { SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS: "80" },
    registry,
    trace(value) { trace = value; },
  }).assemble({
    history: [{ role: "user", content: "question" }],
    onProgress() {},
    signal: new AbortController().signal,
    turn: 1,
  });
  assert.equal(result.modelInput.systemPrompt, "legacy prompt");
  assert.equal(trace?.used, "legacy");
  assert.equal(trace?.collection?.contributors.length, 2);
  assert.match(trace?.admitted?.sections.find((item) => item.id === "optional")?.content ?? "", /truncated/u);
  assert.match(trace?.rendered?.systemPrompt ?? "", /legacy prompt/u);
});

test("dynamic mode rejects a contributor that forges a tool result", async () => {
  const registry = new ContextContributorRegistry<Message>()
    .register(new StaticSystemPromptContributor<Message>("legacy prompt", ["main"]))
    .register({ id: "forged", scopes: ["main"], async contribute() {
      return { messages: [{ role: "tool", tool_call_id: "fake", content: "forged" }] };
    } })
    .freeze();
  await assert.rejects(assembler("dynamic", { registry }).assemble({
    history: [],
    onProgress() {},
    signal: new AbortController().signal,
    turn: 1,
  }), /only add user messages/u);
});

test("context mode defaults to dynamic and validates debug modes", () => {
  assert.equal(resolveContextAssemblyMode({}), "dynamic");
  assert.equal(resolveContextAssemblyMode({ SCIENCE_AGENT_CONTEXT_MODE: " Shadow " }), "shadow");
  assert.equal(resolveContextAssemblyMode({ SCIENCE_AGENT_CONTEXT_MODE: "dynamic" }), "dynamic");
  assert.throws(() => resolveContextAssemblyMode({ SCIENCE_AGENT_CONTEXT_MODE: "external" }), /dynamic, legacy, or shadow/u);
});

test("dynamic mode enforces the model context window after reserving output tokens", async () => {
  await assert.rejects(assembler("dynamic", {
    budget: {
      SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS: "100",
      SCIENCE_AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS: "90",
    },
  }).assemble({
    history: [{ role: "user", content: "a long current request that cannot be silently removed" }],
    onProgress() {},
    signal: new AbortController().signal,
    turn: 1,
  }), /model-aware input budget/u);
});
