// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { CONFIGURATION_AGENT_DESCRIPTORS } from "./agent-metadata.js";
import { verifyNativeConfigurationToolAssembly } from "./native-activation.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function fixture(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "continuation-copy-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Continuation contract"), session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const run = await store.createSessionRun({ sessionId: session.id, prompt: "Owned configuration diagnostic", settingsSnapshot: store.resolveRuntimeSettings(session.id).effective });
  const scheduled: Array<{ sessionId: string; requestId: string }> = [];
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined, resume: async (sessionId, requestId) => { scheduled.push({ sessionId, requestId }); return run; } });
  return { store, session, run, framework, scheduled };
}

test("CFG-XE2E-04: proxy.resources continues its bound task using the approved receipt", async context => {
  const h = await fixture(context);
  const frozen = structuredClone(h.run.settingsSnapshot);
  const card = await h.framework.propose(h.session.id, {
    protocolVersion: 3, runId: h.run.id, capabilityId: "proxy.resources", values: { operation: "create", name: "Owned continuation proxy", kind: "environment" },
  });
  const applied = await h.framework.decide(h.session.id, card.id, {
    revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply",
  });
  assert.equal(applied.activation.mode, "next_connection");
  assert.equal(applied.activation.state, "needs_user_action");
  assert.equal(applied.resumption.state, "queued");
  assert.deepEqual(h.scheduled, [{ sessionId: h.session.id, requestId: card.id }]);
  assert.doesNotThrow(() => verifyNativeConfigurationToolAssembly({ store: h.store, sessionId: h.session.id, runId: h.run.id, requestId: card.id, enabledConnectorIds: [], tools: [] }));
  assert.deepEqual((await h.store.getSessionRun(h.session.id, h.run.id))?.settingsSnapshot, frozen);
});

test("CFG-X09a: saving a bound Reviewer setting resumes the task without changing its snapshot", async context => {
  const h = await fixture(context);
  await h.store.updateReviewerSpecialistSettings({ enabled: true });
  const frozen = structuredClone(h.run.settingsSnapshot);
  const card = await h.framework.propose(h.session.id, {
    protocolVersion: 3, runId: h.run.id, capabilityId: "reviewer.enable", values: { enabled: false },
  });
  assert.ok(card.previewDigest);
  const decision = { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: "persist", decision: "apply" as const };
  const applied = await h.framework.decide(h.session.id, card.id, decision);
  assert.equal(applied.activation.mode, "next_request");
  assert.equal(applied.activation.state, "needs_user_action");
  assert.equal(applied.resumption.state, "queued");
  await h.framework.decide(h.session.id, card.id, decision);
  assert.deepEqual(h.scheduled, [{ sessionId: h.session.id, requestId: card.id }]);
  verifyNativeConfigurationToolAssembly({ store: h.store, sessionId: h.session.id, runId: h.run.id, requestId: card.id, enabledConnectorIds: [], tools: [] });
  assert.deepEqual((await h.store.getSessionRun(h.session.id, h.run.id))?.settingsSnapshot, frozen);
});

test("CFG-XBUG-09: future-setting copy permits only its bound original continuation and preserves the recorded task settings on replay", async context => {
  const h = await fixture(context), frozen = structuredClone(h.run.settingsSnapshot);
  const card = await h.framework.propose(h.session.id, { protocolVersion: 3, runId: h.run.id, capabilityId: "timeouts.configure", values: { runnerExecTimeoutMs: 90000 } });
  assert.match(card.impact.message, /original configuration task already bound/); assert.match(card.impact.message, /frozen task settings/);
  const decision = { revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const };
  const applied = await h.framework.decide(h.session.id, card.id, decision); assert.equal(applied.activation.mode, "next_run"); assert.equal(applied.activation.state, "needs_user_action"); assert.equal(applied.resumption.state, "queued");
  assert.deepEqual(h.scheduled, [{ sessionId: h.session.id, requestId: card.id }]); await h.framework.decide(h.session.id, card.id, decision); assert.equal(h.scheduled.length, 1);
  assert.deepEqual((await h.store.getSessionRun(h.session.id, h.run.id))?.settingsSnapshot, frozen); assert.equal((await h.store.listSessionRuns(h.session.id)).length, 1);
});
test("CFG-XBUG-09: an independent setting has no original task to continue and metadata never promises no continuation for a bound wait", async context => {
  const h = await fixture(context); const card = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "quotas.configure", values: { maxConcurrentSubagents: 2 } });
  await h.framework.decide(h.session.id, card.id, { revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" }); assert.equal(h.scheduled.length, 0);
  for (const id of ["timeouts.configure", "quotas.configure"] as const) {
    assert.match(CONFIGURATION_AGENT_DESCRIPTORS[id].whenNeeded, /original configuration task already bound/);
    assert.doesNotMatch(CONFIGURATION_AGENT_DESCRIPTORS[id].whenNeeded, /does not resume the active run/);
  }
});
