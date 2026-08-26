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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { ModelConnectivityTestResult, ModelProfile } from "@sciencediscovery/schema";

import { ModelConnectivityTestCoordinator, testModelConnectivity } from "./model-connectivity.js";

function profile(baseUrl: string): ModelProfile {
  return {
    baseUrl,
    createdAt: "2026-08-26T00:00:00.000Z",
    hasApiToken: true,
    id: "model-1",
    model: "provider-model",
    name: "Provider model",
    proxyPolicy: "none",
    updatedAt: "2026-08-26T00:00:00.000Z",
    vision: false,
  };
}

async function readRequest(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body;
}

async function withProvider<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const directProxy = () => ({ mode: "direct" } as const);

test("connectivity probe uses the saved endpoint, model, and API token", async () => {
  await withProvider(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer saved-secret");
    const body = JSON.parse(await readRequest(request)) as Record<string, unknown>;
    assert.equal(body.model, "provider-model");
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 8);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  }, async (origin) => {
    const tested = await testModelConnectivity({
      apiToken: "saved-secret",
      profile: profile(`${origin}/v1/`),
      resolveProxy: directProxy,
    });
    assert.equal(tested.ok, true);
    assert.equal(tested.category, "ok");
    assert.equal(tested.providerStatus, 200);
  });
});

test("missing model token fails locally without resolving a proxy or calling a provider", async () => {
  let proxyResolved = false;
  const tested = await testModelConnectivity({
    profile: profile("http://127.0.0.1:1/v1"),
    resolveProxy: () => {
      proxyResolved = true;
      return { mode: "direct" };
    },
  });
  assert.equal(tested.category, "missing_token");
  assert.equal(tested.ok, false);
  assert.equal(proxyResolved, false);
});

test("provider HTTP failures have stable connectivity categories", async () => {
  const categories = new Map<number, ModelConnectivityTestResult["category"]>([
    [401, "authorization"],
    [403, "authorization"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ]);
  await withProvider((request, response) => {
    const status = Number(request.url?.split("/")[1]);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "sensitive provider detail" } }));
  }, async (origin) => {
    for (const [status, category] of categories) {
      const tested = await testModelConnectivity({
        apiToken: "secret",
        profile: profile(`${origin}/${status}`),
        resolveProxy: directProxy,
      });
      assert.equal(tested.category, category);
      assert.equal(tested.providerStatus, status);
      assert.doesNotMatch(tested.message, /sensitive provider detail/);
    }
  });
});

test("reasoning response with an empty final body is still a valid completion", async () => {
  await withProvider(async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: null, reasoning_content: "OK" } }] }));
  }, async (origin) => {
    const tested = await testModelConnectivity({
      apiToken: "secret",
      profile: profile(origin),
      resolveProxy: directProxy,
    });
    assert.equal(tested.category, "ok");
  });
});

test("malformed successful responses are classified as incompatible", async () => {
  await withProvider(async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: "OK" }));
  }, async (origin) => {
    const tested = await testModelConnectivity({
      apiToken: "secret",
      profile: profile(origin),
      resolveProxy: directProxy,
    });
    assert.equal(tested.category, "invalid_response");
    assert.equal(tested.ok, false);
  });
});

test("connectivity probe has an independent short timeout", async () => {
  await withProvider(async (request) => {
    await readRequest(request);
  }, async (origin) => {
    const tested = await testModelConnectivity({
      apiToken: "secret",
      profile: profile(origin),
      resolveProxy: directProxy,
      timeoutMs: 25,
    });
    assert.equal(tested.category, "timeout");
  });
});

test("coordinator coalesces concurrent tests and allows a later retest", async () => {
  const coordinator = new ModelConnectivityTestCoordinator();
  const successful: ModelConnectivityTestResult = {
    category: "ok",
    latencyMs: 1,
    message: "Connection succeeded",
    ok: true,
    providerStatus: 200,
    testedAt: "2026-08-26T00:00:00.000Z",
  };
  let calls = 0;
  let release: (() => void) | undefined;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const run = () => coordinator.run("model-1", async () => {
    calls += 1;
    await deferred;
    return successful;
  });
  const first = run();
  const second = run();
  assert.equal(first, second);
  assert.equal(calls, 1);
  release?.();
  await first;
  await coordinator.run("model-1", async () => {
    calls += 1;
    return successful;
  });
  assert.equal(calls, 2);
});
