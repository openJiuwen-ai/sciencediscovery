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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import type { McpCatalog, McpInvocation, McpInvokeResponse, McpToolResult, ResolvedRuntimeSettings } from "@sciencediscovery/schema";
import { McpGovernanceBroker, McpInvocationError, type McpBrokerStore } from "./broker.js";
import { McpSourceCatalog } from "./catalog.js";
import type { McpTransportClient } from "./transport.js";
import { SourceHealth, SOURCE_HEALTH_POLICY } from "./source-health.js";
import { ResourceRateLimiter } from "./resource-rate-limiter.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "issue-208-health-"));
  const registry = createBuiltinMcpSourceRegistry();
  const invocations: McpInvocation[] = [];
  let calls = 0;
  let fault: (request: Parameters<McpTransportClient["invoke"]>[0], signal?: AbortSignal) => Promise<McpInvokeResponse>;
  const store: McpBrokerStore = {
    appendMcpInvocation: async invocation => { invocations.push(invocation); },
    assertSessionWritable: () => {}, mcpProxyPolicy: () => "none", resolveProxy: () => ({ mode: "direct" }),
    resolveRuntimeSettings: () => ({ effective: { enabledConnectorIds: ["arxiv", "europe-pmc"], plugins: {} } }) as ResolvedRuntimeSettings,
  };
  for (const id of ["arxiv", "europe-pmc"]) {
    const source = registry.get(id);
    const manifest = structuredClone(source.manifest);
    manifest.cache.enabled = false;
    Object.assign(manifest.governance, { minIntervalMs: 0, maxConcurrentRequests: 1, maxQueueDepth: 4, queueTimeoutMs: 40 });
    registry.upsert({ ...source, manifest, normalizeResult: async (_context, raw) => raw.structuredContent as unknown as McpToolResult });
  }
  const catalogData: McpCatalog = { loadedAt: new Date().toISOString(), revision: "faults", servers: [{
    id: "biomed", enabled: true, transport: "stdio", tools: ["arxiv", "europe-pmc"].map(id => ({
      name: registry.getTool(id, "search").mcpToolName!, description: "search", schemaHash: id,
      inputSchema: registry.getTool(id, "search").inputSchema,
    })),
  }] };
  const gateway: McpTransportClient = { catalog: async () => catalogData, reload: async () => catalogData,
    invoke: async (request, signal) => { calls++; return fault(request, signal); } };
  const catalog = new McpSourceCatalog(registry, gateway);
  await catalog.refresh();
  const limiter = new ResourceRateLimiter();
  const health = new SourceHealth(() => Date.now());
  const broker = new McpGovernanceBroker(directory, store, registry, catalog, gateway, { limiter, health });
  const sibling = new McpGovernanceBroker(directory, store, registry, catalog, gateway, { limiter });
  t.after(async () => { broker.close(); sibling.close(); await rm(directory, { recursive: true, force: true }); });
  const invoke = (query: string, sourceId = "arxiv", sessionId = "session", signal?: AbortSignal) => broker.invoke({
    input: { query, limit: 1 }, projectId: "project", sessionId, sourceId, toolId: "search", toolCallId: query, turnId: query, signal,
  });
  return { invoke, invocations, gateway, broker, sibling, registry, limiter, health, setFault: (next: typeof fault) => { fault = next; }, calls: () => calls };
}

function failure(status: "rate-limited" | "semantic-error", retryAfterMs?: number): McpInvokeResponse {
  return { attempts: [{ attempt: 1, durationMs: 1, status, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    errorCode: status === "rate-limited" ? "RATE_LIMITED" : "SEMANTIC_ERROR", errorMessage: status === "rate-limited" ? "HTTP 429" : "HTTP 406",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }],
    content: [{ type: "text", text: "Unavailable" }], durationMs: 1, isError: true, requestId: "request", serverId: "biomed", toolName: "arxiv_search" };
}

test("429 cooldown rejects later agent rounds without another upstream request or wait", async t => {
  const f = await fixture(t);
  f.setFault(async () => failure("rate-limited", 60_000));
  await assert.rejects(f.invoke("first"), McpInvocationError);
  await assert.rejects(f.invoke("next-round", "arxiv", "sibling"), McpInvocationError);
  assert.equal(f.calls(), 1);
  assert.equal(f.invocations.at(-1)?.attempts.length, 0);
  assert.ok(f.invocations.at(-1)?.error?.retryAfterMs);
});

function endpoint406(scope: "endpoint" | "request" | "unknown" = "endpoint", endpoint = "https://export.arxiv.org/api/query?token=do-not-log"): McpInvokeResponse {
  const response = failure("semantic-error");
  response.attempts[0]!.upstream = { statusCode: 406, failureScope: scope, endpoint };
  return response;
}
function success(): McpInvokeResponse {
  return { attempts: [{ attempt: 1, durationMs: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "succeeded" }],
    content: [], structuredContent: { sourceId: "europe-pmc", toolId: "search", records: [{ identifier: "PMC123", contentScope: "abstract", fullTextRetrieved: false,
      primaryCitation: { identifier: "PMC123", url: "https://europepmc.org/articles/PMC123", markdown: "[PMC123](https://europepmc.org/articles/PMC123)" } }],
      warnings: [], untrusted: true, retrievedAt: new Date().toISOString() },
    durationMs: 1, isError: false, requestId: "success", serverId: "biomed", toolName: "search" };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail("Timed out waiting for local fault injection");
}

test("parallel 429 callers share cooldown, drain their queue and do not retry inside one slot", async t => {
  const f = await fixture(t);
  let finish!: () => void;
  f.setFault(async request => {
    assert.equal(request.execution.retryPolicy.maxAttempts, 1);
    await new Promise<void>(resolve => { finish = resolve; });
    return failure("rate-limited", 60_000);
  });
  const requests = Array.from({ length: 12 }, (_, i) => f.invoke(`parallel-${i}`, "arxiv", `sibling-${i}`).catch(error => error));
  await waitFor(() => f.calls() === 1);
  await settle(); finish();
  const errors = await Promise.all(requests);
  assert.equal(f.calls(), 1);
  assert.ok(errors.every(error => error instanceof McpInvocationError));
  assert.ok(f.invocations.some(invocation => invocation.error?.code === "SOURCE_COOLDOWN"));
  assert.ok(f.invocations.every(invocation => invocation.attempts.length <= 1));
  await assert.rejects(f.sibling.invoke({ input: { query: "later", limit: 1 }, sourceId: "arxiv", toolId: "search",
    projectId: "another-project", sessionId: "another-task", toolCallId: "later", turnId: "later" }),
    (error: McpInvocationError) => error.invocation.error?.code === "SOURCE_COOLDOWN");
  assert.equal(f.calls(), 1);
});

test("request-specific, unknown and repeated identical 406s never disable a source", async t => {
  const f = await fixture(t);
  for (const scope of ["request", "unknown"] as const) {
    f.setFault(async () => endpoint406(scope));
    for (let i = 0; i < 5; i++) await assert.rejects(f.invoke(`${scope}-${i}`));
  }
  f.setFault(async () => endpoint406());
  for (let i = 0; i < 5; i++) await assert.rejects(f.invoke("same-invalid-query"));
  assert.equal(f.calls(), 15);
  assert.ok(f.invocations.every(invocation => invocation.error?.code !== "SOURCE_COOLDOWN"));
});

test("three distinct endpoint 406s suppress later rounds with sanitized diagnostics and honest fallback", async t => {
  const f = await fixture(t);
  const logs: unknown[][] = [];
  t.mock.method(console, "info", (...args: unknown[]) => { logs.push(args); });
  f.setFault(async request => request.toolName.startsWith("europe") ? success() : endpoint406());
  for (let i = 0; i < 3; i++) await assert.rejects(f.invoke(`valid-${i}`));
  await assert.rejects(f.invoke("do-not-amplify"));
  assert.equal(f.calls(), 3);
  const error = f.invocations.at(-1)!.error!;
  assert.equal(error.code, "SOURCE_COOLDOWN");
  assert.equal(error.retryAfterMs! <= 30_000, true);
  assert.match(error.message, /^This source is temporarily unavailable/);
  assert.match(error.guidance!, /Preserve citation and evidence requirements/);
  assert.match(error.guidance!, /Do not claim content was retrieved/);
  assert.deepEqual(error.fallbackSourceIds, ["europe-pmc"]);
  assert.equal(error.sourceHealth?.statusCode, 406);
  assert.equal(error.sourceHealth?.endpoint, "https://export.arxiv.org");
  assert.equal(logs.length, 1, "log transitions rather than every rejected sibling");
  assert.ok(!JSON.stringify([logs, f.invocations]).includes("do-not-log"));
  const alternative = await f.invoke("alternative", "europe-pmc");
  assert.equal(alternative.result.records[0]!.fullTextRetrieved, false);
  assert.equal(alternative.result.records[0]!.primaryCitation.identifier, "PMC123");
});

test("unattributed hosts cannot suppress an endpoint and successful requests reset rejection streaks", async t => {
  const f = await fixture(t);
  f.setFault(async () => endpoint406("endpoint", "https://attacker.test/?password=secret"));
  for (let i = 0; i < 4; i++) await assert.rejects(f.invoke(`untrusted-${i}`));
  f.setFault(async () => endpoint406());
  await assert.rejects(f.invoke("first")); await assert.rejects(f.invoke("second"));
  f.setFault(async () => success()); await f.invoke("success");
  f.setFault(async () => endpoint406());
  await assert.rejects(f.invoke("third")); await assert.rejects(f.invoke("fourth"));
  assert.equal(f.calls(), 9);
  assert.ok(f.invocations.every(invocation => invocation.error?.code !== "SOURCE_COOLDOWN"));
});

test("cooldown admits one recovery probe, excludes siblings and restores access on success", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"] });
  f.setFault(async () => failure("rate-limited", 1_000));
  await assert.rejects(f.invoke("first"));
  t.mock.timers.tick(1_001);
  let finish!: () => void;
  f.setFault(async () => { await new Promise<void>(resolve => { finish = resolve; }); return success(); });
  const probe = f.invoke("probe");
  await waitFor(() => f.calls() === 2);
  const siblings = await Promise.all(Array.from({ length: 8 }, (_, i) => f.invoke(`probe-peer-${i}`).catch(error => error)));
  assert.ok(siblings.every((error: McpInvocationError) => error.invocation.error?.sourceHealth?.decision === "probe-in-flight"));
  assert.equal(f.calls(), 2);
  finish(); await probe;
  f.setFault(async () => success()); await f.invoke("recovered");
  assert.equal(f.calls(), 3);
});

test("failed recovery probes apply bounded exponential cooldown without independent sleeps", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"] });
  f.setFault(async () => failure("rate-limited"));
  for (let i = 0; i < 8; i++) {
    await assert.rejects(f.invoke(`probe-${i}`));
    const delay = f.invocations.at(-1)!.error!.retryAfterMs!;
    assert.equal(delay, Math.min(30_000, 1_000 * 2 ** i));
    await assert.rejects(f.invoke(`peer-${i}`));
    assert.equal(f.calls(), i + 1);
    t.mock.timers.tick(delay + 1);
  }
});

test("406 probe failures remain bounded and recover after the upstream recovers", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"] });
  f.setFault(async () => endpoint406());
  for (let i = 0; i < 3; i++) await assert.rejects(f.invoke(`initial-${i}`));
  for (const delay of [30_000, 60_000, 120_000, 120_000]) {
    assert.equal(f.invocations.at(-1)!.error!.retryAfterMs, delay);
    t.mock.timers.tick(delay + 1);
    await assert.rejects(f.invoke(`probe-${delay}`));
    await assert.rejects(f.invoke(`peer-${delay}`));
  }
  const delay = f.invocations.at(-1)!.error!.retryAfterMs!;
  t.mock.timers.tick(delay + 1);
  f.setFault(async () => success()); await f.invoke("recovery"); await f.invoke("normal");
  assert.equal(f.calls(), 9);
});

test("queue exhaustion, timeout and cancellation free resources for subsequent requests", async t => {
  const f = await fixture(t);
  let finish!: () => void;
  f.setFault(async () => { await new Promise<void>(resolve => { finish = resolve; }); return success(); });
  const active = f.invoke("active"); await waitFor(() => f.calls() === 1);
  const controller = new AbortController();
  const cancelled = f.invoke("cancelled", "arxiv", "session", controller.signal).catch(error => error);
  await settle(); controller.abort(new DOMException("Cancelled", "AbortError"));
  const queued = Array.from({ length: 8 }, (_, i) => f.invoke(`queue-${i}`).catch(error => error));
  const errors = await Promise.all(queued);
  assert.equal((await cancelled).invocation.error.code, "CANCELLED");
  assert.ok(errors.some((error: McpInvocationError) => error.invocation.error?.code === "RATE_LIMIT_QUEUE_FULL"));
  assert.ok(errors.some((error: McpInvocationError) => error.invocation.error?.code === "RATE_LIMIT_QUEUE_TIMEOUT"));
  assert.equal(f.calls(), 1);
  finish(); await active;
  f.setFault(async () => success()); await f.invoke("after-cleanup");
  assert.equal(f.calls(), 2);
});

test("cancelling a recovery probe releases both its slot and the single probe permit", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"] });
  f.setFault(async () => failure("rate-limited", 1_000)); await assert.rejects(f.invoke("first"));
  t.mock.timers.tick(1_001);
  f.setFault(async (_request, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  const controller = new AbortController();
  const probe = f.invoke("cancel-probe", "arxiv", "session", controller.signal);
  await waitFor(() => f.calls() === 2); controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(probe);
  assert.equal(f.invocations.at(-1)!.error!.code, "CANCELLED");
  f.setFault(async () => success()); await f.invoke("replacement-probe");
  assert.equal(f.calls(), 3);
});

test("different credentials remain independent while different sessions with identical credentials share health", async t => {
  const f = await fixture(t);
  let scope = "credential-a-secret";
  f.gateway.sourceScope = () => scope;
  f.setFault(async () => failure("rate-limited", 60_000));
  await assert.rejects(f.invoke("first")); await assert.rejects(f.invoke("sibling", "arxiv", "other-session"));
  assert.equal(f.calls(), 1);
  scope = "credential-b-secret";
  f.setFault(async () => success()); await f.invoke("other-credential");
  scope = "credential-a-secret"; await assert.rejects(f.invoke("original"));
  assert.equal(f.calls(), 2);
  assert.ok(!JSON.stringify(f.invocations).includes("credential-a-secret"));
  assert.ok(!JSON.stringify(f.invocations).includes("credential-b-secret"));
});

test("no enabled alternative is reported honestly as blocked", async t => {
  const f = await fixture(t);
  f.setFault(async () => failure("rate-limited", 60_000));
  await assert.rejects(f.broker.invoke({ input: { query: "first" }, projectId: "project", sessionId: "session", sourceId: "arxiv", toolId: "search",
    allowedSourceIds: ["arxiv"], toolCallId: "first", turnId: "first" }));
  assert.match(f.invocations.at(-1)!.error!.message, /blocked because no alternative source is available/);
  assert.deepEqual(f.invocations.at(-1)!.error!.fallbackSourceIds, []);
});

test("a success already in flight does not erase a newer sibling cooldown", () => {
  let now = 0;
  const health = new SourceHealth(() => now);
  const earlier = health.admit("source");
  health.failure("source", health.admit("source"), failure("rate-limited", 1000).attempts[0]!, "other");
  health.success("source", earlier);
  assert.throws(() => health.check("source"));
  now = 1001; const probe = health.admit("source"); health.success("source", probe);
  assert.doesNotThrow(() => health.check("source"));
  assert.equal(SOURCE_HEALTH_POLICY.rejectionThreshold, 3);
});

test("rejection threshold expires outside its window and request-specific errors break the streak", () => {
  let now = 1;
  const health = new SourceHealth(() => now);
  const reject = (fingerprint: string) => health.failure("source", health.admit("source"), endpoint406().attempts[0]!, fingerprint);
  assert.equal(reject("one"), undefined); assert.equal(reject("two"), undefined);
  now += 60_001;
  assert.equal(reject("three"), undefined); assert.equal(reject("four"), undefined);
  health.failure("source", health.admit("source"), endpoint406("request").attempts[0]!, "bad-request");
  assert.equal(reject("five"), undefined); assert.equal(reject("six"), undefined);
  assert.equal(reject("seven")?.diagnostic.statusCode, 406);
});

test("a probe failing with a different HTTP status continues suppression", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"] });
  f.setFault(async () => failure("rate-limited", 1000)); await assert.rejects(f.invoke("first"));
  t.mock.timers.tick(1001);
  f.setFault(async () => endpoint406("unknown")); await assert.rejects(f.invoke("probe"));
  await assert.rejects(f.invoke("peer"));
  assert.equal(f.calls(), 2);
  assert.ok(f.invocations.at(-1)!.error!.retryAfterMs! > 0);
});

test("broker attempts retain source pacing and concurrency on normal requests", async t => {
  const f = await fixture(t);
  const source = f.registry.get("arxiv");
  f.registry.upsert({ ...source, manifest: { ...source.manifest,
    governance: { ...source.manifest.governance, minIntervalMs: 15, queueTimeoutMs: 1000 } } });
  const starts: number[] = [];
  f.setFault(async request => { assert.equal(request.execution.retryPolicy.maxAttempts, 1); starts.push(Date.now()); return success(); });
  await Promise.all(["first", "second", "third"].map(query => f.invoke(query)));
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 14);
});
