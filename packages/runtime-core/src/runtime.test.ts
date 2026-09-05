// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop, ExternalWaitController, RuntimeBuilder, reduceRunState, type RunEvent, type RuntimeMessage } from "./runtime.js";

interface Input { history: RuntimeMessage[] }
interface Usage { tokens: number }

test("durable lifecycle is awaited and a failed commit cannot emit completion", async () => {
  const order: string[] = [];
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1,
    contextAssembler: { async assemble({ history }) { order.push("assemble"); return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { order.push("model"); return { assistantMessage: { role: "assistant" }, toolCalls: [] }; } },
    toolDispatcher: { async execute() { throw new Error("unused"); } },
    turnLifecycle: {
      async beforeTurn() { order.push("before"); },
      async afterAssembly() { order.push("context"); },
      async afterTurn() { await Promise.resolve(); order.push("commit"); throw new Error("disk failure"); },
    },
    eventSink: (event) => { if (event.type === "completed") order.push("completed"); },
  });
  await assert.rejects(loop.run([], new AbortController().signal, () => {}), /disk failure/);
  assert.deepEqual(order, ["before", "assemble", "context", "model", "commit"]);
  assert.equal(loop.snapshot().phase, "failed");
});

test("a failed dispatcher settles sibling workspace writers without committing the turn", async () => {
  let settled = false; let commits = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { return { assistantMessage: { role: "assistant" }, toolCalls: [
      { id: "fail", name: "write", args: {} }, { id: "slow", name: "write", args: {} },
    ] }; } },
    toolDispatcher: { executionMode: () => "parallel", async execute(call) {
      if (call.id === "fail") throw new Error("failed");
      await new Promise((done) => setTimeout(done, 10)); settled = true;
      return { content: "done", isError: false, message: { role: "tool" } };
    } },
    turnLifecycle: { async beforeTurn() {}, async afterAssembly() {}, async afterTurn() { commits += 1; } },
  });
  await assert.rejects(loop.run([], new AbortController().signal, () => {}), /failed/);
  assert.equal(settled, true); assert.equal(commits, 0);
});

test("runs model and concurrent tools while committing results in call order", async () => {
  const events: RunEvent<Usage>[] = [];
  let modelCalls = 0;
  let bothStarted = false;
  const started = new Set<string>();
  const loop = new AgentLoop<RuntimeMessage, Input, Usage>({
    maxModelTurns: 4,
    contextAssembler: {
      async assemble({ history }) {
        const copy = structuredClone([...history]);
        return { history: copy, modelInput: { history: copy } };
      },
    },
    modelClient: {
      async invoke(input) {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            assistantMessage: { role: "assistant", content: "", tool_calls: ["slow", "fast"] },
            toolCalls: [
              { id: "slow", name: "slow", args: {} },
              { id: "fast", name: "fast", args: {} },
            ],
          };
        }
        assert.deepEqual(input.history.slice(-2).map((message) => message.name), ["slow", "fast"]);
        return { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [], usage: { tokens: 7 } };
      },
    },
    toolDispatcher: {
      executionMode: () => "parallel",
      async execute(call) {
        started.add(call.id);
        await Promise.resolve();
        bothStarted = started.size === 2;
        if (call.id === "slow") await new Promise((resolve) => setTimeout(resolve, 15));
        return { content: call.id, isError: false, message: { role: "tool", name: call.name, content: call.id } };
      },
    },
    eventSink: (event) => events.push(event),
  });

  const result = await loop.run([{ role: "user", content: "go" }], new AbortController().signal, () => undefined);
  assert.equal(bothStarted, true);
  assert.equal(result.turns, 2);
  assert.deepEqual(result.history.filter((message) => message.role === "tool").map((message) => message.name), ["slow", "fast"]);
  assert.deepEqual(result.usage, { tokens: 7 });
  assert.equal(events.filter((event) => event.type === "completed").length, 1);
  assert.equal(loop.snapshot().phase, "completed");
});

test("durable turn commit follows the bounded pool and exclusive barriers", async () => {
  let active = 0;
  let peak = 0;
  let commits = 0;
  const ids = ["a", "b", "c", "exclusive", "d"];
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1,
    maxParallelToolCalls: 2,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { return { assistantMessage: { role: "assistant" },
      toolCalls: ids.map((id) => ({ id, name: id, args: {} })) }; } },
    toolDispatcher: {
      executionMode: (call) => call.id === "exclusive" ? "exclusive" : "parallel",
      async execute(call) {
        if (call.id === "exclusive") assert.equal(active, 0);
        active += 1; peak = Math.max(peak, active);
        await new Promise((done) => setImmediate(done));
        active -= 1;
        return { content: call.id, isError: false, message: { role: "tool", content: call.id } };
      },
    },
    turnLifecycle: {
      async beforeTurn() {}, async afterAssembly() {},
      async afterTurn({ results, history }) {
        assert.equal(active, 0);
        assert.deepEqual(results.map((result) => result.content), ids);
        assert.deepEqual(history.slice(1).map((message) => message.content), ids);
        await Promise.resolve(); commits += 1;
      },
    },
  });
  await loop.run([], new AbortController().signal, () => {});
  assert.equal(peak, 2);
  assert.equal(commits, 1);
});

test("cancellation drains started writers without committing a partial Step", async () => {
  const controller = new AbortController();
  const started: string[] = [];
  let active = 0;
  let commits = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1, maxParallelToolCalls: 2,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { return { assistantMessage: { role: "assistant" },
      toolCalls: ["a", "b", "not-started"].map((id) => ({ id, name: "write", args: {} })) }; } },
    toolDispatcher: {
      executionMode: () => "parallel",
      async execute(call) {
        started.push(call.id); active += 1;
        if (call.id === "b") controller.abort();
        await new Promise((done) => setImmediate(done));
        active -= 1;
        return { content: call.id, isError: false, message: { role: "tool" } };
      },
    },
    turnLifecycle: { async beforeTurn() {}, async afterAssembly() {}, async afterTurn() { commits += 1; } },
  });
  await assert.rejects(loop.run([], controller.signal, () => {}), /cancelled/);
  assert.deepEqual(started, ["a", "b"]);
  assert.equal(active, 0);
  assert.equal(commits, 0);
});

test("the max-turn boundary closes every assistant tool call before returning", async () => {
  let turn = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 128,
    contextAssembler: {
      async assemble({ history }) {
        const copy = structuredClone([...history]);
        return { history: copy, modelInput: { history: copy } };
      },
    },
    modelClient: {
      async invoke() {
        turn += 1;
        const id = `call-${turn}`;
        return {
          assistantMessage: { role: "assistant", content: "", tool_calls: [{ id }] },
          toolCalls: [{ id, name: "lookup", args: {} }],
        };
      },
    },
    toolDispatcher: {
      async execute(call) {
        return {
          content: "ok",
          isError: false,
          message: { role: "tool", content: "ok", tool_call_id: call.id },
        };
      },
    },
  });
  const result = await loop.run([], new AbortController().signal, () => undefined);
  assert.equal(result.turns, 128);
  assert.equal(result.history.length, 256);
  for (let index = 0; index < result.history.length; index += 2) {
    const assistant = result.history[index]!;
    const tool = result.history[index + 1]!;
    assert.equal(tool.tool_call_id, (assistant.tool_calls as Array<{ id: string }>)[0]!.id);
  }
});

test("uses assembler history as the next authoritative state", async () => {
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1,
    contextAssembler: {
      async assemble() {
        const history = [{ role: "summary", content: "compacted" }];
        return { history, modelInput: { history } };
      },
    },
    modelClient: {
      async invoke(input) {
        assert.equal(input.history[0]?.role, "summary");
        return { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] };
      },
    },
    toolDispatcher: { async execute() { throw new Error("not called"); } },
  });
  const result = await loop.run([{ role: "user", content: "large history" }], new AbortController().signal, () => undefined);
  assert.deepEqual(result.history.map((message) => message.role), ["summary", "assistant"]);
});

test("cancellation is terminal and an AgentLoop executes once", async () => {
  const controller = new AbortController();
  controller.abort();
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { throw new Error("not called"); } },
    toolDispatcher: { async execute() { throw new Error("not called"); } },
  });
  await assert.rejects(() => loop.run([], controller.signal, () => undefined), /cancelled/);
  assert.equal(loop.snapshot().phase, "cancelled");
  await assert.rejects(() => loop.run([], new AbortController().signal, () => undefined), /exactly once/);
});

test("model failure produces one failed terminal state", async () => {
  const states: string[] = [];
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { throw new Error("provider failed"); } },
    toolDispatcher: { async execute() { throw new Error("not called"); } },
    eventSink: (event) => {
      if (event.type === "state_changed") states.push(event.state);
    },
  });
  await assert.rejects(() => loop.run([], new AbortController().signal, () => undefined), /provider failed/);
  assert.equal(loop.snapshot().phase, "failed");
  assert.deepEqual(states, ["assembling_context", "calling_model", "failed"]);
});

test("provider input overflow forces one context rebuild and retries the same turn once", async () => {
  const assemblies: Array<string | undefined> = [];
  let calls = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1,
    contextAssembler: {
      async assemble({ history, recovery }) {
        assemblies.push(recovery?.reason);
        const next = recovery ? [{ role: "summary", content: "compacted" }] : [...history];
        return { history: next, modelInput: { history: next } };
      },
    },
    modelClient: {
      isInputTooLargeError(error) { return error instanceof Error && error.message === "context too large"; },
      async invoke(input) {
        calls += 1;
        if (calls === 1) throw new Error("context too large");
        assert.equal(input.history[0]?.role, "summary");
        return { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] };
      },
    },
    toolDispatcher: { async execute() { throw new Error("not called"); } },
  });
  const result = await loop.run([{ role: "user", content: "large" }], new AbortController().signal, () => undefined);
  assert.equal(calls, 2);
  assert.deepEqual(assemblies, [undefined, "model-input-overflow"]);
  assert.deepEqual(result.history.map((message) => message.role), ["summary", "assistant"]);
});

test("a second provider input overflow is surfaced without an infinite recovery loop", async () => {
  let calls = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: {
      isInputTooLargeError() { return true; },
      async invoke() { calls += 1; throw new Error("still too large"); },
    },
    toolDispatcher: { async execute() { throw new Error("not called"); } },
  });
  await assert.rejects(() => loop.run([], new AbortController().signal, () => undefined), /still too large/u);
  assert.equal(calls, 2);
});

test("builder validates required ports and freezes the run composition", async () => {
  assert.throws(() => new RuntimeBuilder<RuntimeMessage, Input, never>().build(), /contextAssembler.*modelClient.*toolDispatcher.*maxModelTurns/);
  const assembler = { async assemble({ history }: { history: readonly RuntimeMessage[] }) {
    const copy = [...history];
    return { history: copy, modelInput: { history: copy } };
  } };
  const builder = new RuntimeBuilder<RuntimeMessage, Input, never>()
    .withContextAssembler(assembler)
    .withMaxModelTurns(1)
    .withModelClient({ async invoke() { return { assistantMessage: { role: "assistant", content: "original" }, toolCalls: [] }; } })
    .withToolDispatcher({ async execute() { throw new Error("not called"); } });
  const loop = builder.build();
  builder.withModelClient({ async invoke() { throw new Error("mutated builder"); } });
  const result = await loop.run([], new AbortController().signal, () => undefined);
  assert.equal(result.history.at(-1)?.content, "original");
});

test("multiple external waits are independent and restore the active phase only after all release", async () => {
  const waits = new ExternalWaitController();
  const states: string[] = [];
  let releaseModel!: () => void;
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
  const loop = new RuntimeBuilder<RuntimeMessage, Input, never>()
    .withContextAssembler({ async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } })
    .withMaxModelTurns(1)
    .withModelClient({ async invoke() { await modelGate; return { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] }; } })
    .withToolDispatcher({ async execute() { throw new Error("not called"); } })
    .withWaitController(waits)
    .withEventSink((event) => { if (event.type === "state_changed") states.push(event.state); })
    .build();
  const running = loop.run([], new AbortController().signal, () => undefined);
  await Promise.resolve();
  const first = waits.begin("permission");
  const second = waits.begin("permission");
  assert.deepEqual(states.slice(-1), ["waiting_external"], "adding a second wait must not emit a false resume");
  first.release();
  first.release();
  assert.equal(loop.snapshot().phase, "waiting_external");
  assert.deepEqual(states.slice(-1), ["waiting_external"], "releasing one of two waits must not resume the run");
  second.release();
  assert.equal(loop.snapshot().phase, "calling_model");
  releaseModel();
  await running;
  assert.deepEqual(states.slice(-3), ["waiting_external", "calling_model", "completed"]);
});

test("transition reducer rejects illegal and post-terminal transitions", () => {
  const idle = { history: [], phase: "idle" as const, turn: 0 };
  const assembling = reduceRunState(idle, { phase: "assembling_context", turn: 0 });
  assert.equal(assembling.phase, "assembling_context");
  assert.throws(() => reduceRunState(assembling, { phase: "completed", turn: 0 }), /Invalid AgentLoop transition/);
  const calling = reduceRunState(assembling, { phase: "calling_model", turn: 0 });
  const completed = reduceRunState(calling, { phase: "completed", turn: 0 });
  assert.throws(() => reduceRunState(completed, { phase: "failed", turn: 0 }), /Invalid AgentLoop transition/);
});

test("observer failures cannot change run control flow or its terminal state", async () => {
  const loop = new RuntimeBuilder<RuntimeMessage, Input, never>()
    .withContextAssembler({ async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } })
    .withMaxModelTurns(1)
    .withModelClient({ async invoke() { return { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] }; } })
    .withToolDispatcher({ async execute() { throw new Error("not called"); } })
    .withEventSink(() => { throw new Error("telemetry unavailable"); })
    .build();
  const result = await loop.run([], new AbortController().signal, () => undefined);
  assert.equal(result.history.at(-1)?.content, "done");
  assert.equal(loop.snapshot().phase, "completed");
});
