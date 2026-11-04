// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConfigurationRequestView, ConfigurationScope, ConfigurationValues } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function fixture(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "json-viewer-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("JSON viewer"), session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues, scope?: ConfigurationScope) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "plugin.json_viewer", values, ...(scope ? { scope } : {}) });
  const approval = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const });
  return { store, session, project, framework, propose, approval };
}
test("CFG-X09a: three-layer enable/disable/inherit preserve ordinary settings and other plugins; approval/replay are manual", async context => {
  const h = await fixture(context); await h.store.replaceSessionSettings(h.session.id, { thinkingEffort: "high", plugins: { plan: { enabled: false } } });
  let writes = 0; const apply = h.store.applyJsonViewerConfigurationSync.bind(h.store); h.store.applyJsonViewerConfigurationSync = (...args) => { writes++; apply(...args); };
  for (const scope of [{ kind: "global" }, { kind: "project", id: h.project.id }, { kind: "session", id: h.session.id }] as const) {
    const before = structuredClone(h.store.getSessionSettings(h.session.id)); let card = await h.propose({ mode: "disabled" }, scope);
    assert.equal(card.autoApplyAt, undefined); assert.deepEqual(h.store.getSessionSettings(h.session.id), before);
    assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "applied"); const count = writes; await h.framework.decide(h.session.id, card.id, h.approval(card)); assert.equal(writes, count);
    assert.equal(h.store.configurationJsonViewerSettings(h.session.id).modes[scope.kind], "disabled"); assert.equal(h.store.getSessionSettings(h.session.id).effective.plugins?.["artifact-json"]?.enabled, false);
    card = await h.propose({ mode: "inherit" }, scope); await h.framework.decide(h.session.id, card.id, h.approval(card)); assert.equal(h.store.configurationJsonViewerSettings(h.session.id).modes[scope.kind], "inherit");
    const settings = scope.kind === "global" ? h.store.getGlobalSettings()
      : scope.kind === "project" ? h.store.getProjectSettings(scope.id) : h.store.getSessionSettings(scope.id);
    assert.equal(settings.overrides.plugins?.["artifact-json"], undefined);
  }
  assert.equal(h.store.getSessionSettings(h.session.id).overrides.thinkingEffort, "high"); assert.equal(h.store.getSessionSettings(h.session.id).effective.plugins?.plan?.enabled, false);
});
test("CFG-X09a: upper defaults and lower overrides resolve inheritance without rewriting queued snapshots", async context => {
  const h = await fixture(context); await h.store.replaceGlobalSettings({ plugins: { "artifact-json": { enabled: false } } });
  const run = await h.store.createSessionRun({ sessionId: h.session.id, prompt: "Owned frozen snapshot", settingsSnapshot: h.store.resolveRuntimeSettings(h.session.id).effective });
  let card = await h.propose({ mode: "enabled" }); await h.framework.decide(h.session.id, card.id, h.approval(card)); assert.equal(h.store.getSessionSettings(h.session.id).effective.plugins?.["artifact-json"]?.enabled, true);
  card = await h.propose({ mode: "inherit" }); await h.framework.decide(h.session.id, card.id, h.approval(card)); assert.equal(h.store.getSessionSettings(h.session.id).effective.plugins?.["artifact-json"]?.enabled, false);
  assert.equal((await h.store.getSessionRun(h.session.id, run.id))?.settingsSnapshot.plugins?.["artifact-json"]?.enabled, false);
});
test("CFG-X09a: only finite viewer mode, owned scopes and v3 are accepted", async context => {
  const h = await fixture(context); await assert.rejects(h.propose({ mode: "inherit" }), { code: "CONFIGURATION_NO_CHANGE" }); assert.equal((await h.propose({})).state, "collecting_input");
  for (const values of [{ mode: "other" }, { mode: "disabled", pluginId: "mcp" }, { mode: "disabled", config: "arbitrary" }] as ConfigurationValues[]) await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.propose({ mode: "disabled" }, { kind: "project", id: "foreign" }), { code: "CONFIGURATION_FORBIDDEN" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "plugin.json_viewer", values: {} }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  const described = await discoverConfiguration(h.store, h.session.id, "owned-no-run", "describe", { capabilityId: "plugin.json_viewer" }); assert.deepEqual(described.scopes, ["global", "project", "session"]);
});
test("CFG-X09a: inherited viewer edits invalidate approval while an unrelated plugin edit is retained", async context => {
  const h = await fixture(context); let card = await h.propose({ mode: "disabled" }); await h.store.replaceGlobalSettings({ plugins: { "artifact-json": { enabled: false } } });
  await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { mode: "enabled" }, selectedOptionId: "persist" }); await h.store.replaceSessionSettings(h.session.id, { plugins: { plan: { enabled: false } } });
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "applied"); assert.equal(h.store.getSessionSettings(h.session.id).overrides.plugins?.plan?.enabled, false);
});
test("CFG-X09a: committed Global/Project edits notify Project hosts; receipt failure rolls back without notifications", async context => {
  const h = await fixture(context); let notifications = 0; const unsubscribe = h.store.plugins.subscribe({ projectId: h.project.id }, () => { notifications++; }); context.after(async () => unsubscribe());
  let card = await h.propose({ mode: "disabled" }, { kind: "global" }); await h.framework.decide(h.session.id, card.id, h.approval(card)); assert.ok(notifications > 0);
  notifications = 0; card = await h.propose({ mode: "enabled" }, { kind: "project", id: h.project.id }); const before = h.store.getProjectSettings(h.project.id); const db = h.store.getConfigurationDatabase();
  db.exec("CREATE TRIGGER reject_json_viewer_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "failed"); assert.deepEqual(h.store.getProjectSettings(h.project.id), before); assert.equal(notifications, 0); assert.equal(h.framework.repository.getReceipt(card.id), undefined); db.exec("DROP TRIGGER reject_json_viewer_receipt");
});
test("CFG-X09a: refusal and Stop preserve viewer configuration", async context => {
  const h = await fixture(context); let card = await h.propose({ mode: "disabled" }); card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" });
  assert.equal((await h.framework.decide(h.session.id, card.id, { ...h.approval(card), selectedOptionId: "dismiss", decision: "dismiss" })).state, "dismissed");
  card = await h.propose({ mode: "disabled" }); h.store.notifications.stop(h.session.id); await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card))); assert.equal(h.store.configurationJsonViewerSettings(h.session.id).modes.session, "inherit");
});
