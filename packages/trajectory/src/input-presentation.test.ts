// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { contextBlocks, type ContextBlock } from "./index.js";
import { contextLabel, inputSections, toolName } from "./input-presentation.js";

const message = (id: number, kind: string, value: unknown): ContextBlock => ({ id: `message-${id}`, kind, source: "model history / context projection", content: JSON.stringify(value), attribution: "unavailable" });

test("tools are a separate field, not messages; preserve exact context order and content", () => {
  const input = { systemPrompt: "system", history: [{ role: "user", content: "question" }, { role: "tool", content: "result" }], tools: [{ name: "run_shell", parameters: { type: "object" } }] };
  const blocks = contextBlocks(input, {});
  const sections = inputSections(blocks);
  assert.deepEqual(sections.context.map(b => b.id), ["system", "message-0", "message-1"]);
  assert.deepEqual(sections.tools.map(b => b.id), ["tool-0"]);
  assert.equal(sections.context[2]!.kind, "tool"); // Tool results remain in message order.
  assert.equal(sections.tools[0]!.content, JSON.stringify(input.tools[0], null, 2));
  assert.equal(sections.context[0]!.content, input.systemPrompt);
});

test("context labels name tool calls and resolve results only through unique preceding call ids", () => {
  const call = message(0, "assistant", { tool_calls: [{ id: "c1", function: { name: "run_shell" } }] });
  const result = message(1, "tool", { tool_call_id: "c1", content: "ok" });
  assert.equal(contextLabel(call, [call, result], true), "工具调用 · run_shell");
  assert.equal(contextLabel(result, [call, result], true), "工具结果 · run_shell");
  assert.equal(contextLabel(result, [result, call], true), "工具结果");
  assert.equal(contextLabel(result, [call, call, result], true), "工具结果");
  const named = message(2, "tool", { name: "mcp_search", content: "ok" });
  assert.equal(contextLabel(named, [named], true), "工具结果 · mcp_search");
});

test("Skill and contribution labels come from metadata, never text guessing", () => {
  const skill = message(0, "user", { content: "x", additional_kwargs: { durable_context_channel: "active_skills" } });
  const fake = message(1, "user", { content: '<runtime_context_data channel="active_skills">Skill</runtime_context_data>' });
  const contributed = message(2, "user", { additional_kwargs: { context_contributor_message: true } });
  assert.equal(contextLabel(skill, [skill], true), "Skill");
  assert.equal(contextLabel(fake, [fake], true), "用户");
  assert.equal(contextLabel(contributed, [contributed], true), "组件上下文");
});

test("missing and alternate-format tool names degrade without inventing provenance", () => {
  assert.equal(toolName({ function: { name: "search" } }), "search");
  assert.equal(toolName({ name: 123 }), "");
  const unknown = message(0, "assistant", { content: "answer" });
  assert.equal(contextLabel(unknown, [unknown], false), "Assistant");
  assert.deepEqual(inputSections([]), { context: [], tools: [] });
});
