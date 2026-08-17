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

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  type Environment,
  type EnvironmentRevision,
  type PermissionEpoch,
  type ScientificLanguage,
} from "@science-agent/schema";

import { EnvironmentStore, type EnvironmentRuntime } from "./environment-store.js";
import { executePython, executeShell } from "./executor.js";
import { KernelManager } from "./kernel-manager.js";

const execFileAsync = promisify(execFile);
const BWRAP_PATH = process.env.SCIENCE_AGENT_BWRAP_PATH?.trim() || "bwrap";

function epoch(id = "epoch-test"): PermissionEpoch {
  return {
    createdAt: new Date().toISOString(),
    environmentRevisionId: "rev-python",
    id,
    mounts: [{ mode: "read-write", source: "workspace" }],
    networkPolicy: "none",
    reason: "test",
    secretRefs: [],
    sessionId: "session-test",
  };
}

async function fixture(context: TestContext) {
  const dataDir = resolve(process.cwd(), ".tmp", `scientific-execution-${process.pid}-${Date.now()}-${Math.random()}`);
  const workspaceRoot = resolve(dataDir, "projects", "project", "sessions", "session", "workspace");
  const prefix = resolve(dataDir, "managed-env");
  await mkdir(workspaceRoot, { recursive: true });
  await execFileAsync("/usr/bin/python3", ["-m", "venv", "--without-pip", prefix]);
  await unlink(resolve(prefix, "bin", "python"));
  await copyFile("/usr/bin/python3", resolve(prefix, "bin", "python"));
  await chmod(resolve(prefix, "bin", "python"), 0o755);
  const fakeRWorker = `import json, pathlib, socket, sys
if "-e" not in sys.argv:
    try:
        socket.create_connection(("1.1.1.1", 53), timeout=0.2)
        print("network=available")
    except OSError:
        print("network=denied")
else:
    state = {}
    for line in sys.stdin:
        request = json.loads(line)
        code = request["code"]
        if "x <- 41" in code:
            state["x"] = 41
        if "write.csv" in code:
            pathlib.Path("r-summary.csv").write_text(f"metric,value\\nanswer,{state.get('x', 0) + 1}\\n")
        stdout = "42\\n" if "print(x + 1)" in code else ""
        print(json.dumps({"id": request["id"], "exitCode": 0, "stdout": stdout, "stderr": ""}), flush=True)
`;
  const fakeR = `#!/bin/sh
exec "${resolve(prefix, "bin", "python")}" "${resolve(prefix, "bin", "R-worker.py")}" "$@"
`;
  await writeFile(resolve(prefix, "bin", "R-worker.py"), fakeRWorker);
  await writeFile(resolve(prefix, "bin", "R"), fakeR);
  await chmod(resolve(prefix, "bin", "R"), 0o755);
  context.after(() => rm(dataDir, { force: true, recursive: true }));

  const environments: Record<ScientificLanguage, Environment> = {
    python: {
      createdAt: new Date().toISOString(), currentRevisionId: "rev-python", id: "starter-python",
      kind: "starter", language: "python", name: "Starter Python", updatedAt: new Date().toISOString(),
    },
    r: {
      createdAt: new Date().toISOString(), currentRevisionId: "rev-r", id: "starter-r",
      kind: "starter", language: "r", name: "Starter R", updatedAt: new Date().toISOString(),
    },
  };
  const revision = (language: ScientificLanguage, id: string): EnvironmentRevision => ({
    channels: ["test"],
    createdAt: new Date().toISOString(),
    environmentId: environments[language].id,
    id,
    language,
    languageVersion: "test",
    packages: [],
    packageSpecHash: "a".repeat(64),
    platform: "linux-x64",
    provisioner: "test",
    runnerVersion: "test",
    snapshot: { hash: "a".repeat(64), size: 1 },
  });
  const store = {
    capability: { available: true, enabled: true, languages: ["python", "r"], provisioner: "test", startersReady: true },
    resolveRuntime: (revisionId: string | undefined, language: ScientificLanguage): EnvironmentRuntime => {
      const expected = language === "python" ? "rev-python" : "rev-r";
      if (revisionId && revisionId !== expected && revisionId !== "rev-python-next") {
        throw new Error(`Unknown environment revision: ${revisionId}`);
      }
      const actualRevision = revision(language, revisionId ?? expected);
      return {
        environment: environments[language],
        interpreterPath: resolve(prefix, "bin", language === "python" ? "python" : "R"),
        prefixPath: prefix,
        revision: actualRevision,
      };
    },
  } as unknown as EnvironmentStore;
  return { dataDir, prefix, store, workspaceRoot };
}

test("scientific execution uses the selected environment prefix and denies Python/R egress", async (context) => {
  const { dataDir, store, workspaceRoot } = await fixture(context);
  const python = await executePython({ bwrapPath: BWRAP_PATH, dataDir, execTimeoutMs: 60_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 10_737_418_240 }, {
    agentId: "main",
    code: "import socket, subprocess, sys\nprint(f'prefix={sys.prefix}')\ntry:\n socket.create_connection(('1.1.1.1', 53), timeout=.2); print('network=available')\nexcept OSError: print('network=denied')\ntry:\n subprocess.run(['/usr/bin/python3', '-c', 'print(1)'], check=True); print('host_python=available')\nexcept OSError: print('host_python=denied')",
    environmentRevisionId: "rev-python",
    executionId: "environment-prefix",
    language: "python",
    permissionEpoch: epoch(),
    workspaceRoot,
  }, undefined, store);
  assert.equal(python.exitCode, 0);
  assert.match(python.stdout, /prefix=\/opt\/science-env/);
  assert.match(python.stdout, /network=denied/);
  assert.match(python.stdout, /host_python=denied/);
  assert.equal(python.environmentRevisionId, "rev-python");

  const r = await executePython({ bwrapPath: BWRAP_PATH, dataDir, execTimeoutMs: 60_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 10_737_418_240 }, {
    agentId: "main",
    code: "print('network check')",
    environmentRevisionId: "rev-r",
    executionId: "r-network",
    language: "r",
    permissionEpoch: epoch(),
    workspaceRoot,
  }, undefined, store);
  assert.equal(r.exitCode, 0);
  assert.equal(r.language, "r");
  assert.match(r.stdout, /network=denied/);

  await assert.rejects(executePython({ bwrapPath: BWRAP_PATH, dataDir, execTimeoutMs: 60_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 10_737_418_240 }, {
    agentId: "main",
    code: "print('no')",
    environmentRevisionId: "unknown-revision",
    executionId: "unknown-revision",
    language: "python",
    permissionEpoch: epoch(),
    workspaceRoot,
  }, undefined, store), /Unknown environment revision/);
});

test("shell execution runs an existing workspace script with the same sandbox and provenance envelope", async (context) => {
  const { dataDir, workspaceRoot } = await fixture(context);
  await writeFile(resolve(workspaceRoot, "run_all.sh"), [
    "printf '%s\\n' \"$1\" > shell-result.txt",
    "if exec 3<>/dev/tcp/1.1.1.1/53 2>/dev/null; then echo network=available; else echo network=denied; fi",
  ].join("\n"));
  const result = await executeShell({ bwrapPath: BWRAP_PATH, dataDir, execTimeoutMs: 60_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 10_737_418_240 }, {
    agentId: "main",
    code: "/usr/bin/bash run_all.sh 'legacy pipeline'",
    executionId: "shell-script",
    permissionEpoch: epoch(),
    workspaceRoot,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.language, "shell");
  assert.equal(result.environmentRevisionId, SYSTEM_SHELL_ENVIRONMENT_REVISION_ID);
  assert.equal(result.networkPolicy, "none");
  assert.match(result.stdout, /network=denied/);
  assert.deepEqual(result.createdFiles, ["shell-result.txt"]);
});

test("persistent Python kernels retain variables and restart across epoch or revision changes", async (context) => {
  const { dataDir, store, workspaceRoot } = await fixture(context);
  const manager = new KernelManager({ bwrapPath: BWRAP_PATH, dataDir, execTimeoutMs: 60_000, idleTimeoutMs: 5_000 }, store);
  context.after(() => manager.close());
  const first = await manager.execute({
    agentId: "main",
    code: "x = 41\nprint('stored')", environmentRevisionId: "rev-python", executionId: "eval-one",
    kernelMode: "persistent", language: "python", permissionEpoch: epoch(), workspaceRoot,
  });
  const second = await manager.execute({
    agentId: "main",
    code: "print(x + 1)", environmentRevisionId: "rev-python", executionId: "eval-two",
    kernelMode: "persistent", language: "python", permissionEpoch: epoch(), workspaceRoot,
  });
  assert.equal(first.kernelId, second.kernelId);
  assert.equal(second.stdout.trim(), "42");

  const restarted = await manager.execute({
    agentId: "main",
    code: "print('x' in globals())", environmentRevisionId: "rev-python-next", executionId: "eval-three",
    kernelMode: "persistent", language: "python", permissionEpoch: epoch("epoch-next"), workspaceRoot,
  });
  assert.notEqual(restarted.kernelId, second.kernelId);
  assert.equal(restarted.stdout.trim(), "False");
  assert.match(restarted.memoryStateLost ?? "", /Permission Epoch or Environment Revision changed/);

  await assert.rejects(manager.execute({
    agentId: "main",
    code: "print('no')", environmentRevisionId: "rev-python", executionId: "once-eval",
    kernelMode: "persistent", language: "python", permissionEpoch: { ...epoch(), executeGrantScope: "once" },
    workspaceRoot,
  }), /once-scoped/);
});

test("a persistent Kernel rejects writable and read-only mount changes for one Session-Agent", async (context) => {
  const { dataDir, store, workspaceRoot: readOnlyWorkspaceRoot } = await fixture(context);
  const workspaceRoot = resolve(readOnlyWorkspaceRoot, "subagents", "subagent-1");
  const otherWorkspaceRoot = resolve(readOnlyWorkspaceRoot, "subagents", "subagent-2");
  const otherReadOnlyWorkspaceRoot = resolve(dataDir, "projects", "project", "shared-inputs");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(otherWorkspaceRoot, { recursive: true }),
    mkdir(otherReadOnlyWorkspaceRoot, { recursive: true }),
  ]);
  const manager = new KernelManager({
    bwrapPath: BWRAP_PATH,
    dataDir,
    execTimeoutMs: 60_000,
    idleTimeoutMs: 5_000,
  }, store);
  context.after(() => manager.close());
  const request = {
    agentId: "subagent:subagent-1",
    environmentRevisionId: "rev-python",
    kernelMode: "persistent" as const,
    language: "python" as const,
    permissionEpoch: epoch(),
    readOnlyWorkspaceRoot,
    workspaceRoot,
  };

  const first = await manager.execute({ ...request, code: "x = 41", executionId: "mount-eval-one" });
  const reused = await manager.execute({ ...request, code: "print(x + 1)", executionId: "mount-eval-two" });
  assert.equal(reused.kernelId, first.kernelId);
  assert.equal(reused.stdout.trim(), "42");

  await assert.rejects(manager.execute({
    ...request,
    code: "print('wrong writable mount')",
    executionId: "mount-eval-writable-mismatch",
    workspaceRoot: otherWorkspaceRoot,
  }), /cannot be reused with different workspace mounts/);
  await assert.rejects(manager.execute({
    ...request,
    code: "print('wrong read-only mount')",
    executionId: "mount-eval-read-only-mismatch",
    readOnlyWorkspaceRoot: otherReadOnlyWorkspaceRoot,
  }), /cannot be reused with different workspace mounts/);
  assert.deepEqual(manager.list().map((kernel) => kernel.id), [first.kernelId]);
});

test("persistent R kernel path retains state and reports a generated workspace artifact", async (context) => {
  const { dataDir, store, workspaceRoot } = await fixture(context);
  const manager = new KernelManager({ bwrapPath: BWRAP_PATH, dataDir, execTimeoutMs: 60_000, idleTimeoutMs: 5_000 }, store);
  context.after(() => manager.close());
  const first = await manager.execute({
    agentId: "main",
    code: "x <- 41", environmentRevisionId: "rev-r", executionId: "r-eval-one",
    kernelMode: "persistent", language: "r", permissionEpoch: epoch(), workspaceRoot,
  });
  const second = await manager.execute({
    agentId: "main",
    code: "print(x + 1)\nwrite.csv(data.frame(metric='answer', value=x + 1), 'r-summary.csv')",
    environmentRevisionId: "rev-r", executionId: "r-eval-two", kernelMode: "persistent", language: "r",
    permissionEpoch: epoch(), workspaceRoot,
  });
  assert.equal(first.kernelId, second.kernelId);
  assert.equal(second.stdout.trim(), "42");
  assert.deepEqual(second.createdFiles, ["r-summary.csv"]);
});

test("a persistent Kernel can be torn down by its runtime-status identity", async (context) => {
  const { dataDir, store, workspaceRoot } = await fixture(context);
  const manager = new KernelManager({
    bwrapPath: "/usr/bin/bwrap",
    dataDir,
    execTimeoutMs: 0,
    idleTimeoutMs: 0,
  }, store);
  context.after(() => manager.close());
  const first = await manager.execute({
    agentId: "main",
    code: "x = 41",
    environmentRevisionId: "rev-python",
    executionId: "teardown-eval-one",
    kernelMode: "persistent",
    language: "python",
    permissionEpoch: epoch(),
    workspaceRoot,
  });
  assert.equal(manager.list()[0]?.id, first.kernelId);
  assert.equal(await manager.teardownKernel(first.kernelId, "User cleared this Kernel"), 1);
  assert.deepEqual(manager.list(), []);

  const restarted = await manager.execute({
    agentId: "main",
    code: "print('x' in globals())",
    environmentRevisionId: "rev-python",
    executionId: "teardown-eval-two",
    kernelMode: "persistent",
    language: "python",
    permissionEpoch: epoch(),
    workspaceRoot,
  });
  assert.notEqual(restarted.kernelId, first.kernelId);
  assert.equal(restarted.stdout.trim(), "False");
  assert.equal(restarted.memoryStateLost, "User cleared this Kernel");
});
