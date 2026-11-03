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
  const parent = resolve(process.cwd(), ".tmp"); const root = resolve(parent, `configuration-proxy-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Proxy resources");
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "proxy.resources", values });
  return { store, session, framework, propose };
}
async function preview(framework: ConversationalConfigurationFramework, view: ConfigurationRequestView, url?: string) {
  const draft = url ? await framework.provideCredential(view.sessionId, view.id, { expectedRevision: view.revision, fieldId: "proxyUrl", secret: url }) : undefined;
  return framework.preview(view.sessionId, view.id, { expectedRevision: view.revision,
    values: framework.service.getRecord(view.sessionId, view.id).input, selectedOptionId: "persist", ...(draft ? { credentialHandle: draft.handle } : {}) });
}
const approve = (framework: ConversationalConfigurationFramework, view: ConfigurationRequestView) => framework.decide(view.sessionId, view.id,
  { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply", selectedOptionId: "persist" });

test("CFG-X03b: secure custom creation is encrypted, global, manual, idempotent and never selects routing", async context => {
  const h = await harness(context); const before = h.store.getProxySettings().defaultPolicy;
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "proxy.resources", values: {} }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "proxy.resources", scope: { kind: "session", id: h.session.id }, values: {} }), { code: "INVALID_CONFIGURATION_SCOPE" });
  assert.throws(() => h.framework.service.registry.agentValues("proxy.resources", { url: "http://secret@proxy.invalid" }));
  let view = await h.propose({ operation: "create", name: "Private proxy", kind: "custom_url" });
  assert.equal(view.state, "collecting_input"); assert.equal(view.scope.kind, "global"); assert.equal(view.autoApplyAt, undefined);
  const url = "https://synthetic-user:synthetic-password@proxy.invalid:8443/";
  view = await preview(h.framework, view, url);
  assert.equal(view.state, "awaiting_confirmation"); assert.equal(view.activation.mode, "next_connection");
  assert.equal(view.verificationPlan.maxRequests, 0); assert.doesNotMatch(JSON.stringify(view), /synthetic-password|synthetic-user|proxy\.invalid/);
  assert.doesNotMatch(JSON.stringify(h.store.getConfigurationDatabase().prepare("SELECT * FROM configuration_credential_drafts").all()), /synthetic-password/);
  const applied = await approve(h.framework, view); assert.equal(applied.state, "applied");
  assert.equal(applied.activation.state, "needs_user_action");
  const server = h.store.configurationProxyResources().find(item => item.name === "Private proxy")!;
  assert.equal(h.store.getProxyServerUrl(server.id), url); assert.equal(h.store.getProxySettings().defaultPolicy, before);
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal(h.store.configurationProxyResources().filter(item => item.name === "Private proxy").length, 1);
  assert.doesNotMatch(JSON.stringify(h.store.getConfigurationDatabase().prepare("SELECT * FROM proxy_server_secrets").all()), /synthetic-password/);
});

test("CFG-X03b: metadata update does not decrypt a URL; type changes erase it and custom replacement uses the secure channel", async context => {
  const h = await harness(context); const server = await h.store.createProxyServer({ name: "Original", kind: "custom_url", url: "http://old-secret@proxy.invalid:80/" });
  const originalRead = h.store.getProxyServerUrl;
  h.store.getProxyServerUrl = () => { throw new Error("Do not decrypt for metadata updates"); };
  let view = await h.propose({ operation: "update", proxyId: server.id, name: "Renamed" });
  assert.ok(view.fields.every(field => field.kind !== "credential"));
  assert.equal((await approve(h.framework, await preview(h.framework, view))).state, "applied");
  h.store.getProxyServerUrl = originalRead;
  assert.equal(h.store.getProxyServerUrl(server.id), "http://old-secret@proxy.invalid/");
  view = await h.propose({ operation: "update", proxyId: server.id, kind: "system" });
  assert.equal((await approve(h.framework, await preview(h.framework, view))).state, "applied");
  assert.equal(h.store.getProxyServerUrl(server.id), undefined);
  view = await h.propose({ operation: "update", proxyId: server.id, kind: "custom_url" });
  assert.equal(view.state, "collecting_input");
  assert.equal((await approve(h.framework, await preview(h.framework, view, "socks5://replacement:secret@proxy.invalid:1080"))).state, "applied");
  assert.equal(h.store.getProxyServerUrl(server.id), "socks5://replacement:secret@proxy.invalid:1080");
});

test("CFG-X03b: changing proxy, type, or replacement intent cannot transfer a secure URL draft", async context => {
  const h = await harness(context);
  const a = await h.store.createProxyServer({ name: "A", kind: "custom_url", url: "http://a.invalid" });
  const b = await h.store.createProxyServer({ name: "B", kind: "custom_url", url: "http://b.invalid" });
  let view = await h.propose({ operation: "update", proxyId: a.id, replaceUrl: true });
  await assert.rejects(h.framework.provideCredential(h.session.id, view.id, { expectedRevision: view.revision, fieldId: "apiToken", secret: "wrong-field" }));
  const draft = await h.framework.provideCredential(h.session.id, view.id, { expectedRevision: view.revision, fieldId: "proxyUrl", secret: "http://private.invalid" });
  await assert.rejects(h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { operation: "update", proxyId: b.id, replaceUrl: true }, credentialHandle: draft.handle }));
  const oldIdentity = view.credentialTargetDigest;
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { operation: "update", proxyId: b.id, replaceUrl: true } });
  assert.equal(view.state, "collecting_input"); assert.notEqual(view.credentialTargetDigest, oldIdentity);
  await assert.rejects(h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { operation: "update", proxyId: b.id, replaceUrl: true }, credentialHandle: draft.handle }));
  assert.equal(h.store.getProxyServerUrl(a.id), "http://a.invalid/"); assert.equal(h.store.getProxyServerUrl(b.id), "http://b.invalid/");
});

test("CFG-X03b: invalid URLs fail without echoing secrets, and corrected drafts can be reviewed again", async context => {
  const h = await harness(context); let view = await h.propose({ name: "Correctable", kind: "custom_url" });
  view = await preview(h.framework, view, "ftp://user:secret@bad.invalid/#private");
  view = await approve(h.framework, view);
  assert.equal(view.state, "needs_fix"); assert.equal(view.error?.code, "INVALID_PROXY_URL");
  assert.doesNotMatch(JSON.stringify(view), /user:secret|bad\.invalid|#private/);
  assert.equal(h.store.configurationProxyResources().some(item => item.name === "Correctable"), false);
  view = await preview(h.framework, view, "https://proxy.invalid:443");
  assert.equal((await approve(h.framework, view)).state, "applied");
});

test("CFG-X03b: encrypted URL generations and routing references invalidate stale approvals", async context => {
  const h = await harness(context); const proxy = await h.store.createProxyServer({ name: "CAS", kind: "custom_url", url: "http://one.invalid" });
  let view = await preview(h.framework, await h.propose({ operation: "update", proxyId: proxy.id, name: "Stale rename" }));
  await h.store.updateProxyServer(proxy.id, { url: "http://two.invalid" });
  await assert.rejects(approve(h.framework, view), { code: "RESOURCE_VERSION_CONFLICT" });
  assert.equal(h.store.configurationProxyResources().find(item => item.id === proxy.id)?.name, "CAS");
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { operation: "delete", proxyId: proxy.id } });
  await h.store.updateProxySettings({ defaultPolicy: `proxy:${proxy.id}` });
  await assert.rejects(approve(h.framework, view), { code: "RESOURCE_VERSION_CONFLICT" });
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { operation: "delete", proxyId: proxy.id } });
  const blocked = await approve(h.framework, view); assert.equal(blocked.state, "failed");
  assert.ok(h.store.configurationProxyResources().some(item => item.id === proxy.id));
  assert.equal(h.framework.repository.getReceipt(view.id, view.revision), undefined);
  await h.store.updateProxySettings({ defaultPolicy: "none" });
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: blocked.revision, selectedOptionId: "persist", values: { operation: "delete", proxyId: proxy.id } });
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal(h.store.getProxyServerUrl(proxy.id), undefined);
});

test("CFG-X03b: refusal, Stop, empty cards and explicit no-change never write shared resources", async context => {
  const h = await harness(context); let view = await h.propose({}); assert.equal(view.state, "collecting_input");
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: {}, selectedOptionId: "dismiss" });
  assert.equal((await h.framework.decide(h.session.id, view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "dismiss", selectedOptionId: "dismiss" })).state, "dismissed");
  const proxy = await h.store.createProxyServer({ name: "Unchanged", kind: "system" });
  view = await h.propose({ operation: "update", proxyId: proxy.id }); assert.equal(view.state, "collecting_input");
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: { operation: "update", proxyId: proxy.id, name: "Unchanged" }, selectedOptionId: "persist" });
  assert.equal(view.state, "collecting_input"); assert.deepEqual(view.changes, []);
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: { operation: "update", proxyId: proxy.id, name: "Must not write" }, selectedOptionId: "persist" });
  h.store.notifications.stop(h.session.id);
  await assert.rejects(approve(h.framework, view));
  assert.equal(h.store.configurationProxyResources().find(item => item.id === proxy.id)?.name, "Unchanged");
});

test("CFG-X03b: English and Chinese discovery expose bounded metadata without decrypting URLs or reading environment proxies", async context => {
  const h = await harness(context); await h.store.createProxyServer({ name: "Research proxy", kind: "custom_url", url: "https://synthetic:private@secret.invalid" });
  h.store.getProxySettings = () => { throw new Error("Do not read authenticated proxy settings"); };
  h.store.getProxyServerUrl = () => { throw new Error("Do not decrypt URLs"); };
  for (const query of ["proxy", "代理"]) {
    const found = await discoverConfiguration(h.store, h.session.id, "", "search", { query });
    assert.ok((found.items as Array<{ capabilityId?: string }>).some(item => item.capabilityId === "proxy.resources"));
  }
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "proxy.resources" });
  assert.deepEqual(detail.scopes, ["global"]); assert.doesNotMatch(JSON.stringify(detail), /synthetic|secret\.invalid|encrypted_url/);
});

test("CFG-X03b: receipt failure rolls back proxy metadata and encrypted URL together; retry creates exactly one resource", async context => {
  const h = await harness(context); const database = h.store.getConfigurationDatabase();
  const before = h.store.configurationProxyResources();
  let view = await preview(h.framework, await h.propose({ operation: "create", name: "Rollback", kind: "custom_url" }), "https://synthetic:private@proxy.invalid");
  const secrets = database.prepare("SELECT * FROM proxy_server_secrets ORDER BY server_id").all();
  database.exec("CREATE TRIGGER reject_proxy_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await approve(h.framework, view)).state, "failed");
  assert.deepEqual(h.store.configurationProxyResources(), before);
  assert.deepEqual(database.prepare("SELECT * FROM proxy_server_secrets ORDER BY server_id").all(), secrets);
  assert.equal(h.framework.repository.getReceipt(view.id), undefined);
  database.exec("DROP TRIGGER reject_proxy_receipt");
  view = await preview(h.framework, h.framework.service.get(h.session.id, view.id));
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal(h.store.configurationProxyResources().filter(item => item.name === "Rollback").length, 1);
});
