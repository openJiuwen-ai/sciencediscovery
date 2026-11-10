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
async function preview(framework: ConversationalConfigurationFramework, view: ConfigurationRequestView) {
  return framework.preview(view.sessionId, view.id, { expectedRevision: view.revision,
    values: framework.service.getRecord(view.sessionId, view.id).input, selectedOptionId: "persist" });
}
const approve = (framework: ConversationalConfigurationFramework, view: ConfigurationRequestView) => framework.decide(view.sessionId, view.id,
  { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply", selectedOptionId: "persist" });

test("CFG-X03b: rename preserves URL, type and routing for all existing proxy kinds", async context => {
  const h = await harness(context);
  for (const kind of ["custom_url", "environment", "system"] as const) {
    const proxy = await h.store.createProxyServer({ name: `Original ${kind}`, kind, ...(kind === "custom_url" ? { url: "https://synthetic:private@proxy.invalid/" } : {}) });
    const before = h.store.getProxySettings();
    const read = h.store.getProxyServerUrl;
    h.store.getProxyServerUrl = () => { throw new Error("Rename must not decrypt URLs"); };
    const card = await h.propose({ proxyId: proxy.id, name: `Renamed ${kind}` });
    assert.equal(card.state, "awaiting_confirmation"); assert.equal(card.scope.kind, "global");
    // The paired Desktop presentation accepts the unreleased v1 contract.
    assert.equal(card.adapterVersion, 1); assert.equal(card.schemaVersion, 1);
    assert.equal(card.autoApplyAt, undefined); assert.equal(card.verificationPlan.maxRequests, 0);
    assert.deepEqual(card.changes.map(change => change.field), ["name"]);
    assert.ok(card.fields.every(field => field.kind !== "credential"));
    // The new UI echoes fixed metadata fields as part of its preview payload.
    const values = Object.fromEntries(card.fields.flatMap(field => field.value !== undefined ? [[field.id, field.value]] : []));
    const reviewed = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values, selectedOptionId: "persist" });
    assert.equal((await approve(h.framework, reviewed)).state, "applied");
    assert.equal((await approve(h.framework, reviewed)).state, "applied");
    h.store.getProxyServerUrl = read;
    const after = h.store.getProxySettings();
    assert.equal(after.defaultPolicy, before.defaultPolicy);
    const saved = after.servers.find(item => item.id === proxy.id)!;
    assert.deepEqual(saved, { ...before.servers.find(item => item.id === proxy.id), name: `Renamed ${kind}`, updatedAt: saved.updatedAt });
  }
});

test("CFG-X03b: removed resource operations and credential inputs are rejected without writes", async context => {
  const h = await harness(context);
  const proxy = await h.store.createProxyServer({ name: "Original", kind: "system" });
  const before = h.store.getProxySettings();
  const unsupported: ConfigurationValues[] = [
    { operation: "create", name: "New", kind: "system" }, { operation: "delete", proxyId: proxy.id },
    { proxyId: proxy.id, kind: "environment" }, { proxyId: proxy.id, replaceUrl: true },
    { proxyId: proxy.id, name: "Renamed", url: "https://proxy.invalid" },
  ];
  for (const values of unsupported) await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  const card = await h.propose({ proxyId: proxy.id, name: "Renamed" });
  await assert.rejects(h.framework.provideCredential(h.session.id, card.id, { expectedRevision: card.revision, fieldId: "proxyUrl", secret: "https://proxy.invalid" }));
  assert.deepEqual(h.store.getProxySettings(), before);
  assert.throws(() => h.framework.service.registry.agentValues("proxy.resources", { proxyId: proxy.id, kind: "system" }));
});

test("CFG-X03b: stale URL generations and receipt failures cannot partially rename resources", async context => {
  const h = await harness(context);
  const proxy = await h.store.createProxyServer({ name: "Original", kind: "custom_url", url: "https://one.invalid" });
  let card = await h.propose({ proxyId: proxy.id, name: "Renamed" });
  await h.store.updateProxyServer(proxy.id, { url: "https://two.invalid" });
  await assert.rejects(approve(h.framework, card), { code: "RESOURCE_VERSION_CONFLICT" });
  card = await preview(h.framework, h.framework.service.get(h.session.id, card.id));
  const database = h.store.getConfigurationDatabase();
  const before = h.store.getProxySettings();
  database.exec("CREATE TRIGGER reject_proxy_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await approve(h.framework, card)).state, "failed");
  assert.deepEqual(h.store.getProxySettings(), before);
  assert.equal(h.framework.repository.getReceipt(card.id), undefined);
  database.exec("DROP TRIGGER reject_proxy_receipt");
  card = await preview(h.framework, h.framework.service.get(h.session.id, card.id));
  assert.equal((await approve(h.framework, card)).state, "applied");
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
