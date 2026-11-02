// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView, ConfigurationValues, KernelSession } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { configurationFramework, type ConversationalConfigurationFramework } from "./framework.js";
import { retireSecurityNetworkKernels } from "./security-network-cleanup.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"); const root = resolve(parent, `configuration-security-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(`${parent}${sep}`)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Network policy");
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const sibling = await store.createSession(project.id, "Sibling", {}, {}, { allowUnconfiguredModel: true });
  const cleanups: string[][] = [];
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined, securityNetworkCleanup: async ids => { cleanups.push([...ids]); } });
  const propose = (values: ConfigurationValues) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "security.network", values });
  return { root, store, session, sibling, framework, propose, cleanups };
}
const approval = (card: ConfigurationRequestView) => ({ revision: card.revision, previewDigest: card.previewDigest!, decision: "apply" as const, selectedOptionId: "persist" });
async function consent(framework: ConversationalConfigurationFramework, card: ConfigurationRequestView) {
  return framework.confirmSecurity(card.sessionId, card.id, { revision: card.revision, targetDigest: card.securityConsent!.targetDigest, acknowledged: true });
}

test("CFG-X10a: ordinary confirmation and Agent-supplied acknowledgement cannot authorize network changes", async context => {
  const h = await harness(context); const before = h.store.getSandboxNetworkSettings(), epoch = h.store.getSession(h.session.id)!.permissionEpochId;
  await h.store.updateSession(h.session.id, { autoApplyLowRiskConfiguration: true });
  assert.throws(() => h.framework.service.registry.agentValues("security.network", { mode: "open", acknowledged: true }), { code: "INVALID_CONFIGURATION_INPUT" });
  const card = await h.propose({ mode: "open" }); assert.equal(card.autoApplyAt, undefined);
  assert.equal(card.securityConsent?.status, "required"); assert.equal(card.scope.kind, "global");
  await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card)), { code: "SECURITY_CONSENT_REQUIRED" });
  await assert.rejects(h.framework.confirmSecurity(h.session.id, card.id, { revision: card.revision, targetDigest: card.securityConsent!.targetDigest, acknowledged: false }), { code: "SECURITY_CONSENT_REQUIRED" });
  assert.deepEqual(h.store.getSandboxNetworkSettings(), before); assert.equal(h.store.getSession(h.session.id)!.permissionEpochId, epoch); assert.deepEqual(h.cleanups, []);
});

test("CFG-X10a: independent confirmation writes formal policy, rotates epochs once and preserves approval policy", async context => {
  const h = await harness(context);
  const epoch = h.store.getSession(h.session.id)!.permissionEpochId, siblingEpoch = h.store.getSession(h.sibling.id)!.permissionEpochId;
  const mode = h.store.getSession(h.session.id)!.approvalMode;
  const card = await h.propose({ mode: "domain-allowlist", allowedDomainsText: "EXAMPLE.ORG, *.example.com:443", allowPrivateNetwork: true });
  const confirmed = await consent(h.framework, card); assert.equal(confirmed.securityConsent?.status, "confirmed");
  await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card), undefined, "auto"), { code: "CONFIGURATION_AUTO_NOT_AUTHORIZED" });
  assert.equal(h.store.getSession(h.session.id)!.permissionEpochId, epoch);
  const applied = await h.framework.decide(h.session.id, card.id, approval(card));
  assert.equal(applied.state, "applied"); assert.equal(applied.activation.state, "active"); assert.equal(applied.activation.mode, "next_execution");
  assert.notEqual(h.store.getSession(h.session.id)!.permissionEpochId, epoch); assert.notEqual(h.store.getSession(h.sibling.id)!.permissionEpochId, siblingEpoch);
  assert.equal(h.store.getSession(h.session.id)!.approvalMode, mode);
  assert.ok(h.cleanups[0]!.includes(epoch) && h.cleanups[0]!.includes(siblingEpoch));
  const savedEpoch = h.store.getSession(h.session.id)!.permissionEpochId;
  await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(h.cleanups.length, 1); assert.equal(h.store.getSession(h.session.id)!.permissionEpochId, savedEpoch);
  const reopened = new SessionStore(h.root); await reopened.load();
  try { assert.deepEqual(reopened.getSandboxNetworkSettings(), h.store.getSandboxNetworkSettings()); } finally { reopened.close(); }
});

test("CFG-X10a: target/revision changes need fresh independent consent, while identical preview preserves exact consent", async context => {
  const h = await harness(context); const card = await h.propose({ mode: "open" });
  await assert.rejects(h.framework.confirmSecurity(h.session.id, card.id, { revision: card.revision + 1, targetDigest: card.securityConsent!.targetDigest, acknowledged: true }), { code: "STALE_SECURITY_CONSENT" });
  await consent(h.framework, card);
  const same = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { mode: "open" }, selectedOptionId: "persist" });
  assert.equal(same.securityConsent?.status, "confirmed");
  const edited = await h.framework.preview(h.session.id, card.id, { expectedRevision: same.revision, values: { mode: "open", allowPrivateNetwork: true }, selectedOptionId: "persist" });
  assert.equal(edited.securityConsent?.status, "required"); assert.notEqual(edited.securityConsent?.targetDigest, same.securityConsent?.targetDigest);
  await assert.rejects(h.framework.decide(h.session.id, card.id, approval(edited)), { code: "SECURITY_CONSENT_REQUIRED" });
});

test("CFG-X10a: validation and concurrent epoch/configuration changes cannot reuse an old security authorization", async context => {
  const h = await harness(context);
  const invalid: ConfigurationValues[] = [{ mode: "invalid" }, { mode: "domain-allowlist", allowedDomainsText: "https://example.org/path" }, { mode: "domain-allowlist" }, { mode: "open", allowedDomainsText: "example.org" }, { egressProxyPolicy: "proxy:missing" }];
  for (const values of invalid) await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  const card = await h.propose({ mode: "open" }); await consent(h.framework, card);
  await h.store.createSession(h.session.projectId, "Newly affected", {}, {}, { allowUnconfiguredModel: true });
  await assert.rejects(consent(h.framework, card), { code: "RESOURCE_VERSION_CONFLICT" });
  await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  const dismissedPreview = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" });
  const applyingAgain = await h.framework.preview(h.session.id, card.id, { expectedRevision: dismissedPreview.revision, values: { mode: "open" }, selectedOptionId: "persist" });
  assert.equal(applyingAgain.securityConsent?.status, "required", "Returning from dismissal must rebuild the security target against the new CAS vector");
  await assert.rejects(h.framework.decide(h.session.id, card.id, approval(applyingAgain)), { code: "SECURITY_CONSENT_REQUIRED" });
  assert.equal(h.store.getSandboxNetworkSettings().mode, "none");
});

test("CFG-X10a: dismissal, Stop and audit rollback cannot change the policy or epochs", async context => {
  const h = await harness(context); const original = h.store.getSession(h.session.id)!.permissionEpochId;
  let card = await h.propose({ mode: "open" });
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" });
  await h.framework.decide(h.session.id, card.id, { revision: card.revision, previewDigest: card.previewDigest!, decision: "dismiss", selectedOptionId: "dismiss" });
  await assert.rejects(h.store.runConfigurationTransaction(h.session.id, () => {
    h.store.applySecurityNetworkConfigurationSync({ mode: "open", allowedDomains: [], allowPrivateNetwork: false, egressProxyPolicy: "inherit" }); throw new Error("synthetic audit failure");
  }), /synthetic audit failure/);
  assert.equal(h.store.getSession(h.session.id)!.permissionEpochId, original);
  card = await h.propose({ mode: "open" }); await consent(h.framework, card); h.store.notifications.stop(h.session.id); await h.framework.tick();
  assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled"); assert.equal(h.store.getSandboxNetworkSettings().mode, "none");
});

test("CFG-X10a: failed runtime cleanup remains distinct from saved policy and retries without rotating again", async context => {
  const h = await harness(context); let unavailable = true;
  h.framework.options.securityNetworkCleanup = async () => { if (unavailable) throw new Error("synthetic runtime failure"); };
  const card = await h.propose({ mode: "open" }); await consent(h.framework, card);
  const applied = await h.framework.decide(h.session.id, card.id, approval(card));
  assert.equal(applied.state, "applied"); assert.equal(applied.activation.state, "failed"); assert.equal(h.store.getSandboxNetworkSettings().mode, "open");
  assert.ok(applied.allowedActions.includes("continue"), "A standalone policy must offer a runtime cleanup retry");
  const epoch = h.store.getSession(h.session.id)!.permissionEpochId;
  unavailable = false; const settled = await h.framework.settle(h.session.id, card.id);
  assert.equal(settled.activation.state, "active"); assert.equal(h.store.getSession(h.session.id)!.permissionEpochId, epoch);
});

test("CFG-X10a: bounded cleanup targets old epoch kernel identities and never a new kernel in the same Session", async () => {
  const kernel = (id: string, epoch: string) => ({ id, permissionEpochId: epoch, status: "running", sessionId: "same-session" } as KernelSession);
  const entries = [kernel("old", "old-epoch"), kernel("new", "new-epoch")]; const calls: string[] = [];
  const control = { listKernels: async () => entries, teardownKernel: async (id: string) => { calls.push(id); } };
  await retireSecurityNetworkKernels(control, ["old-epoch"]); assert.deepEqual(calls, ["old"]);
  calls.length = 0; await assert.rejects(retireSecurityNetworkKernels({ ...control, listKernels: async () => Array.from({ length: 9 }, (_, i) => kernel(String(i), "old-epoch")) }, ["old-epoch"]), /budget/);
  assert.equal(calls.length, 8);
});

test("CFG-X10a: missing cleanup support and non-global scopes reject before policy mutation", async context => {
  const h = await harness(context); const before = h.store.getSandboxNetworkSettings();
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "security.network", values: { mode: "open" }, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
  h.framework.options.securityNetworkCleanup = undefined;
  await assert.rejects(h.propose({ mode: "open" }), { code: "CONFIGURATION_BACKEND_UNSUPPORTED" });
  assert.deepEqual(h.store.getSandboxNetworkSettings(), before);
});

test("CFG-X10a: a long valid allowlist remains complete in the reviewed field while the diff stays bounded", async context => {
  const h = await harness(context);
  const domains = Array.from({ length: 80 }, (_, index) => `owned-long-domain-${index}.example.org`);
  const card = await h.propose({ mode: "domain-allowlist", allowedDomainsText: domains.join(", ") });
  const field = card.fields.find(field => field.id === "allowedDomainsText"); assert.ok(field && field.kind !== "credential");
  assert.equal(String(field.value).split(", ").length, 80);
  assert.ok(card.changes.every(change => (change.after?.length ?? 0) < 2000));
  await consent(h.framework, card); await h.framework.decide(h.session.id, card.id, approval(card));
  assert.equal(h.store.getSandboxNetworkSettings().allowedDomains.length, 80);
});
