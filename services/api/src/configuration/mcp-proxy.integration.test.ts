// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
import { createMcpProxyAdapter } from "./mcp-proxy-adapter.js";
import type { ConfigurationAdapterContext } from "./types.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function fixture(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "mcp-proxy-" + randomUUID()), store = new SessionStore(root);
  await store.load(); context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const proxy = await store.createProxyServer({ name: "Owned proxy", kind: "custom_url", url: "http://owned-user:synthetic-proxy@127.0.0.1:1" });
  const project = await store.createProject("MCP proxy"), session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  let services = [{ id: "shared-server", name: "Literature, Papers", connectorIds: ["literature", "papers"] }, { id: "other-server", name: "Other", connectorIds: ["other"] }];
  let revision = "transport-v1"; store.setConfigurationMcpProxySource(() => services); store.setConfigurationConnectorRevisionSource(() => revision);
  await store.updateMcpProxyPolicies({ policies: { "other-server": "none", "historical-server": "none" } });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "proxy.mcp", values });
  const approval = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const });
  return { store, session, project, framework, proxy, propose, approval, setServices: (value: typeof services) => { services = value; }, setRevision: (value: string) => { revision = value; } };
}
const cipher = (store: SessionStore) => store.getConfigurationDatabase().prepare("SELECT server_id,encrypted_url FROM proxy_server_secrets ORDER BY server_id").all();
test("CFG-X03e: manual single-server save preserves other entries, replay once, inherit removes override without resolving secrets", async context => {
  const h = await fixture(context), before = h.store.getMcpProxyPolicies(), secrets = cipher(h.store); let writes = 0;
  h.store.getProxySettings = () => { throw Error("Full proxy view forbidden"); }; h.store.resolveProxy = () => { throw Error("Transport resolution forbidden"); };
  const apply = h.store.applyMcpProxyConfigurationSync.bind(h.store); h.store.applyMcpProxyConfigurationSync = (...args) => { writes++; apply(...args); };
  let card = await h.propose({ mcpServerId: "shared-server", proxyPolicy: "proxy:" + h.proxy.id });
  assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined); assert.deepEqual(h.store.getMcpProxyPolicies(), before);
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "applied"); await h.framework.decide(h.session.id, card.id, h.approval(card)); assert.equal(writes, 1);
  assert.deepEqual(h.store.getMcpProxyPolicies(), { ...before, "shared-server": "proxy:" + h.proxy.id }); assert.deepEqual(cipher(h.store), secrets);
  card = await h.propose({ mcpServerId: "shared-server", proxyPolicy: "inherit" }); await h.framework.decide(h.session.id, card.id, h.approval(card)); assert.deepEqual(h.store.getMcpProxyPolicies(), before);
});
test("CFG-X03e: empty/server-only collect input; finite registered server IDs, v3 and global scope are enforced", async context => {
  const h = await fixture(context); await assert.rejects(h.propose({ mcpServerId: "shared-server", proxyPolicy: "inherit" }), { code: "CONFIGURATION_NO_CHANGE" });
  assert.equal((await h.propose({})).state, "collecting_input"); assert.equal((await h.propose({ mcpServerId: "shared-server" })).state, "collecting_input");
  for (const id of ["literature", "historical-server", "unknown"]) await assert.rejects(h.propose({ mcpServerId: id, proxyPolicy: "none" }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
  const invalid: ConfigurationValues[] = [{ mcpServerId: "shared-server", proxyPolicy: "proxy:missing" }, { mcpServerId: "shared-server", proxyPolicy: "http://secret@host" }, { mcpServerId: "shared-server", headers: "forbidden" }];
  for (const values of invalid) await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "proxy.mcp", values: {} }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  for (const scope of [{ kind: "session" as const, id: h.session.id }, { kind: "project" as const, id: h.project.id }]) await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "proxy.mcp", values: {}, scope }), { code: "INVALID_CONFIGURATION_SCOPE" });
});
test("CFG-X03e: service membership, transport revision, policy and proxy ciphertext changes invalidate approval", async context => {
  for (const mutation of ["removed", "remapped", "transport", "proxy", "policy"] as const) {
    const h = await fixture(context), card = await h.propose({ mcpServerId: "shared-server", proxyPolicy: "proxy:" + h.proxy.id });
    if (mutation === "removed") h.setServices([]);
    if (mutation === "remapped") h.setServices([{ id: "shared-server", name: "Changed", connectorIds: ["other"] }]);
    if (mutation === "transport") h.setRevision("transport-v2");
    if (mutation === "proxy") await h.store.updateProxyServer(h.proxy.id, { url: "http://owned-user:synthetic-rotation@127.0.0.1:2" });
    if (mutation === "policy") await h.store.updateMcpProxyPolicies({ policies: { ...h.store.getMcpProxyPolicies(), "shared-server": "none" } });
    await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card)), { code: "RESOURCE_VERSION_CONFLICT" }); assert.notEqual(h.store.mcpProxyPolicy("shared-server"), "proxy:" + h.proxy.id);
  }
});
test("CFG-X03e: an unrelated server policy edit survives selected-server apply", async context => {
  const h = await fixture(context), card = await h.propose({ mcpServerId: "shared-server", proxyPolicy: "none" });
  await h.store.updateMcpProxyPolicies({ policies: { ...h.store.getMcpProxyPolicies(), "other-server": `proxy:${h.proxy.id}` } });
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "applied"); assert.equal(h.store.mcpProxyPolicy("other-server"), "proxy:" + h.proxy.id);
});
test("CFG-X03e: receipt failure rolls map back with ciphertext unchanged", async context => {
  const h = await fixture(context), before = h.store.getMcpProxyPolicies(), secrets = cipher(h.store), card = await h.propose({ mcpServerId: "shared-server", proxyPolicy: "none" }); const db = h.store.getConfigurationDatabase();
  db.exec("CREATE TRIGGER reject_mcp_proxy_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "failed"); assert.deepEqual(h.store.getMcpProxyPolicies(), before); assert.deepEqual(cipher(h.store), secrets); assert.equal(h.framework.repository.getReceipt(card.id), undefined); db.exec("DROP TRIGGER reject_mcp_proxy_receipt");
});
test("CFG-X03e: safe discovery includes shared connectors; refusal and Stop leave policies unchanged", async context => {
  const h = await fixture(context); h.store.getProxySettings = () => { throw Error("Full proxy view forbidden"); };
  const described = await discoverConfiguration(h.store, h.session.id, "owned-no-run", "describe", { capabilityId: "proxy.mcp", targetId: "shared-server" }); const raw = JSON.stringify(described);
  for (const expected of ["shared-server", "literature", "papers"]) {
    assert.ok(raw.includes(expected));
  }
  for (const forbidden of ["synthetic-proxy", "owned-user", "http://127.0.0.1"]) {
    assert.ok(!raw.includes(forbidden));
  }
  let card = await h.propose({ mcpServerId: "shared-server", proxyPolicy: "none" }); card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" });
  assert.equal((await h.framework.decide(h.session.id, card.id, { ...h.approval(card), selectedOptionId: "dismiss", decision: "dismiss" })).state, "dismissed");
  card = await h.propose({ mcpServerId: "shared-server", proxyPolicy: "none" }); h.store.notifications.stop(h.session.id); await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card))); assert.equal(h.store.mcpProxyPolicy("shared-server"), "inherit");
});
test("CFG-X03e: apply rechecks previewed proxy choices and does not persist an unlisted policy", async context => {
  const h = await fixture(context), apply = createMcpProxyAdapter(h.store).apply; assert.ok(apply);
  const call = (proxyPolicy: string) => apply({ sessionId: h.session.id, requestId: "request", revision: 1, input: { mcpServerId: "shared-server", proxyPolicy }, plan: { fields: [], changes: [], impact: { resourceLocation: "Shared MCP server proxy policy", effectiveScope: "shared-server", message: "Saved" }, verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_connection", ready: true }, snapshot: { projectId: h.project.id, stopGeneration: 0, writable: true, resourceVersions: {}, data: {} }, scope: { kind: "global" } } satisfies ConfigurationAdapterContext);
  for (const proxyPolicy of ["undefined", "proxy:missing"]) assert.throws(() => call(proxyPolicy), { code: "INVALID_CONFIGURATION_INPUT" });
  assert.throws(() => call(`proxy:${h.proxy.id}`), /shared transaction/); assert.equal(h.store.mcpProxyPolicy("shared-server"), "inherit");
});
