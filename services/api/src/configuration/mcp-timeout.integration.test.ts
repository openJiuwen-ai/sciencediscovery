// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { CustomMcpServers } from "../mcp/custom-servers.js";
import { SessionStore } from "../store.js";
import { configurationFramework, ConversationalConfigurationFramework } from "./framework.js";
import { configurationDecisionReady } from "./interaction-wait.js";
import { discoverConfiguration } from "./discovery.js";
import { digest } from "./validation.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
function approval(card: ConfigurationRequestView) { assert.ok(card.previewDigest); return { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: "persist", decision: "apply" as const }; }
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "mcp-timeout-card-" + randomUUID()), store = new SessionStore(root); await store.load(); const state = { refreshes: 0, submits: 0 };
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const registry = createMcpSourceRegistry(), manager = new CustomMcpServers(root, registry, () => undefined, async () => { state.refreshes++; }); await manager.load();
  const server = await manager.save({ name: "Owned 自定义 MCP", description: "Retained", transport: "stdio", enabled: false, command: "owned-must-not-execute", env: { OWNED_SECRET: "synthetic-owned-env" }, timeoutSeconds: 37 });
  const project = await store.createProject("MCP timeout"), session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  const submit = manager.submitConfigurationTimeout.bind(manager); manager.submitConfigurationTimeout = (...args) => { state.submits++; return submit(...args); };
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined, mcpTimeout: manager });
  const propose = (values: ConfigurationValues = { timeoutSeconds: 81 }) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "mcp.timeout", values: { serverId: server.id, ...values } });
  return { root, store, manager, state, server, session, framework, propose };
}

test("CFG-X03b: finite timeout is v3 manual only and does not grant permissions or executable fields", async context => {
  const h = await harness(context), card = await h.propose(); assert.equal(card.scope.kind, "global"); assert.equal(card.activation.mode, "next_invocation"); assert.equal(card.verificationPlan.maxRequests, 0);
  const invalid: ConfigurationValues[] = [{ name: "Forbidden" }, { enabled: true }, { command: "Forbidden" }, { timeoutSeconds: 0 }, { timeoutSeconds: 601 }, { timeoutSeconds: 1.5 }, { timeoutSeconds: "8" }];
  for (const values of invalid) { await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" }); }
  assert.throws(() => h.framework.service.registry.get("mcp.timeout").normalize({ timeoutSeconds: null }), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "mcp.timeout", values: { serverId: h.server.id, timeoutSeconds: 81 } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card), undefined, "auto"), { code: "CONFIGURATION_AUTO_NOT_AUTHORIZED" }); assert.equal(h.state.submits, 0);
});

test("CFG-X03b: bounded Agent discovery exposes only safe timeout facts with actual activation timing", async context => {
  const h = await harness(context), result = await discoverConfiguration(h.store, h.session.id, "owned-unused", "describe", { capabilityId: "mcp.timeout", targetId: h.server.id });
  assert.equal(result.activation, "next_invocation"); assert.equal((result.current as { timeoutSeconds: number }).timeoutSeconds, 37); assert.doesNotMatch(JSON.stringify(result), /synthetic-owned-env|owned-must-not-execute/u); assert.ok(JSON.stringify(result).length < 8_000);
});

test("CFG-X03b: preview is read only; manual save preserves all other fields and replay bytes", async context => {
  const h = await harness(context), file = resolve(h.root, "custom-mcp-servers.enc"), before = await readFile(file, "utf8"), transport = h.manager.transportConfig().servers[h.server.id], refreshes = h.state.refreshes, card = await h.propose();
  assert.equal(await readFile(file, "utf8"), before); const saved = await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(saved.state, "applied"); assert.equal(saved.activation.state, "needs_user_action");
  assert.deepEqual(h.manager.transportConfig().servers[h.server.id], { ...transport, timeoutSeconds: 81, toolCallTimeoutSeconds: 81 }); assert.equal(h.state.refreshes, refreshes); assert.equal(h.manager.list()[0]?.enabled, false);
  const record = h.framework.repository.get(card.id, h.session.id); assert.ok(record); assert.equal(configurationDecisionReady(record), true); assert.equal(saved.resumption.state, "not_requested");
  const bytes = await readFile(file, "utf8"); await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(await readFile(file, "utf8"), bytes); assert.equal(h.state.submits, 1); assert.doesNotMatch(JSON.stringify(saved), /synthetic-owned-env|owned-must-not-execute/u);
});

test("CFG-X03b: selected CAS rejects stale edits while unrelated resources remain isolated", async context => {
  const h = await harness(context); let card = await h.propose(); await h.manager.save({ name: "Unrelated", transport: "stdio", enabled: false, command: "owned-never-executed" }); assert.equal((await h.framework.decide(h.session.id, card.id, approval(card))).state, "applied");
  card = await h.propose({ timeoutSeconds: 15 }); const selected = h.manager.list().find(item => item.id === h.server.id); assert.ok(selected); await h.manager.save({ ...selected, timeoutSeconds: 99 }, h.server.id);
  await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card)), { code: "RESOURCE_VERSION_CONFLICT" }); assert.equal(h.manager.configurationTimeout(h.server.id).current?.timeoutSeconds, 99);
});

test("CFG-X03b: target collection, no-change, missing resource and incorrect scope cannot save", async context => {
  const h = await harness(context), empty = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "mcp.timeout", values: {} }); assert.equal(empty.state, "collecting_input");
  let targeted = await h.propose({ serverId: h.server.id }); assert.equal(targeted.state, "collecting_input"); targeted = await h.framework.preview(h.session.id, targeted.id, { expectedRevision: targeted.revision, values: {}, selectedOptionId: "dismiss" }); await h.framework.decide(h.session.id, targeted.id, { ...approval(targeted), decision: "dismiss", selectedOptionId: "dismiss" });
  await assert.rejects(h.propose({ timeoutSeconds: 37 }), { code: "CONFIGURATION_NO_CHANGE" });
  await assert.rejects(h.propose({ serverId: "custom-000000000000" }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "mcp.timeout", scope: { kind: "session", id: h.session.id }, values: { serverId: h.server.id, timeoutSeconds: 80 } }), { code: "INVALID_CONFIGURATION_INPUT" });
});

test("CFG-X03b: refusal and Stop suppress dispatch without altering authority bytes", async context => {
  const h = await harness(context), file = resolve(h.root, "custom-mcp-servers.enc"), before = await readFile(file, "utf8"); let card = await h.propose(); card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }); await h.framework.decide(h.session.id, card.id, { ...approval(card), decision: "dismiss", selectedOptionId: "dismiss" });
  card = await h.propose(); h.store.notifications.stop(h.session.id); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled"); assert.equal(await readFile(file, "utf8"), before); assert.equal(h.state.submits, 0);
});

test("CFG-X03b: lost submit response resolves the actual durable receipt after manager reload", async context => {
  const h = await harness(context), submit = h.manager.submitConfigurationTimeout.bind(h.manager), card = await h.propose(); h.manager.submitConfigurationTimeout = async (...args) => { await submit(...args); throw new Error("synthetic-private-error"); };
  const saved = await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(saved.state, "applied"); assert.equal(h.state.submits, 1);
  const reloaded = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => { throw new Error("Must not discover"); }); await reloaded.load(); assert.equal(reloaded.configurationTimeout(h.server.id).current?.timeoutSeconds, 81);
  const job = h.framework.repository.getOutbox(`${card.id}:${card.revision}:external_submit`); assert.ok(job); assert.ok(job.payload.operationId); assert.ok(job.payload.bindingDigest);
  const receipt = await reloaded.resolveConfigurationMetadata({ operationId: String(job.payload.operationId), bindingDigest: String(job.payload.bindingDigest) }); assert.equal(receipt.status, "applied");
});

test("CFG-X03b: finite authority rejects null and executable fields, with a durable delayed-submit fence", async context => {
  const h = await harness(context), version = h.manager.configurationTimeout(h.server.id).version; assert.ok(version);
  for (const values of [{ timeoutSeconds: null }, { timeoutSeconds: 0 }, { timeoutSeconds: 601 }, { timeoutSeconds: 3, enabled: true }, {}]) {
    const operation = { operationId: `${randomUUID()}:1:external_submit`, bindingDigest: digest(randomUUID()) }; const result = await h.manager.submitConfigurationTimeout(operation, h.server.id, version, values); assert.equal(result.status, "rejected"); assert.deepEqual(await h.manager.resolveConfigurationMetadata(operation), result);
  }
  const operation = { operationId: `${randomUUID()}:1:external_submit`, bindingDigest: digest(randomUUID()) }, rejected = await h.manager.resolveConfigurationMetadata(operation); assert.equal(rejected.status, "rejected"); assert.deepEqual(await h.manager.submitConfigurationTimeout(operation, h.server.id, version, { timeoutSeconds: 19 }), rejected); assert.equal(h.manager.configurationTimeout(h.server.id).current?.timeoutSeconds, 37);
});

test("CFG-X03b: unavailable authority keeps historical timeout cards query-only", async context => {
  const h = await harness(context), card = await h.propose(); await h.framework.decide(h.session.id, card.id, approval(card)); const reader = new ConversationalConfigurationFramework(h.store, { nativeExecutor: true, connector: () => undefined });
  const historical = reader.service.get(h.session.id, card.id); assert.equal(historical.state, "applied"); assert.deepEqual(historical.allowedActions, ["query"]); assert.equal(historical.error?.code, "CONFIGURATION_BACKEND_UNAVAILABLE");
});
