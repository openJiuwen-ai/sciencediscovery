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

import type { FreeSearchEngine, PaidSearchProvider } from "@sciencediscovery/schema";

import type { AgentPermissionRuntime } from "@sciencediscovery/governance";
import type { SessionStore } from "../store.js";
import {
  WebBroker,
  WebInvocationError,
  WebProviderError,
  type NativeWebProviderClient,
  type WebProviderResponse,
} from "@sciencediscovery/data-source";

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
  freeSearchEngines?: Partial<Record<FreeSearchEngine, boolean>>;
  keys?: Record<string, string>;
  paidSearchProviders?: PaidSearchProvider[];
  resolved?: { mode: "direct" } | { mode: "environment" } | { mode: "url"; url: string };
} = {}): SessionStore {
  return {
    getWebProviderApiKey(provider: string) {
      return options.keys?.[provider];
    },
    getWebSettings() {
      return {
        fetchCacheTtlSeconds: 86_400,
        fetchProvider: options.fetchProvider ?? "jina",
        freeSearchEngines: {
          bing: true,
          "brave-html": true,
          duckduckgo: true,
          ...options.freeSearchEngines,
        },
        paidSearchProviders: options.paidSearchProviders ?? ["tavily", "exa", "brave"],
        providers: [],
        proxyPolicy: "none",
        searchCacheTtlSeconds: 3_600,
      };
    },
    resolveProxy() {
      return options.resolved ?? { mode: "direct" };
    },
  } as unknown as SessionStore;
}

/** Only DuckDuckGo enabled, no paid keys: one predictable candidate. */
function singleEngine(overrides: Parameters<typeof store>[0] = {}): SessionStore {
  return store({
    freeSearchEngines: { bing: false, "brave-html": false, duckduckgo: true },
    paidSearchProviders: [],
    ...overrides,
  });
}

function gateway(
  calls: string[],
  responses: Record<string, WebProviderResponse>,
): NativeWebProviderClient {
  return {
    async invoke(input: { provider: string }) {
      calls.push(input.provider);
      return responses[input.provider]!;
    },
  } as unknown as NativeWebProviderClient;
}

test("search tries paid engines first, then free ones, and caches under the engine that answered", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const calls: string[] = [];
  const resources: string[] = [];
  // Only Tavily is keyed, so Exa and Brave drop out of the paid tier entirely
  // and DuckDuckGo — first in the free order — takes over when Tavily times out.
  const broker = new WebBroker(root, store({ keys: { tavily: "key" } }), gateway(calls, {
    tavily: { content: "", durationMs: 3, errorCode: "timeout", errorMessage: "timed out", isError: true },
    duckduckgo: { content: '{"results":[{"url":"https://example.test"}]}', durationMs: 4, isError: false },
  }));

  const first = await broker.search("TP53", context, permission(resources));
  const cacheConsumer = new WebBroker(root, store(), gateway(calls, {
    duckduckgo: { content: "unused", durationMs: 1, isError: false },
  }));
  const second = await cacheConsumer.search("TP53", { ...context, toolCallId: "call-2" }, permission(resources));

  assert.deepEqual(calls, ["tavily", "duckduckgo"]);
  assert.deepEqual(resources, ["connector:web:search", "connector:web:search"]);
  const attempts = (first as { invocation: { attempts: Array<{ provider: string; tier: string }> } }).invocation.attempts;
  assert.deepEqual(attempts.map((attempt) => [attempt.provider, attempt.tier]), [
    ["tavily", "paid"],
    ["duckduckgo", "free"],
  ]);
  assert.equal((second as { invocation: { cacheHit: boolean } }).invocation.cacheHit, true);
  assert.deepEqual(cacheConsumer.usage(), {
    cacheHits: 1,
    failures: 0,
    fallbacks: 1,
    fetches: 0,
    searches: 2,
  });
});

test("unkeyed paid providers and switched-off free engines are never requested", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-skip-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const calls: string[] = [];
  const broker = new WebBroker(root, store({
    freeSearchEngines: { bing: false, "brave-html": false, duckduckgo: true },
  }), gateway(calls, {
    duckduckgo: { content: '{"results":[{"url":"https://example.test"}]}', durationMs: 2, isError: false },
  }));

  await broker.search("TP53", context, permission([]));
  assert.deepEqual(calls, ["duckduckgo"]);
});

test("search fails as invalid input when every engine is unavailable", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-key-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const calls: string[] = [];
  const broker = new WebBroker(root, store({
    freeSearchEngines: { bing: false, "brave-html": false, duckduckgo: false },
  }), gateway(calls, {}));

  await assert.rejects(
    broker.search("TP53", context, permission([])),
    (error: unknown) => error instanceof WebInvocationError
      && error.invocation.error?.code === "INVALID_INPUT"
      && error.invocation.error.message.includes("Web settings")
      && error.invocation.error.retryable === false,
  );
  assert.deepEqual(calls, []);
  assert.equal(broker.usage().failures, 1);
});

test("web broker hands the resolved registry proxy to the provider", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-proxy-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const requests: Array<{ proxy?: Record<string, unknown> }> = [];
  const providerWithCapture = {
    async invoke(input: { proxy?: Record<string, unknown> }) {
      requests.push(input);
      return { content: '{"results":[]}', durationMs: 1, isError: false };
    },
  } as unknown as NativeWebProviderClient;
  const broker = new WebBroker(root, singleEngine({
    resolved: { mode: "url", url: "http://proxy.example.test:7890" },
  }), providerWithCapture);

  await broker.search("TP53", context, permission([]));
  assert.deepEqual(requests[0]?.proxy, { mode: "url", url: "http://proxy.example.test:7890" });
  assert.equal(broker.listInvocations(context.sessionId)[0]?.attempts[0]?.proxyUsed, true);
});

test("environment policy reaches the provider and still drives the audited proxy flag", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-environment-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const requests: Array<{ proxy?: Record<string, unknown> }> = [];
  const providerWithCapture = {
    async invoke(input: { proxy?: Record<string, unknown> }) {
      requests.push(input);
      return { content: '{"results":[]}', durationMs: 1, isError: false };
    },
  } as unknown as NativeWebProviderClient;
  const broker = new WebBroker(
    root,
    singleEngine({ resolved: { mode: "environment" } }),
    providerWithCapture,
    {
      HTTP_PROXY: "http://ignored-upper.test:1",
      HTTPS_PROXY: "http://effective-upper.test:2",
      http_proxy: " ",
    },
  );

  await broker.search("TP53", context, permission([]));
  assert.deepEqual(requests[0]?.proxy, { mode: "environment" });
  assert.equal(broker.listInvocations(context.sessionId)[0]?.attempts[0]?.proxyUsed, true);
});

test("semantic no-results failures give the agent a corrective hint", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-no-results-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const broker = new WebBroker(root, singleEngine(), gateway([], {
    duckduckgo: {
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

test("provider contract failures remain distinct and non-retryable", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-contract-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const failingProvider = {
    async invoke() {
      throw new WebProviderError("query must be a non-empty string", "invalid-input", false);
    },
  } as unknown as NativeWebProviderClient;
  const broker = new WebBroker(root, singleEngine(), failingProvider);

  await assert.rejects(
    broker.search("TP53", context, permission([])),
    (error: unknown) => error instanceof WebInvocationError
      && error.invocation.error?.code === "INVALID_INPUT"
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
