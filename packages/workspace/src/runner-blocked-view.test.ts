// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import type { RunnerBlockedResult } from "@sciencediscovery/schema";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { RunnerUnavailableError } from "./runner-readiness.js";
import { createWorkspaceTools } from "./workspace.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

const reason = String.raw`Windows path budget exceeded for managed scientific environments.
LongPathsEnabled: 0
Environment prefix: C:\Users\example\AppData\Local\ScienceDiscovery\scientific-envs\revisions
154 characters now + 129 for the deepest member = 283, 24 over.
Move the Runner data directory at least 24 characters shallower.
Provisioning has not started.`;

function shellBlock(): RunnerBlockedResult {
  return {
    code: "RUNNER_UNAVAILABLE", dispatched: false, operationId: "blocked-operation",
    runner: {
      runnerId: "local", checkedAt: "2026-11-17T01:44:37.893Z", connected: true, ready: false, reason,
      capability: {
        instanceId: "runner-instance", checkedAt: "2026-11-17T01:44:37.893Z", sandbox: "none",
        dependencyAvailable: true, sandboxUsable: false, ready: true, reason: "ready", detail: reason,
        platform: "windows", shell: { available: false, name: "bash", utilities: [], unavailableReason: reason },
      },
      suggestions: [`${reason}. Recreate or update the starter environment.`,
        "After repair use check_runner.", "After repair use check_runner."],
    },
    instruction: "Full internal recovery guidance retained for audit.",
  };
}

for (const managed of [false, true]) {
  test(`run_shell projects a pre-dispatch blocker once (managed=${managed})`, async () => {
    const blocked = shellBlock();
    const original = structuredClone(blocked);
    const fail = async (): Promise<never> => { throw new RunnerUnavailableError(blocked); };
    const tools = createWorkspaceTools(process.cwd(), {
      enabledConnectorIds: [], executePython: async () => { throw new Error("unused"); }, executeShell: fail,
      ...(managed ? { shellExecutions: {
        start: fail, wait: fail, get: fail, list: () => [], logs: fail, cancel: fail,
      } } : {}),
    });
    const tool = tools.find(value => value.name === "run_shell");
    assert.ok(tool);
    const response = await tool.execute("call", { command: "echo hello" });
    assert.equal(response.isError, true);
    const text = response.content[0]?.text;
    assert.ok(text);
    const metadata = JSON.parse(text.split("\n")[0]!);
    assert.deepEqual(metadata, {
      code: "RUNNER_UNAVAILABLE", dispatched: false, operationId: "blocked-operation",
      runner: { runnerId: "local", connected: true, ready: false, pythonReady: true, shellAvailable: false },
    });
    assert.equal(text.split(reason).length - 1, 1, "diagnostic appears once with real newlines and paths");
    assert.equal(text.split("After repair use check_runner.").length - 1, 1);
    assert.match(text, /Recreate or update the starter environment/);
    assert.match(text, /wait_for_runner\(operation_id\)/);
    assert.match(text, /No code was dispatched or queued/);
    assert.doesNotMatch(text, /capability|instanceId|checkedAt|unavailableReason|Full internal recovery guidance/);
    assert.deepEqual(response.details, original, "complete diagnostics remain available");
    assert.deepEqual(blocked, original, "projection does not mutate the failure");
  });
}

test("route-scoped readiness keeps Python usable when the managed Shell is not", async () => {
  const blocked = shellBlock();
  // The aggregate `capability.ready` describes the historical Python channel,
  // but a Shell caller's `ready` is false. `readyFor` is the independent
  // contract; Python must be projected from it, not from either aggregate.
  assert.ok(blocked.runner.capability);
  blocked.runner.capability.ready = false;
  blocked.runner.readyFor = { python: true, shell: false };
  const fail = async (): Promise<never> => { throw new RunnerUnavailableError(blocked); };
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [], executePython: async () => { throw new Error("unused"); }, executeShell: fail,
  });
  const tool = tools.find(value => value.name === "run_shell");
  assert.ok(tool);
  const response = await tool.execute("call", { command: "echo hello" });
  const metadata = JSON.parse(response.content[0]!.text.split("\n")[0]!);
  assert.deepEqual(metadata.runner,
    { runnerId: "local", connected: true, ready: false, pythonReady: true, shellAvailable: false });
});

test("offline Runner projection keeps distinct repair advice and unknown channel readiness", async () => {
  const blocked: RunnerBlockedResult = {
    code: "RUNNER_UNAVAILABLE", dispatched: false, operationId: "offline-operation",
    runner: { runnerId: "remote", checkedAt: "now", connected: false, ready: false,
      reason: "Connection refused", suggestions: ["Check Runner authentication and service."] },
    instruction: "Full internal recovery guidance",
  };
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [], executePython: async () => { throw new Error("unused"); },
    executeShell: async () => { throw new RunnerUnavailableError(blocked); },
  });
  const tool = tools.find(value => value.name === "run_shell");
  assert.ok(tool);
  const response = await tool.execute("call", { command: "echo hello", runner_id: "remote" });
  const text = response.content[0]?.text;
  assert.ok(text);
  assert.deepEqual(JSON.parse(text.split("\n")[0]!).runner, { runnerId: "remote", connected: false, ready: false });
  assert.match(text, /Connection refused/);
  assert.match(text, /Check Runner authentication and service/);
});

test("run_shell does not turn unrelated exceptions into readiness failures", async () => {
  const error = new Error("Unexpected execution failure");
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [], executePython: async () => { throw new Error("unused"); },
    executeShell: async () => { throw error; },
  });
  const tool = tools.find(value => value.name === "run_shell");
  assert.ok(tool);
  await assert.rejects(tool.execute("call", { command: "echo hello" }), error);
});
