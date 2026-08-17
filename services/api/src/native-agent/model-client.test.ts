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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";

import type { ResolvedProxy } from "@science-agent/schema";

import {
  normalizeUsage,
  proxyDispatcher,
  resolveModelClientPolicy,
  streamModelTurn,
  toAnthropicMessages,
  type ModelClientPolicy,
} from "./model-client.js";

const policy: ModelClientPolicy = { maxRetries: 1, maxTokens: 1_024, requestTimeoutMs: 5_000 };

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sse(response: ServerResponse, frames: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("openai stream assembles text, thinking, split tool calls, and usage", async () => {
  let requestPayload: Record<string, unknown> | undefined;
  await withServer(async (request, response) => {
    requestPayload = JSON.parse(await readBody(request)) as Record<string, unknown>;
    sse(response, [
      { choices: [{ delta: { reasoning_content: "thinking…" } }] },
      { choices: [{ delta: { content: "Hello " } }] },
      { choices: [{ delta: { content: "world" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":' }, thought_signature: "sig-9" }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"TP53"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 4 } } },
    ]);
  }, async (baseUrl) => {
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const turn = await streamModelTurn(
      { apiToken: "secret", baseUrl, model: "stub" },
      "system prompt",
      [{ role: "user", content: "hi" }],
      [{ description: "Lookup", name: "lookup", parameters: { type: "object" } }],
      policy,
      new AbortController().signal,
      {
        onTextDelta: (delta) => textDeltas.push(delta),
        onThinkingDelta: (delta) => thinkingDeltas.push(delta),
      },
    );

    assert.deepEqual(textDeltas, ["Hello ", "world"]);
    assert.deepEqual(thinkingDeltas, ["thinking…"]);
    assert.equal(turn.assistantMessage.content, "Hello world");
    const calls = turn.assistantMessage.tool_calls as Array<Record<string, unknown>>;
    assert.equal((calls[0]!.function as Record<string, unknown>).arguments, '{"q":"TP53"}');
    assert.equal(calls[0]!.thought_signature, "sig-9");
    assert.deepEqual(turn.toolCalls[0]!.args, { q: "TP53" });
    assert.deepEqual(turn.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19, cacheReadTokens: 4, cacheWriteTokens: null });

    // Request carried system prompt, tools, streaming usage option, and auth.
    const messages = requestPayload!.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]!.role, "system");
    assert.equal((requestPayload!.stream_options as Record<string, unknown>).include_usage, true);
    assert.equal((requestPayload!.tools as unknown[]).length, 1);
  });
});

test("pre-stream 500 is retried once before succeeding", async () => {
  let attempts = 0;
  await withServer((_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(500).end("boom");
      return;
    }
    sse(response, [{ choices: [{ delta: { content: "ok" } }] }]);
  }, async (baseUrl) => {
    const turn = await streamModelTurn(
      { baseUrl, model: "stub" },
      "s",
      [{ role: "user", content: "hi" }],
      [],
      policy,
      new AbortController().signal,
    );
    assert.equal(turn.assistantMessage.content, "ok");
    assert.equal(attempts, 2);
  });
});

test("anthropic dialect translates history and assembles tool_use turns", async () => {
  let requestPayload: Record<string, unknown> | undefined;
  let requestPath = "";
  await withServer(async (request, response) => {
    requestPath = request.url ?? "";
    requestPayload = JSON.parse(await readBody(request)) as Record<string, unknown>;
    sse(response, [
      { type: "message_start", message: { usage: { input_tokens: 30, cache_read_input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Running " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lookup" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu-1", name: "lookup" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"TP' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '53"}' } },
      { type: "message_delta", usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ]);
  }, async (baseUrl) => {
    const turn = await streamModelTurn(
      { apiToken: "key", baseUrl: `${baseUrl}/api/plan`, model: "claude-stub" },
      "system prompt",
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", name: "lookup", content: "result-1" },
      ],
      [{ description: "Lookup", name: "lookup", parameters: { type: "object" } }],
      policy,
      new AbortController().signal,
    );

    assert.match(requestPath, /\/api\/plan\/v1\/messages$/);
    assert.equal(turn.assistantMessage.content, "Running lookup");
    assert.deepEqual(turn.toolCalls[0]!.args, { q: "TP53" });
    assert.deepEqual(turn.usage, { inputTokens: 30, outputTokens: 9, totalTokens: 39, cacheReadTokens: 10, cacheWriteTokens: null });

    // History translation: assistant tool call → tool_use; tool result merged
    // into a user message with a tool_result block; tools use input_schema.
    const messages = requestPayload!.messages as Array<{ content: Array<Record<string, unknown>>; role: string }>;
    assert.equal(messages.length, 3);
    assert.equal(messages[1]!.content[0]!.type, "tool_use");
    assert.equal(messages[2]!.content[0]!.type, "tool_result");
    const tools = requestPayload!.tools as Array<Record<string, unknown>>;
    assert("input_schema" in tools[0]!);
  });
});

test("toAnthropicMessages merges consecutive tool results into one user message", () => {
  const messages = toAnthropicMessages([
    { role: "assistant", content: "", tool_calls: [
      { id: "a", type: "function", function: { name: "x", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "y", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "a", content: "ra" },
    { role: "tool", tool_call_id: "b", content: "rb" },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1]!.content.length, 2);
  assert(messages[1]!.content.every((block) => block.type === "tool_result"));
});

test("usage normalization tolerates provider spellings", () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 1, output_tokens: 2 }), {
    inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: null, cacheWriteTokens: null,
  });
  assert.equal(normalizeUsage({ prompt_tokens: 1 }), undefined);
  assert.equal(normalizeUsage(null), undefined);
});

test("model client policy env parsing validates values", () => {
  assert.equal(resolveModelClientPolicy({}).requestTimeoutMs, 600_000);
  assert.equal(resolveModelClientPolicy({ SCIENCE_AGENT_LLM_TIMEOUT_SECONDS: "30" }).requestTimeoutMs, 30_000);
  assert.throws(() => resolveModelClientPolicy({ SCIENCE_AGENT_LLM_TIMEOUT_SECONDS: "0" }));
  assert.throws(() => resolveModelClientPolicy({ SCIENCE_AGENT_LLM_MAX_RETRIES: "-1" }));
});

test("model proxy policy selects the right dispatcher", () => {
  // "environment" keeps the process default (undefined dispatcher); the other
  // modes pin one, and an incomplete url policy fails loudly.
  assert.equal(proxyDispatcher(undefined), undefined);
  assert.equal(proxyDispatcher({ mode: "environment" }), undefined);
  assert.notEqual(proxyDispatcher({ mode: "direct" }), undefined);
  assert.notEqual(proxyDispatcher({ mode: "url", url: "http://pinned.test:3128" }), undefined);
  assert.throws(() => proxyDispatcher({ mode: "url" } as ResolvedProxy), /requires a proxy URL/);
});
