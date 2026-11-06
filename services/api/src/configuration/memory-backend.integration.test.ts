// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework, type ConversationalConfigurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `configuration-memory-backend-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Memory backend");
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "memory.backend", values });
  return { store, root, session, framework, propose };
}
const approve = (framework: ConversationalConfigurationFramework, view: ConfigurationRequestView) => framework.decide(view.sessionId, view.id,
  { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply", selectedOptionId: "persist" });

test("CFG-X04b: backend selection preserves participation, connection and encrypted password across reopen", async context => {
  const h = await harness(context);
  await h.store.updateMemoryGraphSettings({ enabled: false, backend: "local", neo4jHttp: "https://fixture:private-uri@graph.invalid:7474/path?private-query=1", neo4jUser: "fixture-user", neo4jPassword: "fixture-password" });
  const before = h.store.getMemoryGraphSettings(), database = h.store.getConfigurationDatabase();
  const ciphertext = database.prepare("SELECT * FROM memory_graph_secret").all();
  h.store.getMemoryGraphNeo4jPassword = () => { throw new Error("No password decryption for a backend selection"); };
  const view = await h.propose({ backend: "neo4j" });
  assert.equal(view.scope.kind, "global"); assert.equal(view.autoApplyAt, undefined); assert.equal(view.verificationPlan.maxRequests, 0);
  assert.match(view.impact.message, /graph.invalid:7474/); assert.match(view.impact.message, /self-heal/);
  assert.doesNotMatch(JSON.stringify(view), /fixture:private-uri|private-query|fixture-user|fixture-password/);
  const result = await approve(h.framework, view); assert.equal(result.state, "applied");
  assert.equal(result.activation.mode, "requires_restart"); assert.equal(result.activation.state, "needs_user_action"); assert.equal(result.resumption.state, "not_requested");
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.deepEqual(h.store.getMemoryGraphSettings(), { ...before, backend: "neo4j" });
  assert.deepEqual(database.prepare("SELECT * FROM memory_graph_secret").all(), ciphertext);
  h.store.close(); const reopened = new SessionStore(h.root); await reopened.load();
  assert.deepEqual(reopened.getMemoryGraphSettings(), { ...before, backend: "neo4j" }); reopened.close();
});

test("CFG-X04b: finite v3 fields/global scope/no-op and empty input preserve formal state", async context => {
  const h = await harness(context), before = h.store.getMemoryGraphSettings();
  assert.throws(() => h.store.applyMemoryGraphBackendSync("neo4j"));
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "memory.backend", values: { backend: "neo4j" } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "memory.backend", values: { backend: "neo4j" }, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
  for (const values of [{ backend: "bolt" }, { enabled: true }, { neo4jPassword: "ordinary-key" }, { backend: [] }]) assert.throws(() => h.framework.service.registry.agentValues("memory.backend", values));
  await assert.rejects(h.propose({ backend: before.backend }), { code: "CONFIGURATION_NO_CHANGE" });
  const empty = await h.propose({}); assert.equal(empty.state, "collecting_input");
  const field = empty.fields.find(field => field.id === "backend"); assert.ok(field && field.kind === "enum"); assert.equal(field.value, before.backend);
  assert.deepEqual(h.store.getMemoryGraphSettings(), before);
});

test("CFG-X04b: refusal and Stop keep the existing backend and do not resume work", async context => {
  const h = await harness(context), before = h.store.getMemoryGraphSettings(); let view = await h.propose({ backend: "neo4j" });
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: {}, selectedOptionId: "dismiss" });
  assert.equal((await h.framework.decide(h.session.id, view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "dismiss", selectedOptionId: "dismiss" })).state, "dismissed");
  view = await h.propose({ backend: "neo4j" }); h.store.notifications.stop(h.session.id);
  await assert.rejects(approve(h.framework, view)); assert.deepEqual(h.store.getMemoryGraphSettings(), before);
});

test("CFG-X04b: connection/key/participation edits fence approvals, unrelated Web changes do not", async context => {
  const h = await harness(context); let view = await h.propose({ backend: "neo4j" });
  for (const change of [{ neo4jHttp: "https://concurrent.invalid:7474" }, { neo4jPassword: "rotated-fixture" }, { enabled: false }]) {
    await h.store.updateMemoryGraphSettings(change);
    await assert.rejects(approve(h.framework, view), { code: "RESOURCE_VERSION_CONFLICT" });
    view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { backend: "neo4j" } });
  }
  await h.store.updateWebSettings({ providerApiKeys: { jina: "unrelated-fixture" } });
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal(h.store.getMemoryGraphSettings().neo4jHttp, "https://concurrent.invalid:7474");
});

test("CFG-X04b: receipt failure rolls back selection; explicit retry succeeds", async context => {
  const h = await harness(context), before = h.store.getMemoryGraphSettings(), database = h.store.getConfigurationDatabase();
  let view = await h.propose({ backend: "neo4j" });
  database.exec("CREATE TRIGGER reject_memory_backend_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await approve(h.framework, view)).state, "failed");
  assert.deepEqual(h.store.getMemoryGraphSettings(), before); assert.equal(h.framework.repository.getReceipt(view.id), undefined);
  database.exec("DROP TRIGGER reject_memory_backend_receipt");
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { backend: "neo4j" } });
  assert.equal((await approve(h.framework, view)).state, "applied");
});

test("CFG-X04b: bilingual discovery exposes only safe backend/destination metadata", async context => {
  const h = await harness(context);
  await h.store.updateMemoryGraphSettings({ neo4jHttp: "http://private-user:private-url-password@graph.invalid:7474/path?private-query=1", neo4jUser: "private-user", neo4jPassword: "private-password" });
  h.store.getMemoryGraphNeo4jPassword = () => { throw new Error("No credential read for discovery"); };
  for (const query of ["memory graph backend", "记忆图谱后端"]) {
    const result = await discoverConfiguration(h.store, h.session.id, "", "search", { query });
    assert.ok((result.items as Array<{ capabilityId?: string }>).some(item => item.capabilityId === "memory.backend"));
  }
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "memory.backend" });
  assert.deepEqual(detail.scopes, ["global"]); assert.doesNotMatch(JSON.stringify(detail), /private-user|private-url-password|private-query|private-password/);
  assert.equal((detail.current as { readinessVerified: boolean }).readinessVerified, false);
});
