// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { SessionStore } from "./store.js";
import { manageRunnerEnvironment, runnerWorkspaceBindings } from "./runner-management.js";

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
