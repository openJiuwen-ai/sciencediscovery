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
const target = (id: string, name = "authorization") => JSON.stringify([id, name]);
const operation = () => ({ operationId: `${randomUUID()}:1:external_submit`, bindingDigest: digest(randomUUID()) });
function approval(card: ConfigurationRequestView) { assert.ok(card.previewDigest); return { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: "persist", decision: "apply" as const }; }
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "mcp-header-removal-" + randomUUID()), store = new SessionStore(root); await store.load(); const state = { refreshes: 0, submits: 0 };
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const registry = createMcpSourceRegistry(), manager = new CustomMcpServers(root, registry, ids => store.setCustomConnectorIds(ids), async () => { state.refreshes++; }); await manager.load();
  const server = await manager.save({ name: "Owned HTTP header removal", description: "Retained", transport: "http", enabled: true, url: "http://127.0.0.1:1/owned-never-called", headers: { Authorization: "synthetic-owned-first", authorization: "synthetic-owned-alias", "X-Other": "synthetic-owned-retained" }, timeoutSeconds: 37 });
  manager.applyCatalog({ loadedAt: new Date().toISOString(), revision: "owned-tools", servers: [{ id: server.id, transport: "http", enabled: true, tools: [{ name: "owned_echo", description: "Owned", inputSchema: { type: "object", properties: {} }, schemaHash: "owned" }] }] });
  const project = await store.createProject("Header removal"), session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  const submit = manager.submitConfigurationHeaderRemoval.bind(manager); manager.submitConfigurationHeaderRemoval = (...args) => { state.submits++; return submit(...args); };
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined, mcpHeaderRemoval: manager });
  const propose = (values: ConfigurationValues = { headerName: "Authorization" }) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "mcp.remove_header", values: { serverId: server.id, ...values } });
  return { root, store, manager, registry, state, server, session, framework, propose };
}

test("CFG-X03d: only existing names, never values/executable fields, are manually authorized", async context => {
  const h = await harness(context); await h.store.updateSession(h.session.id, { autoApplyLowRiskConfiguration: true }); const card = await h.propose(); assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined); assert.equal(card.verificationPlan.maxRequests, 0); assert.match(card.changes[0]?.before ?? "", /2 configured/u);
  const invalid: ConfigurationValues[] = [{ name: "forbidden" }, { headers: "forbidden" }, { apiToken: "synthetic-forbidden" }, { enabled: false }, { headerName: " authorization " }, { headerName: "\n" }];
  for (const values of invalid) { await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" }); }
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "mcp.remove_header", values: { serverId: h.server.id, headerName: "Authorization" } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card), undefined, "auto"), { code: "CONFIGURATION_AUTO_NOT_AUTHORIZED" }); assert.equal(h.state.submits, 0);
});

test("CFG-X03d: save removes all case aliases, invalidates discovery before publication and preserves unrelated state", async context => {
  const h = await harness(context), file = resolve(h.root, "custom-mcp-servers.enc"), bytes = await readFile(file, "utf8"), refreshes = h.state.refreshes, before = h.manager.transportConfig().servers[h.server.id], settings = h.store.getSessionSettings(h.session.id), card = await h.propose();
  assert.equal(await readFile(file, "utf8"), bytes); const upsert = h.registry.upsert.bind(h.registry); let observedInvalidation = false;
  h.registry.upsert = adapter => { if (adapter.manifest.id === h.server.id && !Object.hasOwn(h.manager.transportConfig().servers[h.server.id]?.headers ?? {}, "Authorization")) { assert.equal(h.manager.list()[0]?.status, "untested"); assert.equal(Object.keys(adapter.manifest.tools).length, 0); observedInvalidation = true; } return upsert(adapter); };
  const saved = await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(saved.state, "applied"); assert.equal(saved.activation.state, "needs_user_action"); assert.equal(observedInvalidation, true);
  assert.deepEqual(h.manager.transportConfig().servers[h.server.id], { ...before, headers: { "X-Other": "synthetic-owned-retained" } }); assert.equal(h.state.refreshes, refreshes); assert.deepEqual(h.store.getSessionSettings(h.session.id), settings); assert.equal(h.manager.list()[0]?.tools.length, 0);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-owned|owned-never-called/u); const after = await readFile(file, "utf8"); await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(await readFile(file, "utf8"), after); assert.equal(h.state.submits, 1);
});

test("CFG-X03d: a genuine pre-rename file-write failure retains old credentials, tools and bytes; resolution fences retry", async context => {
  const h = await harness(context), selected = target(h.server.id), source = h.manager.configurationHeaderRemoval(selected), op = operation(), file = resolve(h.root, "custom-mcp-servers.enc"), blocker = file + ".tmp", before = await readFile(file, "utf8"); assert.ok(source.version); await mkdir(blocker);
  await assert.rejects(h.manager.submitConfigurationHeaderRemoval(op, selected, source.version)); assert.equal(await readFile(file, "utf8"), before); assert.equal(h.manager.list()[0]?.status, "ready"); assert.equal(h.manager.list()[0]?.tools.length, 1); assert.equal(h.manager.configurationHeaderRemoval(selected).header?.aliases, 2);
  assert.ok(blocker.startsWith(h.root + sep)); await rm(blocker, { recursive: true }); const rejected = await h.manager.resolveConfigurationMetadata(op); assert.equal(rejected.status, "rejected"); assert.deepEqual(await h.manager.submitConfigurationHeaderRemoval(op, selected, source.version), rejected); assert.equal(h.manager.configurationHeaderRemoval(selected).header?.aliases, 2);
});

test("CFG-X03d: post-rename publication failure reconciles the durable removal without resubmitting", async context => {
  const h = await harness(context), selected = target(h.server.id), source = h.manager.configurationHeaderRemoval(selected), op = operation(), upsert = h.registry.upsert.bind(h.registry); assert.ok(source.version); h.registry.upsert = () => { throw new Error("synthetic publication failure"); };
  await assert.rejects(h.manager.submitConfigurationHeaderRemoval(op, selected, source.version)); h.registry.upsert = upsert; const outcome = await h.manager.resolveConfigurationMetadata(op); assert.equal(outcome.status, "applied"); assert.equal(h.manager.configurationHeaderRemoval(selected).header, undefined); assert.equal(h.manager.list()[0]?.status, "untested");
  const reloaded = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => { throw new Error("Must not discover"); }); await reloaded.load(); assert.deepEqual(await reloaded.resolveConfigurationMetadata(op), outcome); assert.equal(reloaded.configurationHeaderRemoval(selected).header, undefined); assert.equal(h.state.submits, 1);
});

test("CFG-X03d: a lost submit response is recovered through the authority receipt exactly once", async context => {
  const h = await harness(context), submit = h.manager.submitConfigurationHeaderRemoval.bind(h.manager), card = await h.propose(); h.manager.submitConfigurationHeaderRemoval = async (...args) => { await submit(...args); throw new Error("synthetic-private-response"); };
  const saved = await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(saved.state, "applied"); assert.equal(h.state.submits, 1); assert.doesNotMatch(JSON.stringify(saved), /synthetic-private-response|synthetic-owned/u);
});

test("CFG-X03d: selected auth changes invalidate CAS while unrelated servers do not", async context => {
  const h = await harness(context); let card = await h.propose(); await h.manager.save({ name: "Unrelated", transport: "stdio", enabled: false, command: "owned-never-executed" }); await h.framework.decide(h.session.id, card.id, approval(card));
  card = await h.propose({ headerName: "X-Other" }); const current = h.manager.list().find(item => item.id === h.server.id); assert.ok(current); await h.manager.save({ ...current, headers: { "X-Other": "synthetic-concurrent" } }, h.server.id); await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card)), { code: "RESOURCE_VERSION_CONFLICT" }); assert.ok(h.manager.configurationHeaderRemoval(target(h.server.id, "x-other")).header);
});

test("CFG-X03d: collection, absent names and STDIO cannot become arbitrary deletion targets", async context => {
  const h = await harness(context), empty = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "mcp.remove_header", values: {} }); assert.equal(empty.state, "collecting_input");
  await assert.rejects(h.propose({ headerName: "missing" }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" }); const stdio = await h.manager.save({ name: "Owned STDIO", transport: "stdio", enabled: false, command: "owned-never-executed" }); await assert.rejects(h.propose({ serverId: stdio.id }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
  const record = await h.propose({ headerName: "AUTHORIZATION" }), field = record.fields.find(item => item.id === "headerName"); assert.ok(field && field.kind === "enum"); assert.equal(field.value, "authorization");
});

test("CFG-X03d: refusal and Stop before submit retain exact authority bytes", async context => {
  const h = await harness(context), file = resolve(h.root, "custom-mcp-servers.enc"), before = await readFile(file, "utf8"); let card = await h.propose(); card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }); await h.framework.decide(h.session.id, card.id, { ...approval(card), decision: "dismiss", selectedOptionId: "dismiss" }); card = await h.propose(); h.store.notifications.stop(h.session.id); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled"); assert.equal(await readFile(file, "utf8"), before); assert.equal(h.state.submits, 0);
});

test("CFG-X03d: Agent discovery projects header names only and the authority-less reader remains query-only", async context => {
  const h = await harness(context), view = await discoverConfiguration(h.store, h.session.id, "owned-unused", "describe", { capabilityId: "mcp.remove_header", targetId: h.server.id }); assert.match(JSON.stringify(view), /authorization/u); assert.doesNotMatch(JSON.stringify(view), /synthetic-owned|owned-never-called/u);
  const card = await h.propose(); await h.framework.decide(h.session.id, card.id, approval(card)); const reader = new ConversationalConfigurationFramework(h.store, { nativeExecutor: true, connector: () => undefined }); assert.deepEqual(reader.service.get(h.session.id, card.id).allowedActions, ["query"]); assert.equal(reader.service.get(h.session.id, card.id).error?.code, "CONFIGURATION_BACKEND_UNAVAILABLE");
});
