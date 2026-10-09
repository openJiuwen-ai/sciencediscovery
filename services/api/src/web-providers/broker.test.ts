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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";


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
      proxyEnvironment: {
        HTTP_PROXY: "http://ignored-upper.test:1",
        HTTPS_PROXY: "http://effective-upper.test:2",
        http_proxy: " ",
      },
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

/** A memory-graph sink that records every observeToolCall emission. */
function recordingSink(): {
  sink: { observeToolCall: (payload: unknown) => void };
  emissions: unknown[];
} {
  const emissions: unknown[] = [];
  return {
    emissions,
    sink: {
      observeToolCall(payload) {
        emissions.push(payload);
      },
    },
  };
}

const SEARCH_DOCUMENT = JSON.stringify({
  query: "TP53",
  total_results: 2,
  results: [
    { content: "p53 summary", title: "TP53 - Wikipedia", url: "https://en.wikipedia.org/wiki/TP53" },
    { content: "", url: "https://example.test/p53" },
  ],
});

test("successful search mirrors web_page products to the memory graph on live and cache paths", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-graph-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const { sink, emissions } = recordingSink();
  const broker = new WebBroker(root, singleEngine(), gateway([], {
    duckduckgo: { content: SEARCH_DOCUMENT, durationMs: 2, isError: false },
  }), { memoryGraphSink: sink });

  // Live path.
  const first = await broker.search("TP53", context, permission([]));
  assert.equal((first as { invocation: { status: string } }).invocation.status, "succeeded");
  assert.equal(emissions.length, 1, "live success must emit one observeToolCall");
  const emission = emissions[0] as {
    taskId: string; sessionId: string; turnId: string;
    toolName: string; toolType: string; resultCount: number;
    products: Array<{ productType: string; url: string; title?: string; snippet?: string }>;
  };
  assert.equal(emission.toolName, "web_search");
  // The tool's *type* is the coarse class, never the tool's own name.
  assert.equal(emission.toolType, "search");
  assert.equal(emission.sessionId, context.sessionId);
  assert.equal(emission.turnId, context.turnId);
  assert.match(emission.taskId, /^subtask:web:/);
  assert.equal(emission.resultCount, 2);
  assert.deepEqual(emission.products, [
    {
      productType: "web_page",
      snippet: "p53 summary",
      title: "TP53 - Wikipedia",
      url: "https://en.wikipedia.org/wiki/TP53",
    },
    { productType: "web_page", url: "https://example.test/p53" },
  ]);

  // Cache path: a re-run of the same query must emit again (the WebPages the
  // LLM will cite must exist on the graph or downstream declare_* calls 422).
  const second = await broker.search("TP53", { ...context, toolCallId: "call-2" }, permission([]));
  assert.equal((second as { invocation: { cacheHit: boolean } }).invocation.cacheHit, true);
  assert.equal(emissions.length, 2, "cache-hit path must emit as well");
  assert.deepEqual(
    (emissions[1] as { products: unknown[] }).products,
    emission.products,
  );
});

test("malformed search content never throws and never emits", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-graph-bad-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const { sink, emissions } = recordingSink();
  const broker = new WebBroker(root, singleEngine(), gateway([], {
    // Not JSON at all — this must not surface an error on the search or emit
    // to the graph (fire-and-forget mirroring contract).
    duckduckgo: { content: "<html>not json</html>", durationMs: 2, isError: false },
  }), { memoryGraphSink: sink });

  const result = await broker.search("TP53", context, permission([]));
  assert.equal((result as { invocation: { status: string } }).invocation.status, "succeeded");
  assert.equal(emissions.length, 0, "unparseable content must not emit");

  // A JSON document whose results rows all lack URLs parses to zero products
  // → no emission, and the search still succeeds.
  const brokerNoUrls = new WebBroker(root, singleEngine(), gateway([], {
    duckduckgo: { content: '{"results":[{"title":"no url"}]}', durationMs: 2, isError: false },
  }), { memoryGraphSink: sink });
  const noUrl = await brokerNoUrls.search("p53 gene", { ...context, toolCallId: "call-3" }, permission([]));
  assert.equal((noUrl as { invocation: { status: string } }).invocation.status, "succeeded");
  assert.equal(emissions.length, 0, "zero valid rows must not emit");
});

test("successful web_fetch mirrors a WebPage with contentHash to the memory graph", async (contextTest) => {
  // The fetched body must land in the CAS data pool (same pool as the
  // recorder + MCP broker), and the mirror must carry the resulting hash —
  // this is the chain that lets declare_evidence with source_webpage_link
  // resolve once a fetch tool populated the body.
  const { createHash } = await import("node:crypto");
  const { stat } = await import("node:fs/promises");
  const root = resolve(process.cwd(), ".tmp", `web-broker-pr9-fetch-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const { sink, emissions } = recordingSink();
  const body = "BRCA1 is a tumor suppressor gene on chromosome 17.";
  const expectedHash = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
  const broker = new WebBroker(root, store({ fetchProvider: "jina" }), gateway([], {
    jina: { content: body, durationMs: 2, isError: false },
  }), { memoryGraphSink: sink });

  const first = await broker.fetch("https://en.wikipedia.org/wiki/BRCA1", context, permission([]));
  assert.equal((first as { invocation: { status: string } }).invocation.status, "succeeded");
  // Fire-and-forget — wait for the async mirror task to drain. The mirror
  // awaits a CAS write before calling the sink, so we wait on setTimeout
  // ticks rather than just setImmediate.
  for (let i = 0; i < 100 && emissions.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(emissions.length, 1, "fetch success must emit one observeToolCall");
  const emission = emissions[0] as {
    taskId: string;
    toolName: string;
    toolType: string;
    resultCount: number;
    products: Array<{ productType: string; url: string; contentHash?: string }>;
  };
  assert.equal(emission.toolName, "web_fetch");
  // Regression guard: this used to read "web_search" — the fetch tool's type
  // was the search tool's name, which is unreadable on the card and was the
  // reason the vocabulary was collapsed.
  assert.equal(emission.toolType, "search");
  assert.equal(emission.resultCount, 1);
  assert.match(emission.taskId, /^subtask:web-fetch:/);
  assert.deepEqual(emission.products, [{
    productType: "web_page",
    url: "https://en.wikipedia.org/wiki/BRCA1",
    contentHash: expectedHash,
  }]);
  // The body lives under data/ (CAS data pool), not agent-state/.
  const blobPath = resolve(root, "versioning", "data", "blobs", "sha256", expectedHash);
  const st = await stat(blobPath);
  assert.equal(st.size, Buffer.byteLength(body, "utf8"));

  // Cache hit must re-emit with the same hash — content-addressed re-put is
  // a no-op so the blob still resolves.
  const second = await broker.fetch("https://en.wikipedia.org/wiki/BRCA1", { ...context, toolCallId: "call-2" }, permission([]));
  assert.equal((second as { invocation: { cacheHit: boolean } }).invocation.cacheHit, true);
  for (let i = 0; i < 100 && emissions.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(emissions.length, 2);
  const cachedProduct = (emissions[1] as { products: Array<{ contentHash?: string }> }).products[0]!;
  assert.equal(cachedProduct.contentHash, expectedHash);
});

test("a search and a fetch that ran in JiuwenSwarm are recorded in the memory graph as ours are", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-external-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const observed: any[] = [];
  const broker = new WebBroker(root, singleEngine(), gateway([], {}), { memoryGraphSink: { observeToolCall: (call: unknown) => { observed.push(call); } } as never });
  await broker.recordExternalResult({ kind: "search", toolName: "free_search", rows: [
    { url: "https://a.example/1", title: "A", snippet: "first" }, { url: "https://a.example/1", title: "dup" }, { url: "https://b.example/2" },
  ] }, context);
  await broker.recordExternalResult({ kind: "fetch", toolName: "fetch_webpage", url: "https://a.example/1", content: "<html>body</html>" }, context);
  assert.equal(observed.length, 2);
  assert.equal(observed[0].toolName, "free_search");
  assert.equal(observed[0].sessionId, "session-1");
  assert.deepEqual(observed[0].products, [
    { productType: "web_page", url: "https://a.example/1", title: "A", snippet: "first" },
    { productType: "web_page", url: "https://b.example/2" },
  ], "one node per URL");
  assert.equal(observed[1].products[0].url, "https://a.example/1");
  assert.match(observed[1].products[0].contentHash, /^[0-9a-f]{64}$/, "the body is in the CAS pool, its hash on the node");
});

test("without a memory graph nothing is recorded and nothing fails", async (contextTest) => {
  const root = resolve(process.cwd(), ".tmp", `web-broker-external-none-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  contextTest.after(() => rm(root, { force: true, recursive: true }));
  const broker = new WebBroker(root, singleEngine(), gateway([], {}));
  await broker.recordExternalResult({ kind: "search", toolName: "free_search", rows: [{ url: "https://a.example" }] }, context);
});
