// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import registry from "../../../../config/external-urls.json" with { type: "json" };
import { NativeWebProviderClient, WebBroker, WebInvocationError, createWebWorkspaceTools } from "@sciencediscovery/data-source";
import type { AgentPermissionRuntime } from "@sciencediscovery/governance";
import { SessionStore } from "../store.js";
import { jiuwenSwarmWebConfig } from "../agent-run/jiuwenswarm-web-settings.js";

// Use the real broker, settings encryption and HTTP transport. Only vendor endpoints are local.
test("DeepSeek search → fetch evidence, settings guards, fallback and classified failures", async (t) => {
  const calls: Array<{ path: string; body: Record<string, unknown>; auth?: string; method?: string }> = [];
  let status = 200;
  let empty = false;
  let delay = false;
  let legacyHits = false;
  let malformed = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length && request.headers["content-type"]?.includes("application/json") ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    calls.push({ path: request.url!, body, auth: request.headers.authorization, method: request.method });
    if (delay) return; // A real hung socket exercises the provider's wall-clock deadline.
    if (request.url!.startsWith("/free")) {
      response.end('<a class="result__a" href="https://1.1.1.1/fallback">Fallback</a><a class="result__snippet">Free result</a>');
      return;
    }
    if (legacyHits && request.url === "/tavily") {
      response.end(JSON.stringify({ results: [{ title: "Existing provider", url: "https://1.1.1.1/legacy", content: "Tavily content" }] }));
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    if (malformed) { response.end("local-test-key"); return; }
    response.end(JSON.stringify(request.url === "/v1/tools/search"
      ? { results: empty ? [] : [{ title: "Catalyst study", url: "https://1.1.1.1/catalyst", summary: "Model-facing summary.", snippet: "Short snippet." }] }
      : { title: "Catalyst study", content: "# Results\n\nThe yield was **93%**." }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const previous = { ...registry.web };
  registry.web.deepseek_search_endpoint = `${origin}/v1/tools/search`;
  registry.web.deepseek_fetch_endpoint = `${origin}/v1/tools/fetch`;
  registry.web.duckduckgo_html_endpoint = `${origin}/free`;
  registry.web.tavily_search_endpoint = `${origin}/tavily`;
  registry.web.exa_search_endpoint = `${origin}/exa`;
  registry.web.brave_search_endpoint = `${origin}/brave`;
  await mkdir(resolve(".tmp"), { recursive: true });
  const directory = await mkdtemp(resolve(".tmp/deepseek-"));
  const store = new SessionStore(directory);
  await store.load();
  const provider = new NativeWebProviderClient();
  const broker = new WebBroker(directory, store, provider);
  t.after(async () => {
    broker.close(); store.close(); Object.assign(registry.web, previous);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  });
  const resources: string[] = [];
  const permission = { getEpoch: () => ({ id: "epoch" }), requirePrivilege: async (input: { resource: string }) => { resources.push(input.resource); return { id: "allow" }; } } as unknown as AgentPermissionRuntime;
  const tools = createWebWorkspaceTools({ broker, permission, context: { forceRefresh: false, projectId: "p", sessionId: "s", turnId: "t" } });
  const settings = await store.updateWebSettings({ deepseekEnabled: true, paidSearchProviders: ["deepseek"], fetchProvider: "deepseek", proxyPolicy: "none", freeSearchEngines: { bing: false, duckduckgo: false, "brave-html": false }, providerApiKeys: { deepseek: "local-test-key" } });
  assert.equal(JSON.stringify(settings).includes("local-test-key"), false);
  const db = new DatabaseSync(resolve(directory, "catalog.sqlite"), { readOnly: true });
  const secret = db.prepare("SELECT encrypted_token FROM web_provider_secrets WHERE provider = 'deepseek'").get() as { encrypted_token: string };
  assert.equal(secret.encrypted_token.includes("local-test-key"), false);
  db.close();
  // This is the exact config payload the default executor sends to the adapter.
  assert.deepEqual(jiuwenSwarmWebConfig(settings, (p) => store.getWebProviderApiKey(p)), {
    free_search_ddg_enabled: "false", free_search_bing_enabled: "false", jina_api_key: "", bocha_api_key: "", serper_api_key: "", perplexity_api_key: "",
    deepseek_api_key: "local-test-key", deepseek_search_enabled: "true", deepseek_fetch_enabled: "true",
  });
  const search = await tools.webSearch("search", "catalyst yield") as { content: string };
  const hit = JSON.parse(search.content).results[0];
  assert.deepEqual(hit, { title: "Catalyst study", url: "https://1.1.1.1/catalyst", content: "Model-facing summary." });
  const page = await tools.webFetch("fetch", hit.url) as { content: string };
  assert.match(page.content, /# Catalyst study/);
  assert.match(page.content, /yield was \*\*93%\*\*/); // The answer has citable page evidence.
  assert.deepEqual(calls.map(({ path, body, auth, method }) => ({ path, body, auth, method })), [
    { path: "/v1/tools/search", body: { query: "catalyst yield", count: 5 }, auth: "Bearer local-test-key", method: "POST" },
    { path: "/v1/tools/fetch", body: { url: hit.url }, auth: "Bearer local-test-key", method: "POST" },
  ]);
  await tools.webSearch("cached-search", "catalyst yield");
  await tools.webFetch("cached-fetch", hit.url);
  assert.equal(calls.length, 2, "both broker caches still work");
  assert.ok(resources.includes("web:search") && resources.includes("1.1.1.1"));
  assert.equal(broker.listInvocations("s").length, 4);

  await store.updateWebSettings({ deepseekEnabled: false });
  await assert.rejects(tools.webSearch("off-search", "catalyst yield"));
  await assert.rejects(tools.webFetch("off-fetch", hit.url), (error: unknown) => error instanceof WebInvocationError && error.invocation.error?.code === "PROVIDER_DISABLED");
  assert.equal(calls.length, 2, "disabled routes do not use cached content or make requests");
  assert.equal(jiuwenSwarmWebConfig(store.getWebSettings(), (p) => store.getWebProviderApiKey(p)).deepseek_api_key, "");
  await store.updateWebSettings({ deepseekEnabled: true, providerApiKeys: { deepseek: null } });
  for (const invoke of [() => tools.webSearch("missing-search", "x"), () => tools.webFetch("missing-fetch", hit.url)]) {
    await assert.rejects(invoke(), (error: unknown) => error instanceof WebInvocationError && error.invocation.error?.code === "MISSING_CREDENTIALS");
  }
  assert.equal(calls.length, 2, "missing credentials produce no requests");
  await store.updateWebSettings({ providerApiKeys: { deepseek: "local-test-key" }, searchCacheTtlSeconds: 0, fetchCacheTtlSeconds: 0 });
  malformed = true;
  await assert.rejects(tools.webSearch("malformed-json", "malformed response"), (error: unknown) => {
    assert.ok(error instanceof WebInvocationError);
    assert.equal(error.invocation.error?.code, "PROVIDER_ERROR");
    assert.match(error.message, /invalid JSON/);
    assert.equal(JSON.stringify(error.invocation).includes("local-test-key"), false, "upstream body must not leak into tool errors or audit");
    return true;
  });
  malformed = false;
  for (const [httpStatus, code] of [[401, "UNAUTHORIZED"], [402, "INSUFFICIENT_BALANCE"], [429, "RATE_LIMITED"], [408, "TIMEOUT"], [504, "TIMEOUT"], [403, "FETCH_FAILED"], [404, "FETCH_FAILED"]] as const) {
    status = httpStatus;
    await assert.rejects(tools.webFetch(`http-${httpStatus}`, `https://1.1.1.1/${httpStatus}`), (error: unknown) => error instanceof WebInvocationError && error.invocation.error?.code === code);
    if (httpStatus !== 404 && httpStatus !== 403) await assert.rejects(tools.webSearch(`http-search-${httpStatus}`, `case ${httpStatus}`), (error: unknown) => error instanceof WebInvocationError && error.invocation.error?.code === code);
  }
  status = 200; empty = true;
  await store.updateWebSettings({ freeSearchEngines: { bing: false, duckduckgo: true, "brave-html": false } });
  const fallback = await tools.webSearch("empty-fallback", "no match") as { content: string; invocation: { attempts: Array<{ status: string }> } };
  assert.match(fallback.content, /Free result/);
  assert.equal(fallback.invocation.attempts[0]!.status, "no-results");
  assert.equal(fallback.invocation.attempts.at(-1)!.status, "succeeded");
  // A successful existing provider still wins before DeepSeek.
  empty = false;
  await store.updateWebSettings({ paidSearchProviders: ["deepseek", "tavily", "exa", "brave"], providerApiKeys: { tavily: "legacy-key", exa: "legacy-key", brave: "legacy-key" } });
  assert.deepEqual(store.getWebSettings().paidSearchProviders, ["tavily", "exa", "brave", "deepseek"]);
  const before = calls.length;
  // The local Tavily fixture is an extract response, so no search rows: all prior providers are attempted before DeepSeek.
  await tools.webSearch("order", "order");
  assert.deepEqual(calls.slice(before).map((c) => c.path.split("?")[0]), ["/tavily", "/exa", "/brave", "/v1/tools/search"]);
  legacyHits = true;
  const beforePreferred = calls.length;
  await tools.webSearch("preferred", "preferred provider");
  assert.deepEqual(calls.slice(beforePreferred).map((c) => c.path), ["/tavily"]);
  registry.web.jina_endpoints = [`${origin}/jina`];
  await store.updateWebSettings({ fetchProvider: "jina" });
  const beforeFetch = calls.length;
  await tools.webFetch("other-fetch", "https://1.1.1.1/other");
  assert.deepEqual(calls.slice(beforeFetch).map((c) => c.path), ["/jina/"]);
  delay = true;
  const timeout = await provider.invoke({ operation: "search", provider: "deepseek", request: "slow", apiKey: "local-test-key", timeoutMs: 25 });
  assert.equal(timeout.errorCode, "timeout");
});
