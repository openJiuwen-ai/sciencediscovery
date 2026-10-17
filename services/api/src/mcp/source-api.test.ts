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
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { createBuiltinMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import type { ConnectorManifest, McpCatalogServer, McpSourceDetails } from "@sciencediscovery/schema";

import { createApiServer, type ServerConfig } from "../server.js";

import type { McpCatalog } from "@sciencediscovery/schema";
import type { McpTransportClient } from "@sciencediscovery/data-source";

/**
 * Minimal MCP transport stub. Tests drive the real catalog/broker path and only
 * replace the server connection, which is what production varies.
 */
function stubTransport(catalog: McpCatalog): McpTransportClient {
  return {
    catalog: async () => catalog,
    invoke: async () => { throw new Error("not invoked in this test"); },
    reload: async () => catalog,
  };
}

async function startApi(context: TestContext, transport: McpTransportClient): Promise<string> {
  const dataDir = await mkdtemp(resolve(tmpdir(), "sciencediscovery-mcp-api-"));
  const config: ServerConfig = {
    authToken: "test-token",
    dataDir,
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 0,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 0,
    // No packaging snapshot in tests: the catalog stays empty unless a test installs one.
    modelCatalogPath: resolve(dataDir, "model-catalog/absent.json"),
    paperPythonPath: resolve(dataDir, "paper-python"),
    paperWorkerPath: resolve(dataDir, "paper-worker.py"),
    port: 0,
    permissionWaitTimeoutMs: 0,
    runnerExecTimeoutMs: 0,
    runnerMaxOutputBytes: 1_000_000,
    runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-token",
    runnerUrl: "http://127.0.0.1:1",
    sshConfigPath: resolve(dataDir, "ssh-config"),
    staticDir: resolve(dataDir, "web"),
    workspaceUpload: {
      maxFileBytes: 1_000_000,
      maxRequestBytes: 10_000_000,
      maxWorkspaceBytes: 10_737_418_240,
    },
    memoryGraph: { url: "http://127.0.0.1:17674", internalToken: "test" },
    evolve: { url: "http://127.0.0.1:4313", internalToken: "test" },
  };
  const server = createApiServer(config, { mcpTransport: transport });
  context.after(async () => {
    // Close sockets before deleting fixture data. An ENOTEMPTY during async
    // startup cleanup must not prevent the HTTP server from being closed.
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
    await rm(dataDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function getJson<T>(origin: string, path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { authorization: "Bearer test-token" } });
  assert.equal(response.status, 200);
  return await response.json() as T;
}

/** A server that lists exactly the tools the built-in manifests expect. */
function healthyServer(id: string, sourceIds: string[]): McpCatalogServer {
  const registry = createBuiltinMcpSourceRegistry();
  return {
    enabled: true,
    id,
    tools: sourceIds.flatMap((sourceId) => Object.values(registry.get(sourceId).manifest.tools)).map((tool) => ({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: tool.mcpToolName ?? tool.id,
      schemaHash: tool.id,
    })),
    transport: "stdio",
  };
}

const BIOMED_SOURCES = ["arxiv", "biorxiv", "chembl", "clinvar", "ensembl", "europe-pmc", "geo", "medrxiv", "pdb", "pubmed", "reactome"];

test("MCP source API exposes only native MCP sources", async (context) => {
  const origin = await startApi(context, stubTransport({
    loadedAt: new Date().toISOString(),
    revision: "catalog-1",
    servers: [{
      description: "UniProt",
      enabled: true,
      id: "uniprot",
      tools: [
        { description: "Search", inputSchema: {
          additionalProperties: false,
          properties: {
            limit: { default: 5, maximum: 25, minimum: 1, type: "integer" },
            query: { maxLength: 500, minLength: 1, type: "string" },
          },
          required: ["query"],
          type: "object",
        }, name: "search", schemaHash: "search" },
        { description: "Lookup", inputSchema: {
          additionalProperties: false,
          properties: { accession: { type: "string" } },
          required: ["accession"],
          type: "object",
        }, name: "lookup", schemaHash: "lookup" },
        { description: "Sequence", inputSchema: {
          additionalProperties: false,
          properties: { accession: { type: "string" }, format: { type: "string" } },
          required: ["accession"],
          type: "object",
        }, name: "prepare_sequence", schemaHash: "sequence" },
      ],
      transport: "stdio",
    }],
  }));

  const sources = await getJson<McpSourceDetails[]>(origin, "/api/mcp/sources");
  assert.deepEqual(sources.map((source) => source.manifest.id).sort(), [
    "arxiv", "biorxiv", "chembl", "clinvar", "ensembl", "europe-pmc",
    "geo", "llm-wiki", "medrxiv", "pdb", "pubmed", "reactome", "uniprot",
  ]);
  assert.equal(sources.find((source) => source.manifest.id === "uniprot")?.status.status, "ready");
  // The fixture configures no biomed server, so its sources are off rather than failing.
  assert.ok(sources.filter((source) => source.manifest.transport.mcpServerId === "biomed")
    .every((source) => source.status.status === "disabled" && !source.connectionError));
  assert.ok(sources.every((source) => Object.keys(source.manifest.tools).length > 0));
  assert.equal(sources.find((source) => source.manifest.id === "uniprot")?.manifest.transport.type, "mcp");
});

test("connectors of an MCP server that is off are not offered, while its management rows remain", async (context) => {
  // biomed is missing from the resolved server table, as when `enabled: false` is set for it.
  const origin = await startApi(context, stubTransport({
    loadedAt: new Date().toISOString(),
    revision: "catalog-off",
    servers: [healthyServer("llm-wiki", ["llm-wiki"]), healthyServer("uniprot", ["uniprot"])],
  }));

  const connectors = await getJson<ConnectorManifest[]>(origin, "/api/connectors");
  assert.deepEqual(connectors.map((connector) => connector.id).toSorted(), ["llm-wiki", "uniprot", "web"]);
  assert.ok(connectors.every((connector) => !connector.connectionError));

  const sources = await getJson<McpSourceDetails[]>(origin, "/api/mcp/sources");
  assert.deepEqual(
    sources.filter((source) => source.status.status === "disabled").map((source) => source.manifest.id).toSorted(),
    BIOMED_SOURCES,
  );
});

test("a server that failed to connect keeps its connectors listed with the failure", async (context) => {
  const checkedAt = new Date().toISOString();
  const origin = await startApi(context, stubTransport({
    loadedAt: checkedAt,
    revision: "catalog-failed",
    servers: [
      { enabled: true, error: "MCP connection timeout", id: "biomed", tools: [], transport: "stdio" },
      // Connected, but listing none of the expected tools: degraded, not a connection failure.
      { enabled: true, id: "llm-wiki", tools: [], transport: "stdio" },
      healthyServer("uniprot", ["uniprot"]),
    ],
  }));

  const connectors = await getJson<ConnectorManifest[]>(origin, "/api/connectors");
  assert.deepEqual(connectors.map((connector) => connector.id).toSorted(), [...BIOMED_SOURCES, "llm-wiki", "uniprot", "web"].toSorted());
  const failed = connectors.filter((connector) => connector.connectionError);
  assert.deepEqual(failed.map((connector) => connector.id).toSorted(), BIOMED_SOURCES);
  assert.ok(failed.every((connector) => connector.connectionError?.message === "MCP connection timeout"
    && connector.connectionError.checkedAt === checkedAt));

  const sources = await getJson<McpSourceDetails[]>(origin, "/api/mcp/sources");
  const byId = new Map(sources.map((source) => [source.manifest.id, source]));
  assert.equal(byId.get("pubmed")?.status.status, "unavailable");
  assert.equal(byId.get("pubmed")?.connectionError?.message, "MCP connection timeout");
  assert.equal(byId.get("llm-wiki")?.status.status, "degraded");
  assert.equal(byId.get("llm-wiki")?.connectionError, undefined);
  assert.equal(byId.get("uniprot")?.status.status, "ready");
  assert.equal(byId.get("uniprot")?.connectionError, undefined);
});

test("a catalog that was never refreshed neither hides nor flags connectors", async (context) => {
  const origin = await startApi(context, {
    catalog: async () => { throw new Error("extensions config is not valid JSON"); },
    invoke: async () => { throw new Error("not invoked in this test"); },
    reload: async () => { throw new Error("not reloaded in this test"); },
  });

  const connectors = await getJson<ConnectorManifest[]>(origin, "/api/connectors");
  assert.deepEqual(connectors.map((connector) => connector.id).toSorted(), [...BIOMED_SOURCES, "llm-wiki", "uniprot", "web"].toSorted());
  assert.ok(connectors.every((connector) => !connector.connectionError));
  const sources = await getJson<McpSourceDetails[]>(origin, "/api/mcp/sources");
  assert.ok(sources.every((source) => source.status.status === "unavailable"
    && source.status.error === "MCP catalog has not been refreshed" && !source.connectionError));
});
