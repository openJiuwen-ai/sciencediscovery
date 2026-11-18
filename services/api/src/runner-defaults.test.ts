// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { SessionStore } from "./store.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

async function fixture(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(".tmp/r"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "runners-"));
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  return { store, root };
}
function register(store: SessionStore, name: string) {
  return store.registerRemoteHost({ alias: name.replace(/\s+/g, "-"), runnerName: name, connectionKind: "direct",
    endpoint: { host: "127.0.0.1", port: 44444, protocol: "http" }, token: randomUUID(),
    capabilities: { conda: false, containerRuntimes: [], cpuCores: 1, cuda: null, gpu: null, memoryBytes: 1024,
      modules: false, nodeVersion: null, platform: "Linux", probedAt: new Date().toISOString(), runnerCommandAvailable: true, scratchPaths: [], slurm: false } });
}
function session(store: SessionStore, projectId: string) {
  return store.createSession(projectId, "Session", {}, {}, { allowUnconfiguredModel: true });
}

test("default projects and standalone sessions use all registered Runners, including later registrations", async context => {
  const { store, root } = await fixture(context);
  const project = await store.createProject("Default");
  const main = await session(store, project.id);
  const inbox = await store.ensureInboxProject();
  const standalone = await session(store, inbox.id);
  assert.deepEqual(store.effectiveRunnerIds(main.id), ["local"]);
  const first = await register(store, "GPU A");
  const second = await register(store, "GPU B");
  const expected = ["local", first.id, second.id];
  for (const id of [main.id, standalone.id]) {
    assert.deepEqual(store.effectiveRunnerIds(id), expected);
    assert.deepEqual(store.effectiveRemoteRunnerHosts(id).map(host => host.id), [first.id, second.id]);
    assert.deepEqual(store.configurationRunnerSelection(id).effectiveRunnerIds, expected.toSorted());
    store.assertSessionAllowsRunner(id, first.id);
  }
  assert.equal(store.getProject(project.id)?.runnerIds, undefined, "reads must not snapshot the default catalog into a fixed list");
  const reopened = new SessionStore(root); await reopened.load();
  try { assert.deepEqual(reopened.effectiveRunnerIds(main.id), expected); } finally { reopened.close(); }
});

test("explicit empty and legacy selections stay restrictive while inherited sessions follow the default catalog", async context => {
  const { store } = await fixture(context);
  const first = await register(store, "GPU A");
  const project = await store.createProject("Default"); const main = await session(store, project.id);
  await store.updateSession(main.id, { runnerIds: [] });
  await register(store, "GPU B");
  assert.deepEqual(store.effectiveRunnerIds(main.id), []);
  assert.throws(() => store.assertSessionAllowsRunner(main.id, first.id), /not allowed/);
  await store.updateSession(main.id, { runnerIds: null });
  assert.equal(store.effectiveRunnerIds(main.id).length, 3);
  await store.updateSession(main.id, { remoteRunnerHostIds: [] });
  assert.deepEqual(store.effectiveRunnerIds(main.id), ["local"]);
  await store.updateSession(main.id, { runnerIds: null });
  await store.updateProject(project.id, { remoteRunnerHostIds: [] });
  assert.deepEqual(store.effectiveRunnerIds(main.id), ["local"], "an explicit legacy Project write must not become the all-Runner default");
  await store.updateProject(project.id, { runnerIds: [] });
  assert.deepEqual(store.effectiveRunnerIds(main.id), []);
  const legacy = await store.createProject("Explicit legacy", {}, []);
  assert.deepEqual(store.effectiveRunnerIds((await session(store, legacy.id)).id), ["local"]);
});

test("malformed legacy selections cannot bypass validation when constructing a Project", async context => {
  const { store } = await fixture(context);
  await assert.rejects(store.createProject("Invalid", {}, { length: 0 } as unknown as string[]), /must be an array/);
  assert.equal(store.listProjects().length, 0);
});

test("default availability still rejects an unusable registered Runner at admission", async context => {
  const { store } = await fixture(context);
  const project = await store.createProject("Default"); const main = await session(store, project.id);
  const unprobed = await store.registerRemoteHost({ alias: "unprobed" });
  assert.ok(store.effectiveRunnerIds(main.id).includes(unprobed.id));
  assert.deepEqual(store.effectiveRemoteRunnerHosts(main.id), []);
  assert.throws(() => store.assertSessionAllowsRunner(main.id, unprobed.id), /cannot run this Session/);
});
