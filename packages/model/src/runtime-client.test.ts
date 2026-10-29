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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ProviderModelClient } from "./runtime-client.js";
import { ModelRequestError, modelWireDiagnosticsOf, type ModelTurn } from "./client.js";
const endpoint = { baseUrl: "http://127.0.0.1:1", model: "synthetic" };
const policy = { maxTokens: 16, maxRetries: 0, requestTimeoutMs: 1000 };
const observer = { onProgress: () => undefined, onTextDelta: () => undefined, onThinkingDelta: () => undefined };
const input = { systemPrompt: "synthetic", history: [{ role: "user", content: "synthetic" }], tools: [] };
for (const failure of ["incomplete", "malformed"] as const) test(`runtime rejects ${failure} stream evidence`, async () => {
  const client = new ProviderModelClient(endpoint, policy, async () => ({ assistantMessage: { role: "assistant", content: "partial" }, toolCalls: [], ...(failure === "incomplete" ? { completionObserved: false } : { streamDiagnostics: { protocol: "openai-responses", unparseableSsePayloads: 1 } }) }));
  await assert.rejects(client.invoke(input, new AbortController().signal, observer), /Model stream/);
});
test("runtime rejects a completed terminal turn with no text and no tool call", async () => {
  const empty: ModelTurn = { assistantMessage: { role: "assistant", content: "  \n" }, toolCalls: [], completionObserved: true };
  const client = new ProviderModelClient(endpoint, policy, async () => empty);
  await assert.rejects(client.invoke(input, new AbortController().signal, observer), /empty terminal turn/);
  // An explicit output-limit finish keeps the existing truncation recovery path.
  const truncated = new ProviderModelClient(endpoint, policy, async () => ({ ...empty, truncated: true }));
  assert.equal((await truncated.invoke(input, new AbortController().signal, observer)).truncated, true);
});
test("runtime preserves original errors and unavailable usage without failing successful completion", async () => {
  const failure = new ModelRequestError("original provider error", 429);
  const bad = new ProviderModelClient(endpoint, policy, async () => { throw failure; });
  await assert.rejects(bad.invoke(input, new AbortController().signal, observer), e => e === failure);
  assert.equal(bad.isInputTooLargeError(failure), false);
  const turn: ModelTurn = { assistantMessage: { role: "assistant", content: "OK" }, toolCalls: [], completionObserved: true };
  const good = new ProviderModelClient(endpoint, policy, async () => turn);
  assert.equal((await good.invoke(input, new AbortController().signal, observer)).usage, undefined);
});

test("runtime rejects an empty terminal turn and its diagnostics carry the classification", async () => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    // The real transport reports its wire record on the success path; the record
    // this client hands to the run must say why the request failed.
    const client = new ProviderModelClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: "synthetic", proxy: { mode: "direct" } }, policy);
    const failure = await client.invoke(input, AbortSignal.timeout(2000), observer)
      .then(() => assert.fail("an empty terminal turn was accepted"), error => error);
    assert.match(String(failure.message), /empty terminal turn/);
    const diagnostics = modelWireDiagnosticsOf(failure);
    assert.equal(diagnostics?.error?.classification, "empty_completion");
    assert.equal(diagnostics?.hasText, false);
    assert.equal(diagnostics?.finishReason, "stop");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const terminal of ["missing-native-stop", "native-end-turn"] as const) test(`Messages HTTP stream with ${terminal} retains strict runtime completion`, async () => {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { usage: { input_tokens: 6 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "valid answer" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", ...(terminal === "native-end-turn" ? { delta: { stop_reason: "end_turn", stop_sequence: null } } : {}), usage: { output_tokens: 5 } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    // Text, usage and OpenAI's sentinel do not establish native Messages completion.
    res.end(terminal === "native-end-turn" ? 'data: {"type":"message_stop"}\n\n' : "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new ProviderModelClient({ ...endpoint, apiProtocol: "anthropic-messages", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, proxy: { mode: "direct" } }, policy);
    const result = client.invoke(input, AbortSignal.timeout(2000), observer);
    if (terminal === "missing-native-stop") await assert.rejects(result, /Model stream ended without a completion event/);
    else {
      const turn = await result;
      assert.equal(turn.assistantMessage.content, "valid answer");
      assert.equal(turn.usage?.inputTokens, 6);
      assert.equal(turn.usage?.outputTokens, 5);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const kind of ['missing-id', 'done-only', 'valid-finish'] as const) test(`Chat runtime strict completion/replay boundary: ${kind}`, async () => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const choice = kind === 'missing-id' ? { delta: { tool_calls: [{ index: 0, function: { name: 'echo', arguments: '{}' } }] }, finish_reason: 'tool_calls' }
      : { delta: { content: 'OK' }, ...(kind === 'valid-finish' ? { finish_reason: 'stop' } : {}) };
    res.end(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const client = new ProviderModelClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'synthetic', proxy: { mode: 'direct' } }, policy);
    const call = client.invoke(input, AbortSignal.timeout(2000), observer);
    if (kind === 'valid-finish') assert.equal((await call).assistantMessage.content, 'OK');
    else await assert.rejects(call, kind === 'missing-id' ? /omitted a tool call ID/ : /without a completion event/);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
