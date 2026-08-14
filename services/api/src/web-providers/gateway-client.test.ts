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

import { WebGatewayClient, WebGatewayError } from "./gateway-client.js";

const input = {
  arguments: { query: "TP53" },
  operation: "search" as const,
  options: { proxyMode: "direct" as const },
  provider: "ddgs" as const,
};

function client(body: unknown, status = 200): WebGatewayClient {
  const fetchImpl = async () => new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { headers: { "content-type": "application/json" }, status },
  );
  return new WebGatewayClient("http://gateway.test", "token", fetchImpl as typeof fetch);
}

test("sends only the generic provider options wire", async () => {
  let sent: unknown;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      content: "ok",
      durationMs: 1,
      isError: false,
    }), { headers: { "content-type": "application/json" }, status: 200 });
  };
  await new WebGatewayClient("http://gateway.test", "token", fetchImpl as typeof fetch).invoke({
    arguments: { query: "TP53" },
    operation: "search",
    options: {
      apiKey: "secret",
      backend: "bing",
      proxyEnvironment: { HTTPS_PROXY: "http://environment.example:3128" },
      proxyMode: "environment",
    },
    provider: "ddgs",
    timeoutMs: 1234,
  });

  assert.deepEqual(sent, {
    arguments: { query: "TP53" },
    operation: "search",
    options: {
      apiKey: "secret",
      backend: "bing",
      proxyEnvironment: { HTTPS_PROXY: "http://environment.example:3128" },
      proxyMode: "environment",
    },
    provider: "ddgs",
    timeoutMs: 1234,
  });
});

test("accepts and normalizes attempts null from an older Gateway", async () => {
  const response = await client({
    attempts: null,
    content: '[{"title":"TP53"}]',
    durationMs: 2,
    errorCode: null,
    errorMessage: null,
    isError: false,
  }).invoke(input);

  assert.equal(response.content, '[{"title":"TP53"}]');
  assert.equal(response.attempts, undefined);
  assert.equal(response.errorCode, undefined);
  assert.equal(response.errorMessage, undefined);
});

test("preserves provider attempts and error details", async () => {
  const response = await client({
    attempts: [{
      durationMs: 4,
      endpoint: "https://r.jina.ai",
      errorCode: "rate-limited",
      errorMessage: "HTTP 429",
      isError: true,
    }],
    content: "",
    durationMs: 4,
    errorCode: "rate-limited",
    errorMessage: "HTTP 429",
    isError: true,
  }).invoke({ ...input, operation: "fetch", provider: "jina" });

  assert.equal(response.errorMessage, "HTTP 429");
  assert.equal(response.attempts?.[0]?.errorCode, "rate-limited");
});

test("rejects malformed successful responses as a contract error", async () => {
  await assert.rejects(
    client({ attempts: "none", content: "ok", durationMs: 1, isError: false }).invoke(input),
    (error: unknown) => error instanceof WebGatewayError
      && error.code === "gateway-contract-error"
      && error.retryable === false,
  );
});

test("treats an empty attempts array as no provider-level attempt details", async () => {
  const response = await client({ attempts: [], content: "ok", durationMs: 1, isError: false }).invoke(input);
  assert.equal(response.attempts, undefined);
});

test("rejects malformed JSON as a non-retryable contract error", async () => {
  await assert.rejects(
    client("not-json").invoke(input),
    (error: unknown) => error instanceof WebGatewayError
      && error.code === "gateway-contract-error"
      && error.retryable === false,
  );
});

test("turns Gateway validation responses into actionable input errors", async () => {
  await assert.rejects(
    client({ detail: "query must be a non-empty string no longer than 2000 characters" }, 400).invoke(input),
    (error: unknown) => error instanceof WebGatewayError
      && error.code === "invalid-input"
      && error.message.includes("query must be a non-empty string")
      && error.retryable === false,
  );
});
