// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `configuration-default-approval-${randomUUID()}`), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Approval defaults"), session = await store.createSession(project.id, "Existing", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (mode: string, projectScope = false) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "security.default_approval", values: { defaultApprovalMode: mode }, ...(projectScope ? { scope: { kind: "project", id: project.id } } : {}) });
  const consent = (card: ConfigurationRequestView) => framework.confirmSecurity(session.id, card.id, { revision: card.revision, targetDigest: card.securityConsent!.targetDigest, acknowledged: true });
  const approval = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, decision: "apply" as const, selectedOptionId: "persist" });
  const save = async (card: ConfigurationRequestView) => { await consent(card); return framework.decide(session.id, card.id, approval(card)); };
  const fresh = () => store.createSession(project.id, "New", {}, {}, { allowUnconfiguredModel: true });
  return { root, store, project, session, framework, propose, consent, approval, save, fresh };
}
test("CFG-X10b: an independent user acknowledgement and manual decision are mandatory", async context => {
  const h = await harness(context); await h.store.updateSession(h.session.id, { autoApplyLowRiskConfiguration: true });
  assert.throws(() => h.framework.service.registry.agentValues("security.default_approval", { defaultApprovalMode: "always_allow", acknowledged: true }));
  const card = await h.propose("always_allow"); assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined);
  await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card)), { code: "SECURITY_CONSENT_REQUIRED" });
  await h.consent(card); await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card), undefined, "auto"), { code: "CONFIGURATION_AUTO_NOT_AUTHORIZED" });
  assert.equal(h.store.getGlobalSettings().overrides.defaultApprovalMode, undefined);
});
test("CFG-X10b: global default changes only new sessions and preserves other settings, epochs and automatic configuration", async context => {
  const h = await harness(context), before = h.store.getSession(h.session.id)!, settings = h.store.getGlobalSettings().overrides;
  const card = await h.propose("always_allow"); assert.equal((await h.save(card)).state, "applied"); await h.framework.decide(h.session.id, card.id, h.approval(card));
  assert.deepEqual(h.store.getGlobalSettings().overrides, { ...settings, defaultApprovalMode: "always_allow" });
  const current = h.store.getSession(h.session.id)!; assert.equal(current.approvalMode, before.approvalMode); assert.equal(current.permissionEpochId, before.permissionEpochId); assert.equal(current.autoApplyLowRiskConfiguration, before.autoApplyLowRiskConfiguration);
  assert.equal((await h.fresh()).approvalMode, "always_allow");
  const reopened = new SessionStore(h.root); await reopened.load(); try { assert.equal(reopened.getGlobalSettings().overrides.defaultApprovalMode, "always_allow"); } finally { reopened.close(); }
});
test("CFG-X10b: Project override and explicit inheritance are independent from global defaults", async context => {
  const h = await harness(context); await h.save(await h.propose("always_allow")); await h.save(await h.propose("ask_for_dangerous", true)); assert.equal((await h.fresh()).approvalMode, "ask_for_dangerous");
  await h.save(await h.propose("inherit", true)); assert.equal(h.store.getProjectSettings(h.project.id).overrides.defaultApprovalMode, undefined); assert.equal((await h.fresh()).approvalMode, "always_allow");
  await h.save(await h.propose("inherit")); assert.equal(h.store.getGlobalSettings().overrides.defaultApprovalMode, undefined); assert.equal((await h.fresh()).approvalMode, "ask_for_dangerous");
});
test("CFG-X10b: v3 finite fields and current Project scope cannot update a current or foreign Session", async context => {
  const h = await harness(context);
  await assert.rejects(h.propose("never_ask"), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "security.default_approval", values: { defaultApprovalMode: "always_allow" } }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  for (const scope of [{ kind: "session" as const, id: h.session.id }, { kind: "project" as const, id: "foreign" }]) await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "security.default_approval", scope, values: { defaultApprovalMode: "always_allow" } }));
  await assert.rejects(h.propose("inherit"), { code: "CONFIGURATION_NO_CHANGE" });
});
test("CFG-X10b: concurrent formal defaults invalidate consent; refusal and Stop preserve the formal choice", async context => {
  const h = await harness(context), card = await h.propose("always_allow"); await h.consent(card);
  await h.store.replaceGlobalSettings({ ...h.store.getGlobalSettings().overrides, defaultApprovalMode: "ask_for_dangerous" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, h.approval(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  const refreshed = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { defaultApprovalMode: "always_allow" }, selectedOptionId: "persist" }); assert.equal(refreshed.securityConsent?.status, "required");
  const declined = await h.framework.preview(h.session.id, card.id, { expectedRevision: refreshed.revision, values: {}, selectedOptionId: "dismiss" });
  assert.equal((await h.framework.decide(h.session.id, card.id, { ...h.approval(declined), decision: "dismiss", selectedOptionId: "dismiss" })).state, "dismissed");
  const stopped = await h.propose("always_allow"); await h.consent(stopped); h.store.notifications.stop(h.session.id);
  await assert.rejects(h.framework.decide(h.session.id, stopped.id, h.approval(stopped))); assert.equal(h.store.getGlobalSettings().overrides.defaultApprovalMode, "ask_for_dangerous");
});
test("CFG-X10b: receipt failure rolls the settings default back without authorizing an existing session", async context => {
  const h = await harness(context), card = await h.propose("always_allow"), before = h.store.getSession(h.session.id); await h.consent(card);
  const db = h.store.getConfigurationDatabase(); db.exec("CREATE TRIGGER reject_default_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.equal((await h.framework.decide(h.session.id, card.id, h.approval(card))).state, "failed"); assert.equal(h.store.getGlobalSettings().overrides.defaultApprovalMode, undefined); assert.deepEqual(JSON.parse(JSON.stringify(h.store.getSession(h.session.id))), JSON.parse(JSON.stringify(before)), "Persisted Session state is unchanged (undefined compatibility keys are not JSON state)");
  assert.equal(h.framework.repository.getReceipt(card.id), undefined); db.exec("DROP TRIGGER reject_default_receipt");
});
