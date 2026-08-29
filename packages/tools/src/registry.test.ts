// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import { ToolOutputGuard } from "./bounded-output.js";
import { ToolRegistry } from "./registry.js";
import { ToolOutputStore } from "./tool-output-store.js";

const resultMessage = (call: { id: string; name: string }, content: string, output?: { ref: string }) => ({
  role: "tool", name: call.name, tool_call_id: call.id, content,
  ...(output ? { additional_kwargs: { tool_output: output } } : {}),
});

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

test("tool scheduling is fail-closed and only exact true enables parallel execution", () => {
  const registry = new ToolRegistry([
    {
      name: "read", label: "read", description: "read", parameters: Type.Object({}),
      isConcurrencySafe: () => true,
      async execute() { return { content: [], details: {} }; },
    },
    {
      name: "write", label: "write", description: "write", parameters: Type.Object({}),
      async execute() { return { content: [], details: {} }; },
    },
    {
      name: "broken", label: "broken", description: "broken", parameters: Type.Object({}),
      isConcurrencySafe() { throw new Error("classifier failed"); },
      async execute() { return { content: [], details: {} }; },
    },
  ], { createResultMessage: resultMessage });
  assert.equal(registry.executionMode({ args: {}, id: "1", name: "read" }), "parallel");
  assert.equal(registry.executionMode({ args: {}, id: "2", name: "write" }), "exclusive");
  assert.equal(registry.executionMode({ args: {}, id: "3", name: "broken" }), "exclusive");
  assert.equal(registry.executionMode({ args: {}, id: "4", name: "missing" }), "exclusive");
});

test("returned tool failures keep their raw result and error flag through durable observations", async () => {
  const observed: Array<{ content: string; isError: boolean }> = [];
  const recorded: Array<{ content: string; isError: boolean }> = [];
  const content = JSON.stringify({ state: "failed", result: { exitCode: 1, stderr: "RuntimeError: " + "y".repeat(650) } });
  const registry = new ToolRegistry([{
    name: "run_shell", label: "Shell", description: "Shell", parameters: Type.Object({}),
    async execute() { return { isError: true, content: [{ type: "text", text: content }], details: {} }; },
  }], {
    createResultMessage: resultMessage,
    recordResult: async (result) => { recorded.push(result); },
    onResult: (result) => { observed.push(result); },
  });
  const result = await registry.execute({ id: "failed-shell", name: "run_shell", args: {} }, new AbortController().signal);
  assert.equal(result.isError, true);
  assert.equal(result.content, content);
  assert.equal(result.message.content, content);
  for (const results of [recorded, observed]) {
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, true);
    assert.equal(results[0]?.content, content);
  }
});

test("error-looking output is successful unless the tool marks it as a failure", async () => {
  for (const isError of [undefined, false]) {
    const registry = new ToolRegistry([{
      name: "echo", label: "echo", description: "echo", parameters: Type.Object({}),
      async execute() { return { isError, content: [{ type: "text", text: "RuntimeError: timeout" }], details: {} }; },
    }], { createResultMessage: resultMessage });
    const result = await registry.execute({ id: "echo", name: "echo", args: {} }, new AbortController().signal);
    assert.equal(result.isError, false);
    assert.equal(result.content, "RuntimeError: timeout");
  }
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

test("batch policies supersede earlier calls without executing them", async () => {
  const executed: string[] = [];
  const registry = new ToolRegistry([{
    name: "replace", label: "replace", description: "replace", parameters: Type.Object({ value: Type.String() }),
    async execute(id) {
      executed.push(id);
      return { content: [{ type: "text" as const, text: id }], details: {} };
    },
  }], {
    batchPolicies: [{
      id: "replace.last-declared",
      decide(calls) {
        const matching = calls.filter((call) => call.name === "replace");
        const winner = matching.at(-1);
        return winner
          ? matching.slice(0, -1).map((call) => ({ byCallId: winner.id, callId: call.id, kind: "supersede" as const }))
          : [];
      },
    }],
    createResultMessage: resultMessage,
  });
  const calls = [
    { args: { value: "old" }, id: "first", name: "replace" },
    { args: {}, id: "echo", name: "missing" },
    { args: { value: "new" }, id: "last", name: "replace" },
  ];
  const batch = registry.prepareBatch(calls);
  const signal = new AbortController().signal;
  const results = await Promise.all(calls.map((call) => batch.execute(call, signal)));
  assert.deepEqual(executed, ["last"]);
  assert.deepEqual(JSON.parse(results[0]!.content), {
    ok: true,
    superseded: true,
    supersededBy: "last",
  });
  assert.equal(results[1]?.isError, true);
  assert.equal(results[2]?.content, "last");
});

test("dynamic availability hides and blocks tools without changing handlers", async () => {
  let active = false;
  const registry = new ToolRegistry([{
    name: "execute", label: "execute", description: "execute", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text" as const, text: "done" }], details: {} }; },
  }], {
    createResultMessage: resultMessage,
    isAvailable: () => active,
  });
  assert.deepEqual(registry.visibleSpecs(), []);
  const blocked = await registry.execute({ args: {}, id: "1", name: "execute" }, new AbortController().signal);
  assert.equal(blocked.isError, true);
  assert.match(blocked.content, /not available under the current run capability policy/u);
  active = true;
  assert.deepEqual(registry.visibleSpecs().map((spec) => spec.name), ["execute"]);
  assert.equal((await registry.execute({ args: {}, id: "2", name: "execute" }, new AbortController().signal)).content, "done");
});

test("every result crosses the output bound before it becomes a history message", async () => {
  const store = new ToolOutputStore();
  const observed: string[] = [];
  const registry = new ToolRegistry([
    {
      // Stands in for an MCP tool: no bound of its own, arbitrary size.
      name: "mcp__pubmed__search", label: "search", description: "search", parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text" as const, text: "hit\n".repeat(200_000) }], details: {} }; },
    },
    {
      name: "read_file", label: "read", description: "read", parameters: Type.Object({}),
      async execute() { return { bounded: true, content: [{ type: "text" as const, text: "page body" }], details: {} }; },
    },
  ], {
    createResultMessage: resultMessage,
    onResult: ({ content }) => observed.push(content),
    outputGuard: new ToolOutputGuard({ sink: store }),
  });

  const oversized = await registry.execute({ args: {}, id: "1", name: "mcp__pubmed__search" }, new AbortController().signal);
  assert.ok(Buffer.byteLength(oversized.content, "utf8") < 60 * 1_024, "the result entering history is bounded");
  assert.match(oversized.content, /\[bounded tool output] mcp__pubmed__search produced 200000 lines/);
  assert.equal(oversized.message.content, oversized.content, "the history message carries the bounded text");
  assert.match(String(oversized.message.additional_kwargs?.tool_output?.ref), /^tool-output-/u);
  assert.deepEqual(observed, [oversized.content], "observers see the bounded text, not the original");

  const ref = /ref "(tool-output-[0-9a-f]{16})"/.exec(oversized.content)?.[1];
  assert.ok(ref);
  assert.equal((await store.read(ref)).totalLines, 200_000, "the full result stays readable behind the ref");

  const selfBounded = await registry.execute({ args: {}, id: "2", name: "read_file" }, new AbortController().signal);
  assert.equal(selfBounded.content, "page body", "a tool that paginates itself keeps its own formatting");
});

test("unavailable deferred tools are absent from discovery", async () => {
  let active = false;
  const registry = new ToolRegistry([{
    deferred: true,
    name: "remote", label: "remote", description: "remote", parameters: Type.Object({}),
    async execute() { return { content: [], details: {} }; },
  }], { createResultMessage: resultMessage, isAvailable: () => active });
  assert.equal(registry.visibleSpecs().some((spec) => spec.name === "tool_search"), false);
  assert.equal(registry.promptSections().join("\n").includes("remote"), false);
  active = true;
  assert.equal(registry.visibleSpecs().some((spec) => spec.name === "tool_search"), true);
  assert.equal(registry.promptSections().join("\n").includes("remote"), true);
});
