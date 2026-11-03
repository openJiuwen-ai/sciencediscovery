// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { CustomMcpServers } from "../mcp/custom-servers.js";
import { SessionStore } from "../store.js";
import { configurationFramework, ConversationalConfigurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
import { digest } from "./validation.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
const operation = () => ({ operationId: `${randomUUID()}:1:external_submit`, bindingDigest: digest(randomUUID()) });
function approval(card: ConfigurationRequestView) { assert.ok(card.previewDigest); return { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: "persist", decision: "apply" as const }; }
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "mcp-delete-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const state = { refreshes: 0, cleanupAttempts: 0, failCleanup: false, submits: 0 }, registry = createMcpSourceRegistry();
  const cleanup = async (id: string) => { state.cleanupAttempts++; if (state.failCleanup) { throw new Error("synthetic local cleanup failure"); } await store.removeCustomConnectorReferences(id); };
  const manager = new CustomMcpServers(root, registry, ids => store.setCustomConnectorIds(ids), async () => { state.refreshes++; }, cleanup); await manager.load();
  const server = await manager.save({ name: "Owned deletion", transport: "http", enabled: true, url: "http://127.0.0.1:1/owned-never-called", headers: { Authorization: "synthetic-owned-secret" } });
  const other = await manager.save({ name: "Retained", transport: "stdio", enabled: false, command: "owned-never-executed", env: { SECRET: "synthetic-other-secret" } });
  const project = await store.createProject("MCP deletion"), session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  await store.updateSession(session.id, { enabledConnectorIds: [server.id, other.id] });
  const submit = manager.submitConfigurationDeletion.bind(manager); manager.submitConfigurationDeletion = (...args) => { state.submits++; return submit(...args); };
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined, mcpDeletion: manager });
  const propose = (values: ConfigurationValues = { confirmDelete: true }) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "mcp.delete", values: { serverId: server.id, ...values } });
  return { root, store, manager, registry, state, server, other, session, framework, propose, cleanup };
}

test("CFG-X03f: finite global deletion requires v3 and independent manual confirmation", async context => {
  const h = await harness(context); await h.store.updateSession(h.session.id, { autoApplyLowRiskConfiguration: true });
  const collecting = await h.propose({}); assert.equal(collecting.state, "collecting_input");
  const card = await h.framework.preview(h.session.id, collecting.id, { expectedRevision: collecting.revision, values: { serverId: h.server.id, confirmDelete: true }, selectedOptionId: "persist" }); assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined); assert.equal(card.verificationPlan.maxRequests, 0);
  const invalid: ConfigurationValues[] = [{ confirmDelete: "true" }, { command: "no" }, { apiToken: "synthetic" }, { serverId: "pubmed" }];
  for (const values of invalid) { await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" }); }
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "mcp.delete", values: { serverId: h.server.id, confirmDelete: true } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card), undefined, "auto"), { code: "CONFIGURATION_AUTO_NOT_AUTHORIZED" }); assert.equal(h.state.submits, 0);
});

test("CFG-X03f: removal cleans selected references only and replays without another write or cleanup", async context => {
  const h = await harness(context), card = await h.propose(), file = resolve(h.root, "custom-mcp-servers.enc"), refreshes = h.state.refreshes, other = h.manager.transportConfig().servers[h.other.id];
  const saved = await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(saved.state, "applied"); assert.equal(saved.activation.state, "needs_user_action");
  assert.equal(h.manager.configurationDeletion(h.server.id).current, undefined); assert.throws(() => h.registry.get(h.server.id));
  assert.deepEqual(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds, [h.other.id]); assert.deepEqual(h.manager.transportConfig().servers[h.other.id], other); assert.equal(h.state.refreshes, refreshes);
  const bytes = await readFile(file, "utf8"), cleanups = h.state.cleanupAttempts; await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(await readFile(file, "utf8"), bytes); assert.equal(h.state.cleanupAttempts, cleanups); assert.equal(h.state.submits, 1);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-owned-secret|owned-never-called/u);
});

test("CFG-X03f: genuine pre-rename failure preserves configuration and resolution fences delayed deletion", async context => {
  const h = await harness(context), op = operation(), source = h.manager.configurationDeletion(h.server.id), file = resolve(h.root, "custom-mcp-servers.enc"), before = await readFile(file, "utf8"), blocker = file + ".tmp"; assert.ok(source.version); await mkdir(blocker);
  await assert.rejects(h.manager.submitConfigurationDeletion(op, h.server.id, source.version)); assert.equal(await readFile(file, "utf8"), before); assert.ok(h.manager.configurationDeletion(h.server.id).current); assert.equal(h.state.cleanupAttempts, 0);
  assert.ok(blocker.startsWith(h.root + sep)); await rm(blocker, { recursive: true }); const rejected = await h.manager.resolveConfigurationMetadata(op); assert.equal(rejected.status, "rejected"); assert.deepEqual(await h.manager.submitConfigurationDeletion(op, h.server.id, source.version), rejected); assert.ok(h.manager.configurationDeletion(h.server.id).current);
});

test("CFG-X03f: cleanup interruption is durable and load finishes cleanup without resubmitting deletion", async context => {
  const h = await harness(context), op = operation(), source = h.manager.configurationDeletion(h.server.id); assert.ok(source.version); h.state.failCleanup = true;
  await assert.rejects(h.manager.submitConfigurationDeletion(op, h.server.id, source.version)); assert.equal(h.manager.configurationDeletion(h.server.id).current, undefined); assert.ok(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds.includes(h.server.id));
  const sourceRegistry = createMcpSourceRegistry(), reloaded = new CustomMcpServers(h.root, sourceRegistry, ids => h.store.setCustomConnectorIds(ids), async () => { throw new Error("No network refresh"); }, h.cleanup);
  h.state.failCleanup = false; await reloaded.load(); const after = await reloaded.resolveConfigurationMetadata(op); assert.equal(after.status, "applied"); assert.deepEqual(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds, [h.other.id]); assert.equal(h.state.submits, 1);
  assert.equal(reloaded.configurationDeletion(h.server.id).current, undefined); assert.throws(() => sourceRegistry.get(h.server.id));
  const bytes = await readFile(resolve(h.root, "custom-mcp-servers.enc"), "utf8"), attempts = h.state.cleanupAttempts; await reloaded.resolveConfigurationMetadata(op); assert.equal(h.state.cleanupAttempts, attempts); assert.equal(await readFile(resolve(h.root, "custom-mcp-servers.enc"), "utf8"), bytes);
});

test("CFG-X03f: lost response resolves one deletion; OAuth cleanup failure must be reconciled before applied", async context => {
  const h = await harness(context), clear = h.manager.oauth.clear.bind(h.manager.oauth); let failures = 1;
  h.manager.oauth.clear = async id => { if (failures-- > 0) { throw new Error("synthetic OAuth write failure"); } await clear(id); };
  const card = await h.propose(), saved = await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(saved.state, "applied"); assert.equal(h.state.submits, 1); assert.deepEqual(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds, [h.other.id]);
});

test("CFG-X03f: a failed cleanup-completion write remains recoverable and later edits retain the deletion receipt", async context => {
  const h = await harness(context), op = operation(), source = h.manager.configurationDeletion(h.server.id), file = resolve(h.root, "custom-mcp-servers.enc"), blocker = file + ".tmp"; assert.ok(source.version);
  const manager = new CustomMcpServers(h.root, h.registry, ids => h.store.setCustomConnectorIds(ids), async () => { throw new Error("No refresh"); }, async id => { await h.cleanup(id); await mkdir(blocker); }); await manager.load();
  await assert.rejects(manager.submitConfigurationDeletion(op, h.server.id, source.version)); assert.equal(manager.configurationDeletion(h.server.id).current, undefined); assert.deepEqual(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds, [h.other.id]);
  assert.ok(blocker.startsWith(h.root + sep)); await rm(blocker, { recursive: true });
  const restored = new CustomMcpServers(h.root, createMcpSourceRegistry(), ids => h.store.setCustomConnectorIds(ids), async () => undefined, h.cleanup); await restored.load(); assert.equal((await restored.resolveConfigurationMetadata(op)).status, "applied");
  const otherVersion = restored.configurationMetadata(h.other.id).version; assert.ok(otherVersion); await restored.submitConfigurationMetadata(operation(), h.other.id, otherVersion, { description: "After completed deletion" });
  const again = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => undefined); await again.load(); assert.equal((await again.resolveConfigurationMetadata(op)).status, "applied"); assert.equal(again.configurationMetadata(h.other.id).current?.description, "After completed deletion");
});

test("CFG-X03f: selected configuration/OAuth changes fence stale deletion while unrelated resources do not", async context => {
  const h = await harness(context); let card = await h.propose(); await h.manager.save({ ...h.other, description: "Unrelated edit" }, h.other.id); await h.framework.decide(h.session.id, card.id, approval(card));
  await h.manager.save({ ...h.other, transport: "http", url: "http://127.0.0.1:1/owned-oauth", authMode: "oauth", env: {} }, h.other.id);
  card = await h.propose({ serverId: h.other.id }); const before = h.manager.configurationDeletion(h.other.id).version; await h.manager.oauth.clear(h.other.id); assert.notEqual(h.manager.configurationDeletion(h.other.id).version, before); await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card)), { code: "RESOURCE_VERSION_CONFLICT" }); assert.ok(h.manager.configurationDeletion(h.other.id).current);
});

test("CFG-X03f: refusal/Stop and missing authority cannot issue deletion", async context => {
  const h = await harness(context), file = resolve(h.root, "custom-mcp-servers.enc"), before = await readFile(file, "utf8"); let card = await h.propose(); card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }); await h.framework.decide(h.session.id, card.id, { ...approval(card), decision: "dismiss", selectedOptionId: "dismiss" });
  card = await h.propose(); const reader = new ConversationalConfigurationFramework(h.store, { nativeExecutor: true, connector: () => undefined }); assert.deepEqual(reader.service.get(h.session.id, card.id).allowedActions, ["query"]);
  h.store.notifications.stop(h.session.id); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled"); assert.equal(await readFile(file, "utf8"), before); assert.equal(h.state.submits, 0);
});

test("CFG-X03f: bilingual discovery contains safe identities and explicit irreversibility only", async context => {
  const h = await harness(context);
  for (const query of ["delete MCP server", "删除 MCP 服务"]) { const page = await discoverConfiguration(h.store, h.session.id, "owned-unused", "search", { query }); assert.match(JSON.stringify(page), /mcp.delete/u); }
  const page = await discoverConfiguration(h.store, h.session.id, "owned-unused", "describe", { capabilityId: "mcp.delete", targetId: h.server.id }); assert.doesNotMatch(JSON.stringify(page), /synthetic-owned|owned-never-called|Authorization/u); assert.match(JSON.stringify(page), /noAutomaticUndo/u);
});
