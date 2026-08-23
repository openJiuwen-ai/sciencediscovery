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

import { constrainCatalogThinking, lookupModelCatalog, type ResolvedProxy } from "@sciencediscovery/schema";

import {
  normalizeUsage,
  proxyDispatcher,
  resolveModelClientPolicy,
  streamModelTurn,
  toAnthropicMessages,
  type ModelClientPolicy,
} from "./client.js";

const policy: ModelClientPolicy = { maxRetries: 1, maxTokens: 1_024, requestTimeoutMs: 5_000 };

test("catalog preserves official period prices and exact model thinking capabilities", () => {
  const flash = lookupModelCatalog("deepseek-v4-flash", "deepseek")!.pricing!;
  const pro = lookupModelCatalog("deepseek-v4-pro", "deepseek")!.pricing!;
  assert.deepEqual(
    flash.periods?.map(({ cachedInput, id, input, output }) => ({ cachedInput, id, input, output })),
    [
      { cachedInput: 0.1, id: "peak", input: 3, output: 9 },
      { cachedInput: 0.05, id: "off-peak", input: 1.5, output: 4.5 },
    ],
  );
  assert.deepEqual(
    pro.periods?.map(({ cachedInput, id, input, output }) => ({ cachedInput, id, input, output })),
    [
      { cachedInput: 0.3, id: "peak", input: 9, output: 27 },
      { cachedInput: 0.15, id: "off-peak", input: 4.5, output: 13.5 },
    ],
  );
  assert.equal(flash.currency, "CNY");
  assert.equal(flash.unit, "per-1m-tokens");
  assert.equal(flash.source.retrievedAt, "2026-08-23");
  assert.match(flash.source.url, /^https:\/\/api-docs\.deepseek\.com\//);
  assert.deepEqual(flash.periods?.map(({ schedule }) => schedule), [
    {
      intervals: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
      kind: "weekdays",
      timeZone: "Asia/Shanghai",
    },
    { kind: "remainder", timeZone: "Asia/Shanghai" },
  ]);
  assert.equal(flash.notes, undefined, "catalog-internal period notes must not leak into the UI");
  assert.equal(lookupModelCatalog("deepseek-v4-pro", "siliconflow")?.pricing, undefined);

  assert.deepEqual(lookupModelCatalog("gpt-5.5", "openai")!.thinking!.efforts, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(lookupModelCatalog("gpt-5.4-mini", "openai")!.thinking!.efforts, ["low", "medium", "high", "xhigh"]);
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.deepEqual(lookupModelCatalog(model, "openai")!.thinking!.efforts, ["low", "medium", "high", "xhigh", "max"]);
  }
  assert.deepEqual(constrainCatalogThinking("gpt-5.5", "enabled", "max"), { effort: "xhigh", mode: "enabled" });

  const k3 = lookupModelCatalog("kimi-k3", "moonshot")!;
  assert.equal(k3.apiVariant, "kimi-k3");
  assert.deepEqual(k3.thinking, {
    defaultEffort: "max",
    defaultMode: "enabled",
    efforts: ["low", "high", "max"],
    modes: ["enabled"],
    supported: true,
  });
  assert.deepEqual(constrainCatalogThinking("kimi-k3", "disabled"), { effort: "max", mode: "enabled" });
  assert.equal(lookupModelCatalog("claude-haiku-4-5-20251001", "anthropic")!.apiVariant, "anthropic-legacy");
});

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
  let requestPath = "";
  await withServer(async (request, response) => {
    requestPath = request.url ?? "";
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
      {
        apiToken: "secret",
        apiProtocol: "openai-chat-completions",
        apiVariant: "deepseek",
        baseUrl,
        model: "stub",
      },
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
    assert.match(requestPath, /\/chat\/completions$/);
    const messages = requestPayload!.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]!.role, "system");
    assert.equal((requestPayload!.stream_options as Record<string, unknown>).include_usage, true);
    assert.equal((requestPayload!.tools as unknown[]).length, 1);
    assert.equal(requestPayload!.thinking, undefined);
    assert.equal(requestPayload!.reasoning_effort, undefined);
  });
});

test("chat variants map thinking controls without cross-provider fields", async () => {
  const requests: Record<string, unknown>[] = [];
  await withServer(async (request, response) => {
    requests.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
    sse(response, [{ choices: [{ delta: { content: "ok" } }] }]);
  }, async (baseUrl) => {
    const endpoints = [
      { apiVariant: "deepseek" as const, thinkingMode: "auto" as const },
      { apiVariant: "deepseek" as const, thinkingMode: "enabled" as const, thinkingEffort: "max" as const },
      { apiVariant: "deepseek" as const, thinkingMode: "disabled" as const },
      { apiVariant: "qwen" as const, thinkingMode: "enabled" as const },
      { apiVariant: "minimax" as const, thinkingMode: "disabled" as const },
      { apiVariant: "gemini" as const, thinkingMode: "enabled" as const },
      { apiVariant: "ollama" as const, thinkingMode: "enabled" as const },
    ];
    for (const endpoint of endpoints) {
      await streamModelTurn(
        { apiProtocol: "openai-chat-completions", baseUrl, model: "stub", ...endpoint },
        "s",
        [{ role: "user", content: "hi" }],
        [],
        policy,
        new AbortController().signal,
      );
    }
  });

  assert.equal(requests[0]!.thinking, undefined);
  assert.equal(requests[0]!.reasoning_effort, undefined);
  assert.deepEqual(requests[1]!.thinking, { type: "enabled" });
  assert.equal(requests[1]!.reasoning_effort, "max");
  assert.deepEqual(requests[2]!.thinking, { type: "disabled" });
  assert.equal(requests[2]!.reasoning_effort, undefined);
  assert.deepEqual(requests[3]!.chat_template_kwargs, { enable_thinking: true });
  assert.equal(requests[3]!.thinking, undefined);
  assert.equal(requests[3]!.reasoning_effort, undefined);
  assert.equal(requests[4]!.reasoning_split, false);
  assert.equal(requests[5]!.reasoning_effort, "high");
  assert.equal(requests[5]!.thinking, undefined);
  assert.equal(requests[6]!.thinking, undefined);
  assert.equal(requests[6]!.reasoning_effort, undefined);
  assert.equal(requests[6]!.chat_template_kwargs, undefined);
  assert.equal(requests[6]!.reasoning_split, undefined);
});

test("explicit protocol changes the endpoint even when the saved URL has an old suffix", async () => {
  const paths: string[] = [];
  await withServer(async (request, response) => {
    paths.push(request.url ?? "");
    await readBody(request);
    if (request.url?.endsWith("/responses")) {
      sse(response, [{ type: "response.output_text.delta", delta: "ok" }]);
    } else if (request.url?.endsWith("/messages")) {
      sse(response, [{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_delta", usage: { output_tokens: 1 } }]);
    } else {
      sse(response, [{ choices: [{ delta: { content: "ok" } }] }]);
    }
  }, async (baseUrl) => {
    const savedUrl = `${baseUrl}/v1/chat/completions`;
    for (const endpoint of [
      { apiProtocol: "openai-chat-completions" as const, apiVariant: "openai" as const },
      { apiProtocol: "openai-responses" as const, apiVariant: "responses" as const },
      { apiProtocol: "anthropic-messages" as const, apiVariant: "anthropic-adaptive" as const },
    ]) {
      await streamModelTurn(
        { ...endpoint, baseUrl: savedUrl, model: "stub" },
        "s",
        [{ role: "user", content: "hi" }],
        [],
        policy,
        new AbortController().signal,
      );
    }
  });
  assert.deepEqual(paths, ["/v1/chat/completions", "/v1/responses", "/v1/messages"]);
});

test("chat variants preserve only their required reasoning replay payload", async () => {
  const requests: Record<string, unknown>[] = [];
  await withServer(async (request, response) => {
    requests.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
    sse(response, [{ choices: [{ delta: { content: "ok" } }] }]);
  }, async (baseUrl) => {
    const history = [{
      role: "assistant",
      content: "",
      reasoning_content: "deep",
      reasoning: { text: "qwen" },
      reasoning_details: [{ text: "minimax" }],
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "lookup", arguments: "{}" },
        thought_signature: "gemini-signature",
        extra_content: { google: { thought_signature: "sig-extra" } },
      }],
    }];
    for (const apiVariant of ["deepseek", "qwen", "minimax", "gemini", "openai"] as const) {
      await streamModelTurn(
        { apiProtocol: "openai-chat-completions", apiVariant, baseUrl, model: "stub" },
        "s",
        history,
        [],
        policy,
        new AbortController().signal,
      );
    }
  });

  const assistants = requests.map((payload) => (payload.messages as Array<Record<string, unknown>>)[1]!);
  assert.equal(assistants[0]!.reasoning_content, "deep");
  assert.equal(assistants[0]!.reasoning, undefined);
  assert.equal(assistants[0]!.reasoning_details, undefined);
  assert.deepEqual(assistants[1]!.reasoning, { text: "qwen" });
  assert.equal(assistants[1]!.reasoning_content, undefined);
  assert.equal(assistants[2]!.reasoning_details, undefined);
  const geminiCall = (assistants[3]!.tool_calls as Array<Record<string, unknown>>)[0]!;
  assert.equal(geminiCall.thought_signature, "gemini-signature");
  // Current Gemini OpenAI-compat nests the signature in extra_content and
  // requires it back verbatim.
  assert.deepEqual(geminiCall.extra_content, { google: { thought_signature: "sig-extra" } });
  const openAiCall = (assistants[4]!.tool_calls as Array<Record<string, unknown>>)[0]!;
  assert.equal(openAiCall.thought_signature, undefined);
  assert.equal(openAiCall.extra_content, undefined);
});

test("MiniMax extracts reasoning_details and inline think without replaying it", async () => {
  let requestPayload: Record<string, unknown> | undefined;
  const thinking: string[] = [];
  await withServer(async (request, response) => {
    requestPayload = JSON.parse(await readBody(request)) as Record<string, unknown>;
    sse(response, [
      { choices: [{ delta: { reasoning_details: [{ text: "structured" }] } }] },
      { choices: [{ delta: { content: "<think>inline</think>answer" } }] },
    ]);
  }, async (baseUrl) => {
    const turn = await streamModelTurn(
      { apiProtocol: "openai-chat-completions", apiVariant: "minimax", baseUrl, model: "stub", thinkingMode: "enabled" },
      "s",
      [{ role: "assistant", content: "old", reasoning_details: [{ text: "do not replay" }] }],
      [],
      policy,
      new AbortController().signal,
      { onThinkingDelta: (delta) => thinking.push(delta) },
    );
    assert.equal(turn.assistantMessage.content, "answer");
    assert.deepEqual(turn.assistantMessage.reasoning_details, [{ text: "structured" }]);
  });
  assert.deepEqual(thinking, ["structured", "inline"]);
  const assistant = (requestPayload!.messages as Array<Record<string, unknown>>)[1]!;
  assert.equal(assistant.reasoning_details, undefined);
  assert.equal(requestPayload!.reasoning_split, true);
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
      { type: "content_block_stop", index: 1 },
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
    assert.equal(requestPayload!.thinking, undefined);
  });
});

test("Anthropic disabled mode sends only its own top-level thinking control", async () => {
  let requestPayload: Record<string, unknown> | undefined;
  await withServer(async (request, response) => {
    requestPayload = JSON.parse(await readBody(request)) as Record<string, unknown>;
    sse(response, [{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_delta", usage: { output_tokens: 1 } }]);
  }, async (baseUrl) => {
    await streamModelTurn(
      {
        apiProtocol: "anthropic-messages",
        apiVariant: "anthropic-adaptive",
        baseUrl,
        model: "claude",
        thinkingMode: "disabled",
      },
      "system",
      [{ role: "user", content: "hi" }],
      [],
      policy,
      new AbortController().signal,
    );
  });
  assert.deepEqual(requestPayload!.thinking, { type: "disabled" });
  assert.equal(requestPayload!.reasoning_effort, undefined);
  assert.equal(requestPayload!.reasoning, undefined);
});

test("Responses uses item protocol and replays reasoning plus function call IDs", async () => {
  const requests: Array<{ path: string; payload: Record<string, unknown> }> = [];
  let attempt = 0;
  await withServer(async (request, response) => {
    requests.push({
      path: request.url ?? "",
      payload: JSON.parse(await readBody(request)) as Record<string, unknown>,
    });
    attempt += 1;
    if (attempt === 1) {
      sse(response, [
        { type: "response.reasoning_summary_text.delta", delta: "summary" },
        { type: "response.output_item.done", output_index: 0, item: {
          id: "rs-1", type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "summary" }],
        } },
        { type: "response.output_item.done", output_index: 1, item: {
          id: "fc-1", type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"q":"TP53"}',
        } },
        { type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 } } },
      ]);
      return;
    }
    sse(response, [
      { type: "response.output_text.delta", delta: "done" },
      { type: "response.output_item.done", output_index: 0, item: {
        id: "msg-2", type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }],
      } },
    ]);
  }, async (baseUrl) => {
    const thinking: string[] = [];
    const first = await streamModelTurn(
      {
        apiProtocol: "openai-responses",
        apiVariant: "responses",
        baseUrl,
        model: "stub",
        thinkingMode: "enabled",
        thinkingEffort: "max",
      },
      "system",
      [{ role: "user", content: "find it" }],
      [{ description: "Lookup", name: "lookup", parameters: { type: "object" } }],
      policy,
      new AbortController().signal,
      { onThinkingDelta: (delta) => thinking.push(delta) },
    );
    assert.deepEqual(thinking, ["summary"]);
    assert.deepEqual(first.toolCalls[0], { args: { q: "TP53" }, id: "call-1", name: "lookup" });
    assert.equal((first.assistantMessage.response_items as unknown[]).length, 2);

    await streamModelTurn(
      { apiProtocol: "openai-responses", apiVariant: "responses", baseUrl, model: "stub", thinkingMode: "disabled" },
      "system",
      [
        { role: "user", content: "find it" },
        first.assistantMessage,
        { role: "tool", tool_call_id: "call-1", content: "result" },
      ],
      [],
      policy,
      new AbortController().signal,
    );
  });

  assert.match(requests[0]!.path, /\/responses$/);
  assert.equal(requests[0]!.payload.instructions, "system");
  assert.equal(requests[0]!.payload.messages, undefined);
  assert.deepEqual(requests[0]!.payload.reasoning, { effort: "max", summary: "auto" });
  assert.deepEqual(requests[0]!.payload.include, ["reasoning.encrypted_content"]);
  const replayInput = requests[1]!.payload.input as Array<Record<string, unknown>>;
  assert.equal(replayInput[1]!.id, "rs-1");
  assert.equal(replayInput[1]!.encrypted_content, "opaque");
  assert.equal(replayInput[2]!.id, "fc-1");
  assert.equal(replayInput[2]!.call_id, "call-1");
  assert.deepEqual(replayInput[3], { type: "function_call_output", call_id: "call-1", output: "result" });
  assert.deepEqual(requests[1]!.payload.reasoning, { effort: "none" });
});

test("Responses sends only the selected model's legal xhigh/max wire value", async () => {
  const requests: Record<string, unknown>[] = [];
  await withServer(async (request, response) => {
    requests.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
    sse(response, [{ type: "response.output_text.delta", delta: "ok" }]);
  }, async (baseUrl) => {
    for (const [model, thinkingEffort] of [
      ["gpt-5.5", "max"],
      ["gpt-5.4-mini", "xhigh"],
      ["gpt-5.6-sol", "max"],
    ] as const) {
      await streamModelTurn(
        {
          apiProtocol: "openai-responses",
          apiVariant: "responses",
          baseUrl,
          model,
          thinkingEffort,
          thinkingMode: "enabled",
        },
        "system",
        [{ role: "user", content: "hi" }],
        [],
        policy,
        new AbortController().signal,
      );
    }
  });
  assert.deepEqual(requests.map((payload) => payload.reasoning), [
    { effort: "xhigh", summary: "auto" },
    { effort: "xhigh", summary: "auto" },
    { effort: "max", summary: "auto" },
  ]);
});

test("Kimi K3 sends official reasoning_effort without a toggle and replays reasoning_content", async () => {
  const requests: Record<string, unknown>[] = [];
  let attempt = 0;
  await withServer(async (request, response) => {
    requests.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
    attempt += 1;
    sse(response, attempt === 1
      ? [
        { choices: [{ delta: { reasoning_content: "think" } }] },
        { choices: [{ delta: { content: "answer" } }] },
      ]
      : [{ choices: [{ delta: { content: "done" } }] }]);
  }, async (baseUrl) => {
    const first = await streamModelTurn(
      {
        apiProtocol: "openai-chat-completions",
        apiVariant: "deepseek",
        baseUrl,
        model: "kimi-k3",
        thinkingEffort: "low",
        thinkingMode: "enabled",
      },
      "system",
      [{ role: "user", content: "hi" }],
      [],
      policy,
      new AbortController().signal,
    );
    assert.equal(first.assistantMessage.reasoning_content, "think");
    await streamModelTurn(
      {
        apiProtocol: "openai-chat-completions",
        apiVariant: "deepseek",
        baseUrl,
        model: "kimi-k3",
        thinkingMode: "disabled",
      },
      "system",
      [first.assistantMessage, { role: "user", content: "again" }],
      [],
      policy,
      new AbortController().signal,
    );
  });
  assert.equal(requests[0]!.reasoning_effort, "low");
  assert.equal(requests[0]!.thinking, undefined);
  assert.equal(requests[1]!.reasoning_effort, "max", "legacy disabled is narrowed to K3 always-reasoning default max");
  assert.equal(requests[1]!.thinking, undefined);
  const replay = requests[1]!.messages as Array<Record<string, unknown>>;
  assert.equal(replay[1]!.reasoning_content, "think");
});

test("Claude Haiku 4.5 overrides an adaptive profile with legal legacy thinking", async () => {
  let payload: Record<string, unknown> | undefined;
  await withServer(async (request, response) => {
    payload = JSON.parse(await readBody(request)) as Record<string, unknown>;
    sse(response, [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "message_delta", usage: { output_tokens: 1 } },
    ]);
  }, async (baseUrl) => {
    await streamModelTurn(
      {
        apiProtocol: "anthropic-messages",
        apiVariant: "anthropic-adaptive",
        baseUrl,
        model: "claude-haiku-4-5",
        thinkingEffort: "high",
        thinkingMode: "enabled",
      },
      "system",
      [{ role: "user", content: "hi" }],
      [],
      { ...policy, maxTokens: 16_384 },
      new AbortController().signal,
    );
  });
  assert.deepEqual(payload!.thinking, { type: "enabled", budget_tokens: 8_192 });
  assert.equal(payload!.output_config, undefined);
});

test("Anthropic thinking blocks and signatures replay verbatim", async () => {
  const requests: Record<string, unknown>[] = [];
  let attempt = 0;
  await withServer(async (request, response) => {
    requests.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
    attempt += 1;
    if (attempt === 1) {
      sse(response, [
        { type: "message_start", message: { usage: { input_tokens: 4 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "consider" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
        { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque-redacted" } },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu-1", name: "lookup", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", usage: { output_tokens: 7 } },
      ]);
      return;
    }
    sse(response, [{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_delta", usage: { output_tokens: 1 } }]);
  }, async (baseUrl) => {
    const thinking: string[] = [];
    const first = await streamModelTurn(
      {
        apiProtocol: "anthropic-messages",
        apiVariant: "anthropic-adaptive",
        baseUrl,
        model: "claude",
        thinkingMode: "enabled",
        thinkingEffort: "max",
      },
      "system",
      [{ role: "user", content: "hi" }],
      [{ description: "Lookup", name: "lookup", parameters: { type: "object" } }],
      policy,
      new AbortController().signal,
      { onThinkingDelta: (delta) => thinking.push(delta) },
    );
    assert.deepEqual(thinking, ["consider"]);
    const blocks = first.assistantMessage.anthropic_content as Array<Record<string, unknown>>;
    assert.deepEqual(blocks[0], { type: "thinking", thinking: "consider", signature: "signed" });
    assert.deepEqual(blocks[1], { type: "redacted_thinking", data: "opaque-redacted" });

    await streamModelTurn(
      {
        apiProtocol: "anthropic-messages",
        apiVariant: "anthropic-legacy",
        baseUrl,
        model: "claude",
        thinkingMode: "enabled",
        thinkingEffort: "high",
      },
      "system",
      [first.assistantMessage, { role: "tool", tool_call_id: "toolu-1", content: "result" }],
      [],
      { ...policy, maxTokens: 16_384 },
      new AbortController().signal,
    );
  });

  assert.deepEqual(requests[0]!.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(requests[0]!.output_config, { effort: "max" });
  const replay = requests[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.deepEqual(replay[0]!.content[0], { type: "thinking", thinking: "consider", signature: "signed" });
  assert.deepEqual(replay[0]!.content[1], { type: "redacted_thinking", data: "opaque-redacted" });
  assert.deepEqual(requests[1]!.thinking, { type: "enabled", budget_tokens: 8_192 });
  assert.equal(requests[1]!.output_config, undefined);
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
