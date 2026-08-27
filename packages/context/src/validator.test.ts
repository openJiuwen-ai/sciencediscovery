// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import { ContextValidator } from "./validator.js";

const tools = [{ description: "search", name: "search", parameters: { type: "object" } }];
const sections = [{
  content: "authority",
  contributorId: "identity",
  id: "identity",
  priority: 100,
  protected: true,
  slot: "identity" as const,
}];

test("validator accepts protected authority and governed tool calls", () => {
  new ContextValidator().validate({
    history: [
      { role: "assistant", tool_calls: [{ id: "call-1" }] },
      { role: "tool", tool_call_id: "call-1", content: "ok" },
    ],
    systemPrompt: "authority",
    tools,
  }, sections, tools);
});

test("validator rejects missing authority, changed tools, and orphan results", () => {
  const validator = new ContextValidator();
  assert.throws(() => validator.validate({ history: [], systemPrompt: "", tools }, sections, tools), /dropped protected/u);
  assert.throws(() => validator.validate({ history: [], systemPrompt: "authority", tools: [] }, sections, tools), /governed tool set/u);
  assert.throws(() => validator.validate({
    history: [{ role: "tool", tool_call_id: "missing", content: "bad" }],
    systemPrompt: "authority",
    tools,
  }, sections, tools), /orphan tool result/u);
});
