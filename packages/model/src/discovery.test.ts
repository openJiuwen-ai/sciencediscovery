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
import type { AddressInfo } from "node:net";
import test from "node:test";

import { listProviderModels, ModelDiscoveryError } from "./discovery.js";

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

test("openai-style listing normalizes ids and optional vendor facts", async () => {
  let requestPath = "";
  let authHeader: string | undefined;
  await withServer((request, response) => {
    requestPath = request.url ?? "";
    authHeader = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      object: "list",
      data: [
        { id: "kimi-k3", object: "model", context_length: 1_048_576, supports_image_in: true, supports_reasoning: true },
        { id: "kimi-k2.5", object: "model", context_length: 262_144, supports_image_in: false },
        { id: "  ", object: "model" },
      ],
    }));
  }, async (baseUrl) => {
    const models = await listProviderModels({
      apiToken: "secret",
      baseUrl: `${baseUrl}/v1`,
      discovery: "openai-models",
    });
    assert.equal(requestPath, "/v1/models");
    assert.equal(authHeader, "Bearer secret");
    assert.deepEqual(models.map((model) => model.id), ["kimi-k2.5", "kimi-k3"]);
    const k3 = models.find((model) => model.id === "kimi-k3")!;
    assert.equal(k3.contextWindow, 1_048_576);
    assert.equal(k3.vision, true);
    assert.equal(k3.thinkingSupported, true);
    const k25 = models.find((model) => model.id === "kimi-k2.5")!;
    assert.equal(k25.vision, false);
    assert.equal(k25.thinkingSupported, undefined);
  });
});

test("openrouter-style per-token pricing converts to per-1M and reads modalities", async () => {
  await withServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: [{
        id: "vendor/some-model",
        name: "Some Model",
        context_length: 200_000,
        architecture: { input_modalities: ["text", "image"] },
        top_provider: { max_completion_tokens: 32_000 },
        supported_parameters: ["reasoning", "tools"],
        pricing: { prompt: "0.0000001", completion: "0.0000002", input_cache_read: "0.00000005" },
      }],
    }));
  }, async (baseUrl) => {
    const [model] = await listProviderModels({
      apiToken: "secret",
      baseUrl,
      discovery: "openai-models",
    });
    assert.equal(model!.displayName, "Some Model");
    assert.equal(model!.contextWindow, 200_000);
    assert.equal(model!.maxOutputTokens, 32_000);
    assert.equal(model!.vision, true);
    assert.equal(model!.thinkingSupported, true);
    assert.deepEqual(model!.pricing, { cachedInput: 0.05, currency: "USD", input: 0.1, output: 0.2 });
  });
});

test("anthropic listing uses x-api-key, /v1/models, and capability fields", async () => {
  let requestPath = "";
  let apiKeyHeader: string | undefined;
  let versionHeader: string | undefined;
  await withServer((request, response) => {
    requestPath = request.url ?? "";
    apiKeyHeader = request.headers["x-api-key"] as string | undefined;
    versionHeader = request.headers["anthropic-version"] as string | undefined;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: [{
        id: "claude-example-1",
        display_name: "Claude Example",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: { image_input: true, thinking: { types: ["adaptive"] } },
      }],
    }));
  }, async (baseUrl) => {
    const [model] = await listProviderModels({
      apiToken: "secret",
      baseUrl,
      discovery: "anthropic-models",
    });
    assert.equal(requestPath, "/v1/models");
    assert.equal(apiKeyHeader, "secret");
    assert.equal(versionHeader, "2023-06-01");
    assert.equal(model!.displayName, "Claude Example");
    assert.equal(model!.contextWindow, 1_000_000);
    assert.equal(model!.maxOutputTokens, 128_000);
    assert.equal(model!.vision, true);
    assert.equal(model!.thinkingSupported, true);
  });
});

test("a missing token sends no auth header at all", async () => {
  let sawAuth: string | undefined = "unset";
  await withServer((request, response) => {
    sawAuth = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "llama3" }] }));
  }, async (baseUrl) => {
    const models = await listProviderModels({ baseUrl, discovery: "openai-models" });
    assert.equal(sawAuth, undefined);
    assert.equal(models[0]!.id, "llama3");
  });
});

test("upstream failures keep the status code and bounded detail", async () => {
  await withServer((request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { message: "bad key" } }));
  }, async (baseUrl) => {
    await assert.rejects(
      listProviderModels({ apiToken: "wrong", baseUrl, discovery: "openai-models" }),
      (error: unknown) => {
        assert.ok(error instanceof ModelDiscoveryError);
        assert.equal(error.statusCode, 401);
        assert.match(error.message, /status 401/);
        assert.match(error.message, /bad key/);
        return true;
      },
    );
  });
});

test("non-JSON and unknown shapes are rejected instead of faked", async () => {
  await withServer((request, response) => {
    response.end("<html>login</html>");
  }, async (baseUrl) => {
    await assert.rejects(
      listProviderModels({ baseUrl, discovery: "openai-models" }),
      /not valid JSON/,
    );
  });
  await withServer((request, response) => {
    response.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await assert.rejects(
      listProviderModels({ baseUrl, discovery: "openai-models" }),
      /unknown shape/,
    );
  });
});
