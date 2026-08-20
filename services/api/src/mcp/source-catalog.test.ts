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
import test from "node:test";

import type {
  McpCatalog,
  McpSourceAdapter,
  McpSourceManifest,
} from "@sciencediscovery/schema";
import { createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";

import type { McpTransportClient } from "./transport.js";
import { inputSchemasCompatible, McpSourceCatalog } from "./source-catalog.js";

function manifest(): McpSourceManifest {
  return {
    cache: { enabled: true, scope: "global-public", ttlSeconds: 60 },
    description: "Demo",
    displayName: "Demo",
    enabledByDefault: false,
    governance: {
      attribution: "Demo",
      dataClassification: "public",
      license: "Demo",
      maxConcurrentRequests: 1,
      maxResponseBytes: 1_000,
      networkHosts: ["example.test"],
      rateLimitGroup: "demo",
      rateLimitPerSecond: 1,
      termsUrl: "https://example.test/terms",
    },
    id: "demo",
    kinds: ["dataset"],
    prompt: { caveats: [], citationPolicy: "record", summary: "Demo" },
    publisher: "Demo",
    schemaVersion: "1",
    tools: {
      search: {
        description: "Search",
        displayName: "Search",
        id: "search",
        idempotent: true,
        inputSchema: {
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object",
        },
        kind: "search",
        mcpToolName: "search",
        permission: { action: "connector", resourceTemplate: "demo:search", summaryTemplate: "Search demo" },
        resultType: "structured-data",
        retryPolicy: {
          initialDelayMs: 1,
          jitterRatio: 0,
          maxAttempts: 1,
          maxDelayMs: 1,
          multiplier: 2,
          respectRetryAfter: true,
          retryOn: [],
        },
        routing: { keywords: ["demo"], mode: "prefer", priority: 50 },
        timeoutMs: 1_000,
      },
    },
    transport: { mcpServerId: "demo-server", type: "mcp" },
    version: "1",
  };
}

function adapter(sourceManifest: McpSourceManifest): McpSourceAdapter {
  return {
    manifest: sourceManifest,
    async normalizeResult() {
      throw new Error("not used");
    },
    validateInput(_toolId, input) {
      return { input: input as never, valid: true };
    },
  };
}

test("schema compatibility requires remote required inputs to be locally required", () => {
  assert.equal(inputSchemasCompatible(
    { properties: { query: { type: "string" } }, required: ["query"], type: "object" },
    { properties: { query: { type: "string" } }, required: ["query"], type: "object" },
  ), true);
  assert.equal(inputSchemasCompatible(
    { properties: { query: { type: "string" } }, required: ["query"], type: "object" },
    { properties: { query: {}, species: {} }, required: ["query", "species"], type: "object" },
  ), false);
});

test("source catalog marks missing MCP tools as degraded", async () => {
  const registry = createMcpSourceRegistry().register(adapter(manifest()));
  const remoteCatalog: McpCatalog = {
    loadedAt: "2026-01-01T00:00:00Z",
    revision: "rev",
    servers: [{
      enabled: true,
      id: "demo-server",
      tools: [],
      transport: "stdio",
    }],
  };
  const gateway = { async catalog() { return remoteCatalog; } } as McpTransportClient;
  const catalog = new McpSourceCatalog(registry, gateway);
  await catalog.refresh();

  assert.equal(catalog.getStatus("demo").status, "degraded");
  assert.deepEqual(catalog.getStatus("demo").missingTools, ["search"]);
});
