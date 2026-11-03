// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { configurationFramework, type ConversationalConfigurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"); const root = resolve(parent, `configuration-proxy-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(`${parent}${sep}`)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Proxy default");
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const server = await store.createProxyServer({ name: "Owned route", kind: "custom_url", url: "http://owned:synthetic-proxy-password@127.0.0.1:9" });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "proxy.default", values });
  return { store, root, session, server, framework, propose, policy: `proxy:${server.id}` };
}
async function decide(framework: ConversationalConfigurationFramework, view: ConfigurationRequestView, option = "persist") {
  const preview = await framework.preview(view.sessionId, view.id, { expectedRevision: view.revision, values: framework.service.getRecord(view.sessionId, view.id).input, selectedOptionId: option });
  if (option === "persist") await confirmProxySecurity(framework, preview);
  const input = { revision: preview.revision, previewDigest: preview.previewDigest!, decision: option === "persist" ? "apply" as const : "dismiss" as const, selectedOptionId: option };
  return { view: await framework.decide(view.sessionId, view.id, input), input };
}

async function confirmProxySecurity(framework: ConversationalConfigurationFramework, card: ConfigurationRequestView) {
  assert.ok(card.securityConsent, "A proxy route change requires separate security consent");
  await framework.confirmSecurity(card.sessionId, card.id, { revision: card.revision, targetDigest: card.securityConsent.targetDigest, acknowledged: true });
}

test("CFG-X68-734: deployment proxy writes require independent human security consent", async context => {
  const h = await harness(context);
  const before = h.store.configurationProxyDefaults();
  const card = await h.propose({ defaultPolicy: h.policy });
  const input = { revision: card.revision, previewDigest: card.previewDigest!, decision: "apply" as const, selectedOptionId: "persist" };
  await assert.rejects(h.framework.decide(h.session.id, card.id, input), { code: "SECURITY_CONSENT_REQUIRED" });
  assert.deepEqual(h.store.configurationProxyDefaults(), before);
  const consent = card.securityConsent!;
  assert.equal(consent.status, "required");
  await h.framework.confirmSecurity(h.session.id, card.id, { revision: card.revision, targetDigest: consent.targetDigest, acknowledged: true });
  assert.equal((await h.framework.decide(h.session.id, card.id, input)).state, "applied");
  assert.equal(h.store.configurationProxyDefaults().defaultPolicy, h.policy);
});

test("CFG-X03a: discovery and empty preview use safe metadata without decrypting proxy URLs", async context => {
  const h = await harness(context);
  h.store.getProxySettings = () => { throw new Error("Full proxy details are forbidden here"); };
  h.store.getProxyServerUrl = () => { throw new Error("Proxy URL decryption is forbidden here"); };
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "proxy.default" });
  assert.doesNotMatch(JSON.stringify(detail), /synthetic-proxy-password|127\.0\.0\.1/);
  assert.ok((detail.items as Array<{ id: string }>).some(item => item.id === h.policy));
  const card = await h.propose({}); assert.equal(card.state, "collecting_input");
  assert.equal(card.scope.kind, "global"); assert.equal(card.verificationPlan.maxRequests, 0);
  assert.match(card.impact.message, /sandbox egress/);
  const edited = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { defaultPolicy: h.policy }, selectedOptionId: "persist" });
  await confirmProxySecurity(h.framework, edited);
  assert.equal((await h.framework.decide(h.session.id, card.id, { revision: edited.revision, previewDigest: edited.previewDigest!, decision: "apply", selectedOptionId: "persist" })).state, "applied");
  assert.equal(h.store.configurationProxyDefaults().defaultPolicy, h.policy);
});

test("CFG-X03a: manual confirmation persists only the default, preserves resources, and replays one receipt", async context => {
  const h = await harness(context); const before = h.store.configurationProxyDefaults();
  const web = h.store.getWebSettings(); const network = h.store.getSandboxNetworkSettings();
  assert.throws(() => h.store.applyProxyDefaultConfigurationSync(h.policy), /shared transaction/);
  const card = await h.propose({ defaultPolicy: h.policy });
  assert.equal(card.autoApplyAt, undefined); assert.deepEqual(h.store.configurationProxyDefaults(), before);
  const applied = await decide(h.framework, card); assert.equal(applied.view.state, "applied");
  assert.deepEqual(h.store.configurationProxyDefaults(), { ...before, defaultPolicy: h.policy });
  assert.deepEqual(h.store.getWebSettings(), web); assert.deepEqual(h.store.getSandboxNetworkSettings(), network);
  const receipt = h.framework.repository.getReceipt(card.id, applied.view.revision);
  await h.framework.decide(h.session.id, card.id, applied.input);
  assert.deepEqual(h.framework.repository.getReceipt(card.id, applied.view.revision), receipt);
  const reopened = new SessionStore(h.root); await reopened.load();
  try { assert.equal(reopened.configurationProxyDefaults().defaultPolicy, h.policy); } finally { reopened.close(); }
});

test("CFG-X03a: arbitrary URLs, unknown policies, credentials, session scope and old protocol reject", async context => {
  const h = await harness(context); const before = h.store.configurationProxyDefaults();
  for (const defaultPolicy of ["inherit", "proxy:missing", "http://127.0.0.1:9", "none "]) await assert.rejects(h.propose({ defaultPolicy }), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.propose({ apiToken: "forbidden" }), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "proxy.default", values: { defaultPolicy: h.policy }, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "proxy.default", values: {} }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  assert.deepEqual(h.store.configurationProxyDefaults(), before);
});

test("CFG-X03a: concurrent formal default, directory or URL-generation changes invalidate old approval", async context => {
  for (const kind of ["default", "directory", "url"]) {
    const h = await harness(context); const card = await h.propose({ defaultPolicy: h.policy });
    await confirmProxySecurity(h.framework, card);
    if (kind === "default") await h.store.updateProxySettings({ defaultPolicy: h.policy as `proxy:${string}` });
    else if (kind === "directory") await h.store.createProxyServer({ name: "Second route", kind: "environment" });
    else await h.store.updateProxyServer(h.server.id, { url: "http://owned:other-synthetic-password@127.0.0.1:10" });
    const before = h.store.configurationProxyDefaults();
    await assert.rejects(h.framework.decide(h.session.id, card.id, { revision: card.revision, previewDigest: card.previewDigest!, decision: "apply", selectedOptionId: "persist" }), { code: "RESOURCE_VERSION_CONFLICT" });
    assert.deepEqual(h.store.configurationProxyDefaults(), before);
  }
});

test("CFG-X03a: provider-only proxy references block deletion and change the resource fence", async context => {
  const h = await harness(context);
  const version = () => h.store.configurationSnapshot(h.session.id, "proxy.resources", h.server.id).resourceVersions.proxyReferences;
  const provider = await h.store.createProvider({
    name: "Proxy owner", baseUrl: "https://example.test/v1", apiProtocol: "openai-chat-completions",
  });
  const before = version();
  await h.store.updateProvider(provider.id, { proxyPolicy: `proxy:${h.server.id}` });
  assert.notEqual(version(), before);
  await assert.rejects(h.store.deleteProxyServer(h.server.id), /referenced by provider "Proxy owner"/);
  assert.ok(h.store.configurationProxyResources().some(item => item.id === h.server.id));
  const card = await h.framework.propose(h.session.id, {
    protocolVersion: 3, capabilityId: "proxy.resources", values: { operation: "delete", proxyId: h.server.id },
  });
  assert.ok(card.previewDigest);
  const rejected = await h.framework.decide(h.session.id, card.id, {
    revision: card.revision, previewDigest: card.previewDigest, decision: "apply", selectedOptionId: "persist",
  });
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.error?.code, "PROXY_RESOURCE_IN_USE");
  assert.match(rejected.error?.message ?? "", /referenced by provider "Proxy owner"/);
  await h.store.updateProvider(provider.id, { proxyPolicy: "inherit" });
  await h.store.deleteProxyServer(h.server.id);
  assert.ok(!h.store.configurationProxyResources().some(item => item.id === h.server.id));
});

test("CFG-X03a: no-op, refusal, Stop and audit rollback leave the default unchanged", async context => {
  const h = await harness(context); const before = h.store.configurationProxyDefaults();
  await assert.rejects(h.propose({ defaultPolicy: before.defaultPolicy }), { code: "CONFIGURATION_NO_CHANGE" });
  await decide(h.framework, await h.propose({ defaultPolicy: h.policy }), "dismiss");
  await assert.rejects(h.store.runConfigurationTransaction(h.session.id, () => { h.store.applyProxyDefaultConfigurationSync(h.policy); throw new Error("synthetic audit failure"); }), /synthetic audit failure/);
  const card = await h.propose({ defaultPolicy: h.policy }); h.store.notifications.stop(h.session.id); await h.framework.tick();
  assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled");
  assert.deepEqual(h.store.configurationProxyDefaults(), before);
});
