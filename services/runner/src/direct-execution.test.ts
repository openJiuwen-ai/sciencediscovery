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
import { mkdtemp, mkdir, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import type { ShellExecutionRequest } from "@sciencediscovery/schema";
import { RunnerClient } from "@sciencediscovery/executor";
import type { AddressInfo } from "node:net";
import { startRunnerServer } from "./server.js";
import { directExecutionCapability, executeDirectShell, type ExecutorConfig } from "./executor.js";

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(resolve(tmpdir(), "direct-shell-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const workspaceRoot = resolve(dataDir, "projects", "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const capability = await directExecutionCapability();
  const config: ExecutorConfig = { dataDir, bwrapPath: "/missing-bwrap", execTimeoutMs: 2000, maxWorkspaceBytes: 1000000, maxOutputBytes: 10000 };
  const request: ShellExecutionRequest = { agentId: "main", code: "printf hello > result.txt; python3 -c 'print(6 * 7)'", executionId: "execution-1", workspaceRoot,
    permissionEpoch: { id: "epoch", sessionId: "session", createdAt: new Date().toISOString(), environmentRevisionId: "", mounts: [{ source: "workspace", mode: "read-write" }], networkPolicy: "none", reason: "test", secretRefs: [] },
    directAuthorization: { authorizationId: "consent", runId: "run", agentId: "main", target: capability.target, account: capability.account, cwd: "", workspaceRoot } };
  return { config, request, workspaceRoot };
}

test("explicit direct shell and Python work with missing sandbox and retain output/artifacts/scope", async t => {
  const { config, request, workspaceRoot } = await fixture(t);
  const output: string[] = [];
  const result = await executeDirectShell(config, request, new AbortController().signal, (_, chunk) => output.push(chunk.toString()));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "42");
  assert.match(output.join(""), /42/);
  assert.equal(await readFile(resolve(workspaceRoot, "result.txt"), "utf8"), "hello");
  assert.deepEqual(result.createdFiles, ["result.txt"]);
  assert.equal(result.sandbox, "none");
  assert.equal(result.networkPolicy, "host");
  assert.deepEqual(result.directAuthorization, request.directAuthorization);
  // Node forwards its coverage directory into explicit spawn environments in CI.
  const expectedKeys = ["HOME", "LANG", "PATH"];
  if (process.env.NODE_V8_COVERAGE) {
    expectedKeys.push("NODE_V8_COVERAGE");
    assert.equal(result.environmentVariables.NODE_V8_COVERAGE, process.env.NODE_V8_COVERAGE);
  }
  assert.deepEqual(Object.keys(result.environmentVariables).sort(), expectedKeys.sort());
});

for (const scope of ["missing", "target", "account", "agentId", "workspaceRoot", "cwd"] as const) {
  test(`direct execution rejects ${scope} scope before side effects`, async t => {
    const { config, request, workspaceRoot } = await fixture(t);
    if (scope === "missing") delete request.directAuthorization;
    else request.directAuthorization![scope] = scope === "cwd" ? "../../" : "wrong";
    await assert.rejects(executeDirectShell(config, request, new AbortController().signal));
    await assert.rejects(readFile(resolve(workspaceRoot, "result.txt")), { code: "ENOENT" });
  });
}

test("direct execution cancellation before dispatch has no side effects", async t => {
  const { config, request, workspaceRoot } = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executeDirectShell(config, request, controller.signal));
  await assert.rejects(readFile(resolve(workspaceRoot, "result.txt")), { code: "ENOENT" });
});

for (const mode of ["timeout", "cancel"] as const) {
  test(`direct execution ${mode} stops its process group and reports failure`, async t => {
    const { config, request, workspaceRoot } = await fixture(t);
    request.code = "printf started; sleep 10; printf late > result.txt";
    request.executionTimeoutMs = mode === "timeout" ? 100 : 0;
    const controller = new AbortController();
    await assert.rejects(executeDirectShell(config, request, controller.signal, () => { if (mode === "cancel") controller.abort(); }), /timed out|aborted/);
    await assert.rejects(readFile(resolve(workspaceRoot, "result.txt")), { code: "ENOENT" });
  });
}

async function remoteFixture(t: TestContext) {
  const f = await fixture(t);
  const server = await startRunnerServer({ ...f.config, authToken: "test-token", host: "127.0.0.1", port: 0,
    scientificEnvsEnabled: false, npuBrokerEnabled: false });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); });
  const client = new RunnerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "test-token");
  const key = "session/main";
  const scope = await client.directExecutionCapability(undefined, { runnerWorkspaceKey: key, cwd: "" });
  assert.ok(scope.workspaceRoot);
  const request: ShellExecutionRequest = { ...f.request, workspaceRoot: "control-plane-path-is-unused", runnerWorkspaceKey: key,
    directAuthorization: { ...f.request.directAuthorization!, ...scope, workspaceRoot: scope.workspaceRoot, cwd: scope.cwd!, runnerWorkspaceKey: key } };
  const owner = { agentId: request.agentId, sessionId: request.permissionEpoch.sessionId };
  const wait = async (id: string) => {
    const deadline = Date.now() + 5000;
    while (true) {
      const value = await client.getShellExecution(id, owner);
      if (!["queued", "running"].includes(value.state)) return value;
      if (Date.now() > deadline) throw new Error("Remote execution did not terminate");
      await new Promise(done => setTimeout(done, 10));
    }
  };
  return { ...f, client, request, owner, wait, remoteRoot: scope.workspaceRoot };
}

test("remote direct Shell/Python retains durable output, workspace version and exact target audit", async t => {
  const f = await remoteFixture(t);
  assert.equal((await f.client.executionCapability()).ready, false);
  await f.client.startShellExecution(f.request);
  const execution = await f.wait(f.request.executionId);
  assert.equal(execution.state, "completed");
  assert.equal(execution.result!.stdout.trim(), "42");
  assert.ok(execution.result!.workspaceSnapshot);
  assert.ok(execution.version);
  assert.equal(execution.result!.sandbox, "none");
  assert.equal(execution.result!.networkPolicy, "host");
  assert.deepEqual(execution.result!.directAuthorization, f.request.directAuthorization);
  assert.equal(await readFile(resolve(f.remoteRoot, "result.txt"), "utf8"), "hello");
  await assert.rejects(readFile(resolve(f.workspaceRoot, "result.txt")), { code: "ENOENT" });
  assert.match((await f.client.shellExecutionLogs(execution.id, f.owner)).chunks.map(c => c.text).join(""), /42/);
  await assert.rejects(f.client.startShellExecution(f.request), /already been used/);
});

for (const changed of ["key", "root", "account", "target", "agent"] as const) {
  test(`remote direct execution rejects changed ${changed} without side effects`, async t => {
    const f = await remoteFixture(t);
    if (changed === "key") f.request.runnerWorkspaceKey = "session/other";
    if (changed === "root") f.request.directAuthorization!.workspaceRoot = f.workspaceRoot;
    if (changed === "account") f.request.directAuthorization!.account = "other";
    if (changed === "target") f.request.directAuthorization!.target = "restarted-runner";
    if (changed === "agent") f.request.directAuthorization!.agentId = "child";
    await f.client.startShellExecution(f.request);
    const execution = await f.wait(f.request.executionId);
    assert.equal(execution.state, "failed");
    await assert.rejects(readFile(resolve(f.remoteRoot, "result.txt")), { code: "ENOENT" });
  });
}

test("remote direct probe rejects invalid workspace keys and escaping cwd before consent", async t => {
  const f = await remoteFixture(t);
  for (const key of ["../outside", "/absolute", "session//main"]) {
    await assert.rejects(f.client.directExecutionCapability(undefined, { runnerWorkspaceKey: key, cwd: "" }));
  }
  await symlink(f.workspaceRoot, resolve(f.remoteRoot, "escape"));
  for (const cwd of ["/tmp", "..", "escape"]) {
    await assert.rejects(f.client.directExecutionCapability(undefined, { runnerWorkspaceKey: "session/main", cwd }));
  }
});

for (const mode of ["timeout", "cancel"] as const) {
  test(`remote direct ${mode} retains progress, final error and version without late effects`, async t => {
    const f = await remoteFixture(t);
    f.request.code = "printf started; sleep 10; printf late > result.txt";
    f.request.executionTimeoutMs = mode === "timeout" ? 100 : 0;
    await f.client.startShellExecution(f.request);
    const deadline = Date.now() + 5000;
    while (!(await f.client.shellExecutionLogs(f.request.executionId, f.owner)).chunks.length) {
      if (Date.now() > deadline) throw new Error("Remote progress missing");
      await new Promise(done => setTimeout(done, 5));
    }
    if (mode === "cancel") await f.client.cancelShellExecution(f.request.executionId, f.owner);
    const execution = await f.wait(f.request.executionId);
    assert.equal(execution.state, mode === "cancel" ? "cancelled" : "failed");
    assert.match(execution.error!, /aborted|timed out/);
    assert.ok(execution.version);
    await assert.rejects(readFile(resolve(f.remoteRoot, "result.txt")), { code: "ENOENT" });
  });
}

test("remote direct execution rejects a cwd redirected after consent", async t => {
  const f = await remoteFixture(t);
  await mkdir(resolve(f.remoteRoot, "approved"));
  await mkdir(resolve(f.remoteRoot, "other"));
  const scope = await f.client.directExecutionCapability(undefined, { runnerWorkspaceKey: "session/main", cwd: "approved" });
  f.request.cwd = scope.cwd!;
  f.request.directAuthorization!.cwd = scope.cwd!;
  await rm(resolve(f.remoteRoot, "approved"), { recursive: true });
  await symlink(resolve(f.remoteRoot, "other"), resolve(f.remoteRoot, "approved"));
  await f.client.startShellExecution(f.request);
  assert.equal((await f.wait(f.request.executionId)).state, "failed");
  await assert.rejects(readFile(resolve(f.remoteRoot, "other/result.txt")), { code: "ENOENT" });
});
