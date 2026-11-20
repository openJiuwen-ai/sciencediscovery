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

test("a value complaint in any envelope keeps the field", async () => {
  // The shapes providers actually send. The earlier rule was clause-based and the
  // `param`-pointer shortcut ignored the message when they were in different
  // clauses, so four of these five were stripped — silently running the turn at
  // the provider default.
  const bodies = [
    '{"object":"error","message":"temperature must be between 0 and 2","type":"BadRequestError","param":"temperature","code":400}',
    '{"error":{"message":"Invalid parameter: temperature. The value is out of range."}}',
    '{"error":{"message":"temperature must be between 0 and 2","param":"temperature","code":"invalid_value"}}',
    '{"error":{"message":"temperature must be between 0 and 2","param":"temperature"}}',
  ];
  for (const body of bodies) {
    const requests: Record<string, unknown>[] = [];
    await withServer(async (request, response) => {
      requests.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(body);
    }, async (baseUrl) => {
      const endpoint = { apiProtocol: "openai-chat-completions" as const, apiVariant: "openai" as const, baseUrl, model: "value" };
      const failure = await streamModelTurn(endpoint, "s", [{ role: "user", content: "hi" }], [], { ...sampling, maxRetries: 0 }, new AbortController().signal)
        .then(() => null, (error: unknown) => error);
      assert.ok(failure instanceof ModelRequestError, `the 400 must surface: ${body}`);
    });
    assert.equal(requests.length, 1, `not retried, and the field not stripped: ${body}`);
    assert.equal(requests[0]!.temperature, 0.95, `temperature was dropped for: ${body}`);
  }
});

test("a real rejection in an envelope with no code still strips", async () => {
  // The other side of the same guard: no value phrase, so the field goes.
  const requests: Record<string, unknown>[] = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requests.push(body);
    if (body.temperature !== undefined) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "`temperature` is deprecated for this model.", param: "temperature" } }));
      return;
    }
    sse(response, [{ choices: [{ delta: { content: "ok" } }] }]);
  }, async (baseUrl) => {
    const endpoint = { apiProtocol: "openai-chat-completions" as const, apiVariant: "openai" as const, baseUrl, model: "plain" };
    const turn = await streamModelTurn(endpoint, "s", [{ role: "user", content: "hi" }], [], sampling, new AbortController().signal);
    assert.equal(turn.assistantMessage.content, "ok");
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.temperature, undefined);
});

test("a provider whose default is the only value strips the field and runs", async () => {
  // The OpenAI reasoning models' answer. Every value the caller could send is
  // refused, so keeping the field would fail every turn — the #1265 symptom under
  // another wording. Dropping it changes nothing that was possible.
  const requests: Record<string, unknown>[] = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requests.push(body);
    if (body.temperature !== undefined) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: {
        message: "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) is supported.",
        param: "temperature",
        code: "unsupported_value",
      } }));
      return;
    }
    sse(response, [{ choices: [{ delta: { content: "ok" } }] }]);
  }, async (baseUrl) => {
    const endpoint = { apiProtocol: "openai-chat-completions" as const, apiVariant: "openai" as const, baseUrl, model: "reasoning" };
    const turn = await streamModelTurn(endpoint, "s", [{ role: "user", content: "hi" }], [], sampling, new AbortController().signal);
    assert.equal(turn.assistantMessage.content, "ok", "an o-series model now runs instead of failing every turn");
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.temperature, undefined, "only the unusable field is gone");
  assert.equal(requests[1]!.top_p, 0.95, "everything else is untouched");
});

test("a default-only refusal strips the field it is about, not the ones it mentions", async () => {
  // F8: proximity to the claim is not evidence. A body echo names every field the
  // request carried, and a message may name another field as the way around the
  // refusal; the stripped set is remembered for the endpoint, so over-stripping
  // `top_p` or `thinking` would change every later turn.
  const cases = [
    {
      body: '{"error":{"message":"Only the default (1) is supported.","request":{"temperature":0.95,"top_p":0.95}}}',
      strips: [],
      why: "nothing in the message names a field, so nothing is identified",
    },
    {
      body: '{"error":{"message":"temperature: only the default (1) is supported. Use top_p to vary the sampling."}}',
      strips: ["temperature"],
      why: "top_p is offered as the alternative, not refused",
    },
    {
      body: '{"error":{"message":"Unsupported value: \'temperature\' does not support 0.7 with this model. Only the default (1) is supported.","request":{"thinking":{"type":"enabled"}}}}',
      strips: ["temperature"],
      why: "the echoed thinking control is not refused",
    },
  ];
  for (const item of cases) {
    const requests: Record<string, unknown>[] = [];
    await withServer(async (request, response) => {
      requests.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(item.body);
      }, async (baseUrl) => {
      // `deepseek` + enabled sends `thinking` (and `reasoning_effort`), so the
      // echoed control is actually carried and the assertion can fail.
      const endpoint = { apiProtocol: "openai-chat-completions" as const, apiVariant: "deepseek" as const, baseUrl, model: "default-only", thinkingMode: "enabled" as const };
      await streamModelTurn(endpoint, "s", [{ role: "user", content: "hi" }], [], { ...sampling, maxRetries: 0 }, new AbortController().signal)
        .then(() => null, () => null);
    });
    // Nothing stripped means no retry at all; otherwise the retry names exactly
    // the fields the refusal was about.
    assert.equal(requests.length, item.strips.length ? 2 : 1, `retries for: ${item.why}`);
    if (item.strips.length) {
      const before = requests[0]!;
      const after = requests[1]!;
      const removed = Object.keys(before)
        .filter((key) => before[key] !== undefined && after[key] === undefined)
        .sort();
      assert.deepEqual(removed, [...item.strips].sort(), `the fields stripped for: ${item.why}`);
      // The control this request really carried must still be there: over-stripping
      // it would silently disable the mode the reader asked for, and the endpoint
      // remembers the strip.
      if (before.thinking !== undefined) {
        assert.notEqual(after.thinking, undefined, `thinking was stripped: ${item.why}`);
      }
    }
  }
});

test("a default-only claim that names the field in the same phrase strips it", async () => {
  // F9: before/after the claim was too coarse. "the default value for temperature"
  // still makes the field the subject of the refusal.
  const bodies = [
    "Only the default value for temperature is supported.",
    "Only the default (1) is supported for temperature.",
  ];
  for (const message of bodies) {
    const requests: Record<string, unknown>[] = [];
    await withServer(async (request, response) => {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requests.push(body);
      if (body.temperature !== undefined) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message } }));
        return;
      }
      sse(response, [{ choices: [{ delta: { content: "ok" } }] }]);
    }, async (baseUrl) => {
      const endpoint = { apiProtocol: "openai-chat-completions" as const, apiVariant: "openai" as const, baseUrl, model: "wording" };
      const turn = await streamModelTurn(endpoint, "s", [{ role: "user", content: "hi" }], [], sampling, new AbortController().signal);
      assert.equal(turn.assistantMessage.content, "ok", `the run continues for: ${message}`);
    });
    assert.equal(requests.length, 2, `retried after stripping for: ${message}`);
    assert.equal(requests[1]!.temperature, undefined, `temperature stripped for: ${message}`);
  }
});
