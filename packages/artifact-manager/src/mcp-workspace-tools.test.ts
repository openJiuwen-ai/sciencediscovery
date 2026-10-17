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
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { McpSourceCatalog } from "../../data-source/src/catalog.js";
import { McpSourceRegistry } from "../../mcp-sources/src/registry.js";
import { createPublicBiomedSources } from "../../mcp-sources/src/public-biomed.js";
import type { McpCatalog } from "@sciencediscovery/schema";
import { createMcpWorkspaceTools, type McpWorkspaceToolOptions } from "./mcp-workspace-tools.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

function fixture() {
  const registry = new McpSourceRegistry();
  for (const source of createPublicBiomedSources(["arxiv", "pubmed"])) registry.register(source);
  const remote: McpCatalog = {
    revision: "test", loadedAt: new Date().toISOString(),
    servers: [{ id: "biomed", enabled: true, transport: "stdio", tools: registry.list().flatMap(({ manifest }) =>
      Object.values(manifest.tools).map((tool) => ({ name: tool.mcpToolName!, inputSchema: tool.inputSchema, description: tool.description, schemaHash: "test" }))) }],
  };
  const catalog = new McpSourceCatalog(registry, {
    catalog: async () => remote, reload: async () => remote,
    invoke: async () => { throw new Error("No external calls in construction tests"); },
  });
  // Construction does not use the execution-only ports.
  const options = { registry, catalog, enabledSourceIds: ["arxiv", "pubmed"] } as unknown as McpWorkspaceToolOptions;
  return { options, catalog, remote };
}

test("enabled literature sources fail visibly before the catalog is refreshed", () => {
  const { options } = fixture();
  assert.throws(() => createMcpWorkspaceTools(options), /arxiv: unavailable.*pubmed: unavailable.*Check \/api\/mcp\/sources/);
});

test("ready literature sources expose every declared MCP tool", async () => {
  const { options, catalog } = fixture();
  await catalog.refresh();
  const names = createMcpWorkspaceTools(options).mcpTools!.map((tool) => tool.name);
  assert.deepEqual(names, options.registry.list().flatMap(({ manifest }) =>
    Object.keys(manifest.tools).map((id) => `mcp__${manifest.id}__${id}`)));
  assert.ok(names.includes("mcp__arxiv__search"));
  assert.ok(names.includes("mcp__pubmed__search"));
});

for (const failure of ["missing server", "disabled server", "server error", "missing tool", "incompatible tool"] as const) {
  test(`enabled literature sources reject ${failure} and recover after refresh`, async () => {
    const { options, catalog, remote } = fixture();
    const healthy = structuredClone(remote.servers);
    if (failure === "missing server") remote.servers = [];
    if (failure === "disabled server") remote.servers[0]!.enabled = false;
    if (failure === "server error") remote.servers[0]!.error = "connection failed";
    if (failure === "missing tool") remote.servers[0]!.tools.shift();
    if (failure === "incompatible tool") remote.servers[0]!.tools[0]!.inputSchema = { type: "array" };
    await catalog.refresh();
    assert.throws(() => createMcpWorkspaceTools(options), /Enabled MCP sources are not ready:.*(?:unavailable|degraded)/);
    remote.servers = healthy;
    await catalog.refresh();
    assert.ok(createMcpWorkspaceTools(options).mcpTools!.length > 0);
  });
}

test("unselected unhealthy MCP sources do not block web-only work", () => {
  const { options } = fixture();
  options.enabledSourceIds = ["web"];
  assert.deepEqual(createMcpWorkspaceTools(options).mcpTools, []);
});

test("a selected ready source remains usable when an unselected source is degraded", async () => {
  const { options, catalog, remote } = fixture();
  remote.servers[0]!.tools = remote.servers[0]!.tools.filter((tool) => tool.name !== "arxiv_search");
  await catalog.refresh();
  assert.equal(catalog.getStatus("arxiv").status, "degraded");
  options.enabledSourceIds = ["pubmed"];
  const tools = createMcpWorkspaceTools(options).mcpTools!;
  assert.ok(tools.some((tool) => tool.name === "mcp__pubmed__search"));
  assert.ok(tools.every((tool) => tool.sourceId === "pubmed"));

  options.enabledSourceIds = ["arxiv", "pubmed"];
  assert.throws(() => createMcpWorkspaceTools(options), /arxiv: degraded.*missing tools: search/);
});

test("subagent construction checks the same enabled literature source readiness", async () => {
  const { options, catalog } = fixture();
  options.parentSubagentId = "literature-searcher-child";
  assert.throws(() => createMcpWorkspaceTools(options), /arxiv: unavailable.*pubmed: unavailable/);
  await catalog.refresh();
  const names = createMcpWorkspaceTools(options).mcpTools!.map((tool) => tool.name);
  assert.ok(names.includes("mcp__arxiv__search"));
  assert.ok(names.includes("mcp__pubmed__search"));
});
