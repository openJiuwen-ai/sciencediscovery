// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
const ciphertext = (store: SessionStore) => store.getConfigurationDatabase().prepare("SELECT model_id,encrypted_token FROM model_secrets ORDER BY model_id").all();
const approve = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "provider-key-removal-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const provider = await store.createProvider({ name: "Owned provider", baseUrl: "https://owned-initial.invalid/v1", apiToken: "synthetic-old-provider" });
  const other = await store.createProvider({ name: "Other provider", baseUrl: "https://owned-other.invalid/v1", apiToken: "synthetic-other" });
  const child = await store.materializeProviderModel(provider.id, "owned-child", { setGlobalDefault: false }), sibling = await store.materializeProviderModel(provider.id, "owned-sibling", { setGlobalDefault: false });
  await store.updateModel(child.id, { ...child, apiVariant: "qwen", apiToken: "synthetic-override" }); await store.replaceGlobalSettings({});
  const project = await store.createProject("Provider key removal"), session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues = {}) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "provider.remove_credential", values: { providerId: provider.id, ...values } });

  return { store, root, provider, other, child, sibling, project, session, framework, propose };
}

test("CFG-X02g: dedicated v3 manual removal exposes the token-free consequence and never accepts a secret", async context => {
  const h = await harness(context), invalid: ConfigurationValues[] = [{ apiToken: "synthetic-forbidden" }, { tokenOptional: true }, { baseUrl: "https://other.invalid" }, { script: "anything" }];
  for (const values of invalid) await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "provider.remove_credential", values: { providerId: h.provider.id } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  const card = await h.propose(); assert.equal(card.scope.kind, "global"); assert.equal(card.verificationPlan.maxRequests, 0); assert.equal(card.endpointAuthorization, undefined); assert.equal(card.fields.some(field => field.kind === "credential"), false);
  assert.match(card.impact.message, /unauthenticated|fail/u); assert.match(card.changes[0]?.after ?? "", /token-free/u);
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card), undefined, "auto"), { code: "CONFIGURATION_AUTO_NOT_AUTHORIZED" });
  await assert.rejects(h.framework.provideCredential(h.session.id, card.id, { expectedRevision: card.revision, fieldId: "apiToken", secret: "synthetic-forbidden" }), { code: "INVALID_CONFIGURATION_INPUT" });
});

test("CFG-X02g: removing a shared key changes inherited readiness and preserves child ciphertext/metadata/defaults without old-key reads", async context => {
  const h = await harness(context), before = structuredClone(h.store.configurationProviderConnectionSource(h.provider.id)), keys = ciphertext(h.store), defaults = h.store.getGlobalSettings();
  h.store.getProviderApiToken = h.store.getModelApiToken = () => { throw new Error("No old key may be read"); };
  const card = await h.propose(); assert.equal((await h.framework.decide(h.session.id, card.id, approve(card))).state, "applied");
  const saved = structuredClone(h.store.configurationProviderConnectionSource(h.provider.id)), afterKeys = ciphertext(h.store);
  assert.equal(saved.provider?.hasApiToken, false); assert.equal(h.store.getModel(h.child.id)?.hasApiToken, true); assert.equal(h.store.getModel(h.sibling.id)?.hasApiToken, false); assert.equal(h.store.modelAllowsMissingToken(h.store.getModel(h.sibling.id)!), true);
  assert.equal(afterKeys.length, keys.length - 1); for (const id of [h.child.id, h.sibling.id]) assert.deepEqual(afterKeys.filter(row => row.model_id === id), keys.filter(row => row.model_id === id));
  for (const field of ["name", "baseUrl", "apiProtocol", "apiVariant", "modelDiscovery", "proxyPolicy", "tokenOptional"] as const) assert.deepEqual(saved.provider?.[field], before.provider?.[field]);
  for (const old of before.children) { const next = saved.children.find(model => model.id === old.id)!; for (const field of ["name", "model", "baseUrl", "facts", "apiVariant", "proxyPolicy"] as const) assert.deepEqual(next[field], old[field]); }
  assert.deepEqual(h.store.getGlobalSettings(), defaults); assert.equal(h.framework.repository.getReceipt(card.id, card.revision)?.result.reversal, undefined);
  await h.framework.decide(h.session.id, card.id, approve(card)); assert.deepEqual(ciphertext(h.store), afterKeys); assert.deepEqual(h.store.configurationProviderConnectionSource(h.provider.id), saved);
});

test("CFG-X02g: receipt failure restores key and readiness; refusal and Stop never remove the key", async context => {
  const h = await harness(context), before = structuredClone(h.store.configurationProviderConnectionSource(h.provider.id)), keys = ciphertext(h.store); let card = await h.propose();
  const write = h.framework.repository.saveReceipt.bind(h.framework.repository); h.framework.repository.saveReceipt = () => { throw new Error("synthetic receipt failure"); };
  assert.equal((await h.framework.decide(h.session.id, card.id, approve(card))).state, "failed"); h.framework.repository.saveReceipt = write;
  assert.deepEqual(h.store.configurationProviderConnectionSource(h.provider.id), before); assert.deepEqual(ciphertext(h.store), keys);
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }); await h.framework.decide(h.session.id, card.id, { ...approve(card), decision: "dismiss", selectedOptionId: "dismiss" }); assert.deepEqual(ciphertext(h.store), keys);
  card = await h.propose(); h.store.notifications.stop(h.session.id); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled"); assert.deepEqual(ciphertext(h.store), keys);
});

test("CFG-X02g: selected credential rotation/new children invalidate removal while unrelated provider changes do not", async context => {
  const h = await harness(context); let card = await h.propose(); await h.store.updateProvider(h.provider.id, { apiToken: "synthetic-concurrent" }); await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { providerId: h.provider.id }, selectedOptionId: "persist" }); await h.store.materializeProviderModel(h.provider.id, "concurrent-child", { setGlobalDefault: false }); await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { providerId: h.provider.id }, selectedOptionId: "persist" }); await h.store.updateProvider(h.other.id, { name: "Unrelated rename" }); assert.equal((await h.framework.decide(h.session.id, card.id, approve(card))).state, "applied");
});

test("CFG-X02g: missing resource is unavailable and an already absent shared key is no-change rather than an actionable card", async context => {
  const h = await harness(context); await assert.rejects(h.propose({ providerId: "missing" }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
  const empty = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "provider.remove_credential", values: {} }); assert.equal(empty.state, "collecting_input");
  await h.store.updateProvider(h.provider.id, { apiToken: null }); await assert.rejects(h.propose(), { code: "CONFIGURATION_NO_CHANGE" });
});

test("CFG-X02g: remote plaintext HTTP does not block safe key removal because no credential is sent", async context => {
  const h = await harness(context); await h.store.updateProvider(h.provider.id, { baseUrl: "http://owned-public.invalid/v1" }); const card = await h.propose(); assert.equal(card.endpointAuthorization, undefined);
  assert.equal((await h.framework.decide(h.session.id, card.id, approve(card))).state, "applied"); assert.equal(h.store.getProvider(h.provider.id)?.hasApiToken, false);
});
