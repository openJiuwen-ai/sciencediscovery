// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/**
 * #1265: a 400 that refuses a sampling field must not fail the run.
 *
 * The provider's own words: `temperature` is deprecated for this model. That is a
 * rejection of the parameter, not of the value it was given, so the strip-and-retry
 * rule the thinking controls already use applies unchanged.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ModelRequestError, streamModelTurn } from "./client.js";
import type { ModelClientPolicy } from "./client.js";

const policy: ModelClientPolicy = { maxRetries: 1, maxTokens: 1_024, requestTimeoutMs: 5_000 };
const sampling: ModelClientPolicy = { ...policy, temperature: 0.95, topP: 0.95 };

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sse(response: import("node:http").ServerResponse, frames: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function withServer(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a 400 that refuses only temperature is retried without it, and remembered", async () => {
  const requests: Record<string, unknown>[] = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requests.push(body);
    if (body.temperature !== undefined) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { message: "`temperature` is deprecated for this model.", type: null, param: "", code: null },
      }));
      return;
    }
    sse(response, [{ choices: [{ delta: { content: "ok" } }] }]);
  }, async (baseUrl) => {
    const endpoint = { apiProtocol: "openai-chat-completions" as const, apiVariant: "openai" as const, baseUrl, model: "stub" };
    const turn = await streamModelTurn(endpoint, "s", [{ role: "user", content: "hi" }], [], sampling, new AbortController().signal);
    assert.equal(turn.assistantMessage.content, "ok", "the run continues instead of dying on the 400");
    const next = await streamModelTurn(endpoint, "s", [{ role: "user", content: "again" }], [], sampling, new AbortController().signal);
    assert.equal(next.assistantMessage.content, "ok");
  });
  assert.equal(requests.length, 3, "the rejected attempt, the stripped retry, then no 400");
  assert.equal(requests[0]!.temperature, 0.95);
  assert.equal(requests[1]!.temperature, undefined, "the field the 400 named is gone");
  assert.equal(requests[1]!.top_p, 0.95, "and only that field: top_p was never complained about");
  assert.equal(requests[2]!.temperature, undefined, "the rejection is remembered for the endpoint");
  assert.equal(requests[2]!.top_p, 0.95);
});

test("a complaint about temperature's value is not a rejection of the parameter", async () => {
  const requests: Record<string, unknown>[] = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "temperature must be between 0 and 2", type: null, param: "temperature", code: "invalid_value" } }));
      return;
    }
    sse(response, [{ choices: [{ delta: { content: "ok" } }] }]);
  }, async (baseUrl) => {
    const endpoint = { apiProtocol: "openai-chat-completions" as const, apiVariant: "openai" as const, baseUrl, model: "value" };
    const failure = await streamModelTurn(endpoint, "s", [{ role: "user", content: "hi" }], [], { ...sampling, maxRetries: 0 }, new AbortController().signal)
      .then(() => null, (error: unknown) => error);
    assert.ok(failure instanceof ModelRequestError, "the 400 is still surfaced");
    assert.equal(failure.statusCode, 400);
    await streamModelTurn(endpoint, "s", [{ role: "user", content: "again" }], [], sampling, new AbortController().signal);
  });
  assert.equal(requests.length, 2, "a value complaint is not retried");
  assert.equal(requests[0]!.temperature, 0.95);
  assert.equal(requests[1]!.temperature, 0.95, "and it does not suppress the field later");
});

test("a state complaint about temperature does not strip it either", async () => {
  // The wording the existing rules already exclude: a control the provider accepts
  // but cannot take in this mode.
  const requests: Record<string, unknown>[] = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "temperature is not supported when thinking is enabled" } }));
      return;
    }
    sse(response, [{ choices: [{ delta: { content: "ok" } }] }]);
  }, async (baseUrl) => {
    const endpoint = { apiProtocol: "openai-chat-completions" as const, apiVariant: "openai" as const, baseUrl, model: "state" };
    const failure = await streamModelTurn(endpoint, "s", [{ role: "user", content: "hi" }], [], { ...sampling, maxRetries: 0 }, new AbortController().signal)
      .then(() => null, (error: unknown) => error);
    assert.ok(failure instanceof ModelRequestError);
  });
  assert.equal(requests.length, 1, "a state complaint is not a rejection");
});
