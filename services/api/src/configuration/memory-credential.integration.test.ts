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
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `configuration-neo4j-password-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  await store.updateMemoryGraphSettings({ enabled: false, backend: "neo4j", neo4jHttp: "http://127.0.0.1:7474", neo4jUser: "owned-user" });
  const project = await store.createProject("Neo4j password"), session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "memory.credential", values });
  return { store, root, session, framework, propose };
}
const approve = (f: ConversationalConfigurationFramework, v: ConfigurationRequestView) => f.decide(v.sessionId, v.id,
  { revision: v.revision, previewDigest: v.previewDigest!, decision: "apply", selectedOptionId: "persist" });
async function consent(f: ConversationalConfigurationFramework, v: ConfigurationRequestView) {
  assert.ok(v.endpointAuthorization);
  return f.confirmEndpoint(v.sessionId, v.id, { revision: v.revision, endpointTarget: v.endpointAuthorization.endpointTarget });
}
async function fill(f: ConversationalConfigurationFramework, v: ConfigurationRequestView, secret = "synthetic-new-password") {
  const draft = await f.provideCredential(v.sessionId, v.id, { expectedRevision: v.revision, fieldId: "apiToken", secret });
  return f.preview(v.sessionId, v.id, { expectedRevision: v.revision, selectedOptionId: "persist", values: { operation: "replace" }, credentialHandle: draft.handle });
}
const cipher = (store: SessionStore) => store.getConfigurationDatabase().prepare("SELECT encrypted_password FROM memory_graph_secret WHERE id=1").get();

test("CFG-X04c: separate exact-target approval precedes encrypted replacement; replay does not encrypt again", async context => {
  const h = await harness(context); await h.store.updateMemoryGraphSettings({ neo4jPassword: "synthetic-old-password" });
  const before = h.store.getMemoryGraphSettings(), encrypted = cipher(h.store), originalRead = h.store.getMemoryGraphNeo4jPassword.bind(h.store);
  h.store.getMemoryGraphNeo4jPassword = () => { throw new Error("Never decrypt an old password for configuration"); };
  let v = await h.propose({ operation: "replace" });
  assert.equal(v.scope.kind, "global"); assert.equal(v.autoApplyAt, undefined); assert.equal(v.endpointAuthorization?.classification, "loopback");
  assert.equal(v.endpointAuthorization?.status, "required"); assert.equal(v.state, "collecting_input");
  await assert.rejects(h.framework.provideCredential(h.session.id, v.id, { expectedRevision: v.revision, fieldId: "apiToken", secret: "synthetic-new-password" }), { code: "ENDPOINT_CONSENT_REQUIRED" });
  v = await consent(h.framework, v); v = await fill(h.framework, v);
  assert.equal(v.state, "awaiting_confirmation"); assert.doesNotMatch(JSON.stringify(v), /synthetic-old-password|synthetic-new-password|owned-user/);
  const result = await approve(h.framework, v); assert.equal(result.state, "applied");
  assert.equal(result.activation.mode, "requires_restart"); assert.equal(result.activation.state, "needs_user_action"); assert.equal(result.resumption.state, "not_requested");
  assert.deepEqual(h.store.getMemoryGraphSettings(), before); assert.notDeepEqual(cipher(h.store), encrypted);
  assert.ok(originalRead() === "synthetic-new-password"); const savedCipher = cipher(h.store);
  assert.equal((await approve(h.framework, v)).state, "applied"); assert.deepEqual(cipher(h.store), savedCipher);
});

test("CFG-X04c: clear is write-only, preserves configuration and stays cleared after reopen", async context => {
  const h = await harness(context); await h.store.updateMemoryGraphSettings({ neo4jPassword: "synthetic-old-password", neo4jHttp: "http://legacy-user:legacy-password@legacy.invalid/path?secret=legacy" });
  const before = h.store.getMemoryGraphSettings(); h.store.getMemoryGraphNeo4jPassword = () => { throw new Error("Clear must not read the password"); };
  const v = await h.propose({ operation: "clear" }); assert.equal(v.endpointAuthorization, undefined);
  assert.equal(v.fields.some(field => field.kind === "credential"), false); assert.match(v.impact.message, /runtime copy/);
  assert.equal((await approve(h.framework, v)).state, "applied");
  assert.deepEqual(h.store.getMemoryGraphSettings(), { ...before, hasNeo4jPassword: false });
  await assert.rejects(h.propose({ operation: "clear" }), { code: "CONFIGURATION_NO_CHANGE" });
  h.store.close(); const reopened = new SessionStore(h.root); await reopened.load();
  assert.deepEqual(reopened.getMemoryGraphSettings(), { ...before, hasNeo4jPassword: false }); reopened.close();
});

test("CFG-X04c: finite ordinary fields/global v3 and empty cards cannot receive a password", async context => {
  const h = await harness(context); assert.throws(() => h.store.applyMemoryCredentialConfigurationSync("synthetic"));
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "memory.credential", values: { operation: "replace" } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "memory.credential", values: { operation: "replace" }, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
  for (const values of [{ apiToken: "ordinary-password" }, { neo4jPassword: "ordinary-password" }, { operation: "install" }, { neo4jHttp: "https://other.invalid" }]) assert.throws(() => h.framework.service.registry.agentValues("memory.credential", values));
  const v = await h.propose({}); assert.equal(v.state, "collecting_input"); assert.equal(v.verificationPlan.maxRequests, 0);
  assert.equal(h.store.getMemoryGraphSettings().hasNeo4jPassword, false);
});

test("CFG-X04c: plaintext public HTTP is blocked; every supported private/HTTPS target requires its own approval", async context => {
  for (const [url, classification] of [["http://public.invalid", "public_http"], ["http://10.0.0.1:7474", "private_network"], ["https://api.openai.com", "public_https"]]) {
    const h = await harness(context); await h.store.updateMemoryGraphSettings({ neo4jHttp: url });
    const v = await h.propose({ operation: "replace" }); assert.equal(v.endpointAuthorization?.classification, classification);
    assert.equal(v.endpointAuthorization?.status, classification === "public_http" ? "blocked" : "required");
    await assert.rejects(h.framework.provideCredential(h.session.id, v.id, { expectedRevision: v.revision, fieldId: "apiToken", secret: "synthetic" }),
      { code: classification === "public_http" ? "ENDPOINT_CREDENTIAL_INSECURE" : "ENDPOINT_CONSENT_REQUIRED" });
  }
});

test("CFG-X04c: unsupported legacy targets reject replacement without exposing their embedded secrets", async context => {
  for (const url of ["invalid", "file:///private", "https://legacy-user:legacy-password@graph.invalid", "https://graph.invalid/path", "https://graph.invalid?secret=legacy", "https://graph.invalid#secret"]) {
    const h = await harness(context); await h.store.updateMemoryGraphSettings({ neo4jHttp: url });
    await assert.rejects(h.propose({ operation: "replace" }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /legacy-user|legacy-password|secret=legacy|file:\/\/\/private/); return true;
    });
  }
});

test("CFG-X04c: formal target/account changes fence old confirmation and discard the old secure draft", async context => {
  const h = await harness(context); let v = await fill(h.framework, await consent(h.framework, await h.propose({ operation: "replace" })));
  const oldEndpoint = v.endpointAuthorization?.endpointTarget;
  await h.store.updateMemoryGraphSettings({ neo4jHttp: "https://replacement.invalid" });
  await assert.rejects(approve(h.framework, v), { code: "RESOURCE_VERSION_CONFLICT" });
  v = await h.framework.preview(h.session.id, v.id, { expectedRevision: v.revision, values: { operation: "replace" }, selectedOptionId: "persist" });
  assert.equal(v.endpointAuthorization?.status, "required"); assert.notEqual(v.endpointAuthorization?.endpointTarget, oldEndpoint);
  assert.equal(v.fields.find(field => field.kind === "credential")?.status, "missing");
  v = await fill(h.framework, await consent(h.framework, v)); const previous = v.endpointAuthorization?.endpointTarget;
  await h.store.updateMemoryGraphSettings({ neo4jUser: "another-owned-user" }); await assert.rejects(approve(h.framework, v), { code: "RESOURCE_VERSION_CONFLICT" });
  v = await h.framework.preview(h.session.id, v.id, { expectedRevision: v.revision, values: { operation: "replace" }, selectedOptionId: "persist" });
  assert.equal(v.endpointAuthorization?.status, "required"); assert.notEqual(v.endpointAuthorization?.endpointTarget, previous);
  assert.equal(v.fields.find(field => field.kind === "credential")?.status, "missing");
});

test("CFG-X04c: formal key rotation fences approval; refusal and Stop preserve the formal credential", async context => {
  const h = await harness(context); let v = await fill(h.framework, await consent(h.framework, await h.propose({ operation: "replace" })));
  await h.store.updateMemoryGraphSettings({ neo4jPassword: "synthetic-formal-rotation" }); const rotated = cipher(h.store);
  await assert.rejects(approve(h.framework, v), { code: "RESOURCE_VERSION_CONFLICT" });
  v = await h.framework.preview(h.session.id, v.id, { expectedRevision: v.revision, values: {}, selectedOptionId: "dismiss" });
  await h.framework.decide(h.session.id, v.id, { revision: v.revision, previewDigest: v.previewDigest!, decision: "dismiss", selectedOptionId: "dismiss" });
  assert.deepEqual(cipher(h.store), rotated);
  v = await fill(h.framework, await consent(h.framework, await h.propose({ operation: "replace" })));
  h.store.notifications.stop(h.session.id); await assert.rejects(approve(h.framework, v)); assert.deepEqual(cipher(h.store), rotated);
});

test("CFG-X04c: receipt failure rolls back ciphertext and an explicit fresh secure retry succeeds", async context => {
  const h = await harness(context); await h.store.updateMemoryGraphSettings({ neo4jPassword: "synthetic-original" }); const before = cipher(h.store);
  let v = await fill(h.framework, await consent(h.framework, await h.propose({ operation: "replace" })));
  const db = h.store.getConfigurationDatabase(); db.exec("CREATE TRIGGER reject_neo4j_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await approve(h.framework, v)).state, "failed"); assert.deepEqual(cipher(h.store), before); assert.equal(h.framework.repository.getReceipt(v.id), undefined);
  db.exec("DROP TRIGGER reject_neo4j_receipt");
  v = await h.framework.preview(h.session.id, v.id, { expectedRevision: v.revision, values: { operation: "replace" }, selectedOptionId: "persist" });
  v = await fill(h.framework, v); assert.equal((await approve(h.framework, v)).state, "applied"); assert.notDeepEqual(cipher(h.store), before);
});

test("CFG-X04c: bilingual discovery projects password presence, not raw URI/account/password or credential schema", async context => {
  const h = await harness(context); await h.store.updateMemoryGraphSettings({ neo4jUser: "private-owned-user", neo4jPassword: "synthetic-private-password" });
  h.store.getMemoryGraphNeo4jPassword = () => { throw new Error("No old password decryption for discovery"); };
  for (const query of ["neo4j password", "记忆图谱密码"]) {
    const search = await discoverConfiguration(h.store, h.session.id, "", "search", { query });
    assert.ok((search.items as Array<{ capabilityId?: string }>).some(item => item.capabilityId === "memory.credential"));
  }
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "memory.credential" });
  assert.deepEqual(Object.keys(detail.fields as object), ["operation"]); assert.deepEqual(detail.scopes, ["global"]);
  assert.doesNotMatch(JSON.stringify(detail), /private-owned-user|synthetic-private-password|http:\/\/127/);
});
