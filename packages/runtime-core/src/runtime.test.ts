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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


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

test("cancellation after a reported model turn still emits model usage", async () => {
  const controller = new AbortController();
  const events: RunEvent<Usage>[] = [];
  const loop = new AgentLoop<RuntimeMessage, Input, Usage>({
    maxModelTurns: 1,
    maxParallelToolCalls: 1,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: {
      async invoke() {
        return {
          assistantMessage: { role: "assistant" },
          toolCalls: [{ id: "cancel", name: "write", args: {} }],
          usage: { tokens: 7 },
        };
      },
    },
    toolDispatcher: {
      async execute() {
        controller.abort();
        throw new Error("cancelled writer");
      },
    },
    turnLifecycle: { async beforeTurn() {}, async afterAssembly() {}, async afterTurn() { throw new Error("not committed"); } },
    eventSink: (event) => events.push(event),
  });

  await assert.rejects(() => loop.run([], controller.signal, () => {}), /cancelled writer/);
  const usageEvent = events.find((event) => event.type === "model_usage");
  assert.deepEqual(usageEvent?.type === "model_usage" ? usageEvent.usage : undefined, { tokens: 7 });
  assert.equal(loop.snapshot().phase, "cancelled");
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

test("finish gate: continue injects the directive and takes another turn, then completes", async () => {
  const events: RunEvent<never>[] = [];
  const order: string[] = [];
  let modelCalls = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 8,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { modelCalls += 1; return { assistantMessage: { role: "assistant", content: `answer-${modelCalls}` }, toolCalls: [] }; } },
    toolDispatcher: { async execute() { throw new Error("unused"); } },
    turnLifecycle: {
      async beforeTurn() {},
      async afterAssembly() {},
      async afterTurn() { order.push("afterTurn"); },
      async beforeFinish() {
        order.push("beforeFinish");
        return modelCalls === 1
          ? { action: "continue", message: { role: "user", content: "audit first" } }
          : undefined;
      },
    },
    eventSink: (event) => events.push(event),
  });
  const result = await loop.run([{ role: "user", content: "go" }], new AbortController().signal, () => undefined);
  assert.equal(modelCalls, 2);
  assert.equal(result.turns, 2);
  assert.deepEqual(order, ["afterTurn", "beforeFinish", "afterTurn", "beforeFinish"], "gate fires after the durable turn boundary");
  const contents = result.history.map((message) => message.content);
  assert.ok(contents.includes("audit first"), "injected directive is in the canonical history");
  assert.deepEqual(
    events.filter((event) => event.type === "finish_gate").map((event) => event.type === "finish_gate" ? event.action : ""),
    ["continue"],
    "an undefined verdict (no opinion) emits no finish_gate event",
  );
  assert.equal(loop.snapshot().phase, "completed");
});

test("finish gate: continuations are capped and never exceed maxModelTurns", async () => {
  let modelCalls = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 10,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { modelCalls += 1; return { assistantMessage: { role: "assistant" }, toolCalls: [] }; } },
    toolDispatcher: { async execute() { throw new Error("unused"); } },
    turnLifecycle: {
      async beforeTurn() {},
      async afterAssembly() {},
      async afterTurn() {},
      // A stuck gate keeps asking for one more turn; the loop must stop it.
      async beforeFinish() { return { action: "continue", message: { role: "user", content: "again" } }; },
    },
  });
  const result = await loop.run([], new AbortController().signal, () => undefined);
  assert.equal(modelCalls, 1 + 3, "initial finish attempt plus MAX_FINISH_GATE_CONTINUATIONS (=3)");
  assert.equal(result.turns, 4);
  assert.equal(loop.snapshot().phase, "completed");

  let smallCalls = 0;
  const small = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 2,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { smallCalls += 1; return { assistantMessage: { role: "assistant" }, toolCalls: [] }; } },
    toolDispatcher: { async execute() { throw new Error("unused"); } },
    turnLifecycle: {
      async beforeTurn() {},
      async afterAssembly() {},
      async afterTurn() {},
      async beforeFinish() { return { action: "continue", message: { role: "user", content: "again" } }; },
    },
  });
  const smallResult = await small.run([], new AbortController().signal, () => undefined);
  assert.equal(smallCalls, 2, "the gate consumes from the same turn budget");
  assert.equal(smallResult.turns, 2);
});

test("finish gate: never fires while the model still calls tools", async () => {
  let gateCalls = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 2,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { return { assistantMessage: { role: "assistant" }, toolCalls: [{ id: "c1", name: "noop", args: {} }] }; } },
    toolDispatcher: { async execute(call) { return { content: "ok", isError: false, message: { role: "tool", name: call.name, tool_call_id: call.id } }; } },
    turnLifecycle: {
      async beforeTurn() {},
      async afterAssembly() {},
      async afterTurn() {},
      async beforeFinish() { gateCalls += 1; return undefined; },
    },
  });
  await loop.run([], new AbortController().signal, () => undefined);
  assert.equal(gateCalls, 0);
});

test("finish gate: a throwing beforeFinish fails the run after the turn committed", async () => {
  let commits = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 4,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { return { assistantMessage: { role: "assistant" }, toolCalls: [] }; } },
    toolDispatcher: { async execute() { throw new Error("unused"); } },
    turnLifecycle: {
      async beforeTurn() {},
      async afterAssembly() {},
      async afterTurn() { commits += 1; },
      async beforeFinish() { throw new Error("gate store down"); },
    },
  });
  await assert.rejects(loop.run([], new AbortController().signal, () => undefined), /gate store down/);
  assert.equal(commits, 1, "the turn is durably recorded before the gate runs");
  assert.equal(loop.snapshot().phase, "failed");
});

test("finish gate: a capped continue is reported as denied, not finish", async () => {
  const events: RunEvent<never>[] = [];
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 10,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke() { return { assistantMessage: { role: "assistant" }, toolCalls: [] }; } },
    toolDispatcher: { async execute() { throw new Error("unused"); } },
    turnLifecycle: {
      async beforeTurn() {},
      async afterAssembly() {},
      async afterTurn() {},
      async beforeFinish() { return { action: "continue", message: { role: "user", content: "again" } }; },
    },
    eventSink: (event) => events.push(event),
  });
  await loop.run([], new AbortController().signal, () => undefined);
  assert.deepEqual(
    events.filter((event) => event.type === "finish_gate").map((event) => event.type === "finish_gate" ? event.action : ""),
    ["continue", "continue", "continue", "denied"],
  );
});

test("stall guard kicks a silent model call and the run recovers with a kick message", async () => {
  let calls = 0;
  const events: string[] = [];
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 4,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke(_input, signal) {
      calls += 1;
      if (calls === 1) {
        // Silent call: settles only if the stall guard aborts it.
        await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted by guard")), { once: true });
        });
      }
      return { assistantMessage: { role: "assistant", content: "recovered" }, toolCalls: [] };
    } },
    stallGuard: {
      createKickMessage: (kick, maxKicks) => ({ content: `kick ${kick}/${maxKicks}`, role: "user" }),
      idleMs: 20,
      maxKicks: 2,
    },
    toolDispatcher: { async execute() { throw new Error("unused"); } },
    eventSink: (event) => { if (event.type === "stall_kick") events.push(`kick:${event.kick}`); },
  });
  const result = await loop.run([], new AbortController().signal, () => {});
  assert.deepEqual(events, ["kick:1"]);
  assert.equal(result.turns, 2);
  const last = result.history.at(-1);
  assert.equal((last as { content?: string }).content, "recovered");
  assert.ok(result.history.some((message) => (message as { content?: string }).content === "kick 1/2"), "the kick message entered the history");
});

test("stall guard fails the run after maxKicks", async () => {
  let calls = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 8,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke(_input, signal) {
      calls += 1;
      await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted by guard")), { once: true });
      });
      throw new Error("unreachable");
    } },
    stallGuard: {
      createKickMessage: (kick) => ({ content: `kick ${kick}`, role: "user" }),
      idleMs: 15,
      maxKicks: 2,
    },
    toolDispatcher: { async execute() { throw new Error("unused"); } },
  });
  await assert.rejects(loop.run([], new AbortController().signal, () => {}), /stalled: no progress after 2 stall-guard kicks/);
  assert.equal(loop.snapshot().phase, "failed");
  assert.equal(calls, 3, "initial attempt + 2 kicked retries, then the stall fails the run");
});

test("an outer abort is never mistaken for a stall kick", async () => {
  const controller = new AbortController();
  let calls = 0;
  const events: string[] = [];
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 4,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke(_input, signal): Promise<never> {
      calls += 1;
      setTimeout(() => controller.abort(), 10);
      await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("outer abort")), { once: true });
      });
      // Promise<never> must not have a reachable end point (tsc strictness).
      throw new Error("unreachable: the abort rejection is the only exit");
    } },
    stallGuard: {
      createKickMessage: () => ({ content: "kick", role: "user" }),
      idleMs: 60_000,
      maxKicks: 3,
    },
    toolDispatcher: { async execute() { throw new Error("unused"); } },
    eventSink: (event) => { if (event.type === "stall_kick") events.push("kick"); },
  });
  await assert.rejects(loop.run([], controller.signal, () => {}));
  assert.equal(loop.snapshot().phase, "cancelled", "an outer abort keeps the cancellation semantics");
  assert.equal(calls, 1, "no retry happened");
  assert.deepEqual(events, [], "no stall kick was emitted");
});

test("model deltas carry a response identity that settles once per invoke attempt", async () => {
  const events: RunEvent<never>[] = [];
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 2,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: {
      async invoke(input, _signal, observer) {
        observer.onTextDelta("part one ");
        observer.onThinkingDelta("reasoning ");
        observer.onTextDelta("part two");
        const toolCalls = input.history.length >= 3 ? [] : [{ id: "t1", name: "lookup", args: {} }];
        return { assistantMessage: { role: "assistant", content: "turn" }, toolCalls };
      },
    },
    toolDispatcher: { async execute() { return { content: "ok", isError: false, message: { role: "tool" } }; } },
    eventSink: (event) => events.push(event),
  });
  await loop.run([{ role: "user", content: "go" }], new AbortController().signal, () => undefined);
  const starts = events.filter((event) => event.type === "response_start");
  const deltas = events.filter((event) => event.type === "model_delta");
  const settled = events.filter((event) => event.type === "response_settled");
  assert.equal(starts.length, 2, "one response per model turn");
  assert.equal(settled.length, 2);
  assert.notEqual(starts[0]!.responseId, starts[1]!.responseId, "each turn gets a fresh identity");
  for (const delta of deltas) {
    assert.ok(starts.some((start) => start.responseId === delta.responseId), "every delta names its response");
  }
  const first = deltas.filter((delta) => delta.responseId === starts[0]!.responseId);
  assert.deepEqual(first.map((delta) => delta.kind), ["text", "thinking", "text"], "text and thinking share the response identity");
});

test("a failed or cancelled invoke still settles its response identity", async () => {
  const controller = new AbortController();
  const events: RunEvent<never>[] = [];
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1,
    contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
    modelClient: { async invoke(_input, _signal, observer) { observer.onTextDelta("partial"); controller.abort(); throw new Error("cancelled writer"); } },
    toolDispatcher: { async execute() { throw new Error("not called"); } },
    eventSink: (event) => events.push(event),
  });
  await assert.rejects(() => loop.run([], controller.signal, () => undefined), /cancelled writer/);
  const starts = events.filter((event) => event.type === "response_start");
  const settled = events.filter((event) => event.type === "response_settled");
  assert.equal(starts.length, 1);
  assert.equal(settled.length, 1, "a mid-invoke abort settles the open response");
  assert.equal(starts[0]!.responseId, settled[0]!.responseId);
});

test("input-overflow recovery retries with a new response identity", async () => {
  const events: RunEvent<never>[] = [];
  let calls = 0;
  const loop = new AgentLoop<RuntimeMessage, Input, never>({
    maxModelTurns: 1,
    contextAssembler: {
      async assemble({ history, recovery }) {
        const next = recovery ? [{ role: "summary", content: "compacted" }] : [...history];
        return { history: next, modelInput: { history: next } };
      },
    },
    modelClient: {
      isInputTooLargeError(error) { return error instanceof Error && error.message === "context too large"; },
      async invoke(_input, _signal, observer) {
        calls += 1;
        if (calls === 1) { observer.onTextDelta("lost prefix"); throw new Error("context too large"); }
        observer.onTextDelta("recovered answer");
        return { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] };
      },
    },
    toolDispatcher: { async execute() { throw new Error("not called"); } },
    eventSink: (event) => events.push(event),
  });
  await loop.run([{ role: "user", content: "large" }], new AbortController().signal, () => undefined);
  const starts = events.filter((event) => event.type === "response_start");
  const settled = events.filter((event) => event.type === "response_settled");
  const deltas = events.filter((event) => event.type === "model_delta");
  assert.equal(starts.length, 2, "the retried invoke is a new response");
  assert.equal(settled.length, 2, "the failed attempt settles before the retry starts");
  assert.notEqual(starts[0]!.responseId, starts[1]!.responseId);
  assert.deepEqual(deltas.map((delta) => [delta.responseId, delta.delta]), [
    [starts[0]!.responseId, "lost prefix"],
    [starts[1]!.responseId, "recovered answer"],
  ]);
});

test("a recovery attempt settles even when it fails or is cancelled", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const events: RunEvent<never>[] = [];
    let calls = 0;
    const loop = new AgentLoop<RuntimeMessage, Input, never>({
      maxModelTurns: 1,
      contextAssembler: { async assemble({ history }) { return { history: [...history], modelInput: { history: [...history] } }; } },
      modelClient: {
        isInputTooLargeError(error) { return error instanceof Error && error.message === "overflow"; },
        async invoke(_input, _signal, observer) {
          calls += 1;
          observer.onTextDelta(`attempt ${calls}`);
          if (calls === 1) throw new Error("overflow");
          if (cancel) controller.abort();
          throw new Error("recovery failed");
        },
      },
      toolDispatcher: { async execute() { throw new Error("unused"); } },
      eventSink: (event) => events.push(event),
    });
    await assert.rejects(loop.run([], controller.signal, () => undefined), /recovery failed/);
    const lifecycle = events.filter((event) => event.type === "response_start" || event.type === "response_settled");
    assert.deepEqual(lifecycle.map((event) => event.type), [
      "response_start", "response_settled", "response_start", "response_settled",
    ]);
    assert.equal(lifecycle[0]!.responseId, lifecycle[1]!.responseId);
    assert.equal(lifecycle[2]!.responseId, lifecycle[3]!.responseId);
    assert.notEqual(lifecycle[0]!.responseId, lifecycle[2]!.responseId);
    assert.equal(loop.snapshot().phase, cancel ? "cancelled" : "failed");
  }
});
