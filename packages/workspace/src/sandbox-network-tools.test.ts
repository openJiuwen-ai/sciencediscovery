// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { AgentShellExecution, ShellExecutionResult } from "@sciencediscovery/schema";
import { createWorkspaceTools } from "./workspace.js";

for (const state of ["allowed", "blocked"] as const) test(`network tool forwards declared scope and exposes ${state} as a decision only`, async () => {
  const controller = new AbortController();
  const decision = { state, hosts: ["pypi.org:443"], instruction: "No code executes here" };
  let calls = 0;
  const tools = createWorkspaceTools(process.cwd(), { enabledConnectorIds: [], executePython: async () => { throw Error("must not execute"); },
    sandboxNetwork: { request: async (input, signal, id) => {
      calls++; assert.deepEqual(input, { hosts: ["pypi.org:443"], purpose: "Fetch package metadata", runnerId: "remote" });
      assert.equal(signal, controller.signal); assert.equal(id, "request"); return decision;
    } },
  });
  const result = await tools.find(t => t.name === "request_sandbox_network")!.execute("request", { hosts: ["pypi.org:443"], purpose: "Fetch package metadata", runner_id: "remote" }, controller.signal);
  assert.equal(calls, 1); assert.equal(result.isError, state === "blocked");
  assert.equal(result.details, decision); assert.match(JSON.stringify(result.content), /No code executes here/);
});

for (const managed of [true, false]) for (const token of [undefined, "token"]) test(`shell preserves optional network token shape (managed=${managed}, token=${token})`, async () => {
  const permission = { state: "allowed" as const, hosts: ["pypi.org:443"], authorizationId: "retry", instruction: "Inspect files before retry" };
  const terminal = { exitCode: 0, networkDeniedHosts: ["pypi.org:443"], networkPermission: permission,
    executionId: "exec", environmentRevisionId: "system", language: "shell", networkPolicy: "domain-allowlist", cgroupMode: "none", environmentVariables: {},
    kernelId: "ephemeral:exec", sandbox: "bubblewrap", runnerVersion: "test", workingDirectory: "/workspace", startedAt: "now", finishedAt: "now",
    createdFiles: ["partial.txt"], modifiedFiles: [], stdout: "partial", stderr: "", kernelMode: "ephemeral" } as ShellExecutionResult;
  let submissions = 0;
  const verify = (input: unknown) => {
    assert.deepEqual(input, { environmentId: undefined, cwd: undefined, ...(token ? { networkAuthorizationId: token } : {}) }); submissions++;
  };
  const tools = createWorkspaceTools(process.cwd(), { enabledConnectorIds: [], executePython: async () => { throw Error("must not execute"); },
    executeShell: async (_code, _mode, _signal, _id, _machine, input) => { verify(input); return terminal; },
    ...(managed ? { shellExecutions: {
      start: async (_code: string, input: unknown) => { verify(input); return { id: "exec", state: "failed", result: terminal } as AgentShellExecution; },
      wait: async () => ({ id: "exec", state: "failed", result: terminal } as AgentShellExecution),
      get: async () => { throw Error("unused"); }, list: () => [], logs: async () => { throw Error("unused"); }, cancel: async () => { throw Error("unused"); },
    } } : {}),
  });
  const result = await tools.find(t => t.name === "run_shell")!.execute("shell", { command: "printf partial", ...(token ? { network_authorization_id: token } : {}) });
  assert.equal(submissions, 1); assert.equal(result.isError, true, "caught HTTP denial must not become success");
  assert.match(JSON.stringify(result.content), /Inspect files before retry/);
});

test("a completed legacy execution carrying a caught network denial is still a tool error", async () => {
  const terminal = { id: "legacy", state: "completed", result: { exitCode: 0, networkDeniedHosts: ["pypi.org:443"] } } as AgentShellExecution;
  const tools = createWorkspaceTools(process.cwd(), { enabledConnectorIds: [], executePython: async () => { throw Error("unused"); },
    executeShell: async () => { throw Error("managed path only"); },
    shellExecutions: { start: async () => terminal, wait: async () => terminal, list: () => [terminal],
      get: async () => terminal, cancel: async () => terminal, logs: async () => { throw Error("unused"); } },
  });
  const result = await tools.find(t => t.name === "run_shell")!.execute("legacy", { command: "printf partial" });
  assert.equal(result.isError, true); assert.equal(result.details, terminal);
  assert.match(JSON.stringify(result.content), /pypi.org:443/);
});

test("an ordinary offline shell result needs no network permission and remains successful", async () => {
  const terminal: ShellExecutionResult = { executionId: "offline", environmentRevisionId: "system", language: "shell", networkPolicy: "none",
    exitCode: 0, stdout: "local result", stderr: "", createdFiles: [], modifiedFiles: [], kernelMode: "ephemeral", kernelId: "ephemeral:offline",
    cgroupMode: "none", sandbox: "bubblewrap", environmentVariables: {}, runnerVersion: "test", workingDirectory: "/workspace", startedAt: "now", finishedAt: "now" };
  const tools = createWorkspaceTools(process.cwd(), { enabledConnectorIds: [], executePython: async () => { throw Error("unused"); }, executeShell: async () => terminal });
  const result = await tools.find(t => t.name === "run_shell")!.execute("offline", { command: "printf local" });
  assert.equal(result.isError, false); assert.equal(result.details, terminal);
  assert.match(JSON.stringify(result.content), /local result/);
  assert.doesNotMatch(JSON.stringify(result.content), /authorizationId|networkPermission/);
});
