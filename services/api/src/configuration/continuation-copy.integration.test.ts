// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { McpGovernanceBroker, McpSourceCatalog, type McpTransportClient } from "@sciencediscovery/data-source";
import { createBuiltinMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import type { McpCatalog, McpInvokeRequest } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { CONFIGURATION_AGENT_DESCRIPTORS } from "./agent-metadata.js";
import { CONFIGURATION_SETTINGS_INVENTORY } from "./settings-catalog.js";
import { verifyNativeConfigurationToolAssembly } from "./native-activation.js";
import { nativeConfigurationDecisionPrompt } from "../runs/index.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function fixture(context: { after(action: () => Promise<void>): void }, enabledConnectorIds?: string[]) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "continuation-copy-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Continuation contract"), session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  if (enabledConnectorIds) await store.updateSession(session.id, { enabledConnectorIds });
  const run = await store.createSessionRun({ sessionId: session.id, prompt: "Owned configuration diagnostic", settingsSnapshot: store.resolveRuntimeSettings(session.id).effective });
  const scheduled: Array<{ sessionId: string; requestId: string }> = [];
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined, resume: async (sessionId, requestId) => { scheduled.push({ sessionId, requestId }); return run; } });
  return { root, store, session, run, framework, scheduled };
}

test("CFG-XE2E-04: proxy.resources continues its bound task using the approved receipt", async context => {
  const h = await fixture(context);
  const frozen = structuredClone(h.run.settingsSnapshot);
  const proxy = await h.store.createProxyServer({ name: "Original", kind: "environment" });
  const card = await h.framework.propose(h.session.id, {
    protocolVersion: 3, runId: h.run.id, capabilityId: "proxy.resources", values: { operation: "update", proxyId: proxy.id, name: "Owned continuation proxy" },
  });
  const applied = await h.framework.decide(h.session.id, card.id, {
    revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply",
  });
  assert.equal(applied.activation.mode, "next_connection");
  const resumed = { ...h.run, configurationResume: { requestId: card.id, decision: "apply" as const, connectorName: "proxy.resources" } };
  const prompt = nativeConfigurationDecisionPrompt(h.store, h.session.id, resumed);
  assert.match(prompt, /Activation mode: next_connection/);
  assert.match(prompt, /saved route is used by later connections of this task as well/);
  assert.doesNotMatch(prompt, /applies to future tasks/);
  assert.match(nativeConfigurationDecisionPrompt(h.store, h.session.id, { ...resumed, configurationResume: { ...resumed.configurationResume, decision: "dismiss" } }), /declined the configuration/);
  assert.equal(applied.activation.state, "needs_user_action");
  assert.equal(applied.resumption.state, "queued");
  assert.deepEqual(h.scheduled, [{ sessionId: h.session.id, requestId: card.id }]);
  assert.doesNotThrow(() => verifyNativeConfigurationToolAssembly({ store: h.store, sessionId: h.session.id, runId: h.run.id, requestId: card.id, enabledConnectorIds: [], tools: [] }));
  assert.deepEqual((await h.store.getSessionRun(h.session.id, h.run.id))?.settingsSnapshot, frozen);
});

test("CFG-XE2E-04: proxy.mcp changes later calls of its bound task without changing the frozen settings", async context => {
  const h = await fixture(context, ["uniprot"]);
  const frozen = structuredClone(h.run.settingsSnapshot);
  const proxy = await h.store.createProxyServer({ name: "Continuation proxy", kind: "custom_url", url: "http://127.0.0.1:19090" });
  await h.store.updateMcpProxyPolicies({ policies: { uniprot: "none" } });
  h.store.setConfigurationMcpProxySource(() => [{ id: "uniprot", name: "UniProt", connectorIds: ["uniprot"] }]);
  const registry = createBuiltinMcpSourceRegistry();
  const lookup = registry.get("uniprot").manifest.tools.lookup!;
  const catalogData: McpCatalog = {
    loadedAt: new Date().toISOString(), revision: "continuation-catalog", servers: [{
      enabled: true, id: "uniprot", transport: "stdio", tools: [{
        description: lookup.description, inputSchema: lookup.inputSchema, name: lookup.mcpToolName!, schemaHash: "lookup",
      }],
    }],
  };
  const calls: McpInvokeRequest[] = [];
  let catalogReads = 0;
  const gateway: McpTransportClient = {
    catalog: async () => { catalogReads++; return catalogData; },
    reload: async () => { throw new Error("Saving an MCP policy must not reconnect the server"); },
    invoke: async request => {
      calls.push(request);
      return { attempts: [], content: [{ type: "text", text: JSON.stringify({
        attribution: "UniProt", license: "fixture", records: [], retrievedAt: new Date().toISOString(),
        sourceId: "uniprot", toolId: "lookup", untrusted: true, warnings: [],
      }) }], durationMs: 1, isError: false, requestId: request.requestId, serverId: request.serverId, toolName: request.toolName };
    },
  };
  const catalog = new McpSourceCatalog(registry, gateway);
  await catalog.refresh();
  const broker = new McpGovernanceBroker(h.root, h.store, registry, catalog, gateway);
  context.after(() => broker.close());
  const invoke = (accession: string) => broker.invoke({
    projectId: h.session.projectId, sessionId: h.session.id, sourceId: "uniprot", toolId: "lookup",
    input: { accession }, toolCallId: `continuation-${accession}`, turnId: h.run.id,
    allowedSourceIds: frozen.enabledConnectorIds,
  });
  await invoke("P04637");
  assert.deepEqual(calls.map(call => call.proxy), [{ mode: "direct" }]);

  const card = await h.framework.propose(h.session.id, {
    protocolVersion: 3, runId: h.run.id, capabilityId: "proxy.mcp",
    values: { mcpServerId: "uniprot", proxyPolicy: `proxy:${proxy.id}` },
  });
  assert.equal(card.state, "awaiting_confirmation");
  assert.equal(card.activation.mode, "next_connection");
  assert.equal(CONFIGURATION_AGENT_DESCRIPTORS["proxy.mcp"].activation, card.activation.mode);
  assert.equal(CONFIGURATION_SETTINGS_INVENTORY.find(item => item.id === "mcp_proxy")?.activation, card.activation.mode);
  assert.equal(h.store.mcpProxyPolicy("uniprot"), "none");
  assert.equal(card.autoApplyAt, undefined);
  const decision = { revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const };
  const applied = await h.framework.decide(h.session.id, card.id, decision);
  assert.equal(applied.activation.mode, "next_connection");
  assert.equal(applied.activation.state, "needs_user_action");
  assert.equal(applied.resumption.state, "queued");
  assert.equal(calls.length, 1, "Saving the policy must not invoke or probe the MCP server");
  assert.equal(catalogReads, 1, "Saving the policy must not refresh discovery");
  const resumed = { ...h.run, configurationResume: { requestId: card.id, decision: "apply" as const, connectorName: "proxy.mcp" } };
  const prompt = nativeConfigurationDecisionPrompt(h.store, h.session.id, resumed);
  assert.match(prompt, /Activation mode: next_connection/);
  assert.match(prompt, /saved route is used by later connections of this task as well/);
  assert.doesNotMatch(prompt, /applies to future tasks/);
  verifyNativeConfigurationToolAssembly({ store: h.store, sessionId: h.session.id, runId: h.run.id,
    requestId: card.id, enabledConnectorIds: frozen.enabledConnectorIds, tools: [] });

  // A different accession avoids the result cache while keeping the same broker, catalog and frozen task.
  await invoke("P38398");
  assert.deepEqual(calls.map(call => call.proxy), [{ mode: "direct" }, h.store.resolveProxy(`proxy:${proxy.id}`)]);
  assert.ok(calls.every(call => call.context.turnId === h.run.id));
  assert.equal(catalogReads, 1);
  await h.framework.decide(h.session.id, card.id, decision);
  assert.deepEqual(h.scheduled, [{ sessionId: h.session.id, requestId: card.id }]);
  assert.deepEqual((await h.store.getSessionRun(h.session.id, h.run.id))?.settingsSnapshot, frozen);
  assert.equal((await h.store.listSessionRuns(h.session.id)).length, 1);
});

test("CFG-XE2E-04: web.credential continues its bound task using the approved receipt", async context => {
  const h = await fixture(context);
  await h.store.updateWebSettings({ providerApiKeys: { jina: "synthetic-continuation-fixture" } });
  const frozen = structuredClone(h.run.settingsSnapshot);
  const card = await h.framework.propose(h.session.id, {
    protocolVersion: 3, runId: h.run.id, capabilityId: "web.credential", values: { webProvider: "jina", operation: "clear" },
  });
  const applied = await h.framework.decide(h.session.id, card.id, {
    revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply",
  });
  assert.equal(applied.activation.mode, "next_request");
  assert.equal(applied.activation.state, "needs_user_action");
  assert.equal(applied.resumption.state, "queued");
  assert.deepEqual(h.scheduled, [{ sessionId: h.session.id, requestId: card.id }]);
  assert.doesNotThrow(() => verifyNativeConfigurationToolAssembly({ store: h.store, sessionId: h.session.id, runId: h.run.id, requestId: card.id, enabledConnectorIds: [], tools: [] }));
  assert.deepEqual((await h.store.getSessionRun(h.session.id, h.run.id))?.settingsSnapshot, frozen);
});

test("CFG-X09a: saving a bound Reviewer setting resumes the task without changing its snapshot", async context => {
  const h = await fixture(context);
  await h.store.updateReviewerSpecialistSettings({ enabled: true });
  const frozen = structuredClone(h.run.settingsSnapshot);
  const card = await h.framework.propose(h.session.id, {
    protocolVersion: 3, runId: h.run.id, capabilityId: "reviewer.enable", values: { enabled: false },
  });
  assert.ok(card.previewDigest);
  const decision = { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: "persist", decision: "apply" as const };
  const applied = await h.framework.decide(h.session.id, card.id, decision);
  assert.equal(applied.activation.mode, "next_request");
  assert.equal(applied.activation.state, "needs_user_action");
  assert.equal(applied.resumption.state, "queued");
  await h.framework.decide(h.session.id, card.id, decision);
  assert.deepEqual(h.scheduled, [{ sessionId: h.session.id, requestId: card.id }]);
  verifyNativeConfigurationToolAssembly({ store: h.store, sessionId: h.session.id, runId: h.run.id, requestId: card.id, enabledConnectorIds: [], tools: [] });
  assert.deepEqual((await h.store.getSessionRun(h.session.id, h.run.id))?.settingsSnapshot, frozen);
});

test("CFG-XBUG-09: future-setting copy permits only its bound original continuation and preserves the recorded task settings on replay", async context => {
  const h = await fixture(context), frozen = structuredClone(h.run.settingsSnapshot);
  const card = await h.framework.propose(h.session.id, { protocolVersion: 3, runId: h.run.id, capabilityId: "timeouts.configure", values: { runnerExecTimeoutMs: 90000 } });
  assert.match(card.impact.message, /original configuration task already bound/); assert.match(card.impact.message, /frozen task settings/);
  const decision = { revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const };
  const applied = await h.framework.decide(h.session.id, card.id, decision); assert.equal(applied.activation.mode, "next_run"); assert.equal(applied.activation.state, "needs_user_action"); assert.equal(applied.resumption.state, "queued");
  assert.match(nativeConfigurationDecisionPrompt(h.store, h.session.id, { ...h.run, configurationResume: { requestId: card.id, decision: "apply", connectorName: "timeouts.configure" } }), /applies to future tasks/);
  assert.deepEqual(h.scheduled, [{ sessionId: h.session.id, requestId: card.id }]); await h.framework.decide(h.session.id, card.id, decision); assert.equal(h.scheduled.length, 1);
  assert.deepEqual((await h.store.getSessionRun(h.session.id, h.run.id))?.settingsSnapshot, frozen); assert.equal((await h.store.listSessionRuns(h.session.id)).length, 1);
});
test("CFG-XBUG-09: an independent setting has no original task to continue and metadata never promises no continuation for a bound wait", async context => {
  const h = await fixture(context); const card = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "quotas.configure", values: { maxConcurrentSubagents: 2 } });
  await h.framework.decide(h.session.id, card.id, { revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" }); assert.equal(h.scheduled.length, 0);
  for (const id of ["timeouts.configure", "quotas.configure"] as const) {
    assert.match(CONFIGURATION_AGENT_DESCRIPTORS[id].whenNeeded, /original configuration task already bound/);
    assert.doesNotMatch(CONFIGURATION_AGENT_DESCRIPTORS[id].whenNeeded, /does not resume the active run/);
  }
});

for (const completed of [true, false]) test(`Manual settings answer ${completed} resumes only the original task without applying`, async context => {
  const h = await fixture(context), frozen = structuredClone(h.run.settingsSnapshot);
  const card = await h.framework.propose(h.session.id, { protocolVersion: 3, runId: h.run.id, capabilityId: "timeouts.configure", values: { runnerExecTimeoutMs: 90000 } });
  const before = h.store.getSessionSettings(h.session.id);
  const input = { revision: card.revision, stateVersion: card.stateVersion, destination: "timeouts" as const, completed };
  const result = await h.framework.confirmSettings(h.session.id, card.id, input, "manual");
  assert.equal(result.settingsConfirmation?.completed, completed); assert.equal(result.settingsConfirmation?.verified, false);
  assert.equal(result.resumption.state, "queued"); assert.equal(result.activation.state, "not_requested");
  assert.deepEqual(h.scheduled, [{ sessionId: h.session.id, requestId: card.id }]);
  await h.framework.confirmSettings(h.session.id, card.id, input, "manual"); assert.equal(h.scheduled.length, 1);
  assert.deepEqual(h.store.getSessionSettings(h.session.id), before);
  assert.deepEqual((await h.store.getSessionRun(h.session.id, h.run.id))?.settingsSnapshot, frozen);
  assert.equal((await h.store.listSessionRuns(h.session.id)).length, 1);
});

test("CFG-X04a: local Memory save resumes only its bound wait without claiming runtime readiness", async context => {
  const h = await fixture(context), frozen = structuredClone(h.run.settingsSnapshot);
  const before = h.store.getMemoryGraphSettings();
  const card = await h.framework.propose(h.session.id, { protocolVersion: 3, runId: h.run.id, capabilityId: "memory.enable", values: { enabled: !before.enabled } });
  const decision = { revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const };
  const applied = await h.framework.decide(h.session.id, card.id, decision);
  assert.equal(applied.activation.mode, "next_request"); assert.equal(applied.activation.state, "needs_user_action"); assert.equal(applied.resumption.state, "queued");
  await h.framework.decide(h.session.id, card.id, decision);
  assert.deepEqual(h.scheduled, [{ sessionId: h.session.id, requestId: card.id }]);
  assert.deepEqual((await h.store.getSessionRun(h.session.id, h.run.id))?.settingsSnapshot, frozen);
});
