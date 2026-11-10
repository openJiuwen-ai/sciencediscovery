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
  return { store, model, other, provider, session, project, framework };
}
test("removed metadata capability is neither advertised nor writable", async context => {
  const h = await fixture(context);
  const before = structuredClone(h.model);
  assert.ok(!h.framework.service.registry.list().some(item => String(item.id) === "model.metadata"));
  assert.ok(!JSON.stringify(h.framework.service.registry.describe()).includes("model.metadata"));
  for (const values of [{ modelId: h.model.id, name: "Renamed" }, { modelId: h.model.id, operation: "clear_facts" }] as ConfigurationValues[]) {
    await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3,
      capabilityId: "model.metadata" as ConfigurationRequestView["capabilityId"], values }),
      { code: "CONFIGURATION_CAPABILITY_UNAVAILABLE" });
  }
  await assert.rejects(discoverConfiguration(h.store, h.session.id, "owned-no-run", "describe", { capabilityId: "model.metadata", targetId: h.model.id }),
    { code: "CONFIGURATION_CAPABILITY_UNAVAILABLE" });
  assert.deepEqual(h.store.getModel(h.model.id), before);
});
