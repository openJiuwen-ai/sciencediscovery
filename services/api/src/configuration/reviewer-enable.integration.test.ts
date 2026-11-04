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
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `configuration-reviewer-global-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Global Reviewer switch");
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const other = await store.createSession(project.id, "Other", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "reviewer.enable", values });
  return { store, root, session, other, framework, propose };
}
const approve = (framework: ConversationalConfigurationFramework, view: ConfigurationRequestView) => framework.decide(view.sessionId, view.id,
  { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply", selectedOptionId: "persist" });

test("CFG-X09a: manual global off preserves feedback/session settings and remains off after reload", async context => {
  const h = await harness(context);
  await h.store.updateReviewerSpecialistSettings({ enabled: true, feedbackPolicy: "repair" });
  const before = h.store.getReviewerSpecialistSettings(), sessionBefore = h.store.getSessionSettings(h.session.id), otherBefore = h.store.getSessionReviewerSpecialistSettings(h.other.id);
  const view = await h.propose({ enabled: false });
  assert.equal(view.scope.kind, "global"); assert.equal(view.autoApplyAt, undefined); assert.equal(view.verificationPlan.maxRequests, 0);
  assert.match(view.impact.message, /repair/); assert.match(view.impact.message, /may charge/); assert.match(view.impact.message, /queued reviews/);
  const result = await approve(h.framework, view); assert.equal(result.state, "applied");
  assert.equal(result.activation.mode, "next_request"); assert.equal(result.activation.state, "needs_user_action"); assert.equal(result.resumption.state, "not_requested");
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.deepEqual(h.store.getReviewerSpecialistSettings(), { ...before, enabled: false });
  assert.deepEqual(h.store.getSessionSettings(h.session.id), sessionBefore); assert.deepEqual(h.store.getSessionReviewerSpecialistSettings(h.other.id), otherBefore);
  h.store.close(); const reopened = new SessionStore(h.root); await reopened.load();
  assert.deepEqual(reopened.getReviewerSpecialistSettings(), { ...before, enabled: false }); reopened.close();
});

test("CFG-X09a: finite v3/global input, no-change and empty cards never write", async context => {
  const h = await harness(context), before = h.store.getReviewerSpecialistSettings();
  assert.throws(() => h.store.applyReviewerParticipationSync(false));
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "reviewer.enable", values: { enabled: false } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "reviewer.enable", values: { enabled: false }, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
  for (const values of [{ enabled: "false" }, { feedbackPolicy: "repair" }, { level: "deep" }, { enabled: [] }]) assert.throws(() => h.framework.service.registry.agentValues("reviewer.enable", values));
  await assert.rejects(h.propose({ enabled: before.enabled }), { code: "CONFIGURATION_NO_CHANGE" });
  const empty = await h.propose({}); assert.equal(empty.state, "collecting_input");
  const field = empty.fields.find(field => field.id === "enabled"); assert.ok(field && field.kind === "boolean"); assert.equal(field.value, before.enabled);
  assert.deepEqual(h.store.getReviewerSpecialistSettings(), before);
});

test("CFG-X09a: refusal and Stop preserve the global flag without resuming work", async context => {
  const h = await harness(context), before = h.store.getReviewerSpecialistSettings(); let view = await h.propose({ enabled: !before.enabled });
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, values: {}, selectedOptionId: "dismiss" });
  assert.equal((await h.framework.decide(h.session.id, view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "dismiss", selectedOptionId: "dismiss" })).state, "dismissed");
  view = await h.propose({ enabled: !before.enabled }); h.store.notifications.stop(h.session.id);
  await assert.rejects(approve(h.framework, view)); assert.deepEqual(h.store.getReviewerSpecialistSettings(), before);
});

test("CFG-X09a: global feedback changes fence approval; other-session review preferences do not", async context => {
  const h = await harness(context), before = h.store.getReviewerSpecialistSettings(); let view = await h.propose({ enabled: !before.enabled });
  await h.store.updateReviewerSpecialistSettings({ enabled: before.enabled, feedbackPolicy: before.feedbackPolicy === "repair" ? "record" : "repair" });
  await assert.rejects(approve(h.framework, view), { code: "RESOURCE_VERSION_CONFLICT" });
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { enabled: !before.enabled } });
  await h.store.updateSessionReviewerSpecialistSettings(h.other.id, { level: "deep", automaticReviewEnabled: false });
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.equal(h.store.getSessionReviewerSpecialistSettings(h.other.id).automaticReviewEnabled, false);
});

test("CFG-X09a: receipt failure rolls back the switch and feedback; explicit retry succeeds", async context => {
  const h = await harness(context), before = h.store.getReviewerSpecialistSettings(), database = h.store.getConfigurationDatabase();
  let view = await h.propose({ enabled: !before.enabled });
  database.exec("CREATE TRIGGER reject_reviewer_global_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await approve(h.framework, view)).state, "failed"); assert.deepEqual(h.store.getReviewerSpecialistSettings(), before);
  assert.equal(h.framework.repository.getReceipt(view.id), undefined); database.exec("DROP TRIGGER reject_reviewer_global_receipt");
  view = await h.framework.preview(h.session.id, view.id, { expectedRevision: view.revision, selectedOptionId: "persist", values: { enabled: !before.enabled } });
  assert.equal((await approve(h.framework, view)).state, "applied");
});

test("CFG-X09a: bilingual discovery separates the global switch from session review fields", async context => {
  const h = await harness(context);
  for (const query of ["reviewer specialist global", "全局审阅专家"]) {
    const result = await discoverConfiguration(h.store, h.session.id, "", "search", { query });
    assert.ok((result.items as Array<{ capabilityId?: string }>).some(item => item.capabilityId === "reviewer.enable"));
  }
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "reviewer.enable" });
  assert.deepEqual(detail.scopes, ["global"]); assert.deepEqual(Object.keys(detail.fields as object), ["enabled"]);
  assert.deepEqual(detail.current, h.store.getReviewerSpecialistSettings());
});
