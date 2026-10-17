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
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import type { ShellExecutionRequest } from "@sciencediscovery/schema";
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
