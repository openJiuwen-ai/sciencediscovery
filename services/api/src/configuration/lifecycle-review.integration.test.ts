// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { ConversationalConfigurationFramework } from "./framework.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

async function fixture(context: { after(work: () => Promise<void>): void }) {
  const root = resolve(tmpdir(), `cfg-review-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  const project = await store.createProject("Affected project");
  const elsewhere = await store.createProject("Other project");
  const session = await store.createSession(project.id, "Source", {}, {}, { allowUnconfiguredModel: true });
  const sibling = await store.createSession(project.id, "Sibling", {}, {}, { allowUnconfiguredModel: true });
  const other = await store.createSession(elsewhere.id, "Elsewhere", {}, {}, { allowUnconfiguredModel: true });
  const stores = [store];
  context.after(async () => {
    for (const item of stores) {
      item.close();
    }
    await rm(root, { recursive: true, force: true });
  });
  const updates = new Map<string, number>();
  for (const item of [session, sibling, other]) {
    store.plugins.subscribe({ projectId: item.projectId, sessionId: item.id }, () => updates.set(item.id, (updates.get(item.id) ?? 0) + 1));
  }
  const framework = new ConversationalConfigurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  return { store, stores, root, project, session, sibling, other, updates, framework };
}

test("CFG-R08 project writes notify all affected sessions and leave queued run snapshots unchanged", async context => {
  const f = await fixture(context); f.store.setAvailableSkillIds(["review-skill"]);
  const before = f.store.getSessionSettings(f.session.id).effective;
  const run = await f.store.createSessionRun({ sessionId: f.session.id, prompt: "Frozen task", settingsSnapshot: before });
  await f.store.runConfigurationTransaction(f.session.id, () => f.store.applyP1ConfigurationSync(f.session.id, "skill.select",
    { skillSelectionMode: "selected", enabledSkillIds: ["review-skill"] }, { kind: "project", id: f.project.id }));
  assert.equal(f.updates.get(f.session.id), 1); assert.equal(f.updates.get(f.sibling.id), 1); assert.equal(f.updates.get(f.other.id), undefined);
  assert.deepEqual(f.store.getSessionSettings(f.sibling.id).effective.enabledSkillIds, ["review-skill"]);
  assert.deepEqual((await f.store.getSessionRun(f.session.id, run.id))!.settingsSnapshot.enabledSkillIds, before.enabledSkillIds);
});

test("CFG-R08 first global model notifies other projects and credential repair only notifies actual profile users", async context => {
  const f = await fixture(context);
  const { modelId } = await f.store.runConfigurationTransaction(f.session.id, () => f.store.applyConfigurationDomainSync(f.session.id, "model.connect",
    { name: "First model", model: "fixture-model", baseUrl: "https://api.openai.com/v1", apiProtocol: "openai-chat-completions", apiVariant: "openai" }, "first-key"));
  assert.ok(modelId);
  for (const item of [f.session, f.sibling, f.other]) assert.equal(f.updates.get(item.id), 1);
  const independent = await f.store.createModel({ name: "Other model", model: "independent", baseUrl: "https://api.openai.com/v1", apiToken: "other-key" });
  await f.store.replaceSessionSettings(f.other.id, { modelId: independent.id });
  f.updates.clear();
  await f.store.runConfigurationTransaction(f.session.id, () => f.store.applyConfigurationDomainSync(f.session.id, "model.repair_credential", { modelId }, "replacement-key"));
  assert.equal(f.updates.get(f.session.id), 1); assert.equal(f.updates.get(f.sibling.id), 1); assert.equal(f.updates.get(f.other.id), undefined);
  assert.equal(f.store.getModelApiToken(independent.id), "other-key");
});

test("CFG-R09 no-run requests persist one timeline identity through preview, decision and restart", async context => {
  const f = await fixture(context); f.store.setAvailableSkillIds(["review-skill"]);
  const proposal = await f.framework.propose(f.session.id, { protocolVersion: 3, capabilityId: "skill.select", values: { skillSelectionMode: "selected", enabledSkillIds: ["review-skill"] } });
  assert.equal(proposal.runId, undefined);
  const preview = await f.framework.preview(f.session.id, proposal.id, { expectedRevision: proposal.revision, selectedOptionId: "dismiss", values: {} });
  await f.framework.decide(f.session.id, proposal.id, { revision: preview.revision, previewDigest: preview.previewDigest!, decision: "dismiss", selectedOptionId: "dismiss" });
  const messages = (await f.store.readMessages(f.session.id)).filter(item => item.configurationRequestId === proposal.id);
  assert.equal(messages.length, 1); assert.equal(messages[0]!.kind, "configuration_notice");
  const reopened = new SessionStore(f.root); f.stores.push(reopened); await reopened.load();
  assert.deepEqual((await reopened.readMessages(f.session.id)).filter(item => item.configurationRequestId === proposal.id), messages);
});

test("CFG-R02/09 deleting a session removes its endpoint consent and timeline work", async context => {
  const f = await fixture(context);
  const proposal = await f.framework.propose(f.session.id, { capabilityId: "model.connect", values: { name: "Gateway", model: "fixture", baseUrl: "https://gateway.example.test/v1", tokenOptional: true } });
  await f.framework.confirmEndpoint(f.session.id, proposal.id, { revision: proposal.revision, endpointTarget: proposal.endpointAuthorization!.endpointTarget });
  const db = f.store.getConfigurationDatabase();
  assert.equal((db.prepare("SELECT count(*) AS n FROM configuration_endpoint_consents WHERE session_id=?").get(f.session.id) as { n: number }).n, 1);
  await f.store.deleteSession(f.session.id, f.session.id);
  assert.equal((db.prepare("SELECT count(*) AS n FROM configuration_endpoint_consents WHERE session_id=?").get(f.session.id) as { n: number }).n, 0);
  assert.equal(f.framework.repository.list(f.session.id).length, 0);
  assert.equal(f.framework.repository.pendingNotices().some(item => item.session_id === f.session.id), false);
});
