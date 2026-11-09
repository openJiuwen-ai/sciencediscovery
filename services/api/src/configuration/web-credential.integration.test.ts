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
async function harness(context: { after(action: () => Promise<void>): void }, nativeExecutor = true) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `configuration-web-key-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Web credential fixture");
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor, connector: () => undefined });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "web.credential", values });
  return { store, framework, session, propose };
}
async function secure(framework: ConversationalConfigurationFramework, view: ConfigurationRequestView, key: string) {
  const draft = await framework.provideCredential(view.sessionId, view.id, { expectedRevision: view.revision, fieldId: "apiToken", secret: key });
  return framework.preview(view.sessionId, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", credentialHandle: draft.handle,
    values: framework.service.getRecord(view.sessionId, view.id).input });
}
const approve = (framework: ConversationalConfigurationFramework, view: ConfigurationRequestView) => framework.decide(view.sessionId, view.id,
  { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply", selectedOptionId: "persist" });

test("CFG-X02b: Native keys are write-only, manual, encrypted and independent from selections or unrelated provider secrets", async context => {
  const h = await harness(context); await h.store.updateWebSettings({ providerApiKeys: { exa: "other-fixture" } });
  const before = h.store.getWebSettings(), database = h.store.getConfigurationDatabase();
  const other = database.prepare("SELECT encrypted_token FROM web_provider_secrets WHERE provider='exa'").get();
  let view = await h.propose({ webProvider: "jina", operation: "replace" });
  assert.equal(view.state, "collecting_input"); assert.equal(view.scope.kind, "global"); assert.equal(view.autoApplyAt, undefined);
  view = await secure(h.framework, view, "new-jina-fixture");
  assert.equal(view.verificationPlan.maxRequests, 0); assert.equal(view.activation.mode, "next_request");
  assert.match(view.impact.message, /anonymous success would not validate/); assert.match(view.impact.message, /already-selected paid provider/);
  assert.doesNotMatch(JSON.stringify(view), /new-jina-fixture|other-fixture/);
  assert.doesNotMatch(JSON.stringify(database.prepare("SELECT * FROM configuration_credential_drafts").all()), /new-jina-fixture/);
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal(h.store.getWebProviderApiKey("jina"), "new-jina-fixture");
  assert.deepEqual(database.prepare("SELECT encrypted_token FROM web_provider_secrets WHERE provider='exa'").get(), other);
  const { providers: _beforeProviders, ...settings } = before, { providers: _afterProviders, ...saved } = h.store.getWebSettings();
  assert.deepEqual(saved, settings);
});

test("CFG-X02b: all eight registered providers are covered by the formal backend matrices without claiming remote activation", async context => {
  const native = await harness(context), jiuwen = await harness(context, false);
  const seen = new Set<string>();
  for (const [h, providers] of [[native, ["jina", "tavily", "exa", "brave", "deepseek"]], [jiuwen, ["bocha", "perplexity", "serper", "jina", "deepseek"]]] as const) {
    const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "web.credential" });
    assert.equal(detail.activation, h === native ? "next_request" : "requires_restart");
    assert.deepEqual((detail.fields as { webProvider: { choices: readonly string[] } }).webProvider.choices, [...providers]);
    for (const provider of providers) {
      seen.add(provider); const view = await secure(h.framework, await h.propose({ webProvider: provider }), `synthetic-${provider}`);
      const result = await approve(h.framework, view); assert.equal(result.state, "applied");
      assert.notEqual(result.activation.state, "active");
      assert.equal(result.activation.mode, h === native ? "next_request" : "requires_restart");
    }
  }
  assert.equal(seen.size, 8);
  await assert.rejects(native.propose({ webProvider: "bocha" }), { code: "CONFIGURATION_BACKEND_UNSUPPORTED" });
  await assert.rejects(jiuwen.propose({ webProvider: "tavily" }), { code: "CONFIGURATION_BACKEND_UNSUPPORTED" });
});

test("CFG-X02b: clearing needs no old-key decryption and does not erase another provider", async context => {
  const h = await harness(context); await h.store.updateWebSettings({ providerApiKeys: { jina: "jina-fixture", exa: "exa-fixture" } });
  h.store.getWebProviderApiKey = () => { throw new Error("No existing secret reads for preview or clear"); };
  const view = await h.propose({ webProvider: "jina", operation: "clear" });
  assert.ok(view.fields.every(field => field.kind !== "credential"));
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal(h.store.getWebSettings().providers.find(item => item.provider === "jina")?.hasApiKey, false);
  assert.equal(h.store.getWebSettings().providers.find(item => item.provider === "exa")?.hasApiKey, true);
  await assert.rejects(h.propose({ webProvider: "jina", operation: "clear" }), { code: "CONFIGURATION_NO_CHANGE" });
});

test("CFG-X02b: a credential cannot transfer to another provider, operation or backend", async context => {
  const h = await harness(context); let view = await h.propose({ webProvider: "jina" });
  const draft = await h.framework.provideCredential(h.session.id, view.id, { expectedRevision: view.revision, fieldId: "apiToken", secret: "isolated-fixture" });
  await assert.rejects(h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: { webProvider: "exa" }, selectedOptionId: "persist", credentialHandle: draft.handle }));
  const identity = view.credentialTargetDigest;
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: { webProvider: "exa" }, selectedOptionId: "persist" });
  assert.equal(view.state, "collecting_input"); assert.notEqual(view.credentialTargetDigest, identity);
  await assert.rejects(h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: { webProvider: "exa" }, selectedOptionId: "persist", credentialHandle: draft.handle }));
  view = await secure(h.framework, view, "new-exa-fixture");
  h.framework.options.nativeExecutor = false;
  const result = await approve(h.framework, view); assert.equal(result.state, "needs_fix");
  assert.equal(result.error?.code, "CONFIGURATION_BACKEND_CHANGED");
  assert.equal(h.store.getWebProviderApiKey("exa"), undefined);
});

test("CFG-X02b: formal key rotation, route edits and Stop fence old approvals", async context => {
  const h = await harness(context); let view = await secure(h.framework, await h.propose({ webProvider: "jina" }), "old-proposal");
  await h.store.updateWebSettings({ providerApiKeys: { jina: "concurrent-formal" } });
  await assert.rejects(approve(h.framework, view), { code: "RESOURCE_VERSION_CONFLICT" });
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: { webProvider: "jina" }, selectedOptionId: "persist" });
  await h.store.updateWebSettings({ proxyPolicy: "none" });
  await assert.rejects(approve(h.framework, view), { code: "RESOURCE_VERSION_CONFLICT" });
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: { webProvider: "jina" }, selectedOptionId: "persist" });
  h.store.notifications.stop(h.session.id); await assert.rejects(approve(h.framework, view));
  assert.equal(h.store.getWebProviderApiKey("jina"), "concurrent-formal");
});

test("CFG-X02b: receipt rollback retains formal secrets and permits an explicit retry", async context => {
  const h = await harness(context); const database = h.store.getConfigurationDatabase();
  await h.store.updateWebSettings({ providerApiKeys: { jina: "original-fixture" } });
  const original = database.prepare("SELECT * FROM web_provider_secrets").all();
  let view = await secure(h.framework, await h.propose({ webProvider: "jina" }), "replacement-fixture");
  database.exec("CREATE TRIGGER reject_web_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await approve(h.framework, view)).state, "failed");
  assert.deepEqual(database.prepare("SELECT * FROM web_provider_secrets").all(), original);
  assert.equal(h.framework.repository.getReceipt(view.id), undefined);
  database.exec("DROP TRIGGER reject_web_receipt");
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: { webProvider: "jina" }, selectedOptionId: "persist" });
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal(h.store.getWebProviderApiKey("jina"), "replacement-fixture");
});

test("CFG-X02b: finite discovery and blank/refused cards never expose or modify formal keys", async context => {
  const h = await harness(context); await h.store.updateWebSettings({ providerApiKeys: { jina: "never-project-fixture" } });
  for (const query of ["web key", "网页密钥"]) {
    const found = await discoverConfiguration(h.store, h.session.id, "", "search", { query });
    assert.ok((found.items as Array<{ capabilityId?: string }>).some(item => item.capabilityId === "web.credential"));
  }
  h.store.getWebProviderApiKey = () => { throw new Error("Do not decrypt a key for discovery"); };
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "web.credential" });
  assert.doesNotMatch(JSON.stringify(detail), /never-project-fixture|encrypted_token/); assert.deepEqual(detail.scopes, ["global"]);
  assert.throws(() => h.framework.service.registry.agentValues("web.credential", { apiToken: "ordinary-secret" }));
  assert.throws(() => h.framework.service.registry.agentValues("web.credential", { operation: ["replace"] }));
  const before = h.store.getWebSettings(); let view = await h.propose({}); assert.equal(view.state, "collecting_input");
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: {}, selectedOptionId: "dismiss" });
  assert.equal((await h.framework.decide(h.session.id, view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "dismiss", selectedOptionId: "dismiss" })).state, "dismissed");
  assert.deepEqual(h.store.getWebSettings(), before);
});
