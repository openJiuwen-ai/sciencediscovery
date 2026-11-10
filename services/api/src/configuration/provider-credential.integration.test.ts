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
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "provider-credential-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const provider = await store.createProvider({ name: "Owned provider", baseUrl: "https://owned-initial.invalid/v1", apiToken: "synthetic-old-provider" });
  const other = await store.createProvider({ name: "Other provider", baseUrl: "https://owned-other.invalid/v1", apiToken: "synthetic-other" });
  const child = await store.materializeProviderModel(provider.id, "owned-child", { setGlobalDefault: false }), sibling = await store.materializeProviderModel(provider.id, "owned-sibling", { setGlobalDefault: false });
  await store.updateModel(child.id, { ...child, apiVariant: "qwen", apiToken: "synthetic-override" }); await store.replaceGlobalSettings({});
  const project = await store.createProject("Provider credential"), session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues = {}) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "provider.credential", values: { providerId: provider.id, ...values } });
  const consent = (card: ConfigurationRequestView) => framework.confirmEndpoint(session.id, card.id, { revision: card.revision, endpointTarget: card.endpointAuthorization!.endpointTarget });
  const upload = (card: ConfigurationRequestView) => framework.provideCredential(session.id, card.id, { expectedRevision: card.revision, fieldId: "apiToken", secret: "synthetic-replacement" });
  const prepare = async (card: ConfigurationRequestView) => { await consent(card); const draft = await upload(card); return framework.preview(session.id, card.id, { expectedRevision: card.revision, values: { providerId: provider.id }, credentialHandle: draft.handle, selectedOptionId: "persist" }); };
  return { store, root, provider, other, child, sibling, project, session, framework, propose, consent, upload, prepare };
}

test("CFG-X02f: secrets never belong to Agent values, and every provider recipient is confirmed before secure upload", async context => {
  const h = await harness(context);
  const invalid: ConfigurationValues[] = [{ apiToken: "synthetic-forbidden" }, { tokenOptional: true }, { baseUrl: "https://other.invalid" }, { removeToken: true }];
  for (const values of invalid) await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  const empty = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "provider.credential", values: {} }); assert.equal(empty.state, "collecting_input");
  await assert.rejects(h.upload(empty), { code: "ENDPOINT_CONSENT_REQUIRED" });
  await h.framework.preview(h.session.id, empty.id, { expectedRevision: empty.revision, values: {}, selectedOptionId: "dismiss" });
  const card = await h.propose(); assert.equal(card.endpointAuthorization?.status, "required"); assert.equal(card.scope.kind, "global"); assert.equal(card.verificationPlan.maxRequests, 0);
  assert.ok(card.endpointAuthorization?.destinations?.some(item => item.url.endsWith("/models"))); assert.ok(card.endpointAuthorization?.destinations?.some(item => /qwen/u.test(item.label)));
  await assert.rejects(h.upload(card), { code: "ENDPOINT_CONSENT_REQUIRED" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "ENDPOINT_CONSENT_REQUIRED" });
});

test("CFG-X02f: manual rotation never reads the old key, preserves child overrides/metadata and replay does not rotate twice", async context => {
  const h = await harness(context), defaults = h.store.getGlobalSettings(), before = structuredClone(h.store.configurationProviderConnectionSource(h.provider.id)), ciphers = ciphertext(h.store), readOwnedProvider = h.store.getProviderApiToken.bind(h.store);
  h.store.getProviderApiToken = h.store.getModelApiToken = () => { throw new Error("No old key read"); };
  const card = await h.prepare(await h.propose()); assert.equal(card.state, "awaiting_confirmation"); assert.equal(card.endpointAuthorization?.status, "confirmed");
  assert.ok(!JSON.stringify(card).includes("synthetic-replacement"));
  assert.equal((await h.framework.decide(h.session.id, card.id, approve(card))).state, "applied");
  const next = structuredClone(h.store.configurationProviderConnectionSource(h.provider.id)), saved = ciphertext(h.store);
  assert.equal(readOwnedProvider(h.provider.id), "synthetic-replacement");
  assert.notDeepEqual(saved, ciphers); assert.deepEqual(saved.filter(row => row.model_id === h.child.id), ciphers.filter(row => row.model_id === h.child.id));
  for (const field of ["baseUrl", "name", "apiProtocol", "apiVariant", "modelDiscovery", "proxyPolicy", "tokenOptional"] as const) assert.deepEqual(next.provider?.[field], before.provider?.[field]);
  for (const child of before.children) { const current = next.children.find(item => item.id === child.id)!; for (const field of ["name", "model", "baseUrl", "facts", "apiVariant", "hasApiToken", "proxyPolicy"] as const) assert.deepEqual(current[field], child[field]); }
  assert.deepEqual(h.store.getGlobalSettings(), defaults); await h.framework.decide(h.session.id, card.id, approve(card)); assert.deepEqual(ciphertext(h.store), saved);
  assert.equal(h.framework.credentials.hasDraft(card.id, card.revision, h.provider.id), false);
});

test("CFG-X02f: adding a first provider key updates only effective readiness; independently keyed child stays unchanged", async context => {
  const h = await harness(context); await h.store.updateProvider(h.provider.id, { apiToken: null }); assert.equal(h.store.getModel(h.sibling.id)?.hasApiToken, false); assert.equal(h.store.getModel(h.child.id)?.hasApiToken, true);
  const card = await h.prepare(await h.propose()); await h.framework.decide(h.session.id, card.id, approve(card));
  assert.equal(h.store.getProvider(h.provider.id)?.hasApiToken, true); assert.equal(h.store.getModel(h.sibling.id)?.hasApiToken, true); assert.equal(h.store.getModel(h.child.id)?.hasApiToken, true);
});

test("CFG-X02f: selected connection/children/credentials invalidate approval while unrelated provider editing is isolated", async context => {
  const h = await harness(context); let card = await h.prepare(await h.propose()); await h.store.updateProvider(h.other.id, { name: "Unrelated rename" });
  assert.equal((await h.framework.decide(h.session.id, card.id, approve(card))).state, "applied");
  card = await h.prepare(await h.propose()); await h.store.updateProvider(h.provider.id, { baseUrl: "https://owned-changed.invalid/v1" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { providerId: h.provider.id }, selectedOptionId: "persist" }); assert.equal(card.endpointAuthorization?.status, "required");
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "ENDPOINT_CONSENT_REQUIRED" }); await h.consent(card);
  await h.store.materializeProviderModel(h.provider.id, "concurrent-child", { setGlobalDefault: false }); await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { providerId: h.provider.id }, selectedOptionId: "persist" }); await h.consent(card);
  await h.store.updateProvider(h.provider.id, { apiToken: "synthetic-concurrent-rotation" }); await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "RESOURCE_VERSION_CONFLICT" });
});

test("CFG-X02f: draft is request/target bound and an expired draft cannot authorize a save", async context => {
  const h = await harness(context), card = await h.propose(); await h.consent(card); const draft = await h.upload(card);
  const other = await h.propose({ providerId: h.other.id }); await h.consent(other);
  await assert.rejects(h.framework.preview(h.session.id, other.id, { expectedRevision: other.revision, values: { providerId: h.other.id }, credentialHandle: draft.handle, selectedOptionId: "persist" }));
  await assert.rejects(h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { providerId: h.other.id }, credentialHandle: draft.handle, selectedOptionId: "persist" }), { code: "INVALID_CONFIGURATION_INPUT" });
  h.store.getConfigurationDatabase().prepare("UPDATE configuration_credential_drafts SET expires_at=0 WHERE handle=?").run(draft.handle);
  await assert.rejects(h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { providerId: h.provider.id }, credentialHandle: draft.handle, selectedOptionId: "persist" }), { code: "CREDENTIAL_DRAFT_EXPIRED" });
});

test("CFG-X02f: failed receipt rolls back the encrypted key and readiness; refusal and Stop discard drafts", async context => {
  const h = await harness(context), before = structuredClone(h.store.configurationProviderConnectionSource(h.provider.id)), keys = ciphertext(h.store);
  let card = await h.prepare(await h.propose()); const save = h.framework.repository.saveReceipt.bind(h.framework.repository); h.framework.repository.saveReceipt = () => { throw new Error("synthetic failure"); };
  assert.equal((await h.framework.decide(h.session.id, card.id, approve(card))).state, "failed"); h.framework.repository.saveReceipt = save;
  assert.deepEqual(ciphertext(h.store), keys); assert.deepEqual(h.store.configurationProviderConnectionSource(h.provider.id), before);
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }); await h.framework.decide(h.session.id, card.id, { ...approve(card), decision: "dismiss", selectedOptionId: "dismiss" }); assert.equal(h.framework.credentials.hasDraft(card.id, card.revision, h.provider.id), false);
  card = await h.prepare(await h.propose()); h.store.notifications.stop(h.session.id); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled"); assert.equal(h.framework.credentials.hasDraft(card.id, card.revision, h.provider.id), false); assert.deepEqual(ciphertext(h.store), keys);
});

test("CFG-X02f: presets still require an independent acknowledgement, and remote HTTP blocks even token-optional providers", async context => {
  const h = await harness(context); await h.store.updateProvider(h.provider.id, { baseUrl: "https://api.openai.com/v1", apiVariant: "openai" });
  assert.equal((await h.propose()).endpointAuthorization?.status, "required");
  await h.store.updateProvider(h.provider.id, { baseUrl: "http://owned-public.invalid/v1", tokenOptional: true }); const prior = await h.propose(); const blocked = await h.framework.preview(h.session.id, prior.id, { expectedRevision: prior.revision, values: { providerId: h.provider.id }, selectedOptionId: "persist" }); assert.equal(blocked.endpointAuthorization?.status, "blocked"); await assert.rejects(h.consent(blocked), { code: "ENDPOINT_CREDENTIAL_INSECURE" }); await assert.rejects(h.upload(blocked), { code: "ENDPOINT_CREDENTIAL_INSECURE" });
});
