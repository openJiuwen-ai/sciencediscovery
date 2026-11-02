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
const cipher = (store: SessionStore) => store.getConfigurationDatabase().prepare("SELECT model_id,encrypted_token FROM model_secrets ORDER BY model_id").all();
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `model-api-identity-${randomUUID()}`), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const provider = await store.createProvider({ name: "Owned provider", baseUrl: "https://owned-model.invalid/v1", apiProtocol: "openai-chat-completions", apiVariant: "openai", apiToken: "synthetic-provider-key" });
  const model = await store.materializeProviderModel(provider.id, "owned-old-model"), sibling = await store.materializeProviderModel(provider.id, "owned-sibling-model");
  const project = await store.createProject("Model API identity"), session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues = { apiModel: "owned-new-model" }) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "model.api_identity", values: { modelId: model.id, ...values } });
  const consent = (card: ConfigurationRequestView) => framework.confirmEndpoint(session.id, card.id, { revision: card.revision, endpointTarget: card.endpointAuthorization!.endpointTarget });
  return { store, root, provider, model, sibling, project, session, framework, propose, consent };
}
const approve = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const });

test("CFG-X02d: changing API identity reuses no plaintext key and requires exact destination confirmation", async context => {
  const h = await harness(context), before = structuredClone(h.model), ciphertext = cipher(h.store);
  h.store.getModelApiToken = () => { throw new Error("No saved key may be read"); };
  const card = await h.propose(); assert.equal(card.scope.kind, "global"); assert.equal(card.endpointAuthorization?.status, "required");
  assert.deepEqual(h.store.getModel(h.model.id), before); assert.equal(card.verificationPlan.maxRequests, 0); assert.equal(card.verificationPlan.mayCharge, false);
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "ENDPOINT_CONSENT_REQUIRED" });
  assert.deepEqual(h.store.getModel(h.model.id), before);
  await h.consent(card); const applied = await h.framework.decide(h.session.id, card.id, approve(card));
  assert.equal(applied.state, "applied"); assert.equal(h.store.getModel(h.model.id)!.model, "owned-new-model"); assert.deepEqual(cipher(h.store), ciphertext);
});

test("CFG-X02d: exact normalized API fields save once; provider, sibling, metadata, defaults and frozen task stay intact", async context => {
  const h = await harness(context); await h.store.replaceGlobalSettings({});
  const before = structuredClone(h.model), provider = structuredClone(h.provider), sibling = structuredClone(h.sibling), settings = h.store.getGlobalSettings(), ciphertext = cipher(h.store);
  const run = await h.store.createSessionRun({ sessionId: h.session.id, prompt: "Frozen model", settingsSnapshot: h.store.resolveRuntimeSettings(h.session.id).effective });
  const card = await h.propose({ apiModel: "  owned-custom-api  ", apiVariant: "qwen" }); await h.consent(card);
  assert.equal(card.changes.find(change => change.field === "apiModel")!.after, "owned-custom-api");
  const saved = await h.framework.decide(h.session.id, card.id, approve(card)); assert.equal(saved.activation.mode, "next_run");
  const profile = structuredClone(h.store.getModel(h.model.id)!); assert.equal(profile.model, "owned-custom-api"); assert.equal(profile.apiVariant, "qwen");
  for (const field of ["name", "baseUrl", "apiProtocol", "providerId", "proxyPolicy", "vision", "facts", "hasApiToken"] as const) {
    assert.deepEqual(profile[field], before[field]);
  }
  await h.framework.decide(h.session.id, card.id, approve(card)); assert.deepEqual(h.store.getModel(h.model.id), profile);
  assert.deepEqual(h.store.getProvider(h.provider.id), provider); assert.deepEqual(h.store.getModel(h.sibling.id), sibling); assert.deepEqual(h.store.getGlobalSettings(), settings); assert.deepEqual(cipher(h.store), ciphertext);
  assert.deepEqual((await h.store.getSessionRun(h.session.id, run.id))!.settingsSnapshot, run.settingsSnapshot);
});

test("CFG-X02d: selected provider/key rotation invalidates approval while unrelated model edits do not", async context => {
  const h = await harness(context), card = await h.propose(); await h.consent(card);
  await h.store.updateModel(h.sibling.id, { ...h.sibling, name: "Unrelated sibling label" });
  const saved = await h.framework.decide(h.session.id, card.id, approve(card)); assert.equal(saved.state, "applied");
  const next = await h.propose({ apiModel: "owned-second-api" }); await h.consent(next);
  await h.store.updateProvider(h.provider.id, { ...h.provider, apiToken: "synthetic-rotated-provider" });
  await assert.rejects(h.framework.decide(h.session.id, next.id, approve(next)), { code: "RESOURCE_VERSION_CONFLICT" });
  assert.equal(h.store.getModel(h.model.id)!.model, "owned-new-model");
});

test("CFG-X02d: unsupported variants, fields, model IDs and scopes fail without writing; no-change and missing input differ", async context => {
  const h = await harness(context), before = structuredClone(h.model);
  const invalid: ConfigurationValues[] = [{ apiVariant: "responses" }, { apiModel: "" }, { apiModel: "new", baseUrl: "https://evil.invalid" }, { apiModel: "new", apiToken: "not-accepted" }];
  for (const values of invalid) {
    await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  }
  await assert.rejects(h.propose({ modelId: "missing", apiModel: "new" }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "model.api_identity", values: { modelId: h.model.id, apiModel: "new" }, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.propose({ apiModel: h.model.model }), { code: "CONFIGURATION_NO_CHANGE" });
  const card = await h.propose({}); assert.equal(card.state, "collecting_input");
  const empty = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "model.api_identity", values: {} });
  assert.equal(empty.state, "collecting_input"); assert.equal(empty.fields.find(field => field.id === "modelId")?.kind, "enum");
  assert.equal(empty.fields.find(field => field.id === "apiModel")?.required, false, "Browser validation must permit loading the selected profile before editing its identity");
  assert.deepEqual(h.store.getModel(h.model.id), before);
});

test("CFG-X02d: changing the reviewed protocol variant invalidates its exact wire-target consent", async context => {
  const h = await harness(context), card = await h.propose({ apiVariant: "qwen" }); await h.consent(card);
  const edited = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { modelId: h.model.id, apiVariant: "ollama" }, selectedOptionId: "persist" });
  assert.notEqual(edited.endpointAuthorization?.endpointTarget, card.endpointAuthorization?.endpointTarget); assert.equal(edited.endpointAuthorization?.status, "required");
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(edited)), { code: "ENDPOINT_CONSENT_REQUIRED" });
  assert.equal(h.store.getModel(h.model.id)!.apiVariant, "openai");
});

test("CFG-X02d: remote plaintext targets cannot reuse a key; destination edits require new endpoint consent", async context => {
  const h = await harness(context);
  await h.store.updateProvider(h.provider.id, { ...h.provider, baseUrl: "http://untrusted-public.invalid/v1" });
  const blocked = await h.propose(); assert.equal(blocked.endpointAuthorization?.status, "blocked");
  await assert.rejects(h.consent(blocked), { code: "ENDPOINT_CREDENTIAL_INSECURE" });
  await assert.rejects(h.framework.decide(h.session.id, blocked.id, approve(blocked)), { code: "ENDPOINT_CREDENTIAL_INSECURE" }); assert.equal(h.store.getModel(h.model.id)!.model, "owned-old-model");
});

test("CFG-X02d: receipt failure rolls back API fields, refusal/Stop do not save, and formal editor uses the same API field writer", async context => {
  const h = await harness(context), before = structuredClone(h.model), card = await h.propose(); await h.consent(card);
  const save = h.framework.repository.saveReceipt.bind(h.framework.repository); h.framework.repository.saveReceipt = () => { throw new Error("synthetic receipt failure"); };
  const failed = await h.framework.decide(h.session.id, card.id, approve(card)); assert.equal(failed.state, "failed"); assert.equal(failed.error?.code, "CONFIGURATION_APPLY_FAILED");
  h.framework.repository.saveReceipt = save; assert.deepEqual(h.store.getModel(h.model.id), before); assert.equal(h.framework.repository.getReceipt(card.id, card.revision), undefined);
  let dismissed = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" });
  await h.framework.decide(h.session.id, dismissed.id, { ...approve(dismissed), selectedOptionId: "dismiss", decision: "dismiss" });
  dismissed = await h.propose(); await h.consent(dismissed); h.store.notifications.stop(h.session.id); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, dismissed.id).state, "cancelled");
  assert.deepEqual(h.store.getModel(h.model.id), before);
  const formal = await h.store.updateModel(h.model.id, { ...before, model: "formal-new-api", apiVariant: "deepseek" });
  assert.equal(formal.model, "formal-new-api"); assert.equal(formal.apiVariant, "deepseek");
});
