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
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "provider-connection-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const provider = await store.createProvider({ name: "Owned provider", baseUrl: "https://owned-initial.invalid/v1", apiProtocol: "openai-chat-completions", apiVariant: "openai", apiToken: "synthetic-provider" });
  const other = await store.createProvider({ name: "Unrelated provider", baseUrl: "https://owned-other.invalid/v1", apiToken: "synthetic-other" });
  const child = await store.materializeProviderModel(provider.id, "owned-child", { setGlobalDefault: false }), sibling = await store.materializeProviderModel(provider.id, "owned-sibling", { setGlobalDefault: false });
  await store.updateModel(child.id, { ...child, apiVariant: "qwen", apiToken: "synthetic-child-override" }); await store.replaceGlobalSettings({});
  const project = await store.createProject("Provider connection"), session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues = { baseUrl: "https://owned-new.invalid/gateway" }) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "provider.connection", values: { providerId: provider.id, ...values } });
  const consent = (card: ConfigurationRequestView) => framework.confirmEndpoint(session.id, card.id, { revision: card.revision, endpointTarget: card.endpointAuthorization!.endpointTarget });
  return { store, root, provider, other, child, sibling, project, session, framework, propose, consent };
}
const approve = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const });

test("CFG-X02e: every provider recipient is reviewed before old provider/profile keys can be reused, without decryption", async context => {
  const h = await harness(context), before = structuredClone(h.store.getProvider(h.provider.id)), children = h.store.configurationProviderConnectionSource(h.provider.id).children, ciphers = ciphertext(h.store);
  h.store.getProviderApiToken = h.store.getModelApiToken = () => { throw new Error("No old key may be read"); };
  h.store.getProxyServerUrl = () => { throw new Error("No old proxy URL may be read"); };
  const card = await h.propose(); assert.equal(card.scope.kind, "global"); assert.equal(card.endpointAuthorization?.status, "required");
  const urls = card.endpointAuthorization!.destinations!.map(item => item.url); assert.ok(urls.includes("https://owned-new.invalid/gateway/chat/completions")); assert.ok(urls.includes("https://owned-new.invalid/gateway/models"));
  assert.ok(card.endpointAuthorization!.destinations!.some(item => /qwen/u.test(item.label)), "A child's retained variant belongs to the reviewed target set");
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "ENDPOINT_CONSENT_REQUIRED" });
  assert.deepEqual(h.store.getProvider(h.provider.id), before); await h.consent(card);
  const saved = await h.framework.decide(h.session.id, card.id, approve(card)); assert.equal(saved.state, "applied"); assert.equal(card.verificationPlan.maxRequests, 0);
  assert.equal(h.store.getProvider(h.provider.id)!.baseUrl, "https://owned-new.invalid/gateway"); assert.deepEqual(ciphertext(h.store), ciphers);
  for (const child of children) { assert.equal(h.store.getModel(child.id)!.baseUrl, "https://owned-new.invalid/gateway"); assert.equal(h.store.getModel(child.id)!.apiVariant, child.apiVariant); }
});

test("CFG-X02e: changing protocol resets child variants, lists the actual discovery wire URL and preserves unrelated resources/defaults", async context => {
  const h = await harness(context), other = structuredClone(h.other), beforeChildren = h.store.configurationProviderConnectionSource(h.provider.id).children, defaults = h.store.getGlobalSettings(), ciphers = ciphertext(h.store);
  const card = await h.propose({ apiProtocol: "anthropic-messages", baseUrl: "https://owned-anthropic.invalid/api" }); await h.consent(card);
  assert.ok(card.endpointAuthorization!.destinations!.some(item => item.url === "https://owned-anthropic.invalid/api/v1/models"));
  await h.framework.decide(h.session.id, card.id, approve(card));
  const saved = structuredClone(h.store.getProvider(h.provider.id)!); assert.equal(saved.apiVariant, "anthropic-adaptive"); assert.equal(saved.modelDiscovery, "anthropic-models");
  for (const child of beforeChildren) {
    const next = h.store.getModel(child.id)!; assert.equal(next.apiProtocol, "anthropic-messages"); assert.equal(next.apiVariant, "anthropic-adaptive");
    for (const field of ["name", "model", "facts", "vision", "hasApiToken", "proxyPolicy"] as const) { assert.deepEqual(next[field], child[field]); }
  }
  await h.framework.decide(h.session.id, card.id, approve(card)); assert.deepEqual(h.store.getProvider(h.provider.id), saved);
  assert.deepEqual(h.store.getProvider(h.other.id), other); assert.deepEqual(h.store.getGlobalSettings(), defaults); assert.deepEqual(ciphertext(h.store), ciphers);
});

test("CFG-X02e: a same-family default-variant edit preserves each existing profile variant", async context => {
  const h = await harness(context), before = h.store.configurationProviderConnectionSource(h.provider.id).children;
  const card = await h.propose({ apiVariant: "deepseek" }); await h.consent(card); await h.framework.decide(h.session.id, card.id, approve(card));
  assert.equal(h.store.getProvider(h.provider.id)!.apiVariant, "deepseek");
  for (const child of before) { assert.equal(h.store.getModel(child.id)!.apiVariant, child.apiVariant); }
});

test("CFG-X02e: a trusted model preset cannot bypass shared-provider destination acknowledgement", async context => {
  const h = await harness(context), card = await h.propose({ baseUrl: "https://api.openai.com/v1" });
  assert.equal(card.endpointAuthorization?.classification, "public_https"); assert.equal(card.endpointAuthorization?.status, "required");
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "ENDPOINT_CONSENT_REQUIRED" });
});

test("CFG-X02e: reselecting the same protocol cannot silently reset a custom discovery format or default variant", async context => {
  const h = await harness(context);
  await h.store.updateProvider(h.provider.id, { apiVariant: "deepseek", modelDiscovery: "anthropic-models" });
  await assert.rejects(h.propose({ apiProtocol: "openai-chat-completions" }), { code: "CONFIGURATION_NO_CHANGE" });
  assert.equal(h.store.getProvider(h.provider.id)!.modelDiscovery, "anthropic-models"); assert.equal(h.store.getProvider(h.provider.id)!.apiVariant, "deepseek");
});

test("CFG-X02e: provider/profile key rotations and new children invalidate old approval; unrelated provider changes do not", async context => {
  const h = await harness(context); let card = await h.propose(); await h.consent(card);
  await h.store.updateProvider(h.other.id, { name: "Unrelated rename" }); assert.equal((await h.framework.decide(h.session.id, card.id, approve(card))).state, "applied");
  card = await h.propose({ name: "Selected new name" }); await h.consent(card);
  await h.store.materializeProviderModel(h.provider.id, "concurrently-added", { setGlobalDefault: false });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  let current = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { providerId: h.provider.id, name: "Selected new name" }, selectedOptionId: "persist" });
  assert.equal(current.endpointAuthorization?.status, "required"); await h.consent(current);
  await h.store.updateModel(h.child.id, { ...h.store.getModel(h.child.id)!, apiToken: "synthetic-child-rotated" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(current)), { code: "RESOURCE_VERSION_CONFLICT" });
  current = await h.framework.preview(h.session.id, card.id, { expectedRevision: current.revision, values: { providerId: h.provider.id, name: "Selected new name" }, selectedOptionId: "persist" }); await h.consent(current);
  await h.store.updateProvider(h.provider.id, { apiToken: "synthetic-provider-rotated" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(current)), { code: "RESOURCE_VERSION_CONFLICT" });
});

test("CFG-X02e: empty target loads before browser validation, no-change has no card, arbitrary/secret fields and public HTTP fail closed", async context => {
  const h = await harness(context);
  const empty = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "provider.connection", values: {} }); assert.equal(empty.state, "collecting_input"); assert.equal(empty.fields.find(field => field.id === "baseUrl")?.required, false);
  await assert.rejects(h.propose({ name: h.provider.name }), { code: "CONFIGURATION_NO_CHANGE" });
  const invalid: ConfigurationValues[] = [{ apiToken: "bad" }, { tokenOptional: true }, { proxyPolicy: "none" }, { apiProtocol: "arbitrary" }, { apiVariant: "responses" }];
  for (const values of invalid) { await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" }); }
  await assert.rejects(h.propose({ baseUrl: "https://user:password@owned.invalid/v1" }), { code: "INVALID_CONFIGURATION_URL" });
  const blocked = await h.propose({ baseUrl: "http://remote-public.invalid/v1" }); assert.equal(blocked.endpointAuthorization?.status, "blocked");
  await assert.rejects(h.consent(blocked), { code: "ENDPOINT_CREDENTIAL_INSECURE" }); await assert.rejects(h.framework.decide(h.session.id, blocked.id, approve(blocked)), { code: "ENDPOINT_CREDENTIAL_INSECURE" });
});

test("CFG-X02e: a failed receipt rolls provider and every child back together; refusal and Stop never save", async context => {
  const h = await harness(context), before = h.store.configurationProviderConnectionSource(h.provider.id), ciphers = ciphertext(h.store);
  let card = await h.propose(); await h.consent(card); const write = h.framework.repository.saveReceipt.bind(h.framework.repository);
  h.framework.repository.saveReceipt = () => { throw new Error("synthetic receipt failure"); };
  const failed = await h.framework.decide(h.session.id, card.id, approve(card)); assert.equal(failed.state, "failed"); h.framework.repository.saveReceipt = write;
  assert.deepEqual(h.store.configurationProviderConnectionSource(h.provider.id), before); assert.deepEqual(ciphertext(h.store), ciphers); assert.equal(h.framework.repository.getReceipt(card.id, card.revision), undefined);
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }); await h.framework.decide(h.session.id, card.id, { ...approve(card), decision: "dismiss", selectedOptionId: "dismiss" });
  card = await h.propose(); await h.consent(card); h.store.notifications.stop(h.session.id); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled");
  assert.deepEqual(h.store.configurationProviderConnectionSource(h.provider.id), before);
});
