// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { SessionStore } from "./store.js";

function requiredSession(store: SessionStore, id: string) {
  const session = store.getSession(id);
  assert.ok(session, "session must remain accessible");
  return session;
}

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "sd-model-selection-"));
  const state = { store: new SessionStore(root) };
  await state.store.load();
  context.after(async () => { state.store.close(); await rm(root, { recursive: true, force: true }); });
  const make = (name: string) => state.store.createModel({ name, model: name, baseUrl: "https://models.example.test/v1", apiToken: randomUUID() });
  const a = await make("A"), b = await make("B"), c = await make("C");
  const project = await state.store.createProject("Model selection");
  const reopen = async () => { state.store.close(); state.store = new SessionStore(root); await state.store.load(); };
  return { state, a, b, c, project, reopen };
}

test("deleting a primary model migrates inherited sessions but blocks explicit choices across restart", async context => {
  const { state, a, b, project, reopen } = await fixture(context);
  const inherited = await state.store.createSession(project.id, "Inherited");
  const explicit = await state.store.createSession(project.id, "Explicit", { modelId: a.id });
  await state.store.deleteModel(a.id, b.id);
  const check = () => {
    assert.equal(state.store.getGlobalSettings().overrides.modelId, b.id);
    assert.equal(requiredSession(state.store, inherited.id).modelId, b.id);
    assert.equal(requiredSession(state.store, explicit.id).modelId, undefined);
    assert.equal(requiredSession(state.store, explicit.id).settingsOverrides.modelId, a.id);
    assert.equal(state.store.resolveRuntimeSettings(explicit.id).effective.modelId, undefined);
    assert.equal(state.store.resolveRuntimeSettings(explicit.id).sources.modelId, "session");
  };
  check(); await reopen(); check();
  await state.store.updateSession(explicit.id, { modelId: b.id });
  assert.equal(requiredSession(state.store, explicit.id).modelId, b.id);
});

test("a deleted explicit model blocks an already configured project and global model", async context => {
  const { state, a, b, c, project, reopen } = await fixture(context);
  await state.store.replaceGlobalSettings({ modelId: c.id });
  await state.store.replaceProjectSettings(project.id, { modelId: b.id });
  const session = await state.store.createSession(project.id, "Explicit A", { modelId: a.id });
  await state.store.deleteModel(a.id);
  assert.equal(state.store.resolveRuntimeSettings(session.id).effective.modelId, undefined);
  await reopen();
  assert.equal(state.store.resolveRuntimeSettings(session.id).effective.modelId, undefined);
  await state.store.replaceSessionSettings(session.id, {});
  assert.equal(requiredSession(state.store, session.id).modelId, b.id);
});

test("clearing all model overrides never resurrects a compatibility mirror", async context => {
  const { state, a, project, reopen } = await fixture(context);
  const session = await state.store.createSession(project.id, "Clear", { modelId: a.id });
  await state.store.replaceSessionSettings(session.id, {});
  await state.store.replaceGlobalSettings({});
  assert.equal(requiredSession(state.store, session.id).modelId, undefined);
  assert.equal(state.store.resolveRuntimeSettings(session.id).effective.modelId, undefined);
  await reopen();
  assert.equal(requiredSession(state.store, session.id).modelId, undefined);
  assert.equal(state.store.resolveRuntimeSettings(session.id).effective.modelId, undefined);
});

test("invalid replacement and failed deletion preserve catalog and credentials atomically", async context => {
  const { state, a, b, project, reopen } = await fixture(context);
  const before = state.store.getModelApiToken(a.id);
  const session = await state.store.createSession(project.id, "Inherited");
  for (const replacement of [a.id, randomUUID()]) {
    await assert.rejects(state.store.deleteModel(a.id, replacement), /Replacement/);
    assert.equal(state.store.getGlobalSettings().overrides.modelId, a.id);
    assert.equal(state.store.getModelApiToken(a.id), before);
  }
  const database = state.store.getConfigurationDatabase();
  database.exec("CREATE TEMP TRIGGER fail_model_delete BEFORE UPDATE ON catalog_state BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END");
  await assert.rejects(state.store.deleteModel(a.id, b.id), /injected deletion failure/);
  database.exec("DROP TRIGGER fail_model_delete");
  assert.equal(state.store.getModelApiToken(a.id), before);
  assert.equal(requiredSession(state.store, session.id).modelId, a.id);
  await reopen();
  assert.equal(state.store.getGlobalSettings().overrides.modelId, a.id);
  assert.equal(state.store.getModelApiToken(a.id), before);
});

test("a stale deletion confirmation cannot change another window's primary model", async context => {
  const { state, a, b, c } = await fixture(context);
  await state.store.replaceGlobalSettings({ modelId: c.id });
  await state.store.deleteModel(a.id, b.id);
  assert.equal(state.store.getGlobalSettings().overrides.modelId, c.id);
});

test("unavailable choices allow unrelated edits but reject new unknown references", async context => {
  const { state, a, b, project } = await fixture(context);
  const session = await state.store.createSession(project.id, "Editable", { modelId: a.id, reviewModelId: a.id });
  await state.store.deleteModel(a.id, b.id);
  await state.store.updateSession(session.id, { title: "Renamed", thinkingMode: "auto" });
  assert.equal(requiredSession(state.store, session.id).settingsOverrides.modelId, a.id);
  await assert.rejects(state.store.updateSession(session.id, { modelId: randomUUID() }), /existing model/);
  await state.store.replaceSessionSettings(session.id, { ...requiredSession(state.store, session.id).settingsOverrides, semanticReviewEnabled: false });
  assert.equal(state.store.resolveRuntimeSettings(session.id).effective.modelId, undefined);
});

test("provider deletion replaces only its default and keeps explicit choices unavailable", async context => {
  const { state, b, project, reopen } = await fixture(context);
  const provider = await state.store.createProvider({ name: "Provider", baseUrl: "https://models.example.test/v1", apiProtocol: "openai-chat-completions", apiVariant: "openai", modelDiscovery: "openai-models", apiToken: randomUUID() });
  const model = await state.store.materializeProviderModel(provider.id, "gpt-4o-mini");
  await state.store.replaceGlobalSettings({ modelId: model.id, reviewModelId: model.id });
  const session = await state.store.createSession(project.id, "Provider choice", { modelId: model.id });
  await state.store.deleteProvider(provider.id, b.id);
  assert.equal(state.store.getGlobalSettings().overrides.modelId, b.id);
  assert.equal(state.store.getGlobalSettings().overrides.reviewModelId, undefined);
  assert.equal(requiredSession(state.store, session.id).modelId, undefined);
  await reopen();
  assert.equal(requiredSession(state.store, session.id).settingsOverrides.modelId, model.id);
  assert.equal(requiredSession(state.store, session.id).modelId, undefined);
});

test("leaving the primary unset survives restart and profile edits", async context => {
  const { state, a, b, project, reopen } = await fixture(context);
  const session = await state.store.createSession(project.id, "Inherited");
  await state.store.deleteModel(a.id, null);
  await state.store.updateModel(b.id, { name: "Renamed B", model: b.model, baseUrl: b.baseUrl });
  await reopen();
  assert.equal(state.store.getGlobalSettings().overrides.modelId, undefined);
  assert.equal(requiredSession(state.store, session.id).modelId, undefined);
});


test("connecting the first model updates existing inherited unconfigured sessions", async context => {
  const root = await mkdtemp(join(tmpdir(), "sd-first-model-"));
  const store = new SessionStore(root);
  context.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await store.load();
  const project = await store.createProject("First model");
  const session = await store.createSession(project.id, "Waiting for setup", {}, {}, { allowUnconfiguredModel: true });
  const model = await store.createModel({ name: "First", model: "first", baseUrl: "https://models.example.test/v1", apiToken: randomUUID() });
  assert.equal(requiredSession(store, session.id).modelId, model.id);
  assert.equal(requiredSession(store, session.id).settingsOverrides.modelId, undefined);
});


test("deleting a model keeps historical run snapshots intact", async context => {
  const { state, a, b, project, reopen } = await fixture(context);
  const session = await state.store.createSession(project.id, "Historical", { modelId: a.id });
  const run = await state.store.createSessionRun({ sessionId: session.id, prompt: "Historical work", settingsSnapshot: state.store.resolveRuntimeSettings(session.id).effective });
  await state.store.updateSessionRun(session.id, run.id, { status: "completed" });
  await state.store.deleteModel(a.id, b.id);
  await reopen();
  assert.deepEqual((await state.store.getSessionRun(session.id, run.id))?.settingsSnapshot, run.settingsSnapshot);
  assert.equal(requiredSession(state.store, session.id).modelId, undefined);
});
