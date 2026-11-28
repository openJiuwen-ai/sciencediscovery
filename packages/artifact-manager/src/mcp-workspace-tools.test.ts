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
import { McpSourceCatalog, type McpTransportClient } from "@sciencediscovery/data-source";
import { McpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { createPublicBiomedSources } from "@sciencediscovery/mcp-sources";
import type { McpCatalog } from "@sciencediscovery/schema";
import { createMcpWorkspaceTools, REPAIR_DECISION_GRACE_MS, type McpWorkspaceToolOptions } from "./mcp-workspace-tools.js";

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

/** One local MCP server carrying both biomedical tools. */
function biomedServer(registry: McpSourceRegistry): McpCatalog["servers"][number] {
  return { id: "biomed", enabled: true, transport: "stdio", tools: registry.list().flatMap(({ manifest }) =>
    Object.values(manifest.tools).map((tool) => ({ name: tool.mcpToolName!, inputSchema: tool.inputSchema, description: tool.description, schemaHash: "test" }))) };
}

/** A repair run whose discovery starts empty: `remote.servers` is filled in when the
 *  user repairs the server, and the test decides the repair card itself. */
function repairStack(
  discovery: (remote: McpCatalog, signal?: AbortSignal) => Promise<McpCatalog>,
  revision?: () => string,
) {
  const registry = new McpSourceRegistry();
  for (const source of createPublicBiomedSources(["arxiv", "pubmed"])) registry.register(source);
  const healthy = [biomedServer(registry)];
  const remote: McpCatalog = { revision: "test", loadedAt: new Date().toISOString(), servers: [] };
  let discoveries = 0;
  const gateway: McpTransportClient = {
    catalog: async (signal) => { discoveries += 1; return discovery(remote, signal); },
    reload: async (_proxies, signal) => { discoveries += 1; return discovery(remote, signal); },
    invoke: async () => { throw new Error("no external calls in repair tests"); },
  };
  const catalog = new McpSourceCatalog(registry, gateway, undefined, undefined, undefined, revision);
  const invocations: Array<Parameters<McpWorkspaceToolOptions["broker"]["invoke"]>[0]> = [];
  let released = 0;
  let decideRepair: ((choice: { action: "retry" | "cancel" }) => void) | undefined;
  let waitSignal: AbortSignal | undefined;
  const options = { registry, catalog, enabledSourceIds: ["arxiv", "pubmed"] } as unknown as McpWorkspaceToolOptions;
  options.pauseExternalWait = () => () => { released += 1; };
  options.store = { listMcpInvocations: async () => [], executionBlocks: {
    // Mirrors ExecutionBlocks: aborting the wait's signal resolves it as cancelled.
    wait: (_input, signal) => {
      waitSignal = signal;
      return new Promise(resolve => {
        decideRepair = choice => resolve(choice);
        signal?.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true });
      });
    },
  } };
  options.broker = { invoke: async (input: Parameters<McpWorkspaceToolOptions["broker"]["invoke"]>[0]) => {
    invocations.push(input); return { result: {}, invocation: { id: "recovered-audit" } };
  } } as unknown as McpWorkspaceToolOptions["broker"];
  return {
    catalog, remote, healthy, options, invocations,
    decideRepair: (choice: { action: "retry" | "cancel" }) => decideRepair!(choice),
    discoveries: () => discoveries,
    releases: () => released,
    waitSignal: () => waitSignal,
  };
}

function recoveredCall(readiness: NonNullable<ReturnType<typeof createMcpWorkspaceTools>["mcpReadiness"]>) {
  return readiness.invoke("arxiv", "search", { query: "repaired" }, undefined, "recovered-call") as Promise<{ invocationId?: string }>;
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
  assert.ok(names.includes("mcp__arxiv__get_paper"), `mounted tools: ${names.join(", ")}`);
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

test("a cancel after a lost call transport releases the wait once and never refreshes or invokes", async () => {
  const {options, catalog} = fixture();
  const controller = new AbortController();
  let releaseCount = 0, invoked = false;
  let waitSignal: AbortSignal | undefined;
  let resolveWait!: (choice: {action: "cancel"}) => void;
  options.pauseExternalWait = () => () => { releaseCount++; };
  options.store = {listMcpInvocations: async () => [], executionBlocks: {wait: (_input, signal) => {
    waitSignal = signal;
    controller.abort();
    return new Promise(resolve => { resolveWait = resolve; signal?.addEventListener("abort", () => resolve({action: "cancel"}), {once: true}); });
  }}};
  options.broker = {invoke: async () => { invoked = true; throw new Error("must not invoke"); }} as unknown as McpWorkspaceToolOptions["broker"];
  const readiness = createMcpWorkspaceTools(options).mcpReadiness!;
  const pending = readiness.decide("wait", "Required", ["arxiv"], controller.signal);
  assert.equal(releaseCount, 0, "the card stays registered while a decision can still arrive");
  assert.equal(waitSignal?.aborted, false, "a lost call transport does not discard the wait immediately");
  resolveWait({action: "cancel"});
  const cancelled = await pending;
  assert.match(JSON.stringify(cancelled), /"action":"cancel"/);
  assert.equal(releaseCount, 1);
  assert.equal(catalog.getStatus("arxiv").status, "unavailable", "a cancel never refreshes the catalog");
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

test("Jiuwen configuration admits only the approved ready source into the existing governed dispatcher", async () => {
  const { options, catalog } = fixture();
  await catalog.refresh(); options.enabledSourceIds = []; options.configurationActivation = true;
  const invocations: Array<Parameters<McpWorkspaceToolOptions["broker"]["invoke"]>[0]> = [];
  options.broker = { invoke: async (input: Parameters<McpWorkspaceToolOptions["broker"]["invoke"]>[0]) => {
    invocations.push(input); return { result: {}, invocation: { id: "approved-source" } };
  } } as unknown as McpWorkspaceToolOptions["broker"];
  const tools = createMcpWorkspaceTools(options);
  assert.deepEqual(tools.mcpTools, []);
  await assert.rejects(tools.mcpReadiness!.invoke("pubmed", "search", {}, undefined, "before-approval"), /not a recovered/);
  const descriptors = tools.activateConfigurationSource("pubmed");
  assert.ok(descriptors.some(tool => tool.toolId === "search"));
  const discovery = await tools.mcpReadiness!.decide("check", "Approved connector", []);
  assert.match(JSON.stringify(discovery), /recoveredTools.*pubmed/);
  await tools.mcpReadiness!.invoke("pubmed", "search", { query: "offline" }, undefined, "original-run-call");
  assert.deepEqual(invocations[0]!.allowedSourceIds, ["pubmed"]);
  assert.equal(typeof invocations[0]!.authorize, "function");
  await assert.rejects(tools.mcpReadiness!.invoke("arxiv", "search", {}, undefined, "unapproved"), /not a recovered/);
  assert.throws(() => tools.activateConfigurationSource("foreign"), /not ready/);
});

test("a repair decision already on its way lands after the blocked call's transport aborts", async () => {
  // The transport that carries the blocked tool call can go away while the user is
  // still deciding (the MCP bridge closes when its caller disconnects). The call's
  // signal aborts first, the user's recheck arrives next. Issue #1034: dropping the
  // wait there removed the block, so the recheck hit an expired decision (409), the
  // catalog kept the source unavailable, and the run's mcp_recovered_call was refused
  // before the broker — no invocation was recorded although the run completed
  // claiming recovery. This gateway honours the signal like a defensive transport;
  // the production McpNodeClient currently ignores it, so the guard is belt and braces.
  const stack = repairStack(async (remote, signal) => { signal?.throwIfAborted(); return remote; });
  await stack.catalog.refresh();
  assert.equal(stack.catalog.getStatus("arxiv").status, "unavailable");
  const setupDiscoveries = stack.discoveries();

  const controller = new AbortController();
  const readiness = createMcpWorkspaceTools(stack.options).mcpReadiness!;
  const pending = readiness.decide("wait", "arXiv evidence is required", ["arxiv"], controller.signal, "wait-call");
  controller.abort();
  // The user repaired the server before the decision application ran.
  stack.remote.servers = stack.healthy;
  stack.decideRepair({ action: "retry" });
  await pending;
  assert.equal(stack.catalog.getStatus("arxiv").status, "ready",
    "the user's retry must still apply its discovery after the call transport aborted");
  const recovered = await recoveredCall(readiness);
  assert.equal(recovered.invocationId, "recovered-audit");
  assert.equal(stack.invocations.length, 1);
  assert.equal(stack.invocations[0]!.sourceId, "arxiv");
  assert.equal(stack.discoveries() - setupDiscoveries, 1, "a ready repair needs one observation, not a retry loop");
});

test("a retry whose discovery is discarded as stale re-observes the repaired source once", async () => {
  // McpSourceCatalog.applyCurrent drops a discovery snapshot whose configuration
  // revision moved while it was running, leaving the previous statuses in place. A
  // retry whose only refresh is discarded would leave recoveredTools() empty and
  // refuse the recovered call before the broker — the same user-visible outcome as
  // the lost wait. The retry therefore re-observes once.
  let revision = "before";
  let moveRevision = false;
  const stack = repairStack(async (remote) => {
    if (moveRevision) { moveRevision = false; revision = "after"; }
    return remote;
  }, () => revision);
  await stack.catalog.refresh();
  assert.equal(stack.catalog.getStatus("arxiv").status, "unavailable");
  const setupDiscoveries = stack.discoveries();

  moveRevision = true;
  stack.remote.servers = stack.healthy;
  const readiness = createMcpWorkspaceTools(stack.options).mcpReadiness!;
  const pending = readiness.decide("wait", "arXiv evidence is required", ["arxiv"], undefined, "wait-call");
  stack.decideRepair({ action: "retry" });
  await pending;
  assert.equal(stack.catalog.getStatus("arxiv").status, "ready",
    "a snapshot discarded as stale must be re-observed instead of leaving the repair unrecorded");
  const recovered = await recoveredCall(readiness);
  assert.equal(recovered.invocationId, "recovered-audit");
  assert.equal(stack.invocations.length, 1);
  assert.equal(stack.discoveries() - setupDiscoveries, 2, "exactly one bounded re-observation");
});

test("a retry whose discovery is lost to an abort still applies the repaired source", async () => {
  // The retry used to start its discovery with the call's own signal and nothing
  // observed an abort that arrived while discovery was running, so the repair never
  // reached the catalog and the recovered call was refused.
  let armAbort = false;
  let discoveryStarted!: () => void;
  const started = new Promise<void>(resolve => { discoveryStarted = resolve; });
  const stack = repairStack(async (remote, signal) => {
    if (!armAbort) return remote;
    armAbort = false;
    discoveryStarted();
    return await new Promise<McpCatalog>((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("discovery aborted")), { once: true }));
  });
  await stack.catalog.refresh();
  const setupDiscoveries = stack.discoveries();

  const controller = new AbortController();
  armAbort = true;
  stack.remote.servers = stack.healthy;
  const readiness = createMcpWorkspaceTools(stack.options).mcpReadiness!;
  const pending = readiness.decide("wait", "arXiv evidence is required", ["arxiv"], controller.signal, "wait-call");
  stack.decideRepair({ action: "retry" });
  await started;
  controller.abort();
  await pending;
  assert.equal(stack.catalog.getStatus("arxiv").status, "ready",
    "an abort during the retry's discovery must not leave the repaired source unobserved");
  const recovered = await recoveredCall(readiness);
  assert.equal(recovered.invocationId, "recovered-audit");
  assert.equal(stack.invocations.length, 1);
  assert.equal(stack.discoveries() - setupDiscoveries, 2, "exactly one bounded re-observation");
});

test("a retry whose first observation lands with the repaired source still in error re-observes once", async () => {
  // The first retry discovery can be non-empty yet report the repaired server as broken
  // (a background reload or a transient tools/list failure). Triggering the bounded
  // re-observation only on an empty catalog would leave recoveredTools() empty and
  // refuse the recovered call before the broker.
  let breakFirstObservation = false;
  const stack = repairStack(async (remote) => {
    if (!breakFirstObservation) return remote;
    breakFirstObservation = false;
    return { ...remote, servers: [{ ...remote.servers[0]!, error: "tools/list failed" }] };
  });
  await stack.catalog.refresh();
  assert.equal(stack.catalog.getStatus("arxiv").status, "unavailable");
  const setupDiscoveries = stack.discoveries();

  breakFirstObservation = true;
  stack.remote.servers = stack.healthy;
  const readiness = createMcpWorkspaceTools(stack.options).mcpReadiness!;
  const pending = readiness.decide("wait", "arXiv evidence is required", ["arxiv"], undefined, "wait-call");
  stack.decideRepair({ action: "retry" });
  await pending;
  assert.equal(stack.catalog.getStatus("arxiv").status, "ready",
    "a non-empty observation that still reports the repaired source in error must be re-observed");
  const recovered = await recoveredCall(readiness);
  assert.equal(recovered.invocationId, "recovered-audit");
  assert.equal(stack.invocations.length, 1);
  assert.equal(stack.discoveries() - setupDiscoveries, 2, "exactly one bounded re-observation");
});

test("a retry whose discovery keeps failing surfaces the error after one bounded re-observation", async () => {
  let armFailures = false;
  const stack = repairStack(async (remote) => {
    if (armFailures) throw new Error("gateway unavailable");
    return remote;
  });
  await stack.catalog.refresh();
  const setupDiscoveries = stack.discoveries();
  armFailures = true;
  const readiness = createMcpWorkspaceTools(stack.options).mcpReadiness!;
  const pending = readiness.decide("wait", "arXiv evidence is required", ["arxiv"], undefined, "wait-call");
  stack.decideRepair({ action: "retry" });
  await assert.rejects(pending, /gateway unavailable/);
  assert.equal(stack.discoveries() - setupDiscoveries, 2, "one re-observation, then the failure surfaces");
  assert.equal(stack.releases(), 1, "the external wait is released after the failure");
  assert.equal(stack.invocations.length, 0);
  assert.equal(stack.catalog.getStatus("arxiv").status, "unavailable");
});

test("a lost call transport keeps the card actionable for a bounded window, then cancels once", async (context) => {
  assert.ok(REPAIR_DECISION_GRACE_MS >= 1_000 && REPAIR_DECISION_GRACE_MS <= 30_000,
    `the repair-decision grace must stay a short, bounded window, got ${REPAIR_DECISION_GRACE_MS} ms`);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const stack = repairStack(async (remote) => remote);
  await stack.catalog.refresh();
  const controller = new AbortController();
  const readiness = createMcpWorkspaceTools(stack.options).mcpReadiness!;
  const pending = readiness.decide("wait", "arXiv evidence is required", ["arxiv"], controller.signal, "wait-call");
  controller.abort();
  const waitSignal = stack.waitSignal()!;
  assert.equal(waitSignal.aborted, false, "the block stays listed while an in-flight decision can still land");
  assert.equal(stack.releases(), 0);
  context.mock.timers.tick(REPAIR_DECISION_GRACE_MS - 1);
  assert.equal(waitSignal.aborted, false, "the window is not shorter than the announced grace");
  assert.equal(stack.releases(), 0);
  context.mock.timers.tick(1);
  const expired = await pending;
  assert.match(JSON.stringify(expired), /"action":"cancel"/);
  assert.equal(waitSignal.aborted, true);
  assert.equal(stack.releases(), 1, "the external wait is released exactly once");
  assert.equal(stack.catalog.getStatus("arxiv").status, "unavailable", "an expired wait never refreshes");
  await assert.rejects(readiness.invoke("arxiv", "search", {}, undefined, "late"), /not a recovered/);
  assert.equal(stack.invocations.length, 0);
  // No timer survives the wait: running every pending timer changes nothing.
  context.mock.timers.runAll();
  assert.equal(stack.releases(), 1);
  assert.equal(stack.invocations.length, 0);
});
