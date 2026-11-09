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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
const approve = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "mcp-metadata-card-" + randomUUID()), store = new SessionStore(root); await store.load(); const state = { refreshes: 0, submits: 0 };
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const manager = new CustomMcpServers(root, createMcpSourceRegistry(), () => undefined, async () => { state.refreshes++; }); await manager.load();
  const server = await manager.save({ name: "Owned custom MCP", description: "Initial metadata", transport: "http", enabled: false, url: "http://127.0.0.1:1/mcp", headers: { Authorization: "synthetic-owned-auth" }, timeoutSeconds: 37 });
  const project = await store.createProject("MCP metadata"), session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  const submit = manager.submitConfigurationMetadata.bind(manager); manager.submitConfigurationMetadata = (...args) => { state.submits++; return submit(...args); };
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined, mcpMetadata: manager });
  const propose = (values: ConfigurationValues = { name: "Owned renamed MCP" }) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "mcp.metadata", values: { serverId: server.id, ...values } });
  return { root, store, manager, state, server, project, session, framework, propose };
}

test("CFG-X03a: only an attached metadata authority registers the finite manual capability; secure/executable fields remain unavailable", async context => {
  const h = await harness(context); configurationFramework(h.store, { nativeExecutor: true, connector: () => undefined });
  const card = await h.propose(); assert.equal(card.scope.kind, "global"); assert.equal(card.verificationPlan.maxRequests, 0); assert.equal(card.fields.some(field => field.kind === "credential"), false); assert.match(card.impact.message, /No catalog refresh/u);
  const invalid: ConfigurationValues[] = [{ command: "forbidden" }, { enabled: true }, { url: "https://other.invalid" }, { timeoutSeconds: 1 }, { apiToken: "synthetic" }, { oauth: "forbidden" }]; for (const values of invalid) await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "mcp.metadata", values: { serverId: h.server.id, name: "Legacy" } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" }); await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card), undefined, "auto"), { code: "CONFIGURATION_AUTO_NOT_AUTHORIZED" }); assert.equal(h.state.submits, 0);
});

test("CFG-X03a: manual save and replay use one external receipt, no refresh and unchanged connection/auth/timeouts", async context => {
  const h = await harness(context), before = h.manager.transportConfig().servers[h.server.id], refreshes = h.state.refreshes, card = await h.propose({ name: "Renamed 服务", description: "Readable updated metadata" });
  const saved = await h.framework.decide(h.session.id, card.id, approve(card)); assert.equal(saved.state, "applied"); assert.equal(saved.activation.state, "needs_user_action"); assert.equal(h.manager.configurationMetadata(h.server.id).current?.description, "Readable updated metadata"); assert.equal(h.state.refreshes, refreshes);
  const after = h.manager.transportConfig().servers[h.server.id]!; for (const field of ["url", "headers", "env", "enabled", "transport", "toolCallTimeoutSeconds"] as const) assert.deepEqual(after[field], before?.[field]);
  assert.ok(h.framework.repository.getReceipt(card.id, card.revision)); assert.doesNotMatch(JSON.stringify(saved), /synthetic-owned-auth|Bearer/u); await h.framework.decide(h.session.id, card.id, approve(card)); assert.equal(h.state.submits, 1);
});

test("CFG-X03a: an actual saved MCP operation with a lost response is recovered without another metadata submission", async context => {
  const h = await harness(context), submit = h.manager.submitConfigurationMetadata.bind(h.manager), card = await h.propose(); h.manager.submitConfigurationMetadata = async (...args) => { await submit(...args); throw new Error("synthetic-private-upstream-error"); };
  const saved = await h.framework.decide(h.session.id, card.id, approve(card)); assert.equal(saved.state, "applied"); assert.equal(h.state.submits, 1); assert.equal(h.manager.configurationMetadata(h.server.id).current?.name, "Owned renamed MCP"); assert.doesNotMatch(JSON.stringify(saved), /synthetic-private/u);
});

test("CFG-X03a: failed root receipt recovers the exact encrypted-file operation rather than resubmitting", async context => {
  const h = await harness(context), card = await h.propose(), save = h.framework.repository.saveReceipt.bind(h.framework.repository); h.framework.repository.saveReceipt = () => { throw new Error("synthetic root receipt failure"); };
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card))); assert.equal(h.manager.configurationMetadata(h.server.id).current?.name, "Owned renamed MCP"); assert.equal(h.framework.service.get(h.session.id, card.id).state, "applying"); h.framework.repository.saveReceipt = save;
  const job = h.framework.repository.getOutbox(`${card.id}:${card.revision}:external_submit`)!; job.payload.leaseUntil = 0; job.payload.nextAttemptAt = 0; h.framework.repository.updateOutbox(job); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, card.id).state, "applied"); assert.equal(h.state.submits, 1); assert.ok(h.framework.repository.getReceipt(card.id, card.revision));
});

test("CFG-X03a: selected concurrent changes invalidate approval while unrelated MCP metadata is isolated", async context => {
  const h = await harness(context); let card = await h.propose(); await h.manager.save({ name: "Unrelated", transport: "stdio", enabled: false, command: "owned-never-executed" }); assert.equal((await h.framework.decide(h.session.id, card.id, approve(card))).state, "applied");
  card = await h.propose({ description: "Stale description" }); await h.manager.save({ ...h.manager.list().find(item => item.id === h.server.id)!, name: "Changed elsewhere" }, h.server.id); await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "RESOURCE_VERSION_CONFLICT" }); assert.equal(h.manager.configurationMetadata(h.server.id).current?.description, "Initial metadata");
});

test("CFG-X03a: empty target loads, explicit no-change has no card, and missing target is unavailable", async context => {
  const h = await harness(context), empty = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "mcp.metadata", values: {} }); assert.equal(empty.state, "collecting_input"); assert.equal(empty.fields.find(field => field.id === "name")?.required, false);
  await assert.rejects(h.propose({ name: h.server.name }), { code: "CONFIGURATION_NO_CHANGE" }); await assert.rejects(h.propose({ serverId: "custom-000000000000" }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
});

test("CFG-X03a: refusal and Stop before submit do not touch the encrypted configuration file", async context => {
  const h = await harness(context), file = resolve(h.root, "custom-mcp-servers.enc"), before = await readFile(file, "utf8"); let card = await h.propose(); card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }); await h.framework.decide(h.session.id, card.id, { ...approve(card), decision: "dismiss", selectedOptionId: "dismiss" }); assert.equal(await readFile(file, "utf8"), before);
  card = await h.propose(); h.store.notifications.stop(h.session.id); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled"); assert.equal(await readFile(file, "utf8"), before); assert.equal(h.state.submits, 0);
});

test("CFG-X03a: a backend without the metadata authority can still read historical cards without enabling a writer", async context => {
  const h = await harness(context), card = await h.propose(); await h.framework.decide(h.session.id, card.id, approve(card));
  const reader = new ConversationalConfigurationFramework(h.store, { nativeExecutor: true, connector: () => undefined });
  assert.equal(reader.service.registry.list().some(item => item.id === "mcp.metadata"), false);
  const historical = reader.service.get(h.session.id, card.id); assert.equal(historical.state, "applied"); assert.deepEqual(historical.allowedActions, ["query"]); assert.equal(historical.error?.code, "CONFIGURATION_BACKEND_UNAVAILABLE"); assert.equal(h.state.submits, 1);
});
