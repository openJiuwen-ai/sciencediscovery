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
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRequestError, type ModelTurn, type streamModelTurn } from "@sciencediscovery/model";

import { isSwarmCompaction, startModelGateway, toModelRequest } from "./jiuwenswarm-model-gateway.js";

const POLICY = { maxRetries: 0, maxTokens: 1000, requestTimeoutMs: 1000 };

test("task admission counts plain replies and rejects excess calls before upstream; auxiliary calls do not consume turns", async () => {
  const controller = new AbortController();
  let turns = 0;
  let progress = 0;
  const { calls, streamer } = fakeStreamer(answer(), [["text", "working"]]);
  const g = await startModelGateway(ENDPOINT, POLICY, controller.signal, streamer, undefined, {
    progress() { progress++; }, beforeTurn() { if (++turns > 1) controller.abort(); },
  });
  const compaction = { messages: [{ role: "user", content: "## NON-NEGOTIABLE OUTPUT RULES\nDo NOT call any tools.\nYou are an Execution State Compression Assistant.\n<coverage_check>\n<state_snapshot>" }],
    tools: [{ type: "function", function: { name: "task" } }] };
  try {
    assert.equal(isSwarmCompaction(compaction), true);
    assert.equal(isSwarmCompaction({ messages: [{ role: "user", content: "Summarize <state_snapshot>" }] }), false);
    assert.equal((await post(g, compaction)).status, 200);
    assert.equal(turns, 0);
    assert.equal(progress, 1, "run-scoped compaction is real progress, including non-streaming HTTP responses");
    assert.equal(g.lastTurn(), undefined, "compaction must not overwrite task output/truncation state");
    const title = await fetch(`${g.url}/chat/completions`, { method: "POST", headers: {
      authorization: `Bearer ${g.token}`, "x-sciencediscovery-model-purpose": "housekeeping",
    }, body: JSON.stringify({ messages: [] }) });
    assert.equal(title.status, 200);
    assert.equal(turns, 0);
    assert.equal(progress, 1, "default-route housekeeping must not renew an unrelated latest run");
    assert.equal((await post(g, { messages: [{ role: "user", content: "hello" }] })).status, 200);
    assert.equal(turns, 1, "a task with no tools is still a model turn");
    assert.equal((await post(g, { stream: true, messages: [] })).status, 502);
    assert.equal(calls.length, 3, "the over-budget request must never reach the model");
  } finally { await g.close(); }
});

test("invalid arguments retain private diagnostics without leaking payload into ordinary logs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "model-arguments-"));
  const file = join(dir, "invalid.jsonl");
  const previous = process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE;
  process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE = file;
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const raw = '{"secret":"private-payload"';
  const { streamer } = fakeStreamer(answer({
    truncated: false,
    assistantMessage: { role: "assistant", content: "", tool_calls: [{ id: "bad-call", type: "function", function: { name: "task", arguments: raw } }] },
    toolCalls: [{ id: "bad-call", name: "task", args: {}, argsParseError: "Unexpected private-payload" }],
  }));
  const g = await gateway(streamer);
  try {
    const response = await post(g, { stream: true, messages: [] });
    assert.match(await response.text(), /Model returned invalid tool arguments/);
    const entry = JSON.parse(await readFile(file, "utf8"));
    assert.equal(entry.calls[0].rawArguments, raw);
    assert.equal(entry.calls[0].error, "Unexpected private-payload");
    assert.equal(entry.truncated, false);
    assert.equal(entry.calls[0].toolCallId, "bad-call");
    assert.match(entry.requestId, /^chatcmpl-/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!warnings.join("").includes("private-payload"));
    // A logging failure must preserve the original model error.
    process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE = join(dir, "absent", "invalid.jsonl");
    assert.match(await (await post(g, { stream: true, messages: [] })).text(), /Model returned invalid tool arguments/);
    assert.ok(warnings.some((line) => line.includes("diagnostic file write failed")));
  } finally {
    await g.close();
    if (previous === undefined) delete process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE;
    else process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
const ENDPOINT = { baseUrl: "http://provider.test", model: "claude-x", apiProtocol: "anthropic-messages" as const };

type Call = { history: unknown[]; systemPrompt: string; tools: unknown[]; endpoint: unknown };

function fakeStreamer(turn: ModelTurn | Error, deltas: Array<["text" | "thinking", string]> = []) {
  const calls: Call[] = [];
  const streamer = (async (endpoint, systemPrompt, history, tools, _policy, _signal, callbacks) => {
    calls.push({ endpoint, history, systemPrompt, tools });
    for (const [kind, delta] of deltas) (kind === "text" ? callbacks?.onTextDelta : callbacks?.onThinkingDelta)?.(delta);
    if (turn instanceof Error) throw turn;
    return turn;
  }) as typeof streamModelTurn;
  return { calls, streamer };
}

const answer = (extra: Partial<ModelTurn> = {}): ModelTurn => ({
  assistantMessage: { role: "assistant", content: "hello" }, toolCalls: [],
  usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 }, ...extra,
});

async function gateway(streamer: typeof streamModelTurn) {
  const controller = new AbortController();
  const started = await startModelGateway(ENDPOINT, POLICY, controller.signal, streamer);
  return { ...started, controller };
}

const post = (g: { url: string; token: string }, body: unknown, token = g.token) =>
  fetch(`${g.url}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

const events = async (response: Response) => (await response.text()).split("\n\n").filter((part) => part.startsWith("data: ") && !part.includes("[DONE]"))
  .map((part) => JSON.parse(part.slice(6)));

test("gateway diagnostics report an active model request without logging its payload", async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const streamer = (async (_e: unknown, _s: unknown, _h: unknown, _t: unknown, _p: unknown,
    _signal: AbortSignal, callbacks: { onProgress?: () => void }) => {
    callbacks.onProgress?.();
    started();
    await waiting;
    return answer();
  }) as unknown as typeof streamModelTurn;
  const g = await gateway(streamer);
  try {
    const pending = post(g, { stream: true, messages: [{ role: "user", content: "private prompt" }],
      tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }] });
    await entered;
    const active = g.diagnostics();
    assert.equal(active.length, 1);
    assert.equal(active[0]?.purpose, "task");
    assert.equal(active[0]?.phase, "receiving");
    assert.equal(active[0]?.upstreamChunks, 1);
    assert.equal(JSON.stringify(active).includes("private prompt"), false);
    release();
    await pending;
    assert.deepEqual(g.diagnostics(), []);
  } finally { release(); await g.close(); }
});

test("invalid truncated tool arguments are withheld for recovery without a terminal failure", async (context) => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (line: string) => warnings.push(line));
  const raw = '{"secret":"private-payload"';
  const { streamer } = fakeStreamer(answer({ truncated: true,
    toolCalls: [{ id: "bad-call", name: "run_shell", args: {}, argsParseError: "Unexpected private-payload" }],
    assistantMessage: { role: "assistant", content: "", tool_calls: [{ id: "bad-call", type: "function",
      function: { name: "run_shell", arguments: raw } }] },
  }));
  const g = await gateway(streamer);
  try {
    const response = await post(g, { stream: true, messages: [{ role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "run_shell", parameters: { type: "object" } } }] });
    const wire = await response.text();
    assert.match(wire, /output_limit:tool_calls_withheld/);
    assert.doesNotMatch(wire, /"tool_calls"/);
    assert.equal(g.lastFailure(), undefined);
    assert.equal(g.lastTurn()?.truncated, true);
    assert.equal(g.lastTurn()?.toolCalls, 1);
    assert.equal(warnings.some((line) => line.includes("private-payload")), false);
  } finally { await g.close(); }
});

test("a chat-completions request is served in the model's own protocol, with the endpoint the run configured", async () => {
  const { calls, streamer } = fakeStreamer(answer());
  const g = await gateway(streamer);
  try {
    const response = await post(g, {
      model: "sd-alias", stream: false,
      messages: [{ role: "system", content: "You are X." }, { role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "echo", description: "Echo.", parameters: { type: "object" } } }],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0]!.endpoint, ENDPOINT, "the real model and protocol, not the alias JiuwenSwarm used");
    assert.equal(calls[0]!.systemPrompt, "You are X.");
    assert.deepEqual(calls[0]!.history, [{ role: "user", content: "hi" }]);
    assert.deepEqual(calls[0]!.tools, [{ name: "echo", description: "Echo.", parameters: { type: "object" } }]);
    const body = await response.json() as any;
    assert.equal(body.choices[0].message.content, "hello");
    assert.deepEqual(body.usage, { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 });
  } finally {
    await g.close();
  }
});

test("a streamed answer carries text, thinking, tool calls, the finish reason and usage as chat-completion chunks", async () => {
  const turn = answer({ toolCalls: [{ id: "call-1", name: "echo", args: { word: "a" } }], usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, cacheReadTokens: 3 } });
  const { streamer } = fakeStreamer(turn, [["thinking", "hmm"], ["text", "he"], ["text", "llo"]]);
  const g = await gateway(streamer);
  try {
    const chunks = await events(await post(g, { stream: true, messages: [{ role: "user", content: "hi" }] }));
    const deltas = chunks.map((chunk) => chunk.choices[0].delta);
    assert.equal(deltas.map((delta) => delta.reasoning_content ?? "").join(""), "hmm");
    assert.equal(deltas.map((delta) => delta.content ?? "").join(""), "hello");
    assert.deepEqual(deltas.find((delta) => delta.tool_calls).tool_calls, [{ index: 0, id: "call-1", type: "function", function: { name: "echo", arguments: "{\"word\":\"a\"}" } }]);
    const last = chunks.at(-1);
    assert.equal(last.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(last.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } });
  } finally {
    await g.close();
  }
});

test("a truncated turn finishes with length, so the reader is told why the answer stopped", async () => {
  const { streamer } = fakeStreamer(answer({ truncated: true }));
  const g = await gateway(streamer);
  try {
    const chunks = await events(await post(g, { stream: true, messages: [{ role: "user", content: "hi" }] }));
    assert.equal(chunks.at(-1).choices[0].finish_reason, "length");
  } finally {
    await g.close();
  }
});

test("tool arguments wait for a complete response, with parallel identity and no replay", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const g = await gateway(async (_e, _p, _h, _t, _policy, _signal, callbacks) => {
    callbacks!.onToolCallDelta!({ index: 0, id: "c1", name: "write", arguments: '{"text":' });
    callbacks!.onToolCallDelta!({ index: 1, id: "c2", name: "search", arguments: '{"q":"birds"}' });
    await gate;
    callbacks!.onToolCallDelta!({ index: 0, arguments: '"report"}' });
    return answer({ toolCalls: [{ id: "c1", name: "write", args: { text: "report" } }, { id: "c2", name: "search", args: { q: "birds" } }] });
  });
  try {
    const response = await fetch(`${g.url}/chat/completions`, { method: "POST", signal: AbortSignal.timeout(2_000),
      headers: { authorization: `Bearer ${g.token}`, "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [] }) });
    const reader = response.body!.getReader();
    const first = await reader.read();
    let wire = new TextDecoder().decode(first.value);
    assert.doesNotMatch(wire, /tool_calls/); // Tool deltas are quarantined until finish.
    finish();
    for (;;) { const next = await reader.read(); if (next.done) break; wire += new TextDecoder().decode(next.value); }
    const chunks = wire.split("\n\n").filter((s) => s.startsWith("data: {")).map((s) => JSON.parse(s.slice(6)));
    const calls = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    assert.equal(calls.filter((c) => c.index === 0).map((c) => c.function.arguments).join(""), '{"text":"report"}');
    assert.equal(calls.filter((c) => c.index === 1).map((c) => c.function.arguments).join(""), '{"q":"birds"}');
    assert.deepEqual(calls.filter((c) => c.id).map((c) => c.id), ["c1", "c2"]);
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
  } finally { finish(); await g.close(); }
});

test("upstream transport progress does not manufacture downstream model content", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const g = await gateway(async (_e, _p, _h, _t, _policy, _signal, callbacks) => {
    callbacks!.onTextDelta!("start");
    callbacks!.onProgress!();
    await gate;
    return answer();
  });
  try {
    const reader = (await post(g, { stream: true, messages: [] })).body!.getReader();
    await reader.read();
    const next = reader.read();
    assert.equal(await Promise.race([next.then(() => "data"), new Promise((r) => setTimeout(() => r("silent"), 40))]), "silent");
    finish();
    await next;
  } finally { finish(); await g.close(); }
});

test("cancelling during tool argument streaming aborts the upstream request", async () => {
  let observedAbort!: () => void;
  const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
  const g = await gateway(async (_e, _p, _h, _t, _policy, signal, callbacks) => {
    callbacks!.onToolCallDelta!({ index: 0, id: "c1", name: "write", arguments: '{"text":' });
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
      observedAbort(); reject(new Error("upstream cancelled"));
    }, { once: true }));
    return answer();
  });
  try {
    const reader = (await post(g, { stream: true, messages: [] })).body!.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.race([aborted, new Promise((_r, reject) => {
      const timer = setTimeout(() => reject(new Error("upstream was not cancelled")), 2_000); timer.unref();
    })]);
  } finally { await g.close(); }
});

test("the provider's HTTP status reaches JiuwenSwarm as that status, so a 429 is a 429", async () => {
  const { streamer } = fakeStreamer(new ModelRequestError("Model request failed (429): slow down", 429));
  const g = await gateway(streamer);
  try {
    for (const stream of [true, false]) {
      const response = await post(g, { stream, messages: [{ role: "user", content: "hi" }] });
      assert.equal(response.status, 429);
      assert.match(((await response.json()) as any).error.message, /slow down/);
    }
  } finally {
    await g.close();
  }
});

test("a failure that is not an HTTP status is a 502", async () => {
  const { streamer } = fakeStreamer(new Error("socket hang up"));
  const g = await gateway(streamer);
  try {
    assert.equal((await post(g, { stream: true, messages: [{ role: "user", content: "hi" }] })).status, 502);
  } finally {
    await g.close();
  }
});

test("only the run's own token is accepted", async () => {
  const { calls, streamer } = fakeStreamer(answer());
  const g = await gateway(streamer);
  try {
    assert.equal((await post(g, { messages: [] }, "wrong")).status, 401);
    assert.equal((await fetch(`${g.url}/chat/completions`, { method: "POST", body: "{}" })).status, 401);
    assert.equal(calls.length, 0);
  } finally {
    await g.close();
  }
});

test("a request with an image is refused, which is how JiuwenSwarm's image probe learns the model has no image input here", async () => {
  const { calls, streamer } = fakeStreamer(answer());
  const g = await gateway(streamer);
  try {
    const response = await post(g, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  } finally {
    await g.close();
  }
});

test("closing the run's signal cancels a model call in flight", async () => {
  let aborted = false;
  const streamer = (async (_e: unknown, _s: unknown, _h: unknown, _t: unknown, _p: unknown, signal: AbortSignal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }));
    throw new Error("aborted");
  }) as unknown as typeof streamModelTurn;
  const g = await gateway(streamer);
  try {
    const pending = post(g, { stream: true, messages: [{ role: "user", content: "hi" }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    g.controller.abort();
    await pending;
    assert.equal(aborted, true);
  } finally {
    await g.close();
  }
});

test("text parts of a message are joined and several system messages become one system prompt", () => {
  const request = toModelRequest({ messages: [
    { role: "system", content: "A" }, { role: "system", content: [{ type: "text", text: "B" }] },
    { role: "user", content: [{ type: "text", text: "he" }, { type: "text", text: "llo" }] },
    { role: "tool", tool_call_id: "c1", name: "echo", content: "out" },
  ] });
  assert.equal(request.systemPrompt, "A\n\nB");
  assert.deepEqual(request.history, [{ role: "user", content: "hello" }, { role: "tool", tool_call_id: "c1", name: "echo", content: "out" }]);
});

test("what a provider needs sent back is restored: JiuwenSwarm's rebuilt assistant message is replaced by the model client's own", async () => {
  const nativeMessage = {
    role: "assistant", content: "", anthropic_content: [{ type: "thinking", thinking: "plan", signature: "sig-1" }, { type: "tool_use", id: "call-1", name: "echo", input: {} }],
    tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: "{}" } }],
  };
  const { calls, streamer } = fakeStreamer(answer({ assistantMessage: nativeMessage as never, toolCalls: [{ id: "call-1", name: "echo", args: {} }] }));
  const g = await gateway(streamer);
  try {
    await post(g, { messages: [{ role: "user", content: "go" }] });
    // The next model call of the same run: JiuwenSwarm sends back what it rebuilt from the first answer.
    await post(g, { messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", name: "echo", content: "out" },
    ] });
    const history = calls[1]!.history as Array<Record<string, unknown>>;
    assert.deepEqual(history[1], nativeMessage, "the thinking block and its signature are back");
    assert.deepEqual(history[0], { role: "user", content: "go" });
    assert.equal(history[2]!.role, "tool");
  } finally {
    await g.close();
  }
});

test("restore also serves the run's final messages, and leaves other messages and unknown turns alone", async () => {
  const nativeMessage = { role: "assistant", content: "done", response_items: [{ type: "message" }] };
  const { streamer } = fakeStreamer(answer({ assistantMessage: nativeMessage as never }));
  const g = await gateway(streamer);
  try {
    await post(g, { stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(g.restore({ role: "assistant", content: "done" }), nativeMessage);
    assert.deepEqual(g.restore({ role: "assistant", content: "something else" }), { role: "assistant", content: "something else" });
    assert.deepEqual(g.restore({ role: "user", content: "done" }), { role: "user", content: "done" });
  } finally {
    await g.close();
  }
});


test("truncated responses withhold ALL tools in streaming and unary modes, preserving usage and diagnostics", async () => {
  for (const stream of [false, true]) {
    let calls = 0;
    const raw = '{"text":"unfinished';
    const turn = answer({ truncated: true, assistantMessage: { role: "assistant", content: "", tool_calls: [
      { id: "bad", type: "function", function: { name: "write", arguments: raw } },
    ] }, toolCalls: [
      { id: "valid", name: "write", args: { text: "syntactically valid but withheld" } },
      { id: "bad", name: "write", args: {}, argsParseError: "unfinished string" },
    ] });
    const g = await gateway(async (_e, _p, _h, _t, _policy, _signal, callbacks) => {
      calls++;
      callbacks?.onToolCallDelta?.({ index: 0, id: "valid", name: "write", arguments: '{"text":"partial"}' });
      callbacks?.onToolCallDelta?.({ index: 1, id: "bad", name: "write", arguments: raw });
      return turn;
    });
    try {
      const response = await post(g, { stream, messages: [] });
      assert.equal(response.status, 200);
      const wire = await response.text();
      const payloads = stream ? wire.split("\n\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6))) : [JSON.parse(wire)];
      for (const p of payloads) {
        assert.equal(p.error, undefined);
        assert.equal((p.choices[0].delta ?? p.choices[0].message).tool_calls, undefined);
      }
      assert.equal(payloads.at(-1).choices[0].finish_reason, "length");
      assert.match(wire, /output_limit:tool_calls_withheld/);
      assert.doesNotMatch(wire, /unfinished|string|syntactically valid/);
      assert.equal(calls, 1, "gateway must not retry the model itself");
      assert.equal(g.lastTurn()?.truncated, true);
      assert.ok(payloads.at(-1).usage);
    } finally { await g.close(); }
  }
});

test("recovery diagnostics count feedback but do not mask a later provider error", async () => {
  let count = 0;
  const g = await gateway(async () => {
    if (++count === 2) throw new ModelRequestError("Insufficient Balance", 402);
    return answer({ truncated: true, toolCalls: [], assistantMessage: { role: "assistant", content: "" } });
  });
  try {
    const request = { messages: [{ role: "user", content: "[Output limit recovery 2/2; reasoning_only] Try one small action." }] };
    assert.equal((await post(g, request)).status, 200);
    assert.equal(g.lastTurn()?.recoveryAttempts, 2);
    assert.equal((await post(g, request)).status, 402);
    assert.equal(g.lastTurn(), undefined, "previous truncation must not mask a new provider failure");
  } finally { await g.close(); }
});

for (const stream of [false, true]) {
  test(`cancellation stops a blocked input recorder before upstream dispatch (stream=${stream})`, { timeout: 3000 }, async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const { calls, streamer } = fakeStreamer(answer());
    const g = await startModelGateway(ENDPOINT, POLICY, controller.signal, streamer, {
      async request() { enter(); await blocked; }, async completed() {},
    });
    try {
      const pending = post(g, { stream, messages: [] });
      await entered;
      assert.equal(g.diagnostics()[0]?.phase, "recording_input");
      controller.abort(new Error("test cancellation"));
      const response = await pending;
      assert.equal(response.status, 502);
      assert.match(await response.text(), /aborted/);
      assert.equal(calls.length, 0);
      release();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length, 0, "late recording completion must not dispatch an aborted model call");
    } finally { release(); await g.close(); }
  });
}

test("cancellation stops waiting for completion recording and tolerates its late rejection", { timeout: 3000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  let enter!: () => void;
  let reject!: (error: Error) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>((_resolve, fail) => { reject = fail; });
  const controller = new AbortController();
  const { calls, streamer } = fakeStreamer(answer());
  const g = await startModelGateway(ENDPOINT, POLICY, controller.signal, streamer, {
    async request() {}, async completed() { enter(); await blocked; },
  });
  try {
    const pending = post(g, { messages: [] });
    await entered;
    assert.equal(g.diagnostics()[0]?.phase, "recording_completion");
    controller.abort();
    assert.equal((await pending).status, 502);
    assert.equal(calls.length, 1);
    reject(new Error("late storage failure"));
    await new Promise(resolve => setImmediate(resolve));
  } finally { reject(new Error("cleanup")); await g.close(); }
});

for (const truncated of [false, true]) {
  test(`buffered tool arguments emit decoded progress without exposing a partial call (truncated=${truncated})`, { timeout: 5000 }, async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const tool = { id: "call-buffered", name: "run_shell", args: { command: "private-command" } };
    const streamer = (async (_e, _s, _h, _t, _p, _signal, callbacks) => {
      callbacks?.onProgress?.();
      callbacks?.onToolCallDelta?.({ index: 0, id: tool.id, name: tool.name, arguments: '{"command":"private-' });
      await blocked;
      return answer({ truncated, toolCalls: [tool], assistantMessage: { role: "assistant", content: "", tool_calls: [
        { id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } },
      ] } });
    }) as typeof streamModelTurn;
    const g = await gateway(streamer);
    try {
      const response = await post(g, { stream: true, messages: [] });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let prefix = "";
      while (!prefix.includes('"delta":{}')) {
        const next = await reader.read();
        assert.equal(next.done, false, "a progress data event must arrive before the model finishes");
        prefix += decoder.decode(next.value, { stream: true });
      }
      const progress = prefix.split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.ok(progress.some(event => Object.keys(event.choices[0].delta).length === 0 && event.choices[0].finish_reason === null));
      assert.doesNotMatch(prefix, /private-|run_shell|tool_calls|\[DONE\]/);
      assert.equal(g.diagnostics()[0]?.downstreamChunks, 1);
      release();
      let suffix = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        suffix += decoder.decode(next.value, { stream: true });
      }
      assert.match(suffix, /\[DONE\]/);
      const finalEvents = suffix.split("\n\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]"))
        .map(line => JSON.parse(line.slice(6)));
      const calls = finalEvents.flatMap(event => event.choices[0].delta.tool_calls ?? []);
      assert.equal(calls.length, truncated ? 0 : 1);
      if (!truncated) assert.deepEqual(JSON.parse(calls[0].function.arguments), tool.args);
      else assert.match(suffix, /output_limit:tool_calls_withheld/);
      assert.equal(finalEvents.at(-1).choices[0].finish_reason, truncated ? "length" : "tool_calls");
    } finally { release(); await g.close(); }
  });
}
