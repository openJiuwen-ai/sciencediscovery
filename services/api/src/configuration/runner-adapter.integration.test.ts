// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView, ConfigurationScope, ConfigurationValues } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { configurationFramework, type ConversationalConfigurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"); const root = resolve(parent, `configuration-runners-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(`${parent}${sep}`)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const host = await store.registerRemoteHost({ alias: "private-address-should-not-be-projected", runnerName: "Owned runner", connectionKind: "direct",
    endpoint: { host: "127.0.0.1", port: 44444, protocol: "http" }, token: "synthetic-runner-credential",
    capabilities: { conda: false, containerRuntimes: [], cpuCores: 1, cuda: null, gpu: null, memoryBytes: 1024, modules: false,
      nodeVersion: null, platform: "Linux", probedAt: new Date().toISOString(), runnerCommandAvailable: true, scratchPaths: [], slurm: false } });
  const project = await store.createProject("Runner selection", undefined, [host.id]);
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const sibling = await store.createSession(project.id, "Sibling", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: ConfigurationValues, scope?: ConfigurationScope) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "runner.assign", values, ...(scope ? { scope } : {}) });
  return { store, root, project, session, sibling, host, framework, propose };
}
async function decide(framework: ConversationalConfigurationFramework, view: ConfigurationRequestView, option = "persist") {
  const preview = await framework.preview(view.sessionId, view.id, { expectedRevision: view.revision, values: framework.service.getRecord(view.sessionId, view.id).input, selectedOptionId: option });
  const input = { revision: preview.revision, previewDigest: preview.previewDigest!, decision: option === "persist" ? "apply" as const : "dismiss" as const, selectedOptionId: option };
  return { view: await framework.decide(view.sessionId, view.id, input), input };
}

test("CFG-X06: explicit Runner IDs take precedence over stale legacy host IDs", async context => {
  const h = await harness(context);
  const updated = await h.store.updateSession(h.session.id, { runnerIds: [h.host.id], remoteRunnerHostIds: ["no-longer-registered"] });
  assert.deepEqual(updated.runnerIds, [h.host.id]);
  assert.deepEqual(updated.remoteRunnerHostIds, [h.host.id]);
  await assert.rejects(h.store.updateSession(h.session.id, { remoteRunnerHostIds: ["no-longer-registered"] }));
});

test("CFG-X06: discovery and preview do not read host credentials or expose addresses", async context => {
  const h = await harness(context);
  const getRemoteHost = h.store.getRemoteHost.bind(h.store);
  h.store.getRemoteHost = () => { throw new Error("Credential-decrypting host description is forbidden here"); };
  h.store.listRemoteHosts = () => { throw new Error("Credential-decrypting host descriptions are forbidden here"); };
  const found = await discoverConfiguration(h.store, h.session.id, "", "search", { query: "分配运行器" });
  assert.ok((found.items as Array<{ capabilityId?: string }>).some(item => item.capabilityId === "runner.assign"));
  const detail = await discoverConfiguration(h.store, h.session.id, "", "describe", { capabilityId: "runner.assign" });
  assert.doesNotMatch(JSON.stringify(detail), /private-address|127\.0\.0\.1|synthetic-runner-credential/);
  const card = await h.propose({}); assert.equal(card.state, "collecting_input");
  const revision = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { runnerIds: [h.host.id] }, selectedOptionId: "persist" });
  // After explicit confirmation the formal domain still validates credential usability.
  h.store.getRemoteHost = getRemoteHost;
  const applied = await h.framework.decide(h.session.id, card.id, { revision: revision.revision, previewDigest: revision.previewDigest!, decision: "apply", selectedOptionId: "persist" });
  assert.equal(applied.state, "applied"); assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), [h.host.id]);
});

test("CFG-X06: an explicit empty Session list disables Runners, persists, and does not rewrite queued settings", async context => {
  const h = await harness(context);
  const run = await h.store.createSessionRun({ sessionId: h.session.id, prompt: "Already queued", settingsSnapshot: h.store.resolveRuntimeSettings(h.session.id).effective });
  const before = h.store.getSession(h.session.id)!;
  const card = await h.propose({ runnerIds: [] });
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), ["local", h.host.id]);
  const applied = await decide(h.framework, card);
  assert.equal(applied.view.state, "applied"); assert.equal(applied.view.autoApplyAt, undefined);
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), []);
  assert.deepEqual(h.store.effectiveRunnerIds(h.sibling.id), ["local", h.host.id]);
  assert.deepEqual(h.store.getSession(h.session.id)!.settingsOverrides, before.settingsOverrides);
  assert.deepEqual((await h.store.getSessionRun(h.session.id, run.id))?.settingsSnapshot, run.settingsSnapshot);
  const receipt = h.framework.repository.getReceipt(card.id, applied.view.revision);
  await h.framework.decide(h.session.id, card.id, applied.input);
  assert.deepEqual(h.framework.repository.getReceipt(card.id, applied.view.revision), receipt);
  const reopened = new SessionStore(h.root); await reopened.load();
  try { assert.deepEqual(reopened.effectiveRunnerIds(h.session.id), []); } finally { reopened.close(); }
});

test("CFG-X06: restoring Session inheritance clears both unified and legacy overrides", async context => {
  const h = await harness(context);
  await h.store.updateSession(h.session.id, { runnerIds: [] });
  const card = await h.propose({ selectionMode: "inherit" });
  await decide(h.framework, card);
  assert.equal(h.store.getSession(h.session.id)!.runnerIds, undefined);
  assert.equal(h.store.getSession(h.session.id)!.remoteRunnerHostIds, undefined);
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), ["local", h.host.id]);
  await assert.rejects(h.propose({ selectionMode: "inherit" }), { code: "CONFIGURATION_NO_CHANGE" });
});

test("CFG-X06: conversational allocation interoperates with legacy formal remote-only selections", async context => {
  const h = await harness(context);
  await h.store.updateSession(h.session.id, { remoteRunnerHostIds: [h.host.id] });
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), ["local", h.host.id]);
  await decide(h.framework, await h.propose({ runnerIds: [h.host.id] }));
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), [h.host.id]);
  await h.store.updateSession(h.session.id, { remoteRunnerHostIds: [] });
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), ["local"]);
  await assert.rejects(h.store.updateSession(h.session.id, { remoteRunnerHostIds: ["missing"] }));
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), ["local"]);
  await decide(h.framework, await h.propose({ selectionMode: "inherit" }));
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), ["local", h.host.id]);
});

test("CFG-X06: Project defaults affect inheriting sessions and preserve explicit Session overrides", async context => {
  const h = await harness(context);
  await h.store.updateSession(h.sibling.id, { runnerIds: ["local"] });
  const card = await h.propose({ runnerIds: [h.host.id] }, { kind: "project", id: h.project.id });
  assert.equal(card.scope.kind, "project"); await decide(h.framework, card);
  assert.deepEqual(h.store.getProject(h.project.id)!.runnerIds, [h.host.id]);
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), [h.host.id]);
  assert.deepEqual(h.store.effectiveRunnerIds(h.sibling.id), ["local"]);
});

test("CFG-X06: unknown IDs, inconsistent modes, global/cross-owner scopes and old protocol fail closed", async context => {
  const h = await harness(context);
  const invalid: ConfigurationValues[] = [{ runnerIds: ["local", "local"] }, { runnerIds: [" "] }, { selectionMode: "selected" }, { selectionMode: "inherit", runnerIds: ["local"] }, { token: "forbidden" }];
  for (const values of invalid) await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  await assert.rejects(h.propose({ runnerIds: ["not-registered"] }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
  const unready = await h.store.registerRemoteHost({ alias: "unready-owned-host" });
  await assert.rejects(h.propose({ runnerIds: [unready.id] }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
  await assert.rejects(h.propose({ selectionMode: "inherit" }, { kind: "project", id: h.project.id }), { code: "INVALID_CONFIGURATION_INPUT" });
  for (const scope of [{ kind: "global" as const }, { kind: "session" as const, id: h.sibling.id }, { kind: "project" as const, id: "other" }]) await assert.rejects(h.propose({ runnerIds: [] }, scope));
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "runner.assign", values: {} }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), ["local", h.host.id]);
});

test("CFG-X06: concurrent Project or Session allocation fences the old approval", async context => {
  for (const scope of ["project", "session", "registry"]) {
    const h = await harness(context); const card = await h.propose({ runnerIds: [] });
    if (scope === "project") await h.store.updateProject(h.project.id, { runnerIds: [h.host.id] });
    else if (scope === "session") await h.store.updateSession(h.session.id, { runnerIds: [h.host.id] });
    else await h.store.registerRemoteHost({ alias: "new-owned-host" });
    await assert.rejects(h.framework.decide(h.session.id, card.id, { revision: card.revision, previewDigest: card.previewDigest!, decision: "apply", selectedOptionId: "persist" }), { code: "RESOURCE_VERSION_CONFLICT" });
    assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), scope === "registry" ? ["local", h.host.id] : [h.host.id]);
  }
});

test("CFG-X06: dismissal, Stop and transaction rollback cannot change Runner admission", async context => {
  const h = await harness(context); const before = h.store.effectiveRunnerIds(h.session.id);
  await decide(h.framework, await h.propose({ runnerIds: [] }), "dismiss");
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), before);
  await assert.rejects(h.store.runConfigurationTransaction(h.session.id, () => {
    h.store.applyRunnerConfigurationSync(h.session.id, { kind: "session", id: h.session.id }, "selected", []);
    throw new Error("synthetic audit failure");
  }), /synthetic audit failure/);
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), before);
  const card = await h.propose({ runnerIds: [] }); h.store.notifications.stop(h.session.id); await h.framework.tick();
  assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled");
  assert.deepEqual(h.store.effectiveRunnerIds(h.session.id), before);
});
