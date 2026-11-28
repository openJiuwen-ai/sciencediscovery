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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { classifyModelWireError, streamModelTurn, type ModelClientPolicy, type ModelEndpoint } from "./client.js";

// #1238: the shared `sseData` reader used to drop a turn the provider had already
// declared complete when the gateway reset the connection before `[DONE]`. These
// cases drive a real HTTP server, so the framing rather than a stubbed streamer is
// what the reader sees.
const policy: ModelClientPolicy = { maxRetries: 0, maxTokens: 1_024, requestTimeoutMs: 5_000 };

/** The reset the JiuwenSwarm gateway performed: no `[DONE]`, no clean end. */
async function runAfterCompletionCase(
  write: (response: ServerResponse) => void,
  endpoint: Partial<ModelEndpoint>,
  assertTurn: (turn: Awaited<ReturnType<typeof streamModelTurn>>) => void,
): Promise<void> {
  await withServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    write(response);
    await reset(response);
  }, async (baseUrl) => {
    assertTurn(await streamModelTurn({ baseUrl, model: "stub", ...endpoint }, "system", [{ role: "user", content: "hi" }], [], policy, new AbortController().signal));
  });
}

test("a chat stream reset after finish_reason still returns the completed turn", async () => {
  await runAfterCompletionCase((response) => {
    writeEvent(response, { choices: [{ delta: { content: "Answer " } }] });
    writeEvent(response, { choices: [{ delta: { content: "text." } }] });
    writeEvent(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":"TP53"}' } }] } }] });
    writeEvent(response, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  }, {}, (turn) => {
    assert.equal(turn.assistantMessage.content, "Answer text.");
    assert.deepEqual(turn.toolCalls.map((call) => ({ args: call.args, name: call.name })), [{ args: { q: "TP53" }, name: "lookup" }]);
  });
});

test("a Responses stream reset after response.completed still returns the completed turn", async () => {
  await runAfterCompletionCase((response) => {
    writeEvent(response, { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Answer " });
    writeEvent(response, { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "text." });
    writeEvent(response, { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "item-1", call_id: "call-1", name: "lookup", arguments: "" } });
    writeEvent(response, { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"q":"TP53"}' });
    writeEvent(response, { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "item-1", call_id: "call-1", name: "lookup", arguments: '{"q":"TP53"}' } });
    writeEvent(response, { type: "response.completed", response: { usage: {} } });
  }, { apiProtocol: "openai-responses" }, (turn) => {
    assert.equal(turn.assistantMessage.content, "Answer text.");
    assert.deepEqual(turn.toolCalls.map((call) => ({ args: call.args, name: call.name })), [{ args: { q: "TP53" }, name: "lookup" }]);
  });
});

test("an Anthropic stream reset after message_delta still returns the completed turn", async () => {
  await runAfterCompletionCase((response) => {
    writeEvent(response, { type: "message_start", message: { usage: { input_tokens: 3 } } });
    writeEvent(response, { type: "content_block_start", index: 0, content_block: { type: "text" } });
    writeEvent(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer text." } });
    writeEvent(response, { type: "content_block_stop", index: 0 });
    writeEvent(response, { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu-1", name: "lookup", input: {} } });
    writeEvent(response, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"TP53"}' } });
    writeEvent(response, { type: "content_block_stop", index: 1 });
    writeEvent(response, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } });
  }, { apiProtocol: "anthropic-messages", apiVariant: "anthropic-adaptive" }, (turn) => {
    assert.equal(turn.assistantMessage.content, "Answer text.");
    assert.deepEqual(turn.toolCalls.map((call) => ({ args: call.args, name: call.name })), [{ args: { q: "TP53" }, name: "lookup" }]);
  });
});

test("a recovered Responses turn with truncated tool arguments is still rejected", async () => {
  await withServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeEvent(response, { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item-1", call_id: "call-1", name: "lookup", arguments: "" } });
    writeEvent(response, { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"q":' });
    // The terminal record arrives while the arguments are still incomplete.
    writeEvent(response, { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "item-1", call_id: "call-1", name: "lookup", arguments: '{"q":' } });
    writeEvent(response, { type: "response.completed", response: { usage: {} } });
    await reset(response);
  }, async (baseUrl) => {
    await assert.rejects(
      streamModelTurn(
        { apiProtocol: "openai-responses", baseUrl, model: "stub" },
        "system",
        [{ role: "user", content: "hi" }],
        [],
        policy,
        new AbortController().signal,
      ),
      /incomplete tool arguments/u,
    );
  });
});

test("a stream reset before finish_reason still fails", async () => {
  await withServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeEvent(response, { choices: [{ delta: { content: "partial answer" } }] });
    await reset(response);
  }, async (baseUrl) => {
    await assert.rejects(
      streamModelTurn(
        { baseUrl, model: "stub" },
        "system",
        [{ role: "user", content: "hi" }],
        [],
        policy,
        new AbortController().signal,
      ),
      (error: unknown) => classifyModelWireError(error) === "network",
    );
  });
});

async function readBody(request: IncomingMessage): Promise<void> {
  for await (const chunk of request) void chunk;
}

function writeEvent(response: ServerResponse, frame: unknown): void {
  response.write(`data: ${JSON.stringify(frame)}\n\n`);
}

async function reset(response: ServerResponse): Promise<void> {
  // Let the written frames reach the socket first: the defect is about what the
  // reader does after the frames it already has, not about losing a frame.
  await new Promise((done) => setTimeout(done, 25));
  response.destroy();
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
