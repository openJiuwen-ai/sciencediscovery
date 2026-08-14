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
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { AgentPermissionRuntime } from "../agent-run/permission-runtime.js";
import type { SessionStore } from "../store.js";
import { WebBroker, WebInvocationError } from "./broker.js";
import { WebGatewayError, type WebGatewayClient, type WebGatewayResponse } from "./gateway-client.js";

const context = {
  forceRefresh: false,
  projectId: "project-1",
  sessionId: "session-1",
  toolCallId: "call-1",
  turnId: "turn-1",
};

function permission(resources: string[]): AgentPermissionRuntime {
  return {
    getEpoch: () => ({ id: "epoch-1" }) as never,
    requirePrivilege: async (request) => {
      resources.push(`${request.action}:${request.resource}`);
      return { id: "authorization-1" } as never;
    },
  };
}

function store(options: {
  fetchProvider?: "jina" | "tavily" | "exa";
  keys?: Record<string, string>;
  resolved?: { mode: "direct" } | { mode: "environment" } | { mode: "url"; url: string };
  searchProvider?: "ddgs" | "tavily" | "exa" | "brave";
} = {}): SessionStore {
  return {
    getWebProviderApiKey(provider: string) {
      return options.keys?.[provider];
    },
    getWebSettings() {
      return {
        ddgsBackend: "bing",
        fetchCacheTtlSeconds: 86_400,
        fetchProvider: options.fetchProvider ?? "jina",
        providers: [],
        proxyPolicy: "none",
        searchCacheTtlSeconds: 3_600,
        searchFallbackProvider: "ddgs",
        searchProvider: options.searchProvider ?? "tavily",
      };
    },
    resolveProxy() {
      return options.resolved ?? { mode: "direct" };
    },
  } as unknown as SessionStore;
}

function gateway(
  calls: string[],
  responses: Record<string, WebGatewayResponse>,
): WebGatewayClient {
  return {
    async invoke(input: { provider: string }) {
      calls.push(input.provider);
      return responses[input.provider]!;
    },
  } as unknown as WebGatewayClient;
}

test("search falls back after a transient failure and caches the result under the provider that produced it", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const calls: string[] = [];
  const resources: string[] = [];
  const broker = new WebBroker(root, store({ keys: { tavily: "key" } }), gateway(calls, {
    tavily: { content: "", durationMs: 3, errorCode: "timeout", errorMessage: "timed out", isError: true },
    ddgs: { content: '{"results":[{"url":"https://example.test"}]}', durationMs: 4, isError: false },
  }));

  const first = await broker.search("TP53", context, permission(resources));
  const fallbackConsumer = new WebBroker(root, store({ searchProvider: "ddgs" }), gateway(calls, {
    ddgs: { content: "unused", durationMs: 1, isError: false },
  }));
  const second = await fallbackConsumer.search("TP53", { ...context, toolCallId: "call-2" }, permission(resources));

  assert.deepEqual(calls, ["tavily", "ddgs"]);
  assert.deepEqual(resources, ["connector:web:search", "connector:web:search"]);
  assert.equal((first as { invocation: { attempts: unknown[] } }).invocation.attempts.length, 2);
  assert.equal((second as { invocation: { cacheHit: boolean } }).invocation.cacheHit, true);
  assert.deepEqual(fallbackConsumer.usage(), {
    cacheHits: 1,
    failures: 0,
    fallbacks: 1,
    fetches: 0,
    searches: 2,
  });
});

test("missing paid-provider credentials fail without fallback", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-key-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const calls: string[] = [];
  const broker = new WebBroker(root, store(), gateway(calls, {}));

  await assert.rejects(
    broker.search("TP53", context, permission([])),
    (error: unknown) => error instanceof WebInvocationError
      && error.invocation.error?.code === "UNAUTHORIZED"
      && error.invocation.error.message.includes("global Web settings")
      && error.invocation.error.retryable === false,
  );
  assert.deepEqual(calls, []);
  assert.equal(broker.usage().failures, 1);
});

test("web broker projects a resolved registry URL into the gateway request", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-proxy-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const requests: Array<{ options: Record<string, unknown> }> = [];
  const gatewayWithCapture = {
    async invoke(input: { options: Record<string, unknown> }) {
      requests.push(input);
      return { content: '{"results":[]}', durationMs: 1, isError: false };
    },
  } as unknown as WebGatewayClient;
  const broker = new WebBroker(root, store({
    resolved: { mode: "url", url: "http://proxy.example.test:7890" },
    searchProvider: "ddgs",
  }), gatewayWithCapture);

  await broker.search("TP53", context, permission([]));
  assert.equal(requests[0]?.options.proxyMode, "custom");
  assert.equal(requests[0]?.options.proxy, "http://proxy.example.test:7890");
  assert.equal(broker.listInvocations(context.sessionId)[0]?.attempts[0]?.proxyUsed, true);
});

test("web broker sends the projected environment snapshot instead of ambient contradictions", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-environment-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const requests: Array<{ options: Record<string, unknown> }> = [];
  const gatewayWithCapture = {
    async invoke(input: { options: Record<string, unknown> }) {
      requests.push(input);
      return { content: '{"results":[]}', durationMs: 1, isError: false };
    },
  } as unknown as WebGatewayClient;
  const broker = new WebBroker(
    root,
    store({ resolved: { mode: "environment" }, searchProvider: "ddgs" }),
    gatewayWithCapture,
    {
      HTTP_PROXY: "http://ignored-upper.test:1",
      HTTPS_PROXY: "http://effective-upper.test:2",
      http_proxy: " ",
    },
  );

  await broker.search("TP53", context, permission([]));
  assert.deepEqual(requests[0]?.options.proxyEnvironment, {
    HTTPS_PROXY: "http://effective-upper.test:2",
  });
  assert.equal(requests[0]?.options.proxyMode, "environment");
  assert.equal(broker.listInvocations(context.sessionId)[0]?.attempts[0]?.proxyUsed, true);
});

test("semantic no-results failures give the agent a corrective hint", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-no-results-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const broker = new WebBroker(root, store({ searchProvider: "ddgs" }), gateway([], {
    ddgs: {
      content: "Error: No results found.",
      durationMs: 3,
      errorCode: "semantic-error",
      errorMessage: "No results found.",
      isError: true,
    },
  }));

  await assert.rejects(
    broker.search("rare query", context, permission([])),
    (error: unknown) => error instanceof WebInvocationError
      && error.invocation.error?.code === "NO_RESULTS"
      && error.invocation.error.message.includes("different search terms")
      && error.invocation.error.retryable === false,
  );
  assert.equal(broker.listInvocations(context.sessionId)[0]?.error?.code, "NO_RESULTS");
});

test("Gateway contract failures remain distinct and non-retryable", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-contract-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const failingGateway = {
    async invoke() {
      throw new WebGatewayError("incompatible Gateway response", "gateway-contract-error", false);
    },
  } as unknown as WebGatewayClient;
  const broker = new WebBroker(root, store({ searchProvider: "ddgs" }), failingGateway);

  await assert.rejects(
    broker.search("TP53", context, permission([])),
    (error: unknown) => error instanceof WebInvocationError
      && error.invocation.error?.code === "GATEWAY_CONTRACT_ERROR"
      && error.invocation.error.retryable === false,
  );
});

test("fetch requests host permission and never switch provider", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-fetch-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const calls: string[] = [];
  const resources: string[] = [];
  const broker = new WebBroker(root, store(), gateway(calls, {
    jina: { content: "", durationMs: 2, errorCode: "server-error", errorMessage: "503", isError: true },
  }));

  await assert.rejects(
    broker.fetch("https://example.test/article", context, permission(resources)),
    (error: unknown) => error instanceof WebInvocationError
      && error.invocation.error?.code === "UPSTREAM_UNAVAILABLE"
      && error.invocation.error.retryable === true,
  );
  assert.deepEqual(calls, ["jina"]);
  assert.deepEqual(resources, ["host:example.test"]);
});
