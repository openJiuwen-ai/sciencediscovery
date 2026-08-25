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

test("result observations retain model-declared order across concurrent completion", async () => {
  const observed: Array<{ name: string; sequence: number }> = [];
  const registry = new ToolRegistry([
    {
      name: "slow", label: "slow", description: "slow", parameters: Type.Object({}),
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { content: [{ type: "text" as const, text: "slow" }], details: {} };
      },
    },
    {
      name: "fast", label: "fast", description: "fast", parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text" as const, text: "fast" }], details: {} }; },
    },
  ], {
    createResultMessage: (call, content) => ({ role: "tool", name: call.name, content }),
    onResult: ({ call, sequence }) => observed.push({ name: call.name, sequence }),
  });
  await Promise.all([
    registry.execute({ args: {}, id: "1", name: "slow" }, new AbortController().signal),
    registry.execute({ args: {}, id: "2", name: "fast" }, new AbortController().signal),
  ]);
  assert.deepEqual(observed.sort((left, right) => left.sequence - right.sequence), [
    { name: "slow", sequence: 1 },
    { name: "fast", sequence: 2 },
  ]);
});
