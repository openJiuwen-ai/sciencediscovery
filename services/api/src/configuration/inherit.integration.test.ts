// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConfigurationRequestView, ConfigurationScope } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function fixture(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "inherit-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  store.setAvailableSkillIds(["literature", "statistics"]);
  await store.replaceGlobalSettings({ semanticReviewEnabled: true, thinkingEffort: "high" });
  const project = await store.createProject("Inheritance", { thinkingEffort: "medium", skillSelectionMode: "all" });
  const session = await store.createSession(project.id, "Target", { thinkingEffort: "low", semanticReviewEnabled: false, enabledConnectorIds: [] }, {}, { allowUnconfiguredModel: true });
  const other = await store.createSession(project.id, "Other", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (selectedFields: string[], scope?: ConfigurationScope) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "settings.inherit", values: { selectedFields }, ...(scope ? { scope } : {}) });
  const approval = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const });
  return { store, project, session, other, framework, propose, approval };
}
test("CFG-X11b: manual Session removal restores effective parent values, preserves other fields/permissions and replays once", async context => {
  const h = await fixture(context), before = h.store.getSessionSettings(h.session.id), session = structuredClone(h.store.getSession(h.session.id)!); let writes = 0;
  h.store.getModelApiToken = () => { throw Error("Old key reads forbidden"); }; const apply = h.store.applyConfigurationInheritanceSync.bind(h.store); h.store.applyConfigurationInheritanceSync = (...args) => { writes++; apply(...args); };
  const card = await h.propose(["thinkingEffort", "semanticReviewEnabled"]); assert.equal(card.autoApplyAt, undefined); assert.deepEqual(h.store.getSessionSettings(h.session.id), before);
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "applied"); await h.framework.decide(h.session.id, card.id, h.approval(card)); assert.equal(writes, 1);
  const saved = h.store.getSessionSettings(h.session.id); assert.equal(Object.hasOwn(saved.overrides, "thinkingEffort"), false); assert.equal(Object.hasOwn(saved.overrides, "semanticReviewEnabled"), false); assert.equal(saved.effective.thinkingEffort, "medium"); assert.equal(saved.effective.semanticReviewEnabled, true); assert.deepEqual(saved.overrides.enabledConnectorIds, []);
  assert.equal(h.store.getSession(h.session.id)?.approvalMode, session.approvalMode); assert.equal(h.store.getSession(h.session.id)?.permissionEpochId, session.permissionEpochId); assert.equal(h.store.getSession(h.session.id)?.autoApplyLowRiskConfiguration, session.autoApplyLowRiskConfiguration);
});
test("CFG-X11b: restoring an unrelated field preserves an unavailable Skill override", async context => {
  const h = await fixture(context);
  await h.store.replaceSessionSettings(h.session.id, {
    thinkingEffort: "low", skillSelectionMode: "selected", enabledSkillIds: ["statistics"],
  });
  h.store.setAvailableSkillIds(["literature"]);
  const card = await h.propose(["thinkingEffort"]);
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "applied");
  const saved = h.store.getSessionSettings(h.session.id);
  assert.equal(saved.overrides.thinkingEffort, undefined);
  assert.deepEqual(saved.overrides.enabledSkillIds, ["statistics"]);
  assert.deepEqual(saved.effective.enabledSkillIds, []);
});

test("CFG-X11b: Project restoration updates inheriting Sessions but retains lower overrides and frozen runs", async context => {
  const h = await fixture(context); const run = await h.store.createSessionRun({ sessionId: h.other.id, prompt: "Owned frozen settings", settingsSnapshot: h.store.resolveRuntimeSettings(h.other.id).effective });
  const card = await h.propose(["thinkingEffort"], { kind: "project", id: h.project.id }); await h.framework.decide(h.session.id, card.id, h.approval(card));
  assert.equal(Object.hasOwn(h.store.getProjectSettings(h.project.id).overrides, "thinkingEffort"), false); assert.equal(h.store.getSessionSettings(h.other.id).effective.thinkingEffort, "high"); assert.equal(h.store.getSessionSettings(h.session.id).effective.thinkingEffort, "low"); assert.equal((await h.store.getSessionRun(h.other.id, run.id))?.settingsSnapshot.thinkingEffort, "medium");
});
test("CFG-X11b: an equal explicit override can be removed; absent fields no_change and empty selection collects input", async context => {
  const h = await fixture(context); await assert.rejects(h.propose(["reviewModelId"]), { code: "CONFIGURATION_NO_CHANGE" });
  await h.store.replaceSessionSettings(h.session.id, { semanticReviewEnabled: true }); let card = await h.propose(["semanticReviewEnabled"]); assert.equal(card.changes.length, 1); await h.framework.decide(h.session.id, card.id, h.approval(card)); assert.equal(Object.hasOwn(h.store.getSessionSettings(h.session.id).overrides, "semanticReviewEnabled"), false);
  card = await h.propose([]); assert.equal(card.state, "collecting_input");
});
test("CFG-X11b: finite ordinary fields reject security resets, Global/foreign scopes and v2; shared Skill backends reject only Skill restoration", async context => {
  const h = await fixture(context);
  for (const field of ["plugins", "defaultApprovalMode", "approvalMode", "autoApplyLowRiskConfiguration", "sandboxNetwork", "runnerIds", "apiToken"]) await assert.rejects(h.propose([field]), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.propose(["thinkingEffort", "thinkingEffort"]), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.propose(["thinkingEffort"], { kind: "global" }), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.propose(["thinkingEffort"], { kind: "project", id: "foreign" }), { code: "CONFIGURATION_FORBIDDEN" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "settings.inherit", values: { selectedFields: ["thinkingEffort"] } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  h.store.setSkillSelectionAvailable(false); await assert.rejects(h.propose(["enabledSkillIds"]), { code: "CONFIGURATION_BACKEND_UNSUPPORTED" }); assert.equal((await h.propose(["semanticReviewEnabled"])).state, "awaiting_confirmation");
});
test("CFG-X11b: parent edits invalidate old approval and receipt failure rolls removals back", async context => {
  const h = await fixture(context); let card = await h.propose(["thinkingEffort"]); await h.store.replaceProjectSettings(h.project.id, { thinkingEffort: "high" }); await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { selectedFields: ["thinkingEffort"] }, selectedOptionId: "persist" }); const before = h.store.getSessionSettings(h.session.id); const db = h.store.getConfigurationDatabase();
  db.exec("CREATE TRIGGER reject_inherit_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END"); assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "failed"); assert.deepEqual(h.store.getSessionSettings(h.session.id), before); assert.equal(h.framework.repository.getReceipt(card.id), undefined); db.exec("DROP TRIGGER reject_inherit_receipt");
});
test("CFG-X11b: refusal and Stop never remove explicit overrides", async context => {
  const h = await fixture(context), before = h.store.getSessionSettings(h.session.id); let card = await h.propose(["thinkingEffort"]); card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }); assert.equal((await h.framework.decide(h.session.id, card.id, { ...h.approval(card), selectedOptionId: "dismiss", decision: "dismiss" })).state, "dismissed");
  card = await h.propose(["thinkingEffort"]); h.store.notifications.stop(h.session.id); await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card))); assert.deepEqual(h.store.getSessionSettings(h.session.id), before);
});
