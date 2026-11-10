// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
test("CFG-XBUG-10: discovery cache identity uses credential generations without decryption and isolates unrelated providers", async context => {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "provider-discovery-version-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const first = await store.createProvider({ name: "Owned first", baseUrl: "https://first.invalid/v1", apiToken: "synthetic-first-key" });
  const other = await store.createProvider({ name: "Owned other", baseUrl: "https://other.invalid/v1", apiToken: "synthetic-other-key" });
  store.getProviderApiToken = () => { throw new Error("Revision reads must not decrypt a saved key"); };
  const version = store.providerDiscoveryRevision(first.id); assert.ok(version !== undefined); assert.match(version, /^[0-9a-f]{64}$/u);
  await store.updateProvider(other.id, { name: "Unrelated renamed provider", apiToken: "synthetic-other-rotated" }); assert.equal(store.providerDiscoveryRevision(first.id), version);
  await store.updateProvider(first.id, { apiToken: "synthetic-first-rotated" }); const rotated = store.providerDiscoveryRevision(first.id); assert.notEqual(rotated, version);
  await store.updateProvider(first.id, { baseUrl: "https://new-first.invalid/v1" }); assert.notEqual(store.providerDiscoveryRevision(first.id), rotated);
  const proxy = await store.createProxyServer({ name: "Owned selected proxy", kind: "custom_url", url: "http://127.0.0.1:9" });
  await store.updateProvider(first.id, { proxyPolicy: `proxy:${proxy.id}` }); const routed = store.providerDiscoveryRevision(first.id);
  const unused = await store.createProxyServer({ name: "Owned unused proxy", kind: "custom_url", url: "http://127.0.0.1:8" });
  await store.updateProxyServer(unused.id, { url: "http://127.0.0.1:7" }); assert.equal(store.providerDiscoveryRevision(first.id), routed);
  await store.updateProxyServer(proxy.id, { url: "http://127.0.0.1:6" }); assert.notEqual(store.providerDiscoveryRevision(first.id), routed);
  assert.equal(store.providerDiscoveryRevision("missing"), undefined);
});
