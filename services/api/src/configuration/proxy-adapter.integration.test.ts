// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationCapabilityId, ConfigurationValues } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
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
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "proxy.default" as ConfigurationCapabilityId, values });
  return { store, root, session, server, framework, propose, policy: `proxy:${server.id}` };
}
test("CFG-X03a: removed deployment default capability is absent and cannot mutate settings", async context => {
  const h = await harness(context); const before = h.store.getProxySettings();
  assert.ok(!h.framework.service.registry.list().some(item => String(item.id) === "proxy.default"));
  await assert.rejects(h.propose({ defaultPolicy: h.policy }), { code: "CONFIGURATION_CAPABILITY_UNAVAILABLE" });
  for (const query of ["proxy", "代理"]) {
    const result = await discoverConfiguration(h.store, h.session.id, "", "search", { query });
    assert.ok(!(result.items as Array<{ capabilityId?: string }>).some(item => item.capabilityId === "proxy.default"));
  }
  assert.deepEqual(h.store.getProxySettings(), before);
  assert.equal(h.store.getConfigurationDatabase().prepare("SELECT name FROM sqlite_master WHERE name = ?").get("configuration_security_consents"), undefined);
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
  await h.store.updateProvider(provider.id, { proxyPolicy: "inherit" });
  await h.store.deleteProxyServer(h.server.id);
  assert.ok(!h.store.configurationProxyResources().some(item => item.id === h.server.id));
});
