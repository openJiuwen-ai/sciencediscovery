// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConfigurationCapabilityId, ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework, type ConversationalConfigurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `configuration-memory-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Memory participation");
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "memory.enable", values });
  return { store, root, session, framework, propose };
}
const approve = (framework: ConversationalConfigurationFramework, view: ConfigurationRequestView) => framework.decide(view.sessionId, view.id,
  { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply", selectedOptionId: "persist" });

test("CFG-X04a: global manual toggle preserves connection fields/password ciphertext and persists across reopen", async context => {
  const h = await harness(context);
  await h.store.updateMemoryGraphSettings({ backend: "local", neo4jHttp: "https://fixture:private-uri@graph.invalid:7474/path?private-query=1", neo4jUser: "fixture-user", neo4jPassword: "fixture-password" });
  const before = h.store.getMemoryGraphSettings(), database = h.store.getConfigurationDatabase();
  const ciphertext = database.prepare("SELECT * FROM memory_graph_secret").all();
  h.store.getMemoryGraphNeo4jPassword = () => { throw new Error("No password decryption for a participation change"); };
  const view = await h.propose({ enabled: !before.enabled });
  assert.equal(view.scope.kind, "global"); assert.equal(view.autoApplyAt, undefined); assert.equal(view.verificationPlan.maxRequests, 0);
  assert.match(view.impact.message, /Local backend only/);
  assert.match(view.impact.message, /saving does not start or restart services/);
  assert.doesNotMatch(JSON.stringify(view), /graph.invalid|fixture:private-uri|private-query|fixture-user|fixture-password/);
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.deepEqual(h.store.getMemoryGraphSettings(), { ...before, enabled: !before.enabled });
  assert.deepEqual(database.prepare("SELECT * FROM memory_graph_secret").all(), ciphertext);
  h.store.close(); const reopened = new SessionStore(h.root); await reopened.load();
  assert.deepEqual(reopened.getMemoryGraphSettings(), { ...before, enabled: !before.enabled }); reopened.close();
});

test("CFG-X04a: invalid fields, non-global scopes and a no-op cannot write; an empty card stays editable", async context => {
  const h = await harness(context), before = h.store.getMemoryGraphSettings();
  assert.throws(() => h.store.applyMemoryGraphParticipationSync(!before.enabled));
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "memory.enable", values: { enabled: false } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "memory.enable", values: { enabled: false }, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
  for (const values of [{ enabled: "true" }, { backend: "neo4j" }, { neo4jPassword: "ordinary-key" }, { enabled: [] }]) assert.throws(() => h.framework.service.registry.agentValues("memory.enable", values));
  await assert.rejects(h.propose({ enabled: before.enabled }), { code: "CONFIGURATION_NO_CHANGE" });
  const empty = await h.propose({}); assert.equal(empty.state, "collecting_input");
  const field = empty.fields.find(field => field.id === "enabled"); assert.ok(field && field.kind === "boolean"); assert.equal(field.value, before.enabled);
  assert.deepEqual(h.store.getMemoryGraphSettings(), before);
});

test("CFG-X04a: refusal and Stop preserve the shared flag and do not resume a task", async context => {
  const h = await harness(context), before = h.store.getMemoryGraphSettings(); let view = await h.propose({ enabled: !before.enabled });
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: {}, selectedOptionId: "dismiss" });
  assert.equal((await h.framework.decide(h.session.id, view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "dismiss", selectedOptionId: "dismiss" })).state, "dismissed");
  view = await h.propose({ enabled: !before.enabled }); h.store.notifications.stop(h.session.id);
  await assert.rejects(approve(h.framework, view)); assert.deepEqual(h.store.getMemoryGraphSettings(), before);
});

test("CFG-X04a: backend changes fence old confirmation while unrelated settings and dormant credentials do not", async context => {
  const h = await harness(context), before = h.store.getMemoryGraphSettings(); let view = await h.propose({ enabled: !before.enabled });
  await h.store.updateMemoryGraphSettings({ backend: "neo4j" });
  await assert.rejects(approve(h.framework, view), { code: "RESOURCE_VERSION_CONFLICT" });
  const other = await h.store.createSession(h.session.projectId, "Unsupported backend", {}, {}, { allowUnconfiguredModel: true });
  await assert.rejects(h.framework.propose(other.id, { protocolVersion: 3, capabilityId: "memory.enable", values: { enabled: !before.enabled } }), { code: "MEMORY_BACKEND_UNSUPPORTED" });
  await assert.rejects(h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { enabled: !before.enabled } }), { code: "MEMORY_BACKEND_UNSUPPORTED" });
  assert.equal(h.store.getMemoryGraphSettings().enabled, before.enabled);
  await h.store.updateMemoryGraphSettings({ backend: "local" });
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { enabled: !before.enabled } });
  await h.store.updateMemoryGraphSettings({ neo4jPassword: "unused-local-fixture" });
  await h.store.updateWebSettings({ providerApiKeys: { jina: "unrelated-fixture" } });
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal(h.store.getMemoryGraphNeo4jPassword(), "unused-local-fixture");
});

test("CFG-X04a: conversational Neo4j capabilities are not registered", async context => {
  const h = await harness(context);
  for (const id of ["memory.backend", "memory.connection", "memory.credential"]) {
    assert.ok(!h.framework.service.registry.list().some(adapter => adapter.id === id));
    await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: id as ConfigurationCapabilityId, values: {} }));
  }
});

test("CFG-X04a: receipt failure rolls back the flag; explicit retry succeeds without touching credentials", async context => {
  const h = await harness(context), before = h.store.getMemoryGraphSettings(), database = h.store.getConfigurationDatabase();
  let view = await h.propose({ enabled: !before.enabled });
  database.exec("CREATE TRIGGER reject_memory_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await approve(h.framework, view)).state, "failed");
  assert.deepEqual(h.store.getMemoryGraphSettings(), before); assert.equal(h.framework.repository.getReceipt(view.id), undefined);
  database.exec("DROP TRIGGER reject_memory_receipt");
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { enabled: !before.enabled } });
  const result = await approve(h.framework, view); assert.equal(result.state, "applied"); assert.equal(result.activation.mode, "next_request"); assert.equal(result.activation.state, "needs_user_action");
});

test("CFG-X04a: bounded bilingual discovery identifies only the workbench gate and never projects connection credentials", async context => {
  const h = await harness(context);
  await h.store.updateMemoryGraphSettings({ backend: "local", neo4jHttp: "http://private-user:private-url-password@graph.invalid:7474/path?private-query=1", neo4jUser: "private-user", neo4jPassword: "private-password" });
  h.store.getMemoryGraphNeo4jPassword = () => { throw new Error("Do not decrypt for discovery"); };
  for (const query of ["memory graph", "记忆图谱开关"]) {
    const result = await discoverConfiguration(h.store, h.session.id, "", "search", { query });
    assert.ok((result.items as Array<{ capabilityId?: string }>).some(item => item.capabilityId === "memory.enable"));
  }
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "memory.enable" });
  assert.deepEqual(detail.scopes, ["global"]); assert.doesNotMatch(JSON.stringify(detail), /private-user|private-url-password|private-query|private-password/);
  assert.equal((detail.current as { readinessVerified: boolean }).readinessVerified, false);
});
