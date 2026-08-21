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

import { createBuiltinMcpSourceRegistry, createMcpSourceRegistry } from "@science-agent/mcp-sources";

import { SessionStore } from "../store.js";
import {
  ResourceRateLimiter,
  ResourceRateLimitQueueFullError,
  ResourceRateLimitQueueTimeoutError,
  type ResourceRateLimitOptions,
} from "@science-agent/data-source";
import { McpGovernanceBroker } from "@science-agent/data-source";
import type { McpTransportClient } from "@science-agent/data-source";
import type { McpCatalog, McpInvokeResponse } from "@science-agent/schema";
import { McpSourceCatalog } from "@science-agent/data-source";

test("governance broker invokes native UniProt MCP through the gateway and caches normalized records", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `mcp-native-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token", baseUrl: "https://models.test/v1", model: "model", name: "Model", vision: false,
  });
  const project = await store.createProject("Native MCP");
  const session = await store.createSession(project.id, "UniProt", model.id);
  await store.updateSession(session.id, { enabledConnectorIds: ["uniprot"] });
  await store.updateMcpProxyPolicies({ policies: { uniprot: "none" } });
  const registry = createBuiltinMcpSourceRegistry();
  const lookup = registry.get("uniprot").manifest.tools.lookup!;
  let invokeCalls = 0;
  const catalogNative = ({
        loadedAt: new Date().toISOString(),
        revision: "catalog-native",
        servers: [{
          enabled: true,
          id: "uniprot",
          tools: [{
            description: "lookup",
            inputSchema: lookup.inputSchema,
            name: "lookup",
            schemaHash: "lookup",
          }],
          transport: "stdio",
        }],
  }) as unknown as McpCatalog;
  const gateway: McpTransportClient = {
    catalog: async () => catalogNative,
    reload: async () => catalogNative,
    invoke: async (request) => {
    // The broker must forward the resolved proxy on the real request object.
    assert.deepEqual(request.proxy, { mode: "direct" });
    invokeCalls += 1;
    const citation = {
      identifier: "P04637",
      identifierType: "UniProt accession",
      label: "TP53",
      markdown: "[UniProt:P04637](https://www.uniprot.org/uniprotkb/P04637/entry)",
      role: "database-record",
      source: "uniprot",
      url: "https://www.uniprot.org/uniprotkb/P04637/entry",
    };
    return ({
      attempts: [{
        attempt: 1, durationMs: 1, finishedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(), status: "succeeded",
      }],
      content: [{ text: JSON.stringify({
        attribution: "server",
        license: "server",
        records: [{
          citations: [citation], contentScope: "curated-record", crossReferences: [],
          fullTextRetrieved: false, identifier: "P04637", identifierType: "UniProt accession",
          primaryCitation: citation, source: "uniprot", structuredData: { reviewed: true },
          title: "Cellular tumor antigen p53", url: citation.url, warnings: [],
        }],
        retrievedAt: new Date().toISOString(), sourceId: "uniprot", toolId: "lookup",
        untrusted: true, warnings: [],
      }), type: "text" }],
      durationMs: 1,
      isError: false,
      requestId: "request",
      serverId: "uniprot",
      toolName: "lookup",
    }) as unknown as McpInvokeResponse;
    },
  };
  const catalog = new McpSourceCatalog(registry, gateway);
  await catalog.refresh();
  const broker = new McpGovernanceBroker(
    dataDir,
    store,
    registry,
    catalog,
    gateway,
  );
  const invoke = (toolCallId: string) => broker.invoke({
    authorize: async () => ({
      action: "connector",
      approvalMode: "ask_for_dangerous",
      createdAt: new Date().toISOString(),
      id: "authorization-native",
      outcome: "allowed",
      permissionEpochId: session.permissionEpochId,
      projectId: project.id,
      resource: "uniprot:lookup",
      sessionId: session.id,
      source: "user_once",
    }),
    input: { accession: "p04637" },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "uniprot",
    toolCallId,
    toolId: "lookup",
    turnId: "turn-native",
  });

  const first = await invoke("call-native-1");
  const second = await invoke("call-native-2");
  assert.equal(first.result.records[0]?.identifier, "P04637");
  assert.equal(first.invocation.transport, "mcp");
  assert.equal(first.invocation.mcpCatalogRevision, "catalog-native");
  assert.equal(second.invocation.cache.hit, true);
  assert.equal(invokeCalls, 1);
  await assert.rejects(
    broker.invoke({
      authorize: async () => { throw new Error("Permission denied by user"); },
      input: { accession: "P04637" },
      projectId: project.id,
      sessionId: session.id,
      sourceId: "uniprot",
      toolCallId: "call-native-denied",
      toolId: "lookup",
      turnId: "turn-native",
    }),
    /Permission denied by user/,
  );
  assert.equal(invokeCalls, 1);
  assert.equal((await store.listMcpInvocations(session.id)).at(-1)?.error?.code, "PERMISSION_DENIED");
});

test("governance broker preserves omitted limits, maps queue guards, and feeds 429s back", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `mcp-rate-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token", baseUrl: "https://models.test/v1", model: "model", name: "Model", vision: false,
  });
  const project = await store.createProject("Rate limits");
  const session = await store.createSession(project.id, "UniProt", model.id);
  await store.updateSession(session.id, { enabledConnectorIds: ["uniprot"] });
  const builtinRegistry = createBuiltinMcpSourceRegistry();
  const source = builtinRegistry.get("uniprot");
  const manifest = structuredClone(source.manifest);
  delete manifest.governance.maxConcurrentRequests;
  delete manifest.governance.maxQueueDepth;
  delete manifest.governance.minIntervalMs;
  delete manifest.governance.queueTimeoutMs;
  delete manifest.governance.rateLimitPerSecond;
  const registry = createMcpSourceRegistry().register({ ...source, manifest });
  const lookup = registry.get("uniprot").manifest.tools.lookup!;
  const catalogRate = ({
        loadedAt: new Date().toISOString(),
        revision: "catalog-rate",
        servers: [{
          enabled: true,
          id: "uniprot",
          tools: [{
            description: "lookup",
            inputSchema: lookup.inputSchema,
            name: "lookup",
            schemaHash: "lookup",
          }],
          transport: "stdio",
        }],
  }) as unknown as McpCatalog;
  const gateway: McpTransportClient = {
    catalog: async () => catalogRate,
    reload: async () => catalogRate,
    invoke: async () => ({
      attempts: [{
        attempt: 1, durationMs: 1, errorCode: "RATE_LIMITED",
        errorMessage: "HTTP 429 Too Many Requests from rest.uniprot.org (retry-after: 2)",
        finishedAt: new Date().toISOString(), retryAfterMs: 2_000,
        startedAt: new Date().toISOString(), status: "rate-limited",
      }],
      content: [{ text: "HTTP 429 Too Many Requests from rest.uniprot.org (retry-after: 2)", type: "text" }],
      durationMs: 1,
      isError: true,
      requestId: "request",
      serverId: "uniprot",
      toolName: "lookup",
    }) as unknown as McpInvokeResponse,
  };
  const catalog = new McpSourceCatalog(registry, gateway);
  await catalog.refresh();
  const reported: Array<[string, number | undefined]> = [];
  let acquireOptions: ResourceRateLimitOptions | undefined;
  let nextAcquire: () => Promise<{ queueWaitMs: number; release: () => void }> =
    async () => ({ queueWaitMs: 7, release: () => {} });
  const limiter = {
    acquire: (_key: string, options: ResourceRateLimitOptions) => {
      acquireOptions = options;
      return nextAcquire();
    },
    reportUpstreamRateLimit: (key: string, retryAfterMs?: number) => {
      reported.push([key, retryAfterMs]);
    },
  } as unknown as ResourceRateLimiter;
  const broker = new McpGovernanceBroker(dataDir, store, registry, catalog, gateway, { limiter });
  const invoke = (toolCallId: string, accession: string) => broker.invoke({
    input: { accession },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "uniprot",
    toolCallId,
    toolId: "lookup",
    turnId: "turn-rate",
  });

  // Upstream 429: structured RATE_LIMITED error, queue wait recorded, cooldown reported.
  await assert.rejects(invoke("call-429", "P04637"), /429/);
  let invocation = (await store.listMcpInvocations(session.id)).at(-1);
  assert.equal(invocation?.error?.code, "RATE_LIMITED");
  assert.equal(invocation?.error?.retryable, true);
  assert.equal(invocation?.error?.retryAfterMs, 2_000);
  assert.equal(invocation?.queueWaitMs, 7);
  assert.deepEqual(reported, [["rest.uniprot.org", 2_000]]);
  assert.deepEqual(acquireOptions, {
    maxConcurrent: undefined,
    maxQueueDepth: undefined,
    minIntervalMs: undefined,
    queueTimeoutMs: undefined,
  });

  nextAcquire = async () => { throw new ResourceRateLimitQueueFullError("rest.uniprot.org", 8); };
  await assert.rejects(invoke("call-full", "P04638"), /too many parallel requests/);
  invocation = (await store.listMcpInvocations(session.id)).at(-1);
  assert.equal(invocation?.error?.code, "RATE_LIMIT_QUEUE_FULL");
  assert.equal(invocation?.error?.retryable, true);

  nextAcquire = async () => { throw new ResourceRateLimitQueueTimeoutError("rest.uniprot.org", 20_000); };
  await assert.rejects(invoke("call-timeout", "P04639"), /no slot became free/);
  invocation = (await store.listMcpInvocations(session.id)).at(-1);
  assert.equal(invocation?.error?.code, "RATE_LIMIT_QUEUE_TIMEOUT");
  assert.equal(invocation?.queueWaitMs, 20_000);
});
