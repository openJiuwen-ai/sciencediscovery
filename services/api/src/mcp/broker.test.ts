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


import { createBuiltinMcpSourceRegistry, createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";

import { SessionStore } from "../store.js";
import {
  ResourceRateLimiter,
  ResourceRateLimitQueueFullError,
  ResourceRateLimitQueueTimeoutError,
  type ResourceRateLimitOptions,
} from "@sciencediscovery/data-source";
import { McpGovernanceBroker } from "@sciencediscovery/data-source";
import type { McpTransportClient } from "@sciencediscovery/data-source";
import type { McpCatalog, McpInvokeResponse, McpToolResult } from "@sciencediscovery/schema";
import type { ObserveToolCallPayload } from "@sciencediscovery/memory";
import { McpSourceCatalog } from "@sciencediscovery/data-source";

test("direct broker calls enforce every source plugin while frozen Run selections remain stable", async context => {
  const dataDir = resolve(process.cwd(), ".tmp", `mcp-plugin-gates-${Date.now()}-${process.pid}`);
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Source plugins");
  const session = await store.createSession(project.id, "Sources", {}, {}, { allowUnconfiguredModel: true });
  const registry = createBuiltinMcpSourceRegistry();
  const ids = registry.list().map(source => source.manifest.id);
  await store.replaceProjectSettings(project.id, { enabledConnectorIds: ids,
    plugins: Object.fromEntries(ids.map(id => [`connector.${id}`, { enabled: false }])) });
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected MCP transport access"); };
  const gateway: McpTransportClient = { catalog: unexpected, reload: unexpected, invoke: unexpected };
  const broker = new McpGovernanceBroker(dataDir, store, registry, new McpSourceCatalog(registry, gateway), gateway);
  context.after(async () => { broker.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  for (const source of registry.list()) {
    const sourceId = source.manifest.id;
    registry.upsert({ ...source, validateInput: () => { throw new Error("Reached validation after selection gate"); } });
    const request = { projectId: project.id, sessionId: session.id, sourceId,
      toolId: Object.keys(source.manifest.tools)[0]!, input: {}, toolCallId: `call-${sourceId}`, turnId: "turn" };
    await assert.rejects(broker.invoke(request), /not enabled for this session/);
    await assert.rejects(broker.invoke({ ...request, allowedSourceIds: [] }), /not enabled for this session/);
    // A trusted existing Run keeps its original scope even after project settings change.
    await assert.rejects(broker.invoke({ ...request, allowedSourceIds: [sourceId] }), /Reached validation after selection gate/);
  }
});

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

/** A memory-graph sink that records every observeToolCall emission. */
function recordingSink(): {
  sink: { observeToolCall: (payload: ObserveToolCallPayload) => void };
  emissions: ObserveToolCallPayload[];
} {
  const emissions: ObserveToolCallPayload[] = [];
  return {
    emissions,
    sink: {
      observeToolCall(payload) {
        emissions.push(payload);
      },
    },
  };
}

/** Build a broker against the builtin registry with one gateway that answers
 *  any registered source/tool with the given normalized result document. */
async function brokerWithGateway(options: {
  dataDir: string;
  store: SessionStore;
  sink?: { observeToolCall: (payload: ObserveToolCallPayload) => void };
  serverId: string;
  sourceId: string;
  toolId: string;
  result: McpToolResult;
  /** Escape hatch: let tests supply a custom wire response (e.g. a
   *  llm-wiki get_page text block carrying the ``content`` field the mirror
   *  reads). Defaults to JSON.stringify-ing ``result``. */
  gatewayResponses?: McpInvokeResponse[];
}) {
  const registry = createBuiltinMcpSourceRegistry();
  const source = registry.get(options.sourceId);
  const tool = source.manifest.tools[options.toolId]!;
  const catalogJson = ({
    loadedAt: new Date().toISOString(),
    revision: "catalog-graph",
    servers: [{
      enabled: true,
      id: options.serverId,
      tools: [{
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.mcpToolName,
        schemaHash: options.toolId,
      }],
      transport: "mcp",
    }],
  }) as unknown as McpCatalog;
  const defaultResponse: McpInvokeResponse = {
    attempts: [{
      attempt: 1, durationMs: 1, finishedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(), status: "succeeded",
    }],
    content: [{ text: JSON.stringify(options.result), type: "text" }],
    durationMs: 1,
    isError: false,
    requestId: "request",
    serverId: options.serverId,
    toolName: tool.mcpToolName ?? options.toolId,
  };
  const responses = options.gatewayResponses ?? [defaultResponse];
  let index = 0;
  const gateway: McpTransportClient = {
    catalog: async () => catalogJson,
    reload: async () => catalogJson,
    invoke: async () => (responses[index++] ?? defaultResponse) as unknown as McpInvokeResponse,
  };
  const catalog = new McpSourceCatalog(registry, gateway);
  await catalog.refresh();
  return new McpGovernanceBroker(options.dataDir, options.store, registry, catalog, gateway, {
    memoryGraphSink: options.sink as never,
  });
}

/** One db-source record shaped like public-biomed's pdb search output. */
function pdbSearchResult(): McpToolResult {
  const citation = {
    identifier: "1J7X",
    identifierType: "PDB ID",
    label: "1J7X",
    markdown: "[PDB:1J7X](https://www.rcsb.org/structure/1J7X)",
    role: "database-record",
    source: "pdb",
    url: "https://www.rcsb.org/structure/1J7X",
  };
  return {
    records: [{
      citations: [citation],
      contentScope: "curated-record",
      crossReferences: [],
      fullTextRetrieved: false,
      identifier: "1J7X",
      identifierType: "PDB ID",
      primaryCitation: citation,
      source: "pdb",
      title: "Human p53 core domain",
      url: "https://www.rcsb.org/structure/1J7X",
      warnings: [],
    }],
    retrievedAt: new Date().toISOString(),
    sourceId: "pdb",
    toolId: "search_structures",
    untrusted: true,
    warnings: [],
  } as unknown as McpToolResult;
}

test("registry-gated mirroring — registered db tool emits db_record products on live and cache paths", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `mcp-graph-pdb-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token", baseUrl: "https://models.test/v1", model: "model", name: "Model", vision: false,
  });
  const project = await store.createProject("Graph pdb");
  const session = await store.createSession(project.id, "pdb", model.id);
  await store.updateSession(session.id, { enabledConnectorIds: ["pdb"] });
  const { sink, emissions } = recordingSink();
  const broker = await brokerWithGateway({
    dataDir, store, sink,
    serverId: "biomed", sourceId: "pdb", toolId: "search_structures",
    result: pdbSearchResult(),
  });
  const request = (toolCallId: string) => ({
    input: { query: "p53" },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "pdb",
    toolCallId,
    toolId: "search_structures",
    turnId: "turn-pdb",
  });

  // Live path: pdb search_structures is in the registry → db_record emission.
  const live = await broker.invoke(request("call-pdb-live"));
  assert.equal(live.result.records.length, 1);
  assert.equal(emissions.length, 1, "live path must emit exactly one observeToolCall");
  const liveEmission = emissions[0]!;
  assert.equal(liveEmission.toolName, "mcp__pdb__search_structures");
  assert.equal(liveEmission.toolType, "search");
  assert.equal(liveEmission.source, "pdb");
  assert.equal(liveEmission.resultCount, 1);
  assert.match(liveEmission.taskId, /^subtask:mcp:/);
  assert.equal(liveEmission.products.length, 1);
  assert.deepEqual(liveEmission.products[0], {
    productType: "db_record",
    source: "pdb",
    identifier: "1J7X",
    identifierType: "PDB ID",
    url: "https://www.rcsb.org/structure/1J7X",
    title: "Human p53 core domain",
    snippet: undefined,
  });

  // Cache path: same search again → cache hit still emits (records the LLM
  // will cite must land on the graph or downstream declare_* calls 422).
  const cached = await broker.invoke(request("call-pdb-cache"));
  assert.equal(cached.invocation.cache.hit, true);
  assert.equal(emissions.length, 2, "cache-hit path must emit as well");
  assert.deepEqual(emissions[1]!.products, liveEmission.products);
});

test("registry-gated mirroring — unregistered lookup tool emits nothing despite succeeding", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `mcp-graph-lookup-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token", baseUrl: "https://models.test/v1", model: "model", name: "Model", vision: false,
  });
  const project = await store.createProject("Graph lookup");
  const session = await store.createSession(project.id, "UniProt", model.id);
  await store.updateSession(session.id, { enabledConnectorIds: ["uniprot"] });
  const { sink, emissions } = recordingSink();
  // uniprot lookup is NOT in TOOL_GRAPH_REGISTRY (lookup is deferred) — a
  // successful lookup must not mirror anything, live or cached.
  const citation = {
    identifier: "P04637",
    identifierType: "UniProt accession",
    label: "TP53",
    markdown: "[UniProt:P04637](https://www.uniprot.org/uniprotkb/P04637/entry)",
    role: "database-record",
    source: "uniprot",
    url: "https://www.uniprot.org/uniprotkb/P04637/entry",
  };
  const broker = await brokerWithGateway({
    dataDir, store, sink,
    serverId: "uniprot", sourceId: "uniprot", toolId: "lookup",
    result: {
      records: [{
        citations: [citation], contentScope: "curated-record", crossReferences: [],
        fullTextRetrieved: false, identifier: "P04637", identifierType: "UniProt accession",
        primaryCitation: citation, source: "uniprot", structuredData: { reviewed: true },
        title: "Cellular tumor antigen p53", url: citation.url, warnings: [],
      }],
      retrievedAt: new Date().toISOString(),
      sourceId: "uniprot", toolId: "lookup", untrusted: true, warnings: [],
    } as unknown as McpToolResult,
  });
  const request = (toolCallId: string) => ({
    input: { accession: "P04637" },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "uniprot",
    toolCallId,
    toolId: "lookup",
    turnId: "turn-lookup",
  });

  await broker.invoke(request("call-lookup-live"));
  const cached = await broker.invoke(request("call-lookup-cache"));
  assert.equal(cached.invocation.cache.hit, true);
  assert.equal(emissions.length, 0, "an unregistered tool must never emit (live or cached)");
});

test("registry-gated mirroring — suppressMemoryGraphMirror keeps the reviewer read path silent", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `mcp-graph-suppress-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token", baseUrl: "https://models.test/v1", model: "model", name: "Model", vision: false,
  });
  const project = await store.createProject("Graph suppress")
  const session = await store.createSession(project.id, "pdb", model.id);
  await store.updateSession(session.id, { enabledConnectorIds: ["pdb"] });
  const { sink, emissions } = recordingSink();
  const broker = await brokerWithGateway({
    dataDir, store, sink,
    serverId: "biomed", sourceId: "pdb", toolId: "search_structures",
    result: pdbSearchResult(),
  });
  await broker.invoke({
    input: { query: "p53" },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "pdb",
    suppressMemoryGraphMirror: true,
    toolCallId: "call-suppress",
    toolId: "search_structures",
    turnId: "turn-suppress",
  });
  assert.equal(emissions.length, 0, "a registered tool with the suppress flag must not emit");
});

test("llm-wiki get_page mirrors web_page with contentHash from the CAS data pool", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `mcp-pr9-getpage-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token", baseUrl: "https://models.test/v1", model: "model", name: "Model", vision: false,
  });
  const project = await store.createProject("get_page");
  const session = await store.createSession(project.id, "llm-wiki", model.id);
  await store.updateSession(session.id, { enabledConnectorIds: ["llm-wiki"] });
  const { sink, emissions } = recordingSink();

  const pageContent = "BRCA1 is a tumor suppressor gene on chromosome 17.";
  const payload = {
    attribution: "llm-wiki",
    license: "owner-managed",
    page_id: "wiki/BRCA1",
    title: "BRCA1",
    summary: "tumor suppressor gene",
    content: pageContent,
    sources: ["ref1"],
  };
  const rawJson = JSON.stringify(payload);
  // sha256 of pageContent — keep the test self-contained by computing it.
  const expectedHash = await (await import("node:crypto")).createHash("sha256")
    .update(Buffer.from(pageContent, "utf8")).digest("hex");

  const broker = await brokerWithGateway({
    dataDir, store, sink,
    serverId: "llm-wiki", sourceId: "llm-wiki", toolId: "get_page",
    result: {
      records: [{
        citations: [], contentScope: "curated-record", crossReferences: [],
        fullTextRetrieved: true,
        identifier: "wiki/BRCA1", identifierType: "wiki-path",
        primaryCitation: {
          identifier: "wiki/BRCA1", identifierType: "wiki-path",
          label: "BRCA1", markdown: "[LLM Wiki:wiki/BRCA1](http://wiki.local/BRCA1)",
          role: "database-record", source: "llm-wiki",
          url: "http://wiki.local/BRCA1",
        },
        source: "llm-wiki",
        title: "BRCA1",
        url: "http://wiki.local/BRCA1",
        warnings: [],
      }],
      retrievedAt: new Date().toISOString(),
      sourceId: "llm-wiki",
      toolId: "get_page",
      untrusted: true,
      warnings: [],
    } as unknown as McpToolResult,
    gatewayResponses: [{
      attempts: [{
        attempt: 1, durationMs: 1, finishedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(), status: "succeeded",
      }],
      content: [{ text: rawJson, type: "text" }],
      durationMs: 1,
      isError: false,
      requestId: "request",
      serverId: "llm-wiki",
      toolName: "get_page",
    }, {
      attempts: [{
        attempt: 1, durationMs: 1, finishedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(), status: "succeeded",
      }],
      // llm-wiki's cache is disabled by default, so the second invocation
      // also walks the gateway — return the same payload so the mirror
      // re-lands the body (content-addressed → no-op blob write).
      content: [{ text: rawJson, type: "text" }],
      durationMs: 1,
      isError: false,
      requestId: "request",
      serverId: "llm-wiki",
      toolName: "get_page",
    }],
  });

  const live = await broker.invoke({
    input: { path: "wiki/BRCA1" },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "llm-wiki",
    toolCallId: "call-pr9-live",
    toolId: "get_page",
    turnId: "turn-pr9",
  });
  assert.equal(emissions.length, 1);
  const liveEmission = emissions[0]!;
  assert.equal(liveEmission.toolName, "mcp__llm-wiki__get_page");
  assert.equal(liveEmission.products.length, 1);
  const product = liveEmission.products[0]!;
  assert.equal(product.productType, "web_page");
  // The identifier is preserved verbatim; the url is rebuilt from the wiki
  // origin by the adapter (registry normalization), so we only assert it points
  // at the same wiki path.
  assert.equal(product.identifier, "wiki/BRCA1");
  assert.match(product.url ?? "", /\/api\/v1\/wiki\/wiki\/BRCA1$/);
  // The body landed in the CAS data pool; the product carries its hash.
  assert.equal(product.contentHash, expectedHash);
  // The same blob is on disk under the data pool (data/, not agent-state/).
  const blobPath = resolve(dataDir, "versioning", "data", "blobs", "sha256", expectedHash);
  const { stat } = await import("node:fs/promises");
  const st = await stat(blobPath);
  assert.equal(st.size, Buffer.byteLength(pageContent, "utf8"));

  // A second call must mirror identically — content_hash re-landing is a
  // no-op because the blob is content-addressed. (llm-wiki's manifest cache
  // is disabled, so this is a fresh live invocation, not a cache hit.)
  const cached = await broker.invoke({
    input: { path: "wiki/BRCA1" },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "llm-wiki",
    toolCallId: "call-pr9-second",
    toolId: "get_page",
    turnId: "turn-pr9",
  });
  assert.equal(emissions.length, 2);
  assert.equal(emissions[1]!.products[0]!.contentHash, expectedHash);
  assert.equal(cached.invocation.status, "succeeded");
});

test("search tools (no body) keep their snippet-only web_page products", async (context) => {
  // web_search carries no ``content`` field on the text block → contentHash
  // must NOT appear on the emitted product (the snippet-only state stays
  // intact).
  const dataDir = resolve(process.cwd(), ".tmp", `mcp-pr9-search-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token", baseUrl: "https://models.test/v1", model: "model", name: "Model", vision: false,
  });
  const project = await store.createProject("web_search");
  const session = await store.createSession(project.id, "llm-wiki", model.id);
  await store.updateSession(session.id, { enabledConnectorIds: ["llm-wiki"] });
  const { sink, emissions } = recordingSink();
  const broker = await brokerWithGateway({
    dataDir, store, sink,
    serverId: "llm-wiki", sourceId: "llm-wiki", toolId: "search",
    result: {
      records: [{
        citations: [], contentScope: "curated-record", crossReferences: [],
        fullTextRetrieved: false, identifier: "wiki/X", identifierType: "wiki-path",
        primaryCitation: {
          identifier: "wiki/X", identifierType: "wiki-path",
          label: "X", markdown: "[LLM Wiki:wiki/X](http://wiki.local/X)",
          role: "database-record", source: "llm-wiki", url: "http://wiki.local/X",
        },
        source: "llm-wiki", title: "X", url: "http://wiki.local/X",
        warnings: [],
      }],
      retrievedAt: new Date().toISOString(),
      sourceId: "llm-wiki", toolId: "search",
      untrusted: true, warnings: [],
    } as unknown as McpToolResult,
    gatewayResponses: [{
      attempts: [{
        attempt: 1, durationMs: 1, finishedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(), status: "succeeded",
      }],
      // llm-wiki's search adapter reads `sources` (not `pages`) — match the
      // adapter's expected payload shape (see llm-wiki.ts normalizeResult).
      content: [{ text: JSON.stringify({
        attribution: "llm-wiki",
        license: "owner-managed",
        sources: [{
          page_id: "wiki/X",
          title: "X",
          summary: "summary",
          content: "page body",
          source_refs: [],
        }],
      }), type: "text" }],
      durationMs: 1,
      isError: false,
      requestId: "request",
      serverId: "llm-wiki",
      toolName: "search",
    }],
  });
  // Note: only one gateway response is needed for the search case because
  // the test makes a single broker.invoke call.
  await broker.invoke({
    input: { query: "TP53" },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "llm-wiki",
    toolCallId: "call-pr9-search",
    toolId: "search",
    turnId: "turn-pr9-search",
  });
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0]!.products[0]!.contentHash, undefined,
    "a snippet-only search must not carry contentHash");
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
