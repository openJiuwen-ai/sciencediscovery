// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { ConfigurationExternalCommitCoordinator } from "./external-commit.js";
import type { ConfigurationExternalControl, ConfigurationExternalOutcome } from "./types.js";
import { digest } from "./validation.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "external-commit-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const model = await store.createModel({ name: "Owned", model: "owned-model", baseUrl: "http://127.0.0.1:1/v1", apiToken: "synthetic-owned" }); await store.replaceGlobalSettings({});
  const project = await store.createProject("External control coordinator"), session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  const state = { version: digest("initial"), writes: 0, submits: 0, resolves: 0 }, journal = new Map<string, ConfigurationExternalOutcome>();
  const snapshot = store.configurationSnapshot.bind(store); store.configurationSnapshot = (sid, capability, target) => { const value = snapshot(sid, capability, target); return capability === "model.select" ? { ...value, resourceVersions: { external: state.version } } : value; };
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined }), adapter = framework.service.registry.get("model.select"), preview = adapter.preview;
  const authority: ConfigurationExternalControl = {
    submit: async operation => { const old = journal.get(operation.operationId); if (old) return old; state.writes++; state.version = digest(state.writes); const result = { ...operation, status: "applied" as const, resourceVersions: { external: state.version } }; journal.set(operation.operationId, result); return result; },
    resolve: async operation => { const old = journal.get(operation.operationId); if (old) return old; const result = { ...operation, status: "rejected" as const, code: "EXTERNAL_OPERATION_NOT_SAVED" }; journal.set(operation.operationId, result); return result; },
  };
  Object.assign(adapter, { persistence: "external_control", apply: undefined,
    preview: (...args: Parameters<typeof preview>) => ({ ...preview(...args), activationMode: "next_run" }),
    externalControl: { submit: async (...args: Parameters<ConfigurationExternalControl["submit"]>) => { state.submits++; return authority.submit(...args); }, resolve: async (...args: Parameters<ConfigurationExternalControl["resolve"]>) => { state.resolves++; return authority.resolve(...args); } },
  });
  const card = await framework.propose(session.id, { protocolVersion: 3, capabilityId: "model.select", values: { modelId: model.id } });
  const decision = { revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: "persist", decision: "apply" as const };
  const coordinator = () => new ConfigurationExternalCommitCoordinator(store, framework.repository, framework.service.registry, 2_000);
  const approve = () => framework.service.decide(session.id, card.id, decision);
  const get = () => framework.service.get(session.id, card.id), job = () => framework.repository.getOutbox(`${card.id}:${card.revision}:external_submit`)!;
  const due = () => { const item = job(); item.payload.nextAttemptAt = 0; item.payload.leaseUntil = 0; framework.repository.updateOutbox(item); };
  return { store, framework, adapter, authority, state, journal, session, card, decision, coordinator, approve, get, job, due };
}

test("CFG-T24/X03a: framework submits once, requires an authoritative receipt and replays without another external write", async context => {
  const h = await harness(context); const result = await h.framework.decide(h.session.id, h.card.id, h.decision); assert.equal(result.state, "applied"); assert.equal(result.activation.state, "needs_user_action");
  assert.equal(h.state.submits, 1); assert.equal(h.state.writes, 1); assert.ok(h.framework.repository.getReceipt(h.card.id, h.card.revision));
  await h.framework.decide(h.session.id, h.card.id, h.decision); await h.framework.tick(); assert.equal(h.state.submits, 1); assert.equal(h.state.writes, 1);
});

test("CFG-T24/X03a: lost response after a saved operation is resolved from the authority without a second submit", async context => {
  const h = await harness(context), submit = h.authority.submit; h.authority.submit = async (...args) => { await submit(...args); throw new Error("synthetic-secret-upstream-error"); };
  await h.approve(); await h.coordinator().settle(h.session.id, h.card.id); assert.equal(h.get().state, "applied"); assert.equal(h.state.submits, 1); assert.equal(h.state.resolves, 1); assert.equal(h.state.writes, 1); assert.doesNotMatch(JSON.stringify(h.get()), /synthetic-secret/u);
});

test("CFG-T24/X03a: unknown results remain unknown; restart/lease recovery only resolves the original operation", async context => {
  const h = await harness(context), submit = h.authority.submit, resolveOperation = h.authority.resolve; h.authority.submit = async (...args) => { await submit(...args); throw new Error("lost response"); }; h.authority.resolve = async () => { throw new Error("authority unavailable"); };
  await h.approve(); await h.coordinator().settle(h.session.id, h.card.id); assert.equal(h.get().state, "applying"); assert.equal(h.get().error?.code, "EXTERNAL_CONFIGURATION_OUTCOME_UNKNOWN"); assert.equal(h.framework.repository.getReceipt(h.card.id, h.card.revision), undefined); assert.equal(h.job().payload.submissionStarted, true);
  h.authority.resolve = resolveOperation; h.due(); await h.coordinator().settle(h.session.id, h.card.id); assert.equal(h.get().state, "applied"); assert.equal(h.state.submits, 1); assert.equal(h.state.writes, 1);
});

test("CFG-T24/X03a: Stop before first submission suppresses the write entirely", async context => {
  const h = await harness(context); await h.approve(); h.store.notifications.stop(h.session.id); await h.coordinator().settle(h.session.id, h.card.id);
  assert.equal(h.get().state, "cancelled"); assert.equal(h.job().state, "suppressed"); assert.equal(h.state.submits, 0); assert.equal(h.state.resolves, 0); assert.equal(h.state.writes, 0);
});

test("CFG-T24/X03a: a non-returning submit is bounded and leaves an unknown outcome without resubmission", async context => {
  const h = await harness(context); h.authority.submit = () => new Promise<ConfigurationExternalOutcome>(() => undefined); h.authority.resolve = async () => { throw new Error("authority unavailable"); };
  await h.approve(); const coordinator = new ConfigurationExternalCommitCoordinator(h.store, h.framework.repository, h.framework.service.registry, 20); await coordinator.settle(h.session.id, h.card.id);
  assert.equal(h.get().state, "applying"); assert.equal(h.get().error?.code, "EXTERNAL_CONFIGURATION_OUTCOME_UNKNOWN"); assert.equal(h.state.submits, 1); assert.equal(h.state.writes, 0); assert.equal(h.framework.repository.getReceipt(h.card.id, h.card.revision), undefined);
});

test("CFG-T24/X03a: Stop after submission preserves an honest saved receipt and suppresses activation/continuation", async context => {
  const h = await harness(context), submit = h.authority.submit; let release!: () => void, started!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  h.authority.submit = async (...args) => { started(); await gate; return submit(...args); }; await h.approve(); const work = h.coordinator().settle(h.session.id, h.card.id); await ready; h.store.notifications.stop(h.session.id); release(); await work;
  assert.equal(h.get().state, "applied"); assert.equal(h.get().activation.state, "suppressed"); assert.equal(h.get().resumption.state, "suppressed"); assert.equal(h.get().error?.code, "EXTERNAL_CONFIGURATION_SAVED_AFTER_STOP"); assert.equal(h.state.writes, 1); assert.ok(h.framework.repository.getReceipt(h.card.id, h.card.revision)); assert.equal(h.framework.repository.listOutbox({ kind: "activate" }).length, 0);
});

test("CFG-T24/X03a: a changed authoritative version before submission requires a new preview without a write", async context => {
  const h = await harness(context); await h.approve(); h.state.version = digest("concurrent-edit"); await h.coordinator().settle(h.session.id, h.card.id); assert.equal(h.get().state, "stale"); assert.equal(h.state.submits, 0); assert.equal(h.state.writes, 0);
});

test("CFG-T24/X03a: an intent without a submission is resolved to a fenced rejection; a late submit cannot apply", async context => {
  const h = await harness(context); await h.approve(); const item = h.job(); item.payload.submissionStarted = true; h.framework.repository.updateOutbox(item); await h.coordinator().settle(h.session.id, h.card.id);
  assert.equal(h.get().state, "failed"); assert.equal(h.state.submits, 0); const rejected = [...h.journal.values()][0]!; const late = await h.authority.submit({ operationId: rejected.operationId, bindingDigest: rejected.bindingDigest }, {} as Parameters<ConfigurationExternalControl["submit"]>[1]); assert.equal(late.status, "rejected"); assert.equal(h.state.writes, 0);
});

test("CFG-T24/X03a: a failed SQLite receipt is recovered from the external journal rather than resubmitted", async context => {
  const h = await harness(context); await h.approve(); const save = h.framework.repository.saveReceipt.bind(h.framework.repository); h.framework.repository.saveReceipt = () => { throw new Error("synthetic receipt failure"); };
  await assert.rejects(h.coordinator().settle(h.session.id, h.card.id)); assert.equal(h.state.writes, 1); assert.equal(h.get().state, "applying"); h.framework.repository.saveReceipt = save; h.due(); await h.coordinator().settle(h.session.id, h.card.id); assert.equal(h.get().state, "applied"); assert.equal(h.state.submits, 1); assert.equal(h.state.resolves, 1); assert.equal(h.state.writes, 1);
});

test("CFG-T24/X03a: a mismatched response cannot manufacture a saved receipt", async context => {
  const h = await harness(context); h.authority.submit = async operation => ({ ...operation, bindingDigest: digest("wrong binding"), status: "applied", resourceVersions: { external: h.state.version } }); await h.approve(); await h.coordinator().settle(h.session.id, h.card.id); assert.equal(h.get().state, "applying"); assert.equal(h.get().error?.code, "EXTERNAL_CONFIGURATION_OUTCOME_UNKNOWN"); assert.equal(h.framework.repository.getReceipt(h.card.id, h.card.revision), undefined);
});

test("CFG-T24/X03a: overlapping coordinator workers share the durable lease and issue only one submission", async context => {
  const h = await harness(context), submit = h.authority.submit; let release!: () => void, started!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  h.authority.submit = async (...args) => { started(); await gate; return submit(...args); }; await h.approve(); const work = h.coordinator().settle(h.session.id, h.card.id); await ready; await h.coordinator().settle(h.session.id, h.card.id); release(); await work; assert.equal(h.state.submits, 1); assert.equal(h.state.writes, 1); assert.equal(h.get().state, "applied");
});
