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
import { McpSourceCatalog } from "@sciencediscovery/data-source";
import { McpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { createPublicBiomedSources } from "@sciencediscovery/mcp-sources";
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

test("enabled literature sources expose diagnostics before the catalog is refreshed", () => {
  const { options } = fixture();
  const reports: string[] = [];
  options.reportReadiness = summary => reports.push(summary);
  const result = createMcpWorkspaceTools(options);
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /omitted tools:.*search/);
  assert.deepEqual(result.mcpTools, []);
  assert.match(result.mcpReadiness!.summary, /arxiv.*unavailable.*pubmed.*unavailable/);
});

test("ready literature sources expose every declared MCP tool", async () => {
  const { options, catalog } = fixture();
  await catalog.refresh();
  const tools = createMcpWorkspaceTools(options).mcpTools!;
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, options.registry.list().flatMap(({ manifest }) =>
    Object.keys(manifest.tools).map((id) => `mcp__${manifest.id}__${id}`)));
  assert.ok(names.includes("mcp__arxiv__search"));
  assert.ok(names.includes("mcp__pubmed__search"));
  assert.equal(tools.find((tool) => tool.name === "mcp__pubmed__search")?.parallelSafe, true);
});

for (const failure of ["missing server", "disabled server", "server error", "missing tool", "incompatible tool"] as const) {
  test(`enabled literature sources report ${failure} and recover after refresh`, async () => {
    const { options, catalog, remote } = fixture();
    const healthy = structuredClone(remote.servers);
    if (failure === "missing server") remote.servers = [];
    if (failure === "disabled server") remote.servers[0]!.enabled = false;
    if (failure === "server error") remote.servers[0]!.error = "connection failed";
    if (failure === "missing tool") remote.servers[0]!.tools.shift();
    if (failure === "incompatible tool") remote.servers[0]!.tools[0]!.inputSchema = { type: "array" };
    await catalog.refresh();
    assert.match(createMcpWorkspaceTools(options).mcpReadiness!.summary, /unavailable|degraded/);
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
  assert.match(createMcpWorkspaceTools(options).mcpReadiness!.summary, /degraded/);
  assert.ok(createMcpWorkspaceTools(options).mcpTools!.some(tool => tool.name === "mcp__pubmed__search"));
  await assert.rejects(createMcpWorkspaceTools(options).mcpReadiness!.invoke("pubmed", "search", {}, undefined, "already-mounted"), /not a recovered/);
});

test("subagent construction checks the same enabled literature source readiness", async () => {
  const { options, catalog } = fixture();
  options.parentSubagentId = "literature-searcher-child";
  assert.match(createMcpWorkspaceTools(options).mcpReadiness!.summary, /arxiv.*unavailable.*pubmed.*unavailable/);
  await catalog.refresh();
  const names = createMcpWorkspaceTools(options).mcpTools!.map((tool) => tool.name);
  assert.ok(names.includes("mcp__arxiv__search"));
  assert.ok(names.includes("mcp__pubmed__search"));
});


test("Specialist extra missing source does not block healthy selected tools; agent can continue visibly", async () => {
  const { options, catalog } = fixture();
  options.parentSubagentId = "literature-searcher-child";
  const sessionSelection = ["arxiv", "pubmed"];
  const specialistConnectors = ["pubmed", "arxiv", "europe-pmc", "biorxiv", "medrxiv"];
  for (const source of createPublicBiomedSources(["europe-pmc", "biorxiv", "medrxiv"])) options.registry.register(source);
  options.enabledSourceIds = [...new Set([...sessionSelection, ...specialistConnectors])];
  await catalog.refresh();
  const result = createMcpWorkspaceTools(options);
  assert.ok(result.mcpTools!.some(tool => tool.name === "mcp__pubmed__search"));
  assert.ok(result.mcpTools!.some(tool => tool.name === "mcp__arxiv__search"));
  assert.ok(!result.mcpTools!.some(tool => tool.sourceId === "biorxiv"));
  const decision = await result.mcpReadiness!.decide("continue", "PubMed and arXiv are sufficient for this task", []);
  assert.match(JSON.stringify(decision), /PubMed and arXiv are sufficient/);
  assert.match(JSON.stringify(decision), /omittedTools.*biorxiv.*search/);
});


test("important missing source waits for repair, rechecks, and invokes recovered tools through governance", async () => {
  const { options, catalog } = fixture();
  let releaseCount = 0;
  let card: unknown;
  let resolveRepair!: (choice: { action: "retry" }) => void;
  const repaired = new Promise<{ action: "retry" }>(resolve => { resolveRepair = resolve; });
  const invocations: Array<Parameters<McpWorkspaceToolOptions["broker"]["invoke"]>[0]> = [];
  options.pauseExternalWait = () => () => { releaseCount++; };
  options.store = { listMcpInvocations: async () => [], executionBlocks: {
    wait: async input => { card = input; return repaired; },
  } };
  options.broker = { invoke: async (input: Parameters<McpWorkspaceToolOptions["broker"]["invoke"]>[0]) => { invocations.push(input); return { result: {}, invocation: { id: "audit" } }; } } as unknown as McpWorkspaceToolOptions["broker"];
  const readiness = createMcpWorkspaceTools(options).mcpReadiness!;
  await assert.rejects(readiness.invoke("arxiv", "search", {}, undefined, "call"), /not a recovered/);
  const pending = readiness.decide("wait", "arXiv evidence is required", ["arxiv"], undefined, "wait-call");
  assert.equal(releaseCount, 0, "external wait remains active until user response");
  assert.equal(catalog.getStatus("arxiv").status, "unavailable");
  assert.equal(invocations.length, 0);
  resolveRepair({ action: "retry" });
  const result = await pending;
  assert.match(JSON.stringify(card), /"kind":"mcp"/);
  assert.match(JSON.stringify(card), /arxiv: unavailable/);
  assert.equal(releaseCount, 1);
  assert.equal(catalog.getStatus("arxiv").status, "ready");
  assert.match(JSON.stringify(result), /recoveredTools.*search/);
  await readiness.invoke("arxiv", "search", { query: "test" }, undefined, "call");
  assert.match(JSON.stringify(invocations[0]), /"sourceId":"arxiv"/);
  assert.equal(typeof invocations[0]!.authorize, "function");
  await assert.rejects(readiness.invoke("foreign", "search", {}, undefined, "call"), /not a recovered/);
});

test("cancelled repair does not refresh or invoke; persistent failure remains visible", async () => {
  const { options, remote } = fixture();
  options.pauseExternalWait = () => () => {};
  options.store = { listMcpInvocations: async () => [], executionBlocks: { wait: async () => ({ action: "cancel" }) } };
  const readiness = createMcpWorkspaceTools(options).mcpReadiness!;
  const cancelled = await readiness.decide("wait", "Required", ["arxiv"]);
  assert.match(JSON.stringify(cancelled), /"action":"cancel"/);
  assert.equal(options.catalog.getStatus("arxiv").status, "unavailable");
  options.store.executionBlocks!.wait = async () => ({ action: "retry" });
  remote.servers = [];
  const stillMissing = await readiness.decide("wait", "Required", ["arxiv"]);
  assert.match(JSON.stringify(stillMissing), /unavailable/);
  await assert.rejects(readiness.invoke("arxiv", "search", {}, undefined, "call"), /not a recovered/);
  await assert.rejects(readiness.decide("wait", "Required", ["foreign"]), /Choose enabled/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readiness.decide("wait", "Required", ["arxiv"], controller.signal), /abort/i);
});


test("timeline readiness lists only unhealthy sources while model diagnostics retain all statuses", async () => {
  const { options, catalog, remote } = fixture();
  remote.servers[0]!.tools = remote.servers[0]!.tools.filter(tool => tool.name !== "arxiv_search");
  await catalog.refresh();
  const reports: string[] = [];
  options.reportReadiness = summary => reports.push(summary);
  const result = createMcpWorkspaceTools(options);
  assert.deepEqual(reports, ["arxiv: degraded; omitted tools: search."]);
  assert.match(result.mcpReadiness!.summary, /pubmed/);
  assert.match(result.mcpReadiness!.summary, /\/api\/mcp\/sources/);
  remote.servers[0]!.tools = [];
  await catalog.refresh();
  createMcpWorkspaceTools(options);
  assert.match(reports[1]!, /arxiv:.*\npubmed:/);
});

test("repair card explains omitted and undiscovered tools consistently with the timeline", async () => {
  const { options } = fixture();
  const original = options.registry.get("arxiv");
  options.registry.upsert({ ...original, manifest: { ...original.manifest, tools: {} } });
  const reports: string[] = [];
  let cardReason: string | undefined;
  options.reportReadiness = summary => reports.push(summary);
  options.pauseExternalWait = () => () => {};
  options.store = { listMcpInvocations: async () => [], executionBlocks: {
    wait: async input => { cardReason = input.reason; return { action: "cancel" }; },
  } };
  const readiness = createMcpWorkspaceTools(options).mcpReadiness!;
  await readiness.decide("wait", "Both sources are required", ["arxiv", "pubmed"]);
  assert.match(cardReason!, /arxiv: unavailable; no tools injected; tool list unavailable until discovery succeeds\./);
  assert.match(cardReason!, /pubmed: unavailable; omitted tools: .*search/);
  assert.equal(cardReason, reports[0]);
  await readiness.decide("wait", "Only arXiv is required", ["arxiv"]);
  assert.equal(cardReason, reports[0]!.split("\n")[0]);
});

test("repair discovers tools absent from the initial manifest without expanding source selection", async () => {
  const { options, catalog } = fixture();
  const original = options.registry.get("arxiv");
  // Disabled custom servers publish an empty manifest until repaired/discovered.
  options.registry.upsert({ ...original, manifest: { ...original.manifest, tools: {} } });
  options.enabledSourceIds = ["arxiv"];
  const reports: string[] = [];
  options.reportReadiness = summary => reports.push(summary);
  const calls: Array<Parameters<McpWorkspaceToolOptions["broker"]["invoke"]>[0]> = [];
  options.broker = { invoke: async (input: Parameters<McpWorkspaceToolOptions["broker"]["invoke"]>[0]) => {
    calls.push(input); return { result: {}, invocation: { id: "repaired-audit" } };
  } } as unknown as McpWorkspaceToolOptions["broker"];
  const result = createMcpWorkspaceTools(options);
  assert.deepEqual(result.mcpTools, []);
  assert.match(reports[0]!, /tool list unavailable/);
  const readiness = result.mcpReadiness!;
  await assert.rejects(readiness.invoke("arxiv", "search", {}, undefined, "early"), /not a recovered/);
  options.registry.upsert(original);
  const checked = await readiness.decide("check", "Server repaired", []);
  assert.match(JSON.stringify(checked), /recoveredTools.*search/);
  await readiness.invoke("arxiv", "search", { query: "recovered" }, undefined, "recovered-call");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.allowedSourceIds, ["arxiv"]);
  assert.equal(calls[0]!.toolCallId, "recovered-call");
  assert.equal(typeof calls[0]!.authorize, "function");
  await assert.rejects(readiness.invoke("pubmed", "search", {}, undefined, "foreign"), /not a recovered/);
  options.registry.upsert({ ...original, manifest: { ...original.manifest, tools: {} } });
  await catalog.refresh();
  await assert.rejects(readiness.invoke("arxiv", "search", {}, undefined, "removed"), /not a recovered/);
});

test("important MCP wait without a repair-card port fails closed without refreshing", async () => {
  const {options, catalog} = fixture();
  options.store = {listMcpInvocations: async () => []};
  let paused = false;
  options.pauseExternalWait = () => { paused = true; return () => {}; };
  const readiness = createMcpWorkspaceTools(options).mcpReadiness!;
  await assert.rejects(readiness.decide("wait", "Required evidence", ["arxiv"]), /Interactive MCP repair is unavailable/);
  assert.equal(paused, false);
  assert.equal(catalog.getStatus("arxiv").status, "unavailable");
  await assert.rejects(readiness.decide("wait", "Required evidence", []), /Choose enabled MCP sources/);
});

test("abort during MCP repair wait releases external wait and never refreshes or invokes", async () => {
  const {options, catalog} = fixture();
  const controller = new AbortController();
  let releaseCount = 0, invoked = false;
  options.pauseExternalWait = () => () => { releaseCount++; };
  options.store = {listMcpInvocations: async () => [], executionBlocks: {wait: async () => {
    controller.abort(); return {action: "retry"};
  }}};
  options.broker = {invoke: async () => { invoked = true; throw new Error("must not invoke"); }} as unknown as McpWorkspaceToolOptions["broker"];
  const readiness = createMcpWorkspaceTools(options).mcpReadiness!;
  await assert.rejects(readiness.decide("wait", "Required", ["arxiv"], controller.signal), /abort/i);
  assert.equal(releaseCount, 1);
  assert.equal(catalog.getStatus("arxiv").status, "unavailable");
  await assert.rejects(readiness.invoke("arxiv", "search", {}, undefined, "invalid"), /not a recovered/);
  assert.equal(invoked, false);
});

test("repair wait rejection releases the clock and a source repaired before wait needs no card", async () => {
  const {options, catalog} = fixture();
  let released = 0;
  options.pauseExternalWait = () => () => { released++; };
  options.store = {listMcpInvocations: async () => [], executionBlocks: {wait: async () => {throw new Error("card aborted");}}};
  const readiness = createMcpWorkspaceTools(options).mcpReadiness!;
  await assert.rejects(readiness.decide("wait", "Required", ["arxiv"]), /card aborted/);
  assert.equal(released, 1);
  await catalog.refresh();
  const result = await readiness.decide("wait", "Already repaired", ["arxiv"]);
  assert.equal(released, 1, "healthy source must not reopen the card");
  assert.match(JSON.stringify(result), /recoveredTools/);
});

test("a ready catalog with no tools is diagnosed, while ready tools omit the recovery port", async (context) => {
  const {options, catalog} = fixture();
  options.enabledSourceIds = ["arxiv"];
  await catalog.refresh();
  assert.equal(createMcpWorkspaceTools(options).mcpReadiness, undefined);
  const ready = catalog.getStatus("arxiv");
  context.mock.method(catalog, "getStatus", () => ({...ready, availableTools: [], missingTools: []}));
  const result = createMcpWorkspaceTools(options);
  assert.deepEqual(result.mcpTools, []);
  assert.ok(result.mcpReadiness);
  const decision = await result.mcpReadiness.decide("continue", "No retrieval needed", []);
  assert.match(JSON.stringify(decision), /No retrieval needed/);
  assert.deepEqual((decision as {omittedTools: unknown[]}).omittedTools, [{sourceId: "arxiv", tools: []}]);
});
