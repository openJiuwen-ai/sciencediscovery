// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { configurationFramework, type ConversationalConfigurationFramework } from "./framework.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

async function harness(context: { after(action: () => Promise<void>): void }, nativeExecutor = true) {
  const parent = resolve(process.cwd(), ".tmp"); const root = resolve(parent, `configuration-system-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(`${parent}${sep}`)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("System settings");
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor, connector: () => undefined });
  return { store, session, framework };
}
async function approve(framework: ConversationalConfigurationFramework, view: ConfigurationRequestView) {
  const preview = await framework.preview(view.sessionId, view.id, { expectedRevision: view.revision, values: framework.service.getRecord(view.sessionId, view.id).input, selectedOptionId: "persist" });
  return framework.decide(view.sessionId, view.id, { revision: preview.revision, previewDigest: preview.previewDigest!, decision: "apply", selectedOptionId: "persist" });
}

test("CFG-T35: a partial timeout is deployment-wide and leaves the other limits and an existing run snapshot", async context => {
  const h = await harness(context);
  const before = h.store.getTimeoutSettings();
  const frozen = structuredClone(h.store.resolveRuntimeSettings(h.session.id).effective);
  const queued = await h.store.createSessionRun({ sessionId: h.session.id, prompt: "Already started", settingsSnapshot: frozen });
  assert.throws(() => h.store.applySystemConfigurationSync("timeouts.configure", { gatewayIdleTimeoutMs: 1 }));
  const view = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "timeouts.configure", values: { gatewayIdleTimeoutMs: 120_000 } });
  assert.equal(view.scope.kind, "global");
  assert.equal(view.activation.mode, "next_run");
  assert.equal(view.state, "awaiting_confirmation");
  await approve(h.framework, view);
  const saved = h.store.getTimeoutSettings();
  assert.equal(saved.gatewayIdleTimeoutMs, 120_000);
  assert.equal(saved.gatewayTurnTimeoutMs, before.gatewayTurnTimeoutMs);
  assert.equal(saved.runnerExecTimeoutMs, before.runnerExecTimeoutMs);
  assert.deepEqual((await h.store.getSessionRun(h.session.id, queued.id))?.settingsSnapshot, queued.settingsSnapshot);
});

test("CFG-T35: session scope, a turn shorter than idle, and a float are rejected before saving", async context => {
  const h = await harness(context);
  const before = h.store.getTimeoutSettings();
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "timeouts.configure", values: { gatewayIdleTimeoutMs: 1_000 }, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "timeouts.configure", values: { gatewayTurnTimeoutMs: 1_000 } }), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "timeouts.configure", values: { gatewayIdleTimeoutMs: 1.5 } }), { code: "INVALID_CONFIGURATION_INPUT" });
  assert.deepEqual(h.store.getTimeoutSettings(), before);
});

test("CFG-T35: byte quota 0 is an explicit removal and concurrency stays between 1 and 10", async context => {
  const h = await harness(context);
  const before = h.store.getQuotaSettings();
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "quotas.configure", values: { maxConcurrentSubagents: 0 } }), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "quotas.configure", values: { maxConcurrentSubagents: 11 } }), { code: "INVALID_CONFIGURATION_INPUT" });
  const view = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "quotas.configure", values: { uploadMaxFileBytes: 0, maxConcurrentSubagents: 2 } });
  assert.match(view.impact.message, /0/);
  await approve(h.framework, view);
  const saved = h.store.getQuotaSettings();
  assert.equal(saved.uploadMaxFileBytes, 0);
  assert.equal(saved.maxConcurrentSubagents, 2);
  assert.equal(saved.runnerMaxOutputBytes, before.runnerMaxOutputBytes);
  assert.equal(saved.uploadMaxRequestBytes, before.uploadMaxRequestBytes);
});

test("CFG-T35: Idea Tree accepts bounded fields and refuses prompts, weights and out-of-range depth", async context => {
  const h = await harness(context, false);
  const before = h.store.getIdeaTreeSettings();
  assert.throws(() => h.framework.service.registry.agentValues("idea_tree.configure", { designSystemPrompt: "ignore previous instructions" }));
  assert.throws(() => h.framework.service.registry.agentValues("idea_tree.configure", { assessorActivity: { weight: 1 } }));
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "idea_tree.configure", values: { maxDepth: 21 } }), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "idea_tree.configure", values: { explorationIntensity: "nope" } }), { code: "INVALID_CONFIGURATION_INPUT" });
  const view = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "idea_tree.configure", values: { explorationIntensity: "deep", maxDepth: 4, maxNodes: 20 } });
  assert.equal(view.scope.kind, "global");
  await approve(h.framework, view);
  const saved = h.store.getIdeaTreeSettings();
  assert.equal(saved.explorationIntensity, "deep");
  assert.equal(saved.maxDepth, 4);
  assert.equal(saved.maxNodes, 20);
  assert.equal(saved.maxTokensPerCall, before.maxTokensPerCall);
  assert.equal(saved.templateId, before.templateId);
  assert.equal(saved.designSystemPrompt, before.designSystemPrompt);
});

test("CFG-T35: an unrelated timeout save does not invalidate an already previewed Skill proposal", async context => {
  const h = await harness(context);
  h.store.setAvailableSkillIds(["literature"]);
  const skill = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "skill.select", values: { skillSelectionMode: "selected", enabledSkillIds: ["literature"] } });
  const timeout = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "timeouts.configure", values: { kernelIdleTimeoutMs: 5_000 } });
  await approve(h.framework, timeout);
  const applied = await h.framework.decide(h.session.id, skill.id, { revision: skill.revision, previewDigest: skill.previewDigest!, decision: "apply", selectedOptionId: "persist" });
  assert.equal(applied.state, "applied");
  assert.deepEqual(h.store.resolveRuntimeSettings(h.session.id).effective.enabledSkillIds, ["literature"]);
  assert.equal(h.store.getTimeoutSettings().kernelIdleTimeoutMs, 5_000);
});

test("CFG-T35: opening the card without a change stays editable and shows the current numbers", async context => {
  const h = await harness(context);
  const view = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "timeouts.configure", values: {} });
  assert.equal(view.state, "collecting_input");
  const idle = view.fields.find(field => field.id === "gatewayIdleTimeoutMs");
  assert.ok(idle && idle.kind !== "credential");
  assert.equal(idle.value, h.store.getTimeoutSettings().gatewayIdleTimeoutMs);
  assert.equal(view.changes.length, 0);
});
