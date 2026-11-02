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
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `configuration-neo4j-connection-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  await store.updateMemoryGraphSettings({ enabled: false, backend: "neo4j", neo4jHttp: "http://127.0.0.1:7474", neo4jUser: "owned-user" });
  const project = await store.createProject("Neo4j connection"), session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "memory.connection", values });
  return { store, root, session, framework, propose };
}
const approve = (f: ConversationalConfigurationFramework, v: ConfigurationRequestView) => f.decide(v.sessionId, v.id,
  { revision: v.revision, previewDigest: v.previewDigest!, decision: "apply", selectedOptionId: "persist" });
async function consent(f: ConversationalConfigurationFramework, v: ConfigurationRequestView) {
  assert.ok(v.endpointAuthorization); return f.confirmEndpoint(v.sessionId, v.id, { revision: v.revision, endpointTarget: v.endpointAuthorization.endpointTarget });
}
const cipher = (store: SessionStore) => store.getConfigurationDatabase().prepare("SELECT encrypted_password FROM memory_graph_secret WHERE id=1").get();
const change = { neo4jHttp: "https://owned-new.invalid", neo4jUser: "new-owned-user" };

test("CFG-X04d: independent recipient consent precedes a shared connection change and never decrypts or replaces its password", async context => {
  const h = await harness(context); await h.store.updateMemoryGraphSettings({ neo4jPassword: "synthetic-existing-password" });
  const before = h.store.getMemoryGraphSettings(), encrypted = cipher(h.store);
  h.store.getMemoryGraphNeo4jPassword = () => { throw new Error("Connection configuration must not decrypt old passwords"); };
  let v = await h.propose(change); assert.equal(v.scope.kind, "global"); assert.equal(v.autoApplyAt, undefined); assert.equal(v.endpointAuthorization?.status, "required");
  assert.match(v.impact.message, /password is already stored/); assert.equal(v.fields.some(field => field.kind === "credential"), false);
  assert.notEqual((await approve(h.framework, v)).state, "applied"); assert.deepEqual(h.store.getMemoryGraphSettings(), before);
  v = await h.framework.preview(h.session.id, v.id, { expectedRevision: v.revision, values: change, selectedOptionId: "persist" });
  v = await consent(h.framework, v); const result = await approve(h.framework, v); assert.equal(result.state, "applied");
  assert.equal(result.activation.mode, "requires_restart"); assert.equal(result.activation.state, "needs_user_action"); assert.equal(result.resumption.state, "not_requested");
  assert.deepEqual(h.store.getMemoryGraphSettings(), { ...before, ...change }); assert.deepEqual(cipher(h.store), encrypted);
  assert.equal((await approve(h.framework, v)).state, "applied"); assert.deepEqual(cipher(h.store), encrypted);
});

test("CFG-X04d: finite ordinary metadata, global scope and v3 cannot carry credentials or commands", async context => {
  const h = await harness(context); assert.throws(() => h.store.applyMemoryConnectionConfigurationSync(change));
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "memory.connection", values: change }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "memory.connection", values: change, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
  for (const values of [{ neo4jPassword: "ordinary-password" }, { apiToken: "ordinary-password" }, { backend: "local" }, { command: "install" }, { neo4jUser: "" }, { neo4jUser: "user\nheader" }])
    assert.throws(() => h.framework.service.registry.agentValues("memory.connection", values));
});

test("CFG-X04d: URL normalization refuses embedded secrets/custom paths without echoing them", async context => {
  const h = await harness(context);
  for (const url of ["invalid", "file:///private", "https://legacy-user:legacy-password@graph.invalid", "https://graph.invalid/path", "https://graph.invalid?secret=legacy", "https://graph.invalid#secret"])
    assert.throws(() => h.framework.service.registry.agentValues("memory.connection", { neo4jHttp: url }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /legacy-user|legacy-password|secret=legacy|file:\/\/\/private/); return true;
    });
  assert.deepEqual(h.framework.service.registry.agentValues("memory.connection", { neo4jHttp: "HTTPS://OWNED.INVALID:443/", neo4jUser: "  owned-user  " }), { neo4jHttp: "https://owned.invalid", neo4jUser: "owned-user" });
});

test("CFG-X04d: a legacy secret-bearing URL stays out of empty cards and discovery; explicit supported input repairs it", async context => {
  const h = await harness(context); await h.store.updateMemoryGraphSettings({ neo4jHttp: "http://legacy-user:legacy-password@legacy.invalid/path?secret=legacy" });
  let v = await h.propose({}); assert.equal(v.state, "collecting_input"); assert.equal(v.endpointAuthorization, undefined);
  const field = v.fields.find(field => field.id === "neo4jHttp"); assert.ok(field && field.kind === "url"); assert.equal(field.value, "");
  assert.doesNotMatch(JSON.stringify(v), /legacy-user|legacy-password|secret=legacy/);
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "memory.connection" });
  assert.doesNotMatch(JSON.stringify(detail), /legacy-user|legacy-password|secret=legacy/);
  v = await h.framework.preview(h.session.id, v.id, { expectedRevision: v.revision, values: change, selectedOptionId: "persist" });
  v = await consent(h.framework, v); assert.equal((await approve(h.framework, v)).state, "applied"); assert.equal(h.store.getMemoryGraphSettings().neo4jHttp, change.neo4jHttp);
});

test("CFG-X04d: semantically unchanged canonical values create no card; empty input remains editable", async context => {
  const h = await harness(context);
  await assert.rejects(h.propose({ neo4jHttp: "HTTP://127.0.0.1:7474/", neo4jUser: " owned-user " }), { code: "CONFIGURATION_NO_CHANGE" });
  assert.equal(h.framework.service.list(h.session.id).length, 0); const v = await h.propose({}); assert.equal(v.state, "collecting_input");
  assert.equal(v.verificationPlan.maxRequests, 0);
});

test("CFG-X04d: public HTTP cannot be approved or applied; private/HTTPS origins are never implicitly trusted", async context => {
  for (const [url, classification] of [["http://public.invalid", "public_http"], ["http://10.0.0.1:7474", "private_network"], ["https://api.openai.com", "public_https"]] as const) {
    const h = await harness(context), before = h.store.getMemoryGraphSettings(), v = await h.propose({ neo4jHttp: url });
    assert.equal(v.endpointAuthorization?.classification, classification);
    assert.notEqual((await approve(h.framework, v)).state, "applied"); assert.deepEqual(h.store.getMemoryGraphSettings(), before);
    if (classification === "public_http") await assert.rejects(consent(h.framework, v));
  }
});

test("CFG-X04d: adding a stored password invalidates the old approval and requires new explicit recipient consent", async context => {
  const h = await harness(context); let v = await consent(h.framework, await h.propose(change));
  await h.store.updateMemoryGraphSettings({ neo4jPassword: "synthetic-added-after-preview" }); const encrypted = cipher(h.store);
  h.store.getMemoryGraphNeo4jPassword = () => { throw new Error("No old secret read"); };
  await assert.rejects(approve(h.framework, v), { code: "RESOURCE_VERSION_CONFLICT" });
  v = await h.framework.preview(h.session.id, v.id, { expectedRevision: v.revision, values: change, selectedOptionId: "persist" });
  assert.equal(v.endpointAuthorization?.status, "required"); assert.match(v.impact.message, /password is already stored/);
  v = await consent(h.framework, v); assert.equal((await approve(h.framework, v)).state, "applied"); assert.deepEqual(cipher(h.store), encrypted);
});

test("CFG-X04d: concurrent connection/cipher edits fence old confirmation; refusal and Stop preserve current settings", async context => {
  const h = await harness(context); let v = await consent(h.framework, await h.propose(change));
  await h.store.updateMemoryGraphSettings({ neo4jUser: "concurrent-owned-user", neo4jPassword: "synthetic-current" }); const before = h.store.getMemoryGraphSettings(), encrypted = cipher(h.store);
  await assert.rejects(approve(h.framework, v), { code: "RESOURCE_VERSION_CONFLICT" });
  v = await h.framework.preview(h.session.id, v.id, { expectedRevision: v.revision, values: {}, selectedOptionId: "dismiss" });
  await h.framework.decide(h.session.id, v.id, { revision: v.revision, previewDigest: v.previewDigest!, decision: "dismiss", selectedOptionId: "dismiss" });
  v = await consent(h.framework, await h.propose(change)); h.store.notifications.stop(h.session.id); await assert.rejects(approve(h.framework, v));
  assert.deepEqual(h.store.getMemoryGraphSettings(), before); assert.deepEqual(cipher(h.store), encrypted);
});

test("CFG-X04d: receipt failure rolls connection fields back without touching ciphertext", async context => {
  const h = await harness(context); await h.store.updateMemoryGraphSettings({ neo4jPassword: "synthetic-existing" }); const before = h.store.getMemoryGraphSettings(), encrypted = cipher(h.store);
  let v = await consent(h.framework, await h.propose(change)); const db = h.store.getConfigurationDatabase();
  db.exec("CREATE TRIGGER reject_neo4j_connection_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await approve(h.framework, v)).state, "failed"); assert.deepEqual(h.store.getMemoryGraphSettings(), before); assert.deepEqual(cipher(h.store), encrypted);
  db.exec("DROP TRIGGER reject_neo4j_connection_receipt");
  v = await h.framework.preview(h.session.id, v.id, { expectedRevision: v.revision, values: change, selectedOptionId: "persist" });
  assert.equal((await approve(h.framework, v)).state, "applied"); assert.deepEqual(cipher(h.store), encrypted);
});
