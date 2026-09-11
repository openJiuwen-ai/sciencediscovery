// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { SessionStore } from "./store.js";
import { manageRunnerEnvironment, runnerWorkspaceBindings, runnerTarget } from "./runner-management.js";

test("remote environment management forwards every operation without writing into the local catalog", async () => {
  const calls: Array<[string, unknown[]]> = [];
  const methods = ["getEnvironmentSetup", "setupScientificEnvironments", "listEnvironmentRevisions", "listEnvironments", "createEnvironment", "installEnvironment", "uninstallEnvironment", "deleteEnvironment"];
  const runner = Object.fromEntries(methods.map((name) => [name, async (...args: unknown[]) => { calls.push([name, args]); return name === "listEnvironments" ? [{ id: "env" }] : { id: "revision" }; }])) as unknown as RunnerClient;
  const store = { getEnvironmentSourceSettings: () => ({ condaSource: "upstream", pipSource: "upstream" }) } as SessionStore;
  for (const [path, method] of [["environment-setup", "GET"], ["environment-setup", "POST"], ["environment-revisions", "GET"], ["environments", "GET"], ["environments", "POST"], ["environments/env/install", "POST"], ["environments/env/uninstall", "POST"], ["environments/env", "DELETE"]]) {
    await manageRunnerEnvironment(runner, store, path!, method!, { name: "analysis", language: "r", packages: ["numpy"], manager: "conda", workspaceRoot: "untrusted", runnerWorkspaceKey: "untrusted" });
  }
  assert.deepEqual(calls.map(([name]) => name), [...methods.slice(0, 6), "listEnvironments", "uninstallEnvironment", "listEnvironments", "deleteEnvironment"]);
  const install = calls.find(([name]) => name === "installEnvironment")![1][1] as Record<string, unknown>;
  assert.equal(install.workspaceRoot, undefined);
  assert.equal(install.runnerWorkspaceKey, undefined);
  await assert.rejects(manageRunnerEnvironment(runner, store, "environments/env/install", "POST", { packages: ["local.whl"] }), /Session workspace/);
  await assert.rejects(manageRunnerEnvironment(runner, store, "environments", "PUT", {}), /Unsupported/);
});

test("workspace management includes other Projects, archived Sessions and previous use after deselection", async () => {
  const states: string[] = [];
  const store = {
    getRemoteHost: () => ({ workspaceNamespace: "target" }),
    listProjects: () => [{ id: "p1", name: "First", remoteRunnerHostIds: ["host"] }, { id: "p2", name: "Second", remoteRunnerHostIds: [] }],
    listSessions: (id: string, state: string) => { states.push(state); return id === "p1" ? [{ id: "s1", title: "Inherited" }] : [{ id: "s2", title: "Previous use", remoteRunnerHostIds: [] }, { id: "unused", title: "Unused" }]; },
    listRemoteWorkspaceSyncs: () => [],
    listExecutionRuns: async (id: string) => id === "s2" ? [{ runnerId: "host" }] : [],
  } as unknown as SessionStore;
  const items = await runnerWorkspaceBindings(store, "host");
  assert.deepEqual(items.map((item) => item.sessionId), ["s1", "s2"]);
  assert.equal(items[1]!.workspaceKey, "p2/s2/runners/target");
  assert.deepEqual(states, ["all", "all"]);
});


for (const id of ["local", "host"]) {
  test(`${id} exposes the same connection and workspace contract`, async () => {
    const resources = { workspaceDisk: { path: "/runner/workspaces" } };
    const store = {
      dataDir: "/app/data", getRemoteHost: () => ({ id: "host", alias: "node", workspaceNamespace: "target" }),
      listProjects: () => [{ id: "p", name: "Project", runnerIds: [id], remoteRunnerHostIds: ["host"] }],
      listSessions: () => [{ id: "s", title: "Session" }], listRemoteWorkspaceSyncs: () => [],
      workspacePath: () => "/app/data/projects/p/s/workspace",
    } as unknown as SessionStore;
    const local = { health: async () => ({ runnerVersion: "v1" }), resources: async () => resources } as unknown as RunnerClient;
    const remote = { runnerStatusWithResources: async () => ({ state: "ready", resources }) } as unknown as Parameters<typeof runnerTarget>[2];
    const target = await runnerTarget(store, local, remote, id);
    assert.equal(target.id, id);
    assert.equal(target.runnerStatus?.state, "ready");
    assert.equal(target.runnerStatus?.resources?.npu, undefined, "absent hardware stays absent");
    const [binding] = await runnerWorkspaceBindings(store, id);
    assert.equal(binding?.runnerId, id);
    assert.equal(binding?.projectId, "p");
    assert.equal(binding?.workspaceKey, id === "local" ? "/app/data/projects/p/s/workspace" : "p/s/runners/target");
  });
}

test("built-in Runner reports connection and resource errors without claiming it is ready", async () => {
  const store = { dataDir: "/app/data" } as SessionStore;
  const local = { health: async () => { throw new Error("connection refused"); } } as unknown as RunnerClient;
  const target = await runnerTarget(store, local, {} as Parameters<typeof runnerTarget>[2], "local");
  assert.equal(target.runnerStatus?.state, "error");
  assert.match(target.runnerStatus?.error ?? "", /connection refused/);
  local.health = async () => ({ runnerVersion: "v1" }) as Awaited<ReturnType<RunnerClient["health"]>>;
  local.resources = async () => { throw new Error("resources unavailable"); };
  const reachable = await runnerTarget(store, local, {} as Parameters<typeof runnerTarget>[2], "local");
  assert.equal(reachable.runnerStatus?.state, "ready");
  assert.equal(reachable.runnerStatus?.resources, undefined);
  assert.match(reachable.runnerStatus?.resourcesError ?? "", /resources unavailable/);
});
