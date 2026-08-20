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
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { McpSourceManifest, McpSourceStatus } from "@sciencediscovery/schema";

import { createApiServer, type ServerConfig } from "../server.js";

import type { McpCatalog } from "@sciencediscovery/schema";
import type { McpTransportClient } from "./transport.js";

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

test("MCP source API exposes only native MCP sources", async (context) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "science-agent-mcp-api-"));
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const config: ServerConfig = {
    authToken: "test-token",
    dataDir,
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 0,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 0,
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
  };
  const server = createApiServer(config, {
    mcpTransport: stubTransport({
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
    }),
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${origin}/api/mcp/sources`, {
    headers: { authorization: "Bearer test-token" },
  });
  assert.equal(response.status, 200);
  const sources = await response.json() as Array<{
    manifest: McpSourceManifest;
    status: McpSourceStatus;
  }>;
  assert.deepEqual(sources.map((source) => source.manifest.id).sort(), [
    "arxiv", "biorxiv", "chembl", "clinvar", "ensembl", "europe-pmc",
    "geo", "medrxiv", "pdb", "pubmed", "reactome", "uniprot",
  ]);
  assert.equal(sources.find((source) => source.manifest.id === "uniprot")?.status.status, "ready");
  assert.ok(sources.filter((source) => source.manifest.transport.mcpServerId === "biomed")
    .every((source) => source.status.status === "unavailable"));
  assert.ok(sources.every((source) => Object.keys(source.manifest.tools).length > 0));
  assert.equal(sources.find((source) => source.manifest.id === "uniprot")?.manifest.transport.type, "mcp");
});
