// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { AgentTool } from "@sciencediscovery/tools";
import type { SpecialistRuntimeEvent, SpecialistRuntimeRequest } from "./adapter.js";
import { CodexSpecialistAdapter } from "./codex.js";
import { runPlatformDecisions } from "./decisions.js";
import { platformDecisionSchema } from "./decision-contract.js";

const call = (command: string) => ({ tool: "run_shell", arguments: JSON.stringify({ command }) });
const batch = JSON.stringify({ summary: "Do both", tools: [call("first"), call("second")] });
const finish = JSON.stringify({ summary: "Finished", tools: [] });

for (const transport of ["codex", "shared Claude/ACP"] as const) {
  async function run(outputs: string[], tool: AgentTool, observed: SpecialistRuntimeEvent[] = [], maxTurns = 2) {
    const prompts: string[] = [];
    const decide = async (prompt: string) => { prompts.push(prompt); assert.ok(outputs.length, "unexpected extra decision request"); return outputs.shift()!; };
    const request: SpecialistRuntimeRequest = { prompt: "Free-form brief: run both checks and summarize.", tools: [tool], maxTurns, signal: AbortSignal.timeout(5000), credential: async () => "fixture-key" };
    const sink = async (event: SpecialistRuntimeEvent) => { observed.push(event); };
    const result = transport === "codex"
      ? new CodexSpecialistAdapter(() => ({ async runStreamed(input, options) {
        assert.deepEqual(options?.outputSchema, platformDecisionSchema);
        const text = await decide(String(input));
        return { events: (async function* () {
          yield { type: "item.completed" as const, item: { type: "agent_message" as const, id: "message", text } };
          yield { type: "turn.completed" as const, usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
        })() };
      } })).invoke(request, sink)
      : runPlatformDecisions(request, sink, decide);
    return { result, prompts };
  }
  const tool = (execute: AgentTool["execute"]): AgentTool => ({ name: "run_shell", label: "Run", description: "Run", parameters: Type.Object({ command: Type.String() }), execute });

  test(`${transport}: a single decision executes two platform calls serially with distinct audit IDs and complete history`, async () => {
    const order: string[] = []; const observed: SpecialistRuntimeEvent[] = [];
    const { result, prompts } = await run([batch, finish], tool(async (_id, args) => {
      const { command } = args as { command: string };
      order.push(`start:${command}`); await new Promise(resolve => setImmediate(resolve)); order.push(`end:${command}`);
      return { content: [{ type: "text", text: `${command} output` }] };
    }), observed);
    assert.equal((await result).summary, "Finished");
    assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
    const calls = observed.filter(e => e.type === "tool_call");
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls.map(e => e.id)).size, 2);
    assert.match(prompts[1]!, /first output/); assert.match(prompts[1]!, /second output/);
  });

  test(`${transport}: corrects malformed and mixed-intent output once, then fails with zero dispatch on a second invalid response`, async () => {
    for (const invalid of ["{", '{}', JSON.stringify({ summary: "Mixed garbage", tools: [call("first"), { tool: "host_shell", arguments: "{}" }] }), JSON.stringify({ summary: "Bad args", tools: [call("first"), { tool: "run_shell", arguments: '{"command":1}' }] }), JSON.stringify({ summary: "Extra intent", tools: [call("first")], tool: "other" })]) {
      let executions = 0;
      const { result, prompts } = await run([invalid, batch, finish], tool(async () => { executions++; return { content: [] }; }));
      await result;
      assert.equal(executions, 2); assert.equal(prompts.length, 3); assert.match(prompts[1]!, /Correct the entire decision once/);
      let rejectedExecutions = 0;
      const failed = await run([invalid, invalid], tool(async () => { rejectedExecutions++; return { content: [] }; }), [], 1);
      await assert.rejects(failed.result, /invalid platform decision after one correction attempt/i);
      assert.equal(failed.prompts.length, 2); assert.equal(rejectedExecutions, 0);
    }
  });

  test(`${transport}: permission/execution failure stops the batch without correction or duplicate dispatch`, async () => {
    let executions = 0;
    const { result, prompts } = await run([batch], tool(async () => { executions++; throw Error("Permission denied"); }));
    await assert.rejects(result, /review|runtime failed/);
    assert.equal(executions, 1); assert.equal(prompts.length, 1);
  });
}
