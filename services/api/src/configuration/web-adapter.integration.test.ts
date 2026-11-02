// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { configurationFramework, type ConversationalConfigurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function harness(context: { after(action: () => Promise<void>): void }, nativeExecutor = true) {
  const parent = resolve(process.cwd(), ".tmp"); const root = resolve(parent, `configuration-web-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(`${parent}${sep}`)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Web settings");
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor, connector: () => undefined });
  const propose = (values: Record<string, string | number | boolean | string[]>) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "web.configure", values });
  return { store, root, session, framework, propose };
}
async function decide(framework: ConversationalConfigurationFramework, view: ConfigurationRequestView, option = "persist") {
  const preview = await framework.preview(view.sessionId, view.id, { expectedRevision: view.revision, values: framework.service.getRecord(view.sessionId, view.id).input, selectedOptionId: option });
  const input = { revision: preview.revision, previewDigest: preview.previewDigest!, decision: option === "persist" ? "apply" as const : "dismiss" as const, selectedOptionId: option };
  return { view: await framework.decide(view.sessionId, view.id, input), input };
}

test("CFG-X02: bounded discovery and an empty card reveal supported fields without secrets or writes", async context => {
  const h = await harness(context);
  await h.store.updateWebSettings({ providerApiKeys: { tavily: "synthetic-web-secret" } });
  await h.store.createProxyServer({ name: "Fixture", kind: "custom_url", url: "http://fixture:synthetic-proxy-secret@127.0.0.1:9" });
  const before = h.store.getWebSettings();
  const found = await discoverConfiguration(h.store, h.session.id, "", "search", { query: "网页搜索缓存" });
  assert.ok((found.items as Array<{ capabilityId?: string }>).some(item => item.capabilityId === "web.configure"));
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "web.configure" });
  assert.doesNotMatch(JSON.stringify(detail), /synthetic-web-secret|synthetic-proxy-secret|127\.0\.0\.1/);
  assert.equal((detail.current as { backend: string }).backend, "native");
  const card = await h.propose({});
  assert.equal(card.scope.kind, "global"); assert.equal(card.state, "collecting_input");
  assert.ok(card.fields.some(field => field.id === "freeSearchEngines" && field.kind === "multiselect"));
  assert.equal(card.verificationPlan.maxRequests, 0);
  assert.deepEqual(h.store.getWebSettings(), before);
});

test("CFG-X02: partial confirmed settings persist, preserve keys, canonicalize order and replay idempotently", async context => {
  const h = await harness(context);
  await h.store.updateWebSettings({ providerApiKeys: { exa: "synthetic-preserved-key" } });
  const before = h.store.getWebSettings();
  assert.throws(() => h.store.applyWebConfigurationSync({ searchCacheTtlSeconds: 0 }), /shared transaction/);
  const card = await h.propose({ searchCacheTtlSeconds: 0, freeSearchEngines: ["bing", "duckduckgo"], paidSearchProviders: ["exa", "tavily"] });
  assert.deepEqual(h.framework.service.getRecord(h.session.id, card.id).input.paidSearchProviders, ["tavily", "exa"]);
  assert.deepEqual(h.store.getWebSettings(), before);
  const applied = await decide(h.framework, card);
  assert.equal(applied.view.state, "applied"); assert.equal(applied.view.activation.state, "needs_user_action");
  const receipt = h.framework.repository.getReceipt(card.id, applied.view.revision);
  assert.equal((await h.framework.decide(h.session.id, card.id, applied.input)).state, "applied");
  assert.deepEqual(h.framework.repository.getReceipt(card.id, applied.view.revision), receipt);
  const saved = h.store.getWebSettings();
  assert.equal(saved.searchCacheTtlSeconds, 0); assert.equal(saved.fetchCacheTtlSeconds, before.fetchCacheTtlSeconds);
  assert.equal(saved.fetchProvider, before.fetchProvider); assert.equal(saved.freeSearchEngines["brave-html"], false);
  assert.equal(h.store.getWebProviderApiKey("exa"), "synthetic-preserved-key");
  const reopened = new SessionStore(h.root); await reopened.load();
  try { assert.deepEqual(reopened.getWebSettings(), saved); } finally { reopened.close(); }
});

test("CFG-X02: invalid fields, scope, credentials, duplicate engines and TTLs reject before persistence", async context => {
  const h = await harness(context); const before = h.store.getWebSettings();
  const invalid: Array<Record<string, string | number | boolean | string[]>> = [{ apiToken: "forbidden" }, { proxyPolicy: "http://127.0.0.1" }, { proxyPolicy: "proxy:missing" }, { searchCacheTtlSeconds: 2_592_001 }, { fetchCacheTtlSeconds: 0.1 }, { freeSearchEngines: ["bing", "bing"] }, { paidSearchProviders: ["bocha"] }, { deepseekEnabled: "yes" }];
  for (const values of invalid) await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "web.configure", values: { fetchProvider: "exa" }, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "web.configure", values: {} }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  assert.deepEqual(h.store.getWebSettings(), before);
});

test("CFG-X02: Swarm supports only its matrix, preserves Native selections, and reports restart instead of activation", async context => {
  const h = await harness(context, false);
  await h.store.updateWebSettings({ fetchProvider: "exa" });
  const before = h.store.getWebSettings();
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "web.configure" });
  assert.ok(!("searchCacheTtlSeconds" in (detail.fields as object)));
  const invalid: Array<Record<string, string | number | boolean | string[]>> = [{ searchCacheTtlSeconds: 1 }, { fetchProvider: "exa" }, { freeSearchEngines: ["brave-html"] }, { paidSearchProviders: ["tavily"] }, { proxyPolicy: "none" }];
  for (const values of invalid) {
    await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  }
  const card = await h.propose({ freeSearchEngines: ["bing"], paidSearchProviders: [], deepseekEnabled: false, fetchProvider: "jina" });
  assert.equal(card.activation.mode, "requires_restart"); assert.match(card.impact.message, /remote activation is not verified/);
  const applied = await decide(h.framework, card);
  assert.equal(applied.view.activation.state, "needs_user_action");
  const saved = h.store.getWebSettings(); assert.equal(saved.freeSearchEngines.duckduckgo, false);
  assert.equal(saved.fetchProvider, "exa", "The unchanged Swarm default must not erase a Native-only fetch selection");
  assert.equal(saved.freeSearchEngines["brave-html"], before.freeSearchEngines["brave-html"]);
  assert.deepEqual(saved.paidSearchProviders, before.paidSearchProviders.filter(id => id !== "deepseek"));
});

test("CFG-X02: unchanged settings and dismissal do not mutate formal state", async context => {
  const h = await harness(context); const before = h.store.getWebSettings();
  await assert.rejects(h.propose({ fetchProvider: before.fetchProvider }), { code: "CONFIGURATION_NO_CHANGE" });
  const card = await h.propose({ searchCacheTtlSeconds: 5 });
  await decide(h.framework, card, "dismiss"); assert.deepEqual(h.store.getWebSettings(), before);
});

test("CFG-X02: formal settings, ciphertext generations, proxy state and backend changes invalidate old approvals", async context => {
  for (const kind of ["settings", "credential", "proxy", "backend"]) {
    const h = await harness(context);
    const card = await h.propose({ searchCacheTtlSeconds: 4 });
    if (kind === "settings") await h.store.updateWebSettings({ fetchCacheTtlSeconds: 3 });
    if (kind === "credential") await h.store.updateWebSettings({ providerApiKeys: { exa: "synthetic-rotated-key" } });
    if (kind === "proxy") await h.store.createProxyServer({ name: "new", kind: "environment" });
    if (kind === "backend") h.framework.options = { ...h.framework.options, nativeExecutor: false };
    const afterConcurrent = h.store.getWebSettings();
    await assert.rejects(h.framework.decide(h.session.id, card.id, { revision: card.revision, previewDigest: card.previewDigest!, decision: "apply", selectedOptionId: "persist" }), { code: "RESOURCE_VERSION_CONFLICT" });
    assert.deepEqual(h.store.getWebSettings(), afterConcurrent);
  }
});

test("CFG-X02: audit transaction failure rolls back the formal Web domain mutation", async context => {
  const h = await harness(context); const before = h.store.getWebSettings();
  await assert.rejects(h.store.runConfigurationTransaction(h.session.id, () => {
    h.store.applyWebConfigurationSync({ searchCacheTtlSeconds: 7 });
    throw new Error("synthetic audit failure");
  }), /synthetic audit failure/);
  assert.deepEqual(h.store.getWebSettings(), before);
});

test("CFG-X02: Stop invalidates an undecided card without changing deployment Web settings", async context => {
  const h = await harness(context); const before = h.store.getWebSettings();
  const card = await h.propose({ searchCacheTtlSeconds: 9 });
  h.store.notifications.stop(h.session.id);
  await h.framework.tick();
  assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled");
  await assert.rejects(h.framework.decide(h.session.id, card.id, { revision: card.revision, previewDigest: card.previewDigest!, decision: "apply", selectedOptionId: "persist" }));
  assert.deepEqual(h.store.getWebSettings(), before);
});
