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

import { ModelRequestError, type ModelTurn, type streamModelTurn } from "@sciencediscovery/model";

import { startModelGateway, toModelRequest } from "./jiuwenswarm-model-gateway.js";

const POLICY = { maxRetries: 0, maxTokens: 1000, requestTimeoutMs: 1000 };
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

test("invalid truncated tool arguments fail before a tool call is forwarded", async (context) => {
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
    assert.match(await response.text(), /invalid tool arguments after reaching max_tokens/);
    assert.equal(g.lastFailure()?.truncated, true);
    assert.deepEqual(g.lastFailure()?.tools, ["run_shell"]);
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
