// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import { ToolRegistry } from "./registry.js";

const resultMessage = (call: { id: string; name: string }, content: string) => ({ role: "tool", name: call.name, tool_call_id: call.id, content });

test("rejects duplicate tool names when freezing the run registry", () => {
  const tool = { name: "same", label: "same", description: "same", parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } };
  assert.throws(() => new ToolRegistry([tool, tool], { createResultMessage: resultMessage }), /Duplicate tool name/);
});

test("executes tools and creates the canonical result message", async () => {
  const registry = new ToolRegistry([{
    name: "echo", label: "echo", description: "echo", parameters: Type.Object({ value: Type.String() }),
    async execute(_id, params: { value: string }) { return { content: [{ type: "text", text: params.value }], details: {} }; },
  }], { createResultMessage: resultMessage });
  const result = await registry.execute({ id: "1", name: "echo", args: { value: "ok" } }, new AbortController().signal);
  assert.equal(result.content, "ok");
  assert.deepEqual(result.message, { role: "tool", name: "echo", tool_call_id: "1", content: "ok" });
});
