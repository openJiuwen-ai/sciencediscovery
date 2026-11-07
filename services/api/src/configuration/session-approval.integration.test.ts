// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { createConfigurationAgentTools } from "./agent-tools.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `session-approval-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Session approval"), session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const sibling = await store.createSession(project.id, "Sibling", {}, {}, { allowUnconfiguredModel: true });
  const cleanups: string[][] = [];
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined, sessionApprovalCleanup: async ids => { cleanups.push([...ids]); } });
  const propose = (values: ConfigurationValues = { approvalMode: "always_allow" }) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "security.approval_mode", values });
  const consent = (card: ConfigurationRequestView) => framework.confirmSecurity(session.id, card.id, { revision: card.revision, targetDigest: card.securityConsent!.targetDigest, acknowledged: true });
  return { store, root, project, session, sibling, framework, propose, consent, cleanups };
}
const approve = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, decision: "apply" as const, selectedOptionId: "persist" });

test("CFG-X10d: two human confirmations are required; automatic policy and Agent fields cannot authorize", async context => {
  const h = await harness(context); await h.store.updateSession(h.session.id, { autoApplyLowRiskConfiguration: true });
  const card = await h.propose(); assert.equal(card.autoApplyAt, undefined); assert.equal(card.securityConsent?.status, "required");
  assert.throws(() => h.framework.service.registry.agentValues("security.approval_mode", { approvalMode: "always_allow", acknowledged: true }), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "SECURITY_CONSENT_REQUIRED" });
  await h.consent(card);
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card), undefined, "auto"), { code: "CONFIGURATION_AUTO_NOT_AUTHORIZED" });
  assert.equal(h.store.getSession(h.session.id)!.approvalMode, "ask_for_dangerous"); assert.deepEqual(h.cleanups, []);
});

test("CFG-X10d: only this Session changes, one epoch is retired, no action authorization is added, and replay is inert", async context => {
  const h = await harness(context), before = structuredClone(h.store.getSession(h.session.id)!);
  const sibling = structuredClone(h.store.getSession(h.sibling.id)!), network = h.store.getSandboxNetworkSettings(), defaults = h.store.getGlobalSettings();
  const grants = h.store.listPermissionGrants(), authorizations = h.store.listPermissionAuthorizations(h.session.id);
  const card = await h.propose(); await h.consent(card);
  const applied = await h.framework.decide(h.session.id, card.id, approve(card));
  const after = h.store.getSession(h.session.id)!;
  assert.equal(after.approvalMode, "always_allow"); assert.notEqual(after.permissionEpochId, before.permissionEpochId);
  assert.equal(after.autoApplyLowRiskConfiguration, before.autoApplyLowRiskConfiguration);
  assert.equal(applied.activation.state, "active"); assert.equal(applied.resumption.state, "not_requested");
  assert.deepEqual(h.cleanups, [[before.permissionEpochId]]); assert.deepEqual(h.store.listPermissionAuthorizations(h.session.id), authorizations);
  assert.deepEqual(h.store.listPermissionGrants(), grants); assert.deepEqual(h.store.getSession(h.sibling.id), sibling);
  assert.deepEqual(h.store.getSandboxNetworkSettings(), network); assert.deepEqual(h.store.getGlobalSettings(), defaults);
  await h.framework.decide(h.session.id, card.id, approve(card)); await h.framework.tick();
  assert.equal(h.store.getSession(h.session.id)!.permissionEpochId, after.permissionEpochId); assert.equal(h.cleanups.length, 1);
  const reopened = new SessionStore(h.root); await reopened.load();
  try { assert.equal(reopened.getSession(h.session.id)!.approvalMode, "always_allow"); assert.deepEqual(reopened.listPermissionAuthorizations(h.session.id), authorizations); } finally { reopened.close(); }
});

test("CFG-X10d: pending permission cards disable discovery and proposals; a new pending request invalidates reviewed consent", async context => {
  const h = await harness(context), card = await h.propose(); await h.consent(card);
  const pending = await h.store.requestPermission(h.session.id, "remote_job", "owned-fixture", "Needs a separate human decision"); assert.equal(pending.allowed, false);
  const run = await h.store.createSessionRun({ sessionId: h.session.id, prompt: "Owned discovery", settingsSnapshot: h.store.resolveRuntimeSettings(h.session.id).effective });
  const tools = createConfigurationAgentTools({ store: h.store, sessionId: h.session.id, runId: run.id });
  const result = await tools[0]!.execute(randomUUID(), { action: "describe", capabilityId: "security.approval_mode" });
  const page = JSON.parse(result.content[0]!.text); assert.equal(page.available, false); assert.equal(page.unsupportedReason, "PENDING_PERMISSION_REQUESTS"); assert.equal(page.current.pendingCount, 1);
  await assert.rejects(h.consent(card), { code: "RESOURCE_VERSION_CONFLICT" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  await assert.rejects(h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { approvalMode: "always_allow" }, selectedOptionId: "persist" }), { code: "PENDING_PERMISSION_REQUESTS" });
  await assert.rejects(h.store.runConfigurationTransaction(h.session.id, () => h.store.applySessionApprovalConfigurationSync(h.session.id, "always_allow")), { code: "PENDING_PERMISSION_REQUESTS" });
  assert.equal(h.store.listPermissionRequests(h.session.id)[0]!.state, "pending"); assert.deepEqual(h.store.listPermissionAuthorizations(h.session.id), []); assert.deepEqual(h.cleanups, []);
});

test("CFG-X10d: concurrent formal mode/epoch changes invalidate consent; previewing the opposite mode needs fresh acknowledgement", async context => {
  const h = await harness(context), card = await h.propose(); await h.consent(card);
  await h.store.setApprovalMode(h.session.id, "always_allow");
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  const edited = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { approvalMode: "ask_for_dangerous" }, selectedOptionId: "persist" });
  assert.equal(edited.securityConsent?.status, "required"); assert.notEqual(edited.securityConsent?.targetDigest, card.securityConsent?.targetDigest);
  await assert.rejects(h.framework.decide(h.session.id, card.id, approve(edited)), { code: "SECURITY_CONSENT_REQUIRED" });
  await h.consent(edited); await h.framework.decide(h.session.id, card.id, approve(edited)); assert.equal(h.store.getSession(h.session.id)!.approvalMode, "ask_for_dangerous");
});

test("CFG-X10d: failed receipt write rolls back mode and epoch together, leaving no cleanup or authorization", async context => {
  const h = await harness(context), before = structuredClone(h.store.getSession(h.session.id)!);
  const card = await h.propose(); await h.consent(card);
  const save = h.framework.repository.saveReceipt.bind(h.framework.repository);
  h.framework.repository.saveReceipt = () => { throw new Error("synthetic receipt failure"); };
  const failed = await h.framework.decide(h.session.id, card.id, approve(card));
  assert.equal(failed.state, "failed"); assert.equal(failed.error?.code, "CONFIGURATION_APPLY_FAILED");
  h.framework.repository.saveReceipt = save;
  assert.deepEqual(h.store.getSession(h.session.id), before); assert.deepEqual(h.store.listPermissionAuthorizations(h.session.id), []);
  assert.equal(h.framework.repository.getReceipt(card.id, card.revision), undefined); assert.deepEqual(h.cleanups, []);
});

test("CFG-X10d: saved policy with failed cleanup retries only on explicit Continue, without rotating or granting again", async context => {
  const h = await harness(context); let fail = true, calls = 0;
  h.framework.options.sessionApprovalCleanup = async () => { calls++; if (fail) throw new Error("synthetic cleanup failure"); };
  const card = await h.propose(); await h.consent(card); const saved = await h.framework.decide(h.session.id, card.id, approve(card));
  const epoch = h.store.getSession(h.session.id)!.permissionEpochId;
  assert.equal(saved.state, "applied"); assert.equal(saved.activation.state, "failed"); assert.ok(saved.allowedActions.includes("continue"));
  await h.framework.tick(); await h.framework.decide(h.session.id, card.id, approve(card)); assert.equal(calls, 1);
  fail = false; const settled = await h.framework.settle(h.session.id, card.id); assert.equal(settled.activation.state, "active"); assert.equal(calls, 2);
  assert.equal(h.store.getSession(h.session.id)!.permissionEpochId, epoch); assert.deepEqual(h.store.listPermissionAuthorizations(h.session.id), []);
});

test("CFG-X10d: refusal and Stop suppress the policy; invalid modes, foreign scopes and missing cleanup fail before writes", async context => {
  const h = await harness(context), before = structuredClone(h.store.getSession(h.session.id)!);
  for (const value of ["invalid", true, ["always_allow"]]) {
    await assert.rejects(h.propose({ approvalMode: value }), { code: "INVALID_CONFIGURATION_INPUT" });
  }
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "security.approval_mode", scope: { kind: "session", id: h.sibling.id }, values: { approvalMode: "always_allow" } }), { code: "CONFIGURATION_FORBIDDEN" });
  let card = await h.propose(); card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" });
  await h.framework.decide(h.session.id, card.id, { ...approve(card), decision: "dismiss", selectedOptionId: "dismiss" });
  card = await h.propose(); await h.consent(card); h.store.notifications.stop(h.session.id); await h.framework.tick();
  assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled"); assert.deepEqual(h.store.getSession(h.session.id), before);
  h.framework.options.sessionApprovalCleanup = undefined;
  await assert.rejects(h.propose(), { code: "CONFIGURATION_BACKEND_UNSUPPORTED" }); assert.deepEqual(h.cleanups, []);
});

test("CFG-X10d: formal mode editor retains its existing pending-action compatibility behavior", async context => {
  const h = await harness(context);
  await h.store.requestPermission(h.session.id, "code", "owned-code", "Formal page compatibility");
  await h.store.requestPermission(h.session.id, "direct_code", "owned-direct", "Direct code remains separately authorized");
  const result = await h.store.setApprovalMode(h.session.id, "always_allow");
  assert.equal(result.authorizations.length, 1); assert.equal(result.resolvedPendingRequests.length, 1);
  assert.equal(h.store.listPermissionAuthorizations(h.session.id).length, 1);
  assert.equal(h.store.listPermissionRequests(h.session.id).find(row => row.action === "direct_code")!.state, "pending");
});

test("CFG-X10d: only a bound original wait schedules continuation, after successful cleanup, with frozen task settings intact", async context => {
  const h = await harness(context);
  const run = await h.store.createSessionRun({ sessionId: h.session.id, prompt: "Owned policy wait", settingsSnapshot: h.store.resolveRuntimeSettings(h.session.id).effective });
  const frozen = structuredClone(run.settingsSnapshot), scheduled: string[] = [];
  h.framework.options.resume = async (_sessionId, requestId) => { assert.equal(h.cleanups.length, 1); scheduled.push(requestId); return run; };
  const card = await h.framework.propose(h.session.id, { protocolVersion: 3, runId: run.id, capabilityId: "security.approval_mode", values: { approvalMode: "always_allow" } });
  await h.consent(card); const applied = await h.framework.decide(h.session.id, card.id, approve(card));
  assert.equal(applied.resumption.state, "queued"); assert.deepEqual(scheduled, [card.id]);
  await h.framework.decide(h.session.id, card.id, approve(card)); assert.equal(scheduled.length, 1);
  assert.deepEqual((await h.store.getSessionRun(h.session.id, run.id))!.settingsSnapshot, frozen);
  assert.equal((await h.store.listSessionRuns(h.session.id)).length, 1);
});
