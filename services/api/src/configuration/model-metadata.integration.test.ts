// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function fixture(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "model-metadata-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const provider = await store.createProvider({ name: "Owned provider", baseUrl: "https://owned-private.invalid/v1", apiProtocol: "openai-chat-completions", apiVariant: "openai", apiToken: "synthetic-old-key" });
  const model = await store.materializeProviderModel(provider.id, "owned-model", { setGlobalDefault: false, facts: { contextWindow: 4096, maxOutputTokens: 1024, pricing: { currency: "USD", input: 1.5, output: 3 } } });
  const other = await store.materializeProviderModel(provider.id, "owned-other", { setGlobalDefault: false }); const project = await store.createProject("Metadata"), session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "model.metadata", values });
  const approval = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const });
  return { store, model, other, provider, session, project, framework, propose, approval };
}
const cipher = (store: SessionStore) => store.getConfigurationDatabase().prepare("SELECT model_id,encrypted_token FROM model_secrets ORDER BY model_id").all();
test("CFG-X11a: manual metadata patch preserves connection, old ciphertext, other resources and an unset task default", async context => {
  const h = await fixture(context), before = structuredClone(h.model), other = structuredClone(h.other), provider = structuredClone(h.provider), secrets = cipher(h.store); let writes = 0;
  h.store.getModelApiToken = () => { throw Error("Old model key access forbidden"); }; h.store.getProviderApiToken = () => { throw Error("Old provider key access forbidden"); };
  const apply = h.store.applyModelMetadataConfigurationSync.bind(h.store); h.store.applyModelMetadataConfigurationSync = (...args) => { writes++; apply(...args); };
  const card = await h.propose({ modelId: h.model.id, operation: "update", name: "Owned renamed", vision: true, contextWindow: 8192, priceInput: "0.25" });
  assert.deepEqual(h.store.getModel(h.model.id), before); assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined);
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "applied"); await h.framework.decide(h.session.id, card.id, h.approval(card)); assert.equal(writes, 1);
  const saved = h.store.getModel(h.model.id)!; assert.equal(saved.name, "Owned renamed"); assert.equal(saved.vision, true); assert.equal(saved.facts?.contextWindow, 8192); assert.equal(saved.facts?.maxOutputTokens, 1024); assert.deepEqual(saved.facts?.pricing, { currency: "USD", input: 0.25, output: 3 });
  for (const field of ["baseUrl", "apiProtocol", "apiVariant", "model", "providerId", "proxyPolicy", "hasApiToken"] as const) assert.deepEqual(saved[field], before[field]);
  assert.deepEqual(h.store.getModel(h.other.id), other); assert.deepEqual(h.store.getProvider(h.provider.id), provider); assert.deepEqual(cipher(h.store), secrets); assert.equal(h.store.getGlobalSettings().overrides.modelId, undefined);
});
test("CFG-X11a: clear facts removes all overrides and ignores prior card edit fields while retaining name and vision", async context => {
  const h = await fixture(context), before = structuredClone(h.model); const card = await h.propose({ modelId: h.model.id, operation: "clear_facts", name: "Ignored old draft", vision: true, contextWindow: 8000 });
  assert.deepEqual(card.fields.map(field => field.id), ["modelId", "operation"]); assert.ok(card.changes.some(change => change.field === "contextWindow"));
  await h.framework.decide(h.session.id, card.id, h.approval(card)); const saved = h.store.getModel(h.model.id)!; assert.equal(saved.facts, undefined); assert.equal(saved.name, before.name); assert.equal(saved.vision, before.vision);
  await assert.rejects(h.propose({ modelId: h.model.id, operation: "clear_facts" }), { code: "CONFIGURATION_NO_CHANGE" });
});
test("CFG-X11a: finite fields, positive tokens, decimal price and owned global v3 scope are enforced", async context => {
  const h = await fixture(context); assert.equal((await h.propose({})).state, "collecting_input"); assert.equal((await h.propose({ modelId: h.model.id })).state, "collecting_input");
  const invalid: ConfigurationValues[] = [{ modelId: h.model.id, contextWindow: 0 }, { modelId: h.model.id, maxOutputTokens: 1.5 }, { modelId: h.model.id, priceInput: "-1" }, { modelId: h.model.id, priceInput: "Infinity" }, { modelId: h.model.id, thinkingEfforts: ["invented"] }, { modelId: h.model.id, apiToken: "synthetic-forbidden" }, { modelId: h.model.id, baseUrl: "https://unknown.invalid" }];
  for (const values of invalid) await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.propose({ modelId: h.other.id, priceInput: "1.5" }), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.propose({ modelId: "missing", name: "Unknown" }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "model.metadata", values: {} }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "model.metadata", values: {}, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
});
test("CFG-X11a: selected credential generation invalidates approval but unrelated model metadata is preserved", async context => {
  const h = await fixture(context); let card = await h.propose({ modelId: h.model.id, name: "Selected new name" }); await h.store.updateProvider(h.provider.id, { apiToken: "synthetic-rotation" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { modelId: h.model.id, name: "Selected new name" }, selectedOptionId: "persist" });
  await h.store.updateModel(h.other.id, { ...h.other, name: "Other renamed" });
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "applied"); assert.equal(h.store.getModel(h.other.id)?.name, "Other renamed");
});
test("CFG-X11a: a failed receipt rolls model metadata back with no key or default changes", async context => {
  const h = await fixture(context), before = structuredClone(h.model), secrets = cipher(h.store), card = await h.propose({ modelId: h.model.id, name: "Rollback target", priceInput: "0" }); const db = h.store.getConfigurationDatabase();
  db.exec("CREATE TRIGGER reject_model_metadata_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "failed"); assert.deepEqual(h.store.getModel(h.model.id), before); assert.deepEqual(cipher(h.store), secrets); assert.equal(h.store.getGlobalSettings().overrides.modelId, undefined); assert.equal(h.framework.repository.getReceipt(card.id), undefined); db.exec("DROP TRIGGER reject_model_metadata_receipt");
});
test("CFG-X11a: refusal and Stop preserve metadata and safe discovery excludes endpoints and credentials", async context => {
  const h = await fixture(context); const described = await discoverConfiguration(h.store, h.session.id, "owned-no-run", "describe", { capabilityId: "model.metadata", targetId: h.model.id }); const raw = JSON.stringify(described); assert.ok(raw.includes(h.model.id)); assert.ok(!raw.includes("owned-private.invalid")); assert.ok(!raw.includes("synthetic-old-key"));
  let card = await h.propose({ modelId: h.model.id, name: "Refused name" }); card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" });
  assert.equal((await h.framework.decide(h.session.id, card.id, { ...h.approval(card), selectedOptionId: "dismiss", decision: "dismiss" })).state, "dismissed");
  card = await h.propose({ modelId: h.model.id, name: "Stopped name" }); h.store.notifications.stop(h.session.id); await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card))); assert.equal(h.store.getModel(h.model.id)?.name, h.model.name);
});
