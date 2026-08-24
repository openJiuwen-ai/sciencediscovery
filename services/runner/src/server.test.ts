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
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  NpuJob,
  NpuWorkloadDescriptor,
  PermissionEpoch,
  PythonExecutionResult,
  RunnerHealth,
  RunnerRuntimeStatus,
  ShellExecutionRequest,
  ShellExecutionResult,
} from "@sciencediscovery/schema";

import { appendBounded, executePython, localPythonPackageCandidatePaths, RESOURCE_LIMIT_MODE, sandboxLaunchProfile, truncateToBudget } from "./executor.js";
import { EnvironmentStore } from "./environment-store.js";
import { HostNpuJobBroker } from "./npu-broker.js";
import { SessionEnvProfileStore } from "./session-env-profile.js";
import { ShellSessionManager } from "./shell-session-manager.js";
import {
  createExecutionSignature,
  EXECUTION_SIGNATURE_HEADER,
  EXECUTION_TIMESTAMP_HEADER,
} from "./request-auth.js";
import { createRunnerServer, loadRunnerConfig, startRunnerServer, type RunnerConfig } from "./server.js";

const protenixPipelineScriptsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "skills",
  "antibody-protenix-pipeline",
  "scripts",
);

test("appendBounded treats remaining room 0 as empty, not unlimited", () => {
  const exhausted = appendBounded("already-full", Buffer.from("more-stderr"), 10, 10);
  assert.equal(exhausted.text, "");
  assert.equal(exhausted.truncated, true);

  const unlimited = appendBounded("keep", Buffer.from("-going"), 0, 0);
  assert.equal(unlimited.text, "keep-going");
  assert.equal(unlimited.truncated, false);

  assert.equal(truncateToBudget("drop-me", 0), "");
  assert.ok(Buffer.byteLength(truncateToBudget("abcdefghij", 8)) <= 8);
});

function epoch(): PermissionEpoch {
  return {
    createdAt: new Date().toISOString(),
    environmentRevisionId: "test-python",
    id: "epoch-test",
    mounts: [{ mode: "read-write", source: "workspace" }],
    networkPolicy: "none",
    reason: "test",
    secretRefs: [],
    sessionId: "session-test",
  };
}

function config(dataDir: string): RunnerConfig {
  return {
    authToken: "runner-test-token",
    bwrapPath: process.env.SCIENCE_AGENT_BWRAP_PATH?.trim() || "bwrap",
    dataDir,
    execTimeoutMs: 60_000,
    host: "127.0.0.1",
    maxOutputBytes: 1_073_741_824,
    maxWorkspaceBytes: 10_737_418_240,
    npuBrokerEnabled: true,
    port: 0,
  };
}

function bashForTest(): string | undefined {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return "bash";
  } catch {
    return undefined;
  }
}

function pythonForTest(): string | undefined {
  for (const candidate of [process.env.SCIENCE_AGENT_PYTHON_PATH, process.env.PYTHON, "python3", "python"]) {
    if (!candidate?.trim()) continue;
    try {
      return execFileSync(candidate.trim(), ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).trim();
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function createNpuTestServer(runnerConfig: RunnerConfig, pythonPath: string) {
  const managedSitePackages = dirname(pythonPath);
  const broker = new HostNpuJobBroker({
    dataDir: runnerConfig.dataDir,
    enabled: runnerConfig.npuBrokerEnabled,
    maxOutputBytes: runnerConfig.maxOutputBytes,
    protenixScriptPath: runnerConfig.npuProtenixScriptPath,
    pythonPath: runnerConfig.npuPythonPath,
    resolveEnvironmentPython: (revisionId) => {
      assert.equal(revisionId, "test-npu-revision");
      return pythonPath;
    },
    resolveEnvironmentPythonPath: (revisionId) => {
      assert.equal(revisionId, "test-npu-revision");
      return managedSitePackages;
    },
    smokeScriptPath: runnerConfig.npuSmokeScriptPath,
    workloadConfigPath: runnerConfig.npuWorkloadConfigPath,
  });
  return createRunnerServer(runnerConfig, undefined, undefined, undefined, undefined, broker);
}

test("loadRunnerConfig resolves runtime data from the repository root", () => {
  const repositoryRoot = resolve(process.cwd(), ".tmp", "relocated-ScienceDiscovery");
  const loaded = loadRunnerConfig({}, repositoryRoot);
  assert.equal(loaded.bwrapPath, "bwrap");
  assert.equal(loaded.dataDir, resolve(repositoryRoot, ".sciencediscovery-data"));
  assert.equal(loaded.host, "127.0.0.1");
  assert.equal(loaded.port, 4311);
  assert.equal(loaded.execTimeoutMs, 0);
  assert.equal(loaded.maxWorkspaceBytes, 10_737_418_240);
  assert.equal(loaded.maxOutputBytes, 1_073_741_824);
  assert.equal(loaded.npuBrokerEnabled, false);
  assert.equal(loadRunnerConfig({ SCIENCE_AGENT_NPU_BROKER: "1" }).npuBrokerEnabled, true);
  assert.equal(loadRunnerConfig({ SCIENCE_AGENT_EXEC_TIMEOUT_MS: "90000" }).execTimeoutMs, 90_000);
  assert.equal(loadRunnerConfig({ SCIENCE_AGENT_EXEC_TIMEOUT_MS: "0" }).execTimeoutMs, 0);
  assert.equal(loadRunnerConfig({ SCIENCE_AGENT_NPU_BROKER: "0" }).npuBrokerEnabled, false);
  assert.equal(loaded.scientificKernelIdleMs, 0);
  assert.equal(loadRunnerConfig({ SCIENCE_AGENT_MAX_WORKSPACE_BYTES: "0" }).maxWorkspaceBytes, 0);
  assert.equal(loadRunnerConfig({ SCIENCE_AGENT_MAX_OUTPUT_BYTES: "8000000" }).maxOutputBytes, 8_000_000);
  assert.throws(() => loadRunnerConfig({ SCIENCE_AGENT_KERNEL_IDLE_MS: "-1" }), /non-negative integer/);
  assert.throws(() => loadRunnerConfig({ SCIENCE_AGENT_MAX_WORKSPACE_BYTES: "-1" }), /non-negative integer/);
});

test("local Python package lookup discovers project-owned versioned directories", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `python-package-layout-${process.pid}-${Date.now()}`);
  const packageRoot = resolve(dataDir, "python-packages");
  await mkdir(resolve(packageRoot, "py3.12"), { recursive: true });
  await mkdir(resolve(packageRoot, "py3.14"), { recursive: true });
  await mkdir(resolve(packageRoot, "not-python"), { recursive: true });
  await writeFile(resolve(packageRoot, "py3.13"), "");
  context.after(() => rm(dataDir, { force: true, recursive: true }));

  assert.deepEqual(await localPythonPackageCandidatePaths(dataDir), [
    resolve(dataDir, "python-packages", "py3.14"),
    resolve(dataDir, "python-packages", "py3.12"),
    resolve(dataDir, "python-packages", "py3"),
    resolve(dataDir, "python-packages"),
  ]);
});

test("local Python package lookup falls back when no package root exists", async () => {
  const dataDir = resolve(process.cwd(), ".tmp", "missing-python-package-layout");
  assert.deepEqual(await localPythonPackageCandidatePaths(dataDir), [
    resolve(dataDir, "python-packages", "py3"),
    resolve(dataDir, "python-packages"),
  ]);
});

test("runner mounts discovered local Python package directory", async (context) => {
  const fixture = await workspaceFixture(context);
  const packageDir = resolve(fixture.dataDir, "python-packages", "py3.14");
  await mkdir(packageDir, { recursive: true });
  await writeFile(resolve(packageDir, "science_local_probe.py"), "VALUE = 'mounted-local-package'\n");

  const result = await executePython(config(fixture.dataDir), {
    agentId: "main",
    code: "import science_local_probe\nprint(science_local_probe.VALUE)",
    executionId: "execution-local-python-package",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^mounted-local-package$/m);
});

test("runner startup fails closed when the sandbox binary is missing", async () => {
  await assert.rejects(startRunnerServer({
    ...config(resolve(process.cwd(), ".tmp", "missing-sandbox")),
    bwrapPath: resolve(process.cwd(), ".tmp", "does-not-exist", "bwrap"),
  }), /ENOENT/);
});

test("runner startup fails closed when bubblewrap lacks required security options", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `old-bwrap-${process.pid}-${Date.now()}`);
  const fakeBwrap = resolve(root, "bwrap");
  await mkdir(root, { recursive: true });
  await writeFile(fakeBwrap, "#!/bin/sh\necho 'usage: bwrap --unshare-all --unshare-user'\n");
  await chmod(fakeBwrap, 0o755);
  context.after(() => rm(root, { force: true, recursive: true }));
  await assert.rejects(startRunnerServer({
    ...config(resolve(root, "data")),
    bwrapPath: fakeBwrap,
  }), /lacks required sandbox options.*--seccomp/);
});

/** Quote for a shell single-quoted string; bubblewrap messages contain apostrophes. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * A bubblewrap stand-in whose `--help` is `helpText` and which fails any launch
 * carrying one of `rejects` with that entry's message. Detection probes by
 * launching, so a stub that only omits an option from `--help` would not model
 * anything.
 */
async function bwrapRejecting(
  root: string,
  helpText: string,
  rejects: Array<{ argument: string; failure: string }>,
): Promise<string> {
  const fakeBwrap = resolve(root, "bwrap");
  await mkdir(root, { recursive: true });
  await writeFile(fakeBwrap, [
    "#!/bin/sh",
    'for candidate in "$@"; do',
    ...rejects.flatMap(({ argument, failure }) => [
      `  if [ "$candidate" = "${argument}" ]; then`,
      `    echo ${shellQuote(failure)} >&2`,
      "    exit 1",
      "  fi",
    ]),
    "done",
    `if [ "$1" = "--help" ]; then echo '${helpText}'; fi`,
    "exit 0",
    "",
  ].join("\n"));
  await chmod(fakeBwrap, 0o755);
  return fakeBwrap;
}

const BWRAP_HELP_WITHOUT_OPTION =
  "usage: bwrap --cap-drop --die-with-parent --new-session --seccomp --unshare-all --unshare-user";

/** Collect the operator-facing warning without letting it reach the test output. */
async function warningsFrom(action: () => Promise<void>): Promise<string> {
  const original = console.warn;
  const captured: string[] = [];
  console.warn = (...parts: unknown[]) => { captured.push(parts.join(" ")); };
  try {
    await action();
  } finally {
    console.warn = original;
  }
  return captured.join("\n");
}

test("runner starts without --disable-userns on old bubblewrap (< 0.8)", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `bwrap-06-${process.pid}-${Date.now()}`);
  const fakeBwrap = await bwrapRejecting(root, BWRAP_HELP_WITHOUT_OPTION, [
    { argument: "--disable-userns", failure: "bwrap: Unknown option --disable-userns" },
  ]);
  context.after(() => rm(root, { force: true, recursive: true }));
  let server!: Server;
  const warned = await warningsFrom(async () => {
    server = await startRunnerServer({ ...config(resolve(root, "data")), bwrapPath: fakeBwrap });
  });
  context.after(() => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); }));
  assert.ok(server.listening);
  assert.match(warned, /does not support --disable-userns/);
  assert.match(warned, /Upgrade bubblewrap/);
});

test("runner starts and omits --disable-userns when /proc/sys is read-only", async (context) => {
  // LXC and container runtimes that mount /proc/sys read-only: bubblewrap
  // advertises the option but aborts when it writes user.max_user_namespaces.
  // Trusting --help here is what made every run_python / run_r / run_shell fail.
  const root = resolve(process.cwd(), ".tmp", `bwrap-ro-proc-${process.pid}-${Date.now()}`);
  const fakeBwrap = await bwrapRejecting(root, `${BWRAP_HELP_WITHOUT_OPTION} --disable-userns`, [
    {
      argument: "--disable-userns",
      failure: "bwrap: cannot open /proc/sys/user/max_user_namespaces: Read-only file system",
    },
  ]);
  context.after(() => rm(root, { force: true, recursive: true }));
  let server!: Server;
  const warned = await warningsFrom(async () => {
    server = await startRunnerServer({ ...config(resolve(root, "data")), bwrapPath: fakeBwrap });
  });
  context.after(() => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); }));
  assert.ok(server.listening);
  assert.match(warned, /cannot use it here/);
  assert.match(warned, /max_user_namespaces: Read-only file system/);
  // The binary is fine, so telling an operator to upgrade would misdirect them.
  assert.ok(!/Upgrade bubblewrap/.test(warned));
  // The detection the runner just cached is the one executions read.
  assert.deepEqual(await sandboxLaunchProfile(fakeBwrap), { disableUserns: false, procMode: "new" });
  // Only the userns axis degraded; /proc must not have been touched.
  assert.ok(!/fresh \/proc/.test(warned));
});

test("runner starts and binds /proc when a fresh procfs is refused", async (context) => {
  // Docker's default readonlyPaths/maskedPaths, i.e. Compose without
  // systempaths=unconfined: the kernel refuses a new procfs in the sandbox's
  // own pid namespace, which would otherwise abort every execution.
  const root = resolve(process.cwd(), ".tmp", `bwrap-proc-eperm-${process.pid}-${Date.now()}`);
  const fakeBwrap = await bwrapRejecting(root, `${BWRAP_HELP_WITHOUT_OPTION} --disable-userns`, [
    { argument: "--proc", failure: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted" },
  ]);
  context.after(() => rm(root, { force: true, recursive: true }));
  let server!: Server;
  const warned = await warningsFrom(async () => {
    server = await startRunnerServer({ ...config(resolve(root, "data")), bwrapPath: fakeBwrap });
  });
  context.after(() => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); }));
  assert.ok(server.listening);
  assert.match(warned, /cannot mount a fresh \/proc/);
  assert.match(warned, /--ro-bind \/proc \/proc/);
  assert.match(warned, /systempaths=unconfined/);
  // The /proc fallback must not drag --disable-userns down with it.
  assert.deepEqual(await sandboxLaunchProfile(fakeBwrap), { disableUserns: true, procMode: "bind" });
  assert.ok(!/does not support --disable-userns/.test(warned));
});

test("runner reports an unusable sandbox instead of claiming executions still run", async (context) => {
  // A host that cannot build any sandbox (no unprivileged user namespaces).
  // `disableUserns` is false here too, so reporting that degradation would name
  // the wrong cause and promise executions that will in fact all fail.
  const root = resolve(process.cwd(), ".tmp", `bwrap-unusable-${process.pid}-${Date.now()}`);
  const fakeBwrap = resolve(root, "bwrap");
  await mkdir(root, { recursive: true });
  await writeFile(fakeBwrap, [
    "#!/bin/sh",
    `if [ "$1" = "--help" ]; then echo '${BWRAP_HELP_WITHOUT_OPTION} --disable-userns'; exit 0; fi`,
    "echo 'bwrap: No permissions to creating new namespace' >&2",
    "exit 1",
    "",
  ].join("\n"));
  await chmod(fakeBwrap, 0o755);
  context.after(() => rm(root, { force: true, recursive: true }));

  let server!: Server;
  const warned = await warningsFrom(async () => {
    server = await startRunnerServer({ ...config(resolve(root, "data")), bwrapPath: fakeBwrap });
  });
  context.after(() => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); }));

  // Startup still succeeds: the Web UI and control API stay up, as before.
  assert.ok(server.listening);
  assert.match(warned, /could not build a sandbox/);
  assert.match(warned, /cannot create a sandbox on this host/);
  assert.match(warned, /run_python and run_shell will fail/);
  assert.match(warned, /No permissions to creating new namespace/);
  // Neither degradation may be reported: both promise working executions.
  assert.ok(!/executions still run/.test(warned));
  assert.ok(!/supports --disable-userns but cannot use it here/.test(warned));
  assert.ok(!/does not support --disable-userns/.test(warned));
  assert.ok(!/cannot mount a fresh \/proc/.test(warned));
});

test("runner health remains available while Python base bootstraps in the background", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `runner-background-bootstrap-${process.pid}-${Date.now()}`);
  const provisionerPath = resolve(root, "micromamba");
  await mkdir(root, { recursive: true });
  await writeFile(provisionerPath, "#!/bin/sh\nexit 0\n");
  await chmod(provisionerPath, 0o755);
  context.after(() => rm(root, { force: true, recursive: true }));
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolveGate) => { releaseCreate = resolveGate; });
  const store = new EnvironmentStore({
    allowedChannels: ["conda-forge"],
    enabled: true,
    provisionerPath,
    root: resolve(root, "scientific-envs"),
    runnerVersion: "test",
  }, async (_path, arguments_) => {
    const prefixIndex = arguments_.indexOf("--prefix");
    const prefix = prefixIndex >= 0 ? arguments_[prefixIndex + 1]! : "";
    if (arguments_[1] === "create") {
      await createGate;
      await mkdir(resolve(prefix, "bin"), { recursive: true });
      await writeFile(resolve(prefix, "bin", "python"), "test");
      await chmod(resolve(prefix, "bin", "python"), 0o755);
      return "";
    }
    if (arguments_[1] === "list") {
      return JSON.stringify([{ build_string: "test_0", name: "python", version: "3.12" }]);
    }
    throw new Error(`Unexpected provisioner command: ${arguments_[1]}`);
  });
  await store.initialize();
  const server = createRunnerServer({ ...config(root), scientificEnvsEnabled: true }, store);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assert.equal(store.startManagedEnvironmentSetup().state, "installing");
  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  const installing = await fetch(`${origin}/environment-setup`, {
    headers: { authorization: "Bearer runner-test-token" },
  });
  assert.equal((await installing.json() as { state: string }).state, "installing");

  releaseCreate();
  await store.setupManagedEnvironments();
  const ready = await fetch(`${origin}/environment-setup`, {
    headers: { authorization: "Bearer runner-test-token" },
  });
  assert.equal((await ready.json() as { state: string }).state, "ready");
  assert.deepEqual(store.list().map((environment) => environment.id), ["starter-python"]);
});

async function workspaceFixture(context: { after: (callback: () => Promise<void>) => void }) {
  const dataDir = resolve(process.cwd(), ".tmp", `runner-${Date.now()}-${process.pid}-${Math.random()}`);
  const workspaceRoot = resolve(dataDir, "projects", "project", "sessions", "session", "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  return { dataDir, workspaceRoot };
}

function signedExecutionInit(token: string, value: unknown, timestamp = Date.now().toString()): RequestInit {
  const body = JSON.stringify(value);
  return {
    body,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      [EXECUTION_SIGNATURE_HEADER]: createExecutionSignature(token, timestamp, body),
      [EXECUTION_TIMESTAMP_HEADER]: timestamp,
    },
    method: "POST",
  };
}

test("bubblewrap runner exposes only the workspace and denies network", async (context) => {
  const fixture = await workspaceFixture(context);
  const result = await executePython(config(fixture.dataDir), {
    agentId: "main",
    code: [
      "import socket",
      "import ctypes",
      "from pathlib import Path",
      "Path('result.txt').write_text('isolated')",
      "print(f'host_passwd={Path(\"/etc/passwd\").exists()}')",
      "libc = ctypes.CDLL(None, use_errno=True)",
      "print(f'no_new_privs={libc.prctl(39, 0, 0, 0, 0)}')",
      "ctypes.set_errno(0)",
      "print(f'unshare={libc.syscall(272, 0)}:{ctypes.get_errno()}')",
      "try:",
      "    socket.create_connection(('1.1.1.1', 53), timeout=0.2)",
      "    print('network=available')",
      "except OSError:",
      "    print('network=denied')",
    ].join("\n"),
    executionId: "execution-isolation",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.sandbox, "bubblewrap");
  assert.equal(result.cgroupMode, RESOURCE_LIMIT_MODE);
  assert.equal(result.networkPolicy, "none");
  assert.match(result.stdout, /host_passwd=False/);
  assert.match(result.stdout, /no_new_privs=1/);
  assert.match(result.stdout, /unshare=-1:1/);
  assert.match(result.stdout, /network=denied/);
  assert.deepEqual(result.createdFiles, ["result.txt"]);
  assert.equal(await readFile(resolve(fixture.workspaceRoot, "result.txt"), "utf8"), "isolated");
});

test("bubblewrap runner can read but not write the parent workspace mount", async (context) => {
  const fixture = await workspaceFixture(context);
  const parentWorkspaceRoot = fixture.workspaceRoot;
  const privateWorkspaceRoot = resolve(parentWorkspaceRoot, "subagents", "subagent-1");
  await mkdir(resolve(parentWorkspaceRoot, "final"), { recursive: true });
  await mkdir(privateWorkspaceRoot, { recursive: true });
  await writeFile(resolve(parentWorkspaceRoot, "final/summary.md"), "parent\n");

  const result = await executePython(config(fixture.dataDir), {
    agentId: "subagent:subagent-1",
    code: [
      "from pathlib import Path",
      "print(Path('/workspace/final/summary.md').read_text().strip())",
      "try:",
      "    Path('/workspace/final/new.txt').write_text('nope')",
      "    print('parent_write=allowed')",
      "except OSError:",
      "    print('parent_write=denied')",
      "Path('result.txt').write_text('private')",
    ].join("\n"),
    executionId: "execution-parent-ro",
    permissionEpoch: epoch(),
    readOnlyWorkspaceRoot: parentWorkspaceRoot,
    workspaceRoot: privateWorkspaceRoot,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^parent$/m);
  assert.match(result.stdout, /^parent_write=denied$/m);
  assert.equal(await readFile(resolve(privateWorkspaceRoot, "result.txt"), "utf8"), "private");
  await assert.rejects(readFile(resolve(parentWorkspaceRoot, "final/new.txt")));
});

test("runner rejects workspaces outside its configured projects root", async (context) => {
  const fixture = await workspaceFixture(context);
  await assert.rejects(
    executePython(config(fixture.dataDir), {
      agentId: "main",
      code: "print('no')",
      executionId: "execution-outside",
      permissionEpoch: epoch(),
        workspaceRoot: resolve(fixture.dataDir, "outside"),
    }),
    /inside the configured projects directory|ENOENT/,
  );
});

test("per-request Runner timeout overrides the unlimited process default with an explicit duration", async (context) => {
  const fixture = await workspaceFixture(context);
  await assert.rejects(
    executePython({ ...config(fixture.dataDir), execTimeoutMs: 0 }, {
      agentId: "main",
      code: "import time\ntime.sleep(1)",
      executionId: "execution-short-timeout",
      executionTimeoutMs: 25,
      permissionEpoch: epoch(),
      workspaceRoot: fixture.workspaceRoot,
    }),
    /Python execution timed out after 25 ms/,
  );
});

test("runner allows files larger than the former 16 MiB per-file quota", async (context) => {
  const fixture = await workspaceFixture(context);
  const result = await executePython(config(fixture.dataDir), {
    agentId: "main",
    code: "from pathlib import Path\nPath('big.bin').write_bytes(b'x' * 17_000_000)",
    executionId: "execution-large-file-ok",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.createdFiles, ["big.bin"]);
});

test("runner truncates oversized execution output instead of failing", async (context) => {
  const fixture = await workspaceFixture(context);
  const result = await executePython({
    ...config(fixture.dataDir),
    maxOutputBytes: 2_000,
  }, {
    agentId: "main",
    code: "print('x' * 5000)",
    executionId: "execution-output-truncate",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /output truncated/);
  assert.ok(Buffer.byteLength(result.stdout) <= 2_000);
});

test("runner enforces a finite workspace total quota", async (context) => {
  const fixture = await workspaceFixture(context);
  await assert.rejects(executePython({
    ...config(fixture.dataDir),
    maxWorkspaceBytes: 1_000,
  }, {
    agentId: "main",
    code: "from pathlib import Path\nPath('too-big.bin').write_bytes(b'x' * 50_000)",
    executionId: "execution-workspace-limit",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  }), /byte execution quota/);
});

test("runner HTTP service requires its internal token", async (context) => {
  const fixture = await workspaceFixture(context);
  const server = createRunnerServer(config(fixture.dataDir));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const unauthorized = await fetch(`${origin}/execute`, {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(unauthorized.status, 401);

  const health = await (await fetch(`${origin}/health`)).json() as RunnerHealth;
  assert.equal(health.status, "ok");
  assert.equal(health.sandbox, "bubblewrap");
  assert.equal(health.cgroupMode, RESOURCE_LIMIT_MODE);
  assert.equal(health.cgroupDelegated, false);
  assert.equal(health.executionTimeoutMs, 60_000);
  assert.equal(health.maxFileBytes, 0);
  assert.equal(health.maxWorkspaceBytes, 10_737_418_240);
  assert.equal(health.maxOutputBytes, 1_073_741_824);
  assert.equal(health.npuBroker.enabled, true);
  assert.equal(health.npuBroker.workloads.some((workload) => workload.id === "npu.smoke_test"), true);
  assert.deepEqual(health.npuBroker.workloads.map((workload) => workload.id), [
    "npu.smoke_test",
    "antibody.protenix.v1",
  ]);
  assert.equal(health.npuBroker.workloads.some((workload) => workload.id === "antibody.pipeline.v1"), false);
});

test("runner NPU Broker runs a signed allowlisted smoke job", async (context) => {
  const fixture = await workspaceFixture(context);
  const smokeScript = resolve(fixture.dataDir, "smoke.cjs");
  await writeFile(smokeScript, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const workspace = process.argv[2];",
    "fs.writeFileSync(path.join(workspace, 'npu-smoke.txt'), 'ok');",
    "if (!process.env.HOME || !fs.statSync(process.env.HOME).isDirectory()) throw new Error('NPU HOME is not a directory');",
    "fs.writeFileSync(path.join(process.env.HOME, 'home-marker.txt'), 'ok');",
    "console.log('pythonpath=' + process.env.PYTHONPATH);",
    "console.log('home=' + process.env.HOME);",
    "console.log('npu smoke ok');",
  ].join("\n"));
  const runnerConfig = {
    ...config(fixture.dataDir),
    npuPythonPath: process.execPath,
    npuSmokeScriptPath: smokeScript,
  };
  const server = createNpuTestServer(runnerConfig, process.execPath);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const unsigned = await fetch(`${origin}/npu/jobs`, {
    body: "{}",
    headers: { authorization: "Bearer runner-test-token", "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(unsigned.status, 401);

  const missingRevision = await fetch(`${origin}/npu/jobs`, signedExecutionInit("runner-test-token", {
    jobId: "npu-smoke-missing-revision",
    sessionId: "session-test",
    workloadId: "npu.smoke_test",
    workspaceRoot: fixture.workspaceRoot,
  }));
  assert.equal(missingRevision.status, 400);
  assert.match(await missingRevision.text(), /environmentRevisionId is required/);

  const submitted = await (await fetch(`${origin}/npu/jobs`, signedExecutionInit("runner-test-token", {
    jobId: "npu-smoke-job",
    environmentRevisionId: "test-npu-revision",
    sessionId: "session-test",
    workloadId: "npu.smoke_test",
    workspaceRoot: fixture.workspaceRoot,
  }))).json() as NpuJob;
  assert.equal(submitted.state, "queued");

  let job = submitted;
  for (let attempt = 0; attempt < 300 && job.state !== "succeeded"; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    job = await (await fetch(`${origin}/npu/jobs/${job.id}?session_id=session-test`, {
      headers: { authorization: "Bearer runner-test-token" },
    })).json() as NpuJob;
  }
  assert.equal(job.state, "succeeded", job.logs.stderr || job.logs.stdout);
  assert.equal(job.exitCode, 0);
  assert.equal(job.logs.truncated, false);
  const pythonPath = job.logs.stdout.match(/pythonpath=(.*)/)?.[1] ?? "";
  assert.equal(pythonPath.split(delimiter)[0], dirname(process.execPath));
  assert.match(job.logs.stdout, /npu smoke ok/);

  const missingSession = await fetch(`${origin}/npu/jobs/${job.id}`, {
    headers: { authorization: "Bearer runner-test-token" },
  });
  assert.equal(missingSession.status, 400);
  const wrongSession = await fetch(`${origin}/npu/jobs/${job.id}?session_id=session-other`, {
    headers: { authorization: "Bearer runner-test-token" },
  });
  assert.equal(wrongSession.status, 400);

  const logs = await (await fetch(`${origin}/npu/jobs/${job.id}/logs?session_id=session-test`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as { stdout: string };
  assert.match(logs.stdout, /npu smoke ok/);

  const result = await (await fetch(`${origin}/npu/jobs/${job.id}/result?session_id=session-test`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as { job: NpuJob };
  assert.equal(result.job.state, "succeeded");
  assert.equal(await readFile(resolve(fixture.workspaceRoot, "npu-smoke.txt"), "utf8"), "ok");
  assert.equal(await readFile(resolve(fixture.workspaceRoot, ".npu-home", "home-marker.txt"), "utf8"), "ok");

  const filteredJobs = await (await fetch(`${origin}/npu/jobs?session_id=session-test`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as NpuJob[];
  assert.equal(filteredJobs.length, 1);
  assert.equal(filteredJobs[0]?.id, "npu-smoke-job");
  assert.equal(filteredJobs[0]?.workspaceRoot, "");
  assert.equal(filteredJobs[0]?.logs.stdout, "");
  assert.equal(filteredJobs[0]?.logs.stderr, "");

  const otherSessionJobs = await (await fetch(`${origin}/npu/jobs?session_id=session-other`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as NpuJob[];
  assert.deepEqual(otherSessionJobs, []);

  const unscopedJobs = await fetch(`${origin}/npu/jobs`, {
    headers: { authorization: "Bearer runner-test-token" },
  });
  assert.equal(unscopedJobs.status, 400);

  const unsignedCancel = await fetch(`${origin}/npu/jobs/${job.id}/cancel`, {
    body: JSON.stringify({ sessionId: "session-test" }),
    headers: { authorization: "Bearer runner-test-token", "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(unsignedCancel.status, 401);

  const signedCancel = await fetch(`${origin}/npu/jobs/${job.id}/cancel`, signedExecutionInit("runner-test-token", {
    sessionId: "session-test",
  }));
  assert.equal(signedCancel.status, 200);
});

test("runner NPU Broker ignores a corrupt persisted catalog during startup", async (context) => {
  const fixture = await workspaceFixture(context);
  await mkdir(resolve(fixture.dataDir, "npu-jobs"), { recursive: true });
  await writeFile(resolve(fixture.dataDir, "npu-jobs", "jobs.json"), "{not-valid-json");
  const server = createRunnerServer(config(fixture.dataDir));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const health = await (await fetch(`${origin}/health`)).json() as RunnerHealth;
  assert.equal(health.status, "ok");
  assert.equal(health.npuBroker.enabled, true);
  const jobs = await (await fetch(`${origin}/npu/jobs?session_id=session-test`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as NpuJob[];
  assert.deepEqual(jobs, []);
});

test("runner NPU Broker rejects AF3 configs submitted to the Protenix workload", async (context) => {
  const fixture = await workspaceFixture(context);
  await mkdir(resolve(fixture.workspaceRoot, "antibody_pipeline"), { recursive: true });
  await writeFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "config.json"), JSON.stringify({
    af3_dir: "/site/AlphaFold3",
    db_dir: "/site/af3_data",
    pipeline_backend: "alphafold3",
    workspace: "antibody_pipeline",
  }));
  const server = createNpuTestServer(config(fixture.dataDir), process.execPath);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${origin}/npu/jobs`, signedExecutionInit("runner-test-token", {
    inputs: { configPath: "antibody_pipeline/config.json" },
    environmentRevisionId: "test-npu-revision",
    jobId: "wrong-af3-workload",
    sessionId: "session-test",
    workloadId: "antibody.protenix.v1",
    workspaceRoot: fixture.workspaceRoot,
  }));
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /only exposes antibody\.protenix\.v1/);
});

test("runner NPU Broker runs the Protenix manager workload through its own allowlisted entrypoint", async (context) => {
  const fixture = await workspaceFixture(context);
  const python = pythonForTest();
  if (!python) {
    context.skip("Python interpreter unavailable");
    return;
  }
  const managerScript = resolve(fixture.dataDir, "protenix_manager.py");
  await writeFile(managerScript, [
    "import json",
    "import sys",
    "from pathlib import Path",
    "",
    "PRESETS = {'6DZM': {'target_pdb_name': '6DZM_A_renumbered.pdb', 'framework_pdb_name': 'Ebola_rfantibody/3dwt_HLT.pdb'}}",
    "",
    "def read_json(path):",
    "    return json.loads(path.open(encoding='utf-8').read())",
    "",
    "def resolve_config(cfg):",
    "    cfg = dict(cfg)",
    "    workspace = Path(cfg['workspace']).resolve()",
    "    cfg['workspace'] = str(workspace)",
    "    app_dir = Path(cfg['app_dir'])",
    "    cfg['protenix_dir'] = str(app_dir / 'protenix')",
    "    cfg['protenix_ckpt'] = str(app_dir / 'protenix' / 'release_data' / 'checkpoint' / 'ms_model_v0.5.0.ckpt')",
    "    cfg['scripts_dir'] = str(workspace / 'helpers')",
    "    cfg['run_dir'] = str(workspace / 'runs' / cfg.get('run_name', 'protenix-test-run'))",
    "    cfg['python'] = sys.executable",
    "    return cfg",
    "",
    "def validate_format(cfg):",
    "    return []",
    "",
    "def validate_paths(cfg):",
    "    errors = []",
    "    for key in ('app_dir', 'rf_diffusion_dir', 'proteinmpnn_dir', 'protenix_dir'):",
    "        value = cfg.get(key, '')",
    "        if not value or not Path(value).is_dir():",
    "            errors.append(f'{key} invalid: {value}')",
    "    if not Path(cfg.get('protenix_ckpt', '')).is_file():",
    "        errors.append(f\"protenix_ckpt invalid: {cfg.get('protenix_ckpt', '')}\")",
    "    for key in ('target_pdb', 'framework_pdb'):",
    "        value = cfg.get(key, '')",
    "        if not value or str(value).startswith('/workspace') or not Path(value).is_file():",
    "            errors.append(f'{key} invalid: {value}')",
    "    return errors, []",
    "",
    "def command_for_full_run(cfg):",
    "    return ['bash', str(Path(cfg['workspace']) / 'helpers' / 'run_full_antibody_pipeline.sh'), '--scripts-dir', str(Path(cfg['workspace']) / 'helpers'), cfg['run_dir'], str(Path(cfg['workspace'])), cfg['target_pdb'], cfg['framework_pdb'], cfg['protenix_dir']]",
  ].join("\n"));
  await mkdir(resolve(fixture.dataDir, "scripts"), { recursive: true });
  await writeFile(resolve(fixture.dataDir, "scripts", "run_full_antibody_pipeline.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"$1\" != \"--scripts-dir\" ]]; then echo 'missing scripts dir flag' >&2; exit 2; fi",
    "scripts_dir=\"$2\"",
    "run=\"$3\"",
    "workspace=\"$4\"",
    "target=\"$5\"",
    "framework=\"$6\"",
    "protenix_dir=\"$7\"",
    "if [[ \"$scripts_dir\" != \"$(cd \"$(dirname \"$0\")\" && pwd -P)\" ]]; then echo \"wrong scripts dir: $scripts_dir\" >&2; exit 2; fi",
    "mkdir -p \"$run/01_rfdiffusion\" \"$run/02_proteinmpnn\" \"$run/03_protenix_input_json\" \"$run/04_protenix_output/design_0\" \"$run/05_screening\"",
    "printf rf-pdb > \"$run/01_rfdiffusion/output_000000.pdb\"",
    "printf rf-trb > \"$run/01_rfdiffusion/output_000000.trb\"",
    "printf mpnn-pdb > \"$run/02_proteinmpnn/output_000000_dldesign_0.pdb\"",
    "printf protenix-json > \"$run/03_protenix_input_json/output_000000_dldesign_0.json\"",
    "printf ranking > \"$run/04_protenix_output/design_0/ranking_scores.csv\"",
    "printf cif > \"$run/04_protenix_output/design_0/model.cif\"",
    "printf report > \"$run/05_screening/protenix_screening_report.md\"",
    "printf '%s/%s/%s/%s' \"$(cat \"$target\")\" \"$(cat \"$framework\")\" \"$(basename \"$framework\")\" \"$(basename \"$protenix_dir\")\" > \"$workspace/broker-result.txt\"",
    "echo 'protenix full run ok'",
  ].join("\n"));
  await chmod(resolve(fixture.dataDir, "scripts", "run_full_antibody_pipeline.sh"), 0o755);
  await mkdir(resolve(fixture.dataDir, "models", "mindscience", "MindSPONGE", "applications", "rf_diffusion"), { recursive: true });
  await mkdir(resolve(fixture.dataDir, "models", "mindscience", "MindSPONGE", "applications", "proteinmpnn"), { recursive: true });
  await mkdir(resolve(fixture.dataDir, "models", "mindscience", "MindSPONGE", "applications", "protenix", "release_data", "checkpoint"), { recursive: true });
  await writeFile(resolve(fixture.dataDir, "models", "mindscience", "MindSPONGE", "applications", "protenix", "release_data", "checkpoint", "ms_model_v0.5.0.ckpt"), "checkpoint");
  await mkdir(resolve(fixture.dataDir, "resources", "presets", "6DZM"), { recursive: true });
  await writeFile(resolve(fixture.dataDir, "resources", "presets", "6DZM", "6DZM_A_renumbered.pdb"), "target");
  await writeFile(resolve(fixture.dataDir, "resources", "presets", "6DZM", "3dwt_HLT.pdb"), "framework");
  await mkdir(resolve(fixture.workspaceRoot, "antibody_pipeline"), { recursive: true });
  await mkdir(resolve(fixture.workspaceRoot, "antibody_pipeline", "helpers"), { recursive: true });
  await writeFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "helpers", "run_full_antibody_pipeline.sh"), [
    "#!/usr/bin/env bash",
    "echo compromised",
    "printf compromised > \"$2/compromised.txt\"",
  ].join("\n"));
  await chmod(resolve(fixture.workspaceRoot, "antibody_pipeline", "helpers", "run_full_antibody_pipeline.sh"), 0o755);
  await writeFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "config.json"), JSON.stringify({
    preset: "6DZM",
    scripts_dir: "/workspace/antibody_pipeline/helpers",
    run_name: "broker-protenix-test",
    workspace: "/workspace/antibody_pipeline",
  }));
  const runnerConfig = {
    ...config(fixture.dataDir),
    npuProtenixScriptPath: managerScript,
    npuPythonPath: python,
  };
  const server = createNpuTestServer(runnerConfig, python);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const submitted = await (await fetch(`${origin}/npu/jobs`, signedExecutionInit("runner-test-token", {
    inputs: { configPath: "antibody_pipeline/config.json" },
    environmentRevisionId: "test-npu-revision",
    jobId: "protenix-manager-job",
    sessionId: "session-test",
    workloadId: "antibody.protenix.v1",
    workspaceRoot: fixture.workspaceRoot,
  }))).json() as NpuJob;
  assert.equal(submitted.state, "queued");

  let job = submitted;
  for (let attempt = 0; attempt < 300 && job.state !== "succeeded"; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    job = await (await fetch(`${origin}/npu/jobs/${job.id}?session_id=session-test`, {
      headers: { authorization: "Bearer runner-test-token" },
    })).json() as NpuJob;
  }
  assert.equal(job.state, "succeeded", job.logs.stderr || job.logs.stdout);
  assert.equal(job.exitCode, 0);
  assert.match(job.logs.stdout, /RUN_DIR=.*broker-protenix-test/);
  assert.match(job.logs.stdout, /protenix full run ok/);
  assert.equal(await readFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "broker-result.txt"), "utf8"), "target/framework/3dwt_HLT.pdb/protenix");
  await assert.rejects(readFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "compromised.txt"), "utf8"));
  assert.doesNotMatch(job.logs.stdout, /compromised/);
  const result = await (await fetch(`${origin}/npu/jobs/${job.id}/result?session_id=session-test`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as { job: NpuJob };
  assert.deepEqual(result.job.createdFiles, [
    "antibody_pipeline/runs/broker-protenix-test/01_rfdiffusion/output_000000.pdb",
    "antibody_pipeline/runs/broker-protenix-test/01_rfdiffusion/output_000000.trb",
    "antibody_pipeline/runs/broker-protenix-test/02_proteinmpnn/output_000000_dldesign_0.pdb",
    "antibody_pipeline/runs/broker-protenix-test/03_protenix_input_json/output_000000_dldesign_0.json",
    "antibody_pipeline/runs/broker-protenix-test/04_protenix_output/design_0/model.cif",
    "antibody_pipeline/runs/broker-protenix-test/04_protenix_output/design_0/ranking_scores.csv",
    "antibody_pipeline/runs/broker-protenix-test/05_screening/protenix_screening_report.md",
  ]);
});

test("runner NPU Broker rewrites workspace helper directory arguments even when helpers is absent", async (context) => {
  const fixture = await workspaceFixture(context);
  const python = pythonForTest();
  if (!python) {
    context.skip("Python interpreter unavailable");
    return;
  }
  const managerScript = resolve(fixture.dataDir, "protenix_manager_no_helpers.py");
  await writeFile(managerScript, [
    "import json",
    "import sys",
    "from pathlib import Path",
    "",
    "def read_json(path):",
    "    return json.loads(path.open(encoding='utf-8').read())",
    "",
    "def resolve_config(cfg):",
    "    cfg = dict(cfg)",
    "    workspace = Path(cfg['workspace']).resolve()",
    "    cfg['workspace'] = str(workspace)",
    "    app_dir = Path(cfg['app_dir'])",
    "    cfg['protenix_dir'] = cfg.get('protenix_dir') or str(app_dir / 'protenix')",
    "    cfg['protenix_ckpt'] = cfg.get('protenix_ckpt') or str(app_dir / 'protenix' / 'release_data' / 'checkpoint' / 'ms_model_v0.5.0.ckpt')",
    "    cfg['scripts_dir'] = str(workspace / 'helpers')",
    "    cfg['run_dir'] = str(workspace / 'runs' / cfg.get('run_name', 'protenix-no-helpers-test'))",
    "    cfg['python'] = sys.executable",
    "    return cfg",
    "",
    "def validate_format(cfg):",
    "    return []",
    "",
    "def validate_paths(cfg):",
    "    errors = []",
    "    for key in ('app_dir', 'rf_diffusion_dir', 'proteinmpnn_dir', 'protenix_dir'):",
    "        value = cfg.get(key, '')",
    "        if not value or not Path(value).is_dir():",
    "            errors.append(f'{key} invalid: {value}')",
    "    if not Path(cfg.get('protenix_ckpt', '')).is_file():",
    "        errors.append(f\"protenix_ckpt invalid: {cfg.get('protenix_ckpt', '')}\")",
    "    for key in ('target_pdb', 'framework_pdb'):",
    "        value = cfg.get(key, '')",
    "        if not value or not Path(value).is_file():",
    "            errors.append(f'{key} invalid: {value}')",
    "    return errors, []",
    "",
    "def command_for_full_run(cfg):",
    "    return [cfg['python'], str(Path(cfg['workspace']) / 'helpers' / 'run_full_antibody_pipeline.py'), '--scripts-dir', str(Path(cfg['workspace']) / 'helpers'), cfg['run_dir'], str(Path(cfg['workspace'])), cfg['target_pdb'], cfg['framework_pdb'], cfg['protenix_dir'], cfg['protenix_ckpt']]",
  ].join("\n"));
  await mkdir(resolve(fixture.dataDir, "scripts"), { recursive: true });
  await writeFile(resolve(fixture.dataDir, "scripts", "run_full_antibody_pipeline.py"), [
    "import argparse",
    "from pathlib import Path",
    "",
    "parser = argparse.ArgumentParser()",
    "parser.add_argument('--scripts-dir', required=True)",
    "parser.add_argument('run')",
    "parser.add_argument('workspace')",
    "parser.add_argument('target')",
    "parser.add_argument('framework')",
    "parser.add_argument('protenix_dir')",
    "parser.add_argument('protenix_ckpt')",
    "args = parser.parse_args()",
    "expected = Path(__file__).resolve().parent",
    "if Path(args.scripts_dir).resolve() != expected:",
    "    raise SystemExit(f'wrong scripts dir: {args.scripts_dir}')",
    "run = Path(args.run)",
    "workspace = Path(args.workspace)",
    "report = run / '05_screening' / 'protenix_screening_report.md'",
    "report.parent.mkdir(parents=True, exist_ok=True)",
    "report.write_text('report', encoding='utf-8')",
    "(workspace / 'no-helpers-result.txt').write_text(Path(args.target).read_text(encoding='utf-8') + '/' + Path(args.framework).read_text(encoding='utf-8') + '/' + Path(args.protenix_dir).name + '/' + Path(args.protenix_ckpt).name, encoding='utf-8')",
    "print('no workspace helpers run ok')",
  ].join("\n"));
  await mkdir(resolve(fixture.dataDir, "models", "mindscience", "MindSPONGE", "applications", "rf_diffusion"), { recursive: true });
  await mkdir(resolve(fixture.dataDir, "models", "mindscience", "MindSPONGE", "applications", "proteinmpnn"), { recursive: true });
  await mkdir(resolve(fixture.dataDir, "models", "mindscience", "MindSPONGE", "applications", "protenix", "release_data", "checkpoint"), { recursive: true });
  await writeFile(resolve(fixture.dataDir, "models", "mindscience", "MindSPONGE", "applications", "protenix", "release_data", "checkpoint", "ms_model_v0.5.0.ckpt"), "checkpoint");
  await mkdir(resolve(fixture.workspaceRoot, "antibody_pipeline", "inputs"), { recursive: true });
  await mkdir(resolve(fixture.workspaceRoot, "rogue-protenix"), { recursive: true });
  await writeFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "inputs", "target.pdb"), "target-input");
  await writeFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "inputs", "framework.pdb"), "framework-input");
  await writeFile(resolve(fixture.workspaceRoot, "rogue-protenix", "evil.ckpt"), "evil");
  await writeFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "config.json"), JSON.stringify({
    framework_pdb: "antibody_pipeline/inputs/framework.pdb",
    protenix_ckpt: resolve(fixture.workspaceRoot, "rogue-protenix", "evil.ckpt"),
    protenix_dir: resolve(fixture.workspaceRoot, "rogue-protenix"),
    run_name: "nh",
    target_pdb: "antibody_pipeline/inputs/target.pdb",
    workspace: "/workspace/antibody_pipeline",
  }));
  await assert.rejects(stat(resolve(fixture.workspaceRoot, "antibody_pipeline", "helpers")));
  const runnerConfig = {
    ...config(fixture.dataDir),
    npuProtenixScriptPath: managerScript,
    npuPythonPath: python,
  };
  const server = createNpuTestServer(runnerConfig, python);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const submitted = await (await fetch(`${origin}/npu/jobs`, signedExecutionInit("runner-test-token", {
    inputs: { configPath: "antibody_pipeline/config.json" },
    environmentRevisionId: "test-npu-revision",
    jobId: "protenix-no-helpers-job",
    sessionId: "session-test",
    workloadId: "antibody.protenix.v1",
    workspaceRoot: fixture.workspaceRoot,
  }))).json() as NpuJob;
  assert.equal(submitted.state, "queued");

  let job = submitted;
  for (let attempt = 0; attempt < 300 && job.state !== "succeeded"; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    job = await (await fetch(`${origin}/npu/jobs/${job.id}?session_id=session-test`, {
      headers: { authorization: "Bearer runner-test-token" },
    })).json() as NpuJob;
  }
  assert.equal(job.state, "succeeded", job.logs.stderr || job.logs.stdout);
  assert.match(job.logs.stdout, /no workspace helpers run ok/);
  await stat(resolve(fixture.workspaceRoot, "antibody_pipeline", "helpers"));
  assert.equal(await readFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "no-helpers-result.txt"), "utf8"), "target-input/framework-input/protenix/ms_model_v0.5.0.ckpt");
});

test("Protenix full pipeline forwards user hotspots to the screening stage", async () => {
  const script = await readFile(resolve(protenixPipelineScriptsDir, "run_full_antibody_pipeline.sh"), "utf8");
  const downstream = await readFile(resolve(protenixPipelineScriptsDir, "run_after_rfdiffusion.sh"), "utf8");

  assert.match(script, /--hotspots "\$HOTSPOTS"/);
  assert.match(script, /--target-pdb "\$TARGET_PDB"/);
  assert.doesNotMatch(script, /--hotspots "\$SCREEN_HOTSPOTS"/);
  assert.doesNotMatch(script, /SCREEN_HOTSPOTS=/);
  assert.doesNotMatch(script, /--screen-hotspots/);
  assert.match(downstream, /run_logged proteinmpnn run_proteinmpnn_inline/);
  assert.match(downstream, /run_proteinmpnn_inline\(\) \(/);
  assert.match(downstream, /run_protenix_inline\(\) \(/);
  assert.doesNotMatch(downstream, /bash -lc/);
  assert.doesNotMatch(downstream, /\$PWD\/antibody_pipeline\/helpers/);
});

test("Protenix shell scheduler enforces device concurrency and reports failed designs", async (context) => {
  const bash = bashForTest();
  if (!bash) {
    context.skip("bash unavailable");
    return;
  }

  const root = await mkdtemp(resolve(tmpdir(), "sciencediscovery-protenix-scheduler-"));
  try {
    const script = resolve(protenixPipelineScriptsDir, "run_after_rfdiffusion.sh");
    const scriptsDir = protenixPipelineScriptsDir;
    const runDir = resolve(root, "run");
    const rfDir = resolve(runDir, "01_rfdiffusion");
    const appDir = resolve(root, "app");
    const proteinmpnnDir = resolve(appDir, "proteinmpnn");
    const protenixDir = resolve(appDir, "protenix");
    const fakePython = resolve(root, "scientific-envs", "revisions", "env", "rev", "bin", "python3");
    const checkpoint = resolve(root, "checkpoint.ckpt");
    const targetPdb = resolve(root, "target.pdb");
    const eventsPath = resolve(root, "events.log");

    await mkdir(rfDir, { recursive: true });
    await mkdir(proteinmpnnDir, { recursive: true });
    await mkdir(protenixDir, { recursive: true });
    await mkdir(dirname(fakePython), { recursive: true });
    await writeFile(resolve(proteinmpnnDir, "proteinmpnn_interface_design.py"), "# stub\n");
    await writeFile(resolve(protenixDir, "inference.py"), "# stub\n");
    await writeFile(checkpoint, "checkpoint");
    await writeFile(targetPdb, "ATOM\n");
    for (let index = 0; index < 12; index += 1) {
      await writeFile(resolve(rfDir, `output_${index.toString().padStart(6, "0")}.pdb`), "MODEL\n");
    }

    await writeFile(fakePython, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-" ]]; then
  cat >/dev/null
  echo "Protenix import check ok"
  exit 0
fi
script="\${1:-}"
base="$(basename "$script")"
if [[ "$base" == "proteinmpnn_interface_design.py" ]]; then
  pdbdir=""
  outpdbdir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -pdbdir) pdbdir="$2"; shift 2 ;;
      -outpdbdir) outpdbdir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$outpdbdir"
  for pdb in "$pdbdir"/output_*.pdb; do
    name="$(basename "\${pdb%.pdb}")"
    printf "PDB\\n" > "$outpdbdir/\${name}_dldesign_0.pdb"
  done
  exit 0
fi
if [[ "$base" == "pdb_to_protenix_json.py" ]]; then
  input_dir="$2"
  out_dir=""
  shift 2
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o) out_dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$out_dir"
  for pdb in "$input_dir"/*.pdb; do
    name="$(basename "\${pdb%.pdb}")"
    printf '{"name":"%s"}\\n' "$name" > "$out_dir/$name.json"
    printf '{}\\n' > "$out_dir/$name.chain_map.json"
  done
  exit 0
fi
if [[ "$base" == "protenix_py312_compat.py" ]]; then
  shift
  script="$1"
  base="$(basename "$script")"
fi
if [[ "$base" == "inference.py" ]]; then
  json_path=""
  dump_dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --input_json_path) json_path="$2"; shift 2 ;;
      --dump_dir) dump_dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  name="$(basename "\${json_path%.json}")"
  npu="\${ASCEND_RT_VISIBLE_DEVICES:-\${DEVICE_ID:-unknown}}"
  start="$(date +%s%N)"
  printf 'start %s %s %s\\n' "$name" "$npu" "$start" >> "$SCIENCE_AGENT_PROTENIX_TEST_EVENTS"
  sleep 0.2
  end="$(date +%s%N)"
  printf 'end %s %s %s\\n' "$name" "$npu" "$end" >> "$SCIENCE_AGENT_PROTENIX_TEST_EVENTS"
  if [[ "\${SCIENCE_AGENT_PROTENIX_FAIL_NAME:-}" == "$name" ]]; then
    echo "intentional failure for $name" >&2
    exit 9
  fi
  pred="$dump_dir/$name/seed_42/predictions"
  mkdir -p "$pred"
  printf '{}\\n' > "$pred/\${name}_seed_42_summary_confidence_sample_0.json"
  printf 'CIF\\n' > "$pred/\${name}_seed_42_sample_0.cif"
  exit 0
fi
if [[ "$base" == "screen_protenix_results.py" ]]; then
  out_dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out-dir) out_dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$out_dir"
  printf 'design,decision,hotspot_sequence_positions,hotspot_mapping_error\\n' > "$out_dir/protenix_screening_summary.csv"
  printf '# report\\n' > "$out_dir/protenix_screening_report.md"
  exit 0
fi
echo "unexpected fake python invocation: $*" >&2
exit 2
`);
    await chmod(fakePython, 0o755);

    const commonArgs = [
      script,
      "--run-dir", runDir,
      "--rf-dir", rfDir,
      "--target-pdb", targetPdb,
      "--num-designs", "12",
      "--app-dir", appDir,
      "--scripts-dir", scriptsDir,
      "--python", fakePython,
      "--npus", "0,1,2",
      "--protenix-dir", protenixDir,
      "--protenix-ckpt", checkpoint,
      "--hotspots", "[A1]",
      "--force",
    ];
    execFileSync(bash, commonArgs, {
      encoding: "utf8",
      env: {
        ...process.env,
        ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV: "0",
        SCIENCE_AGENT_PROTENIX_TEST_EVENTS: eventsPath,
      },
    });

    const events = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).map((line, seq) => {
      const match = /^(start|end) (\S+) (\S+) (\d+)$/.exec(line);
      if (!match) {
        throw new Error(`invalid scheduler event: ${line}`);
      }
      return { kind: match[1] as "start" | "end", name: match[2]!, npu: match[3]!, time: BigInt(match[4]!), seq };
    }).sort((a, b) => a.time === b.time ? a.seq - b.seq : (a.time < b.time ? -1 : 1));

    let active = 0;
    let peak = 0;
    const activeByNpu = new Map<string, string>();
    for (const event of events) {
      if (event.kind === "start") {
        assert.equal(activeByNpu.has(event.npu), false, `overlap on NPU ${event.npu}`);
        activeByNpu.set(event.npu, event.name);
        active += 1;
        peak = Math.max(peak, active);
      } else {
        assert.equal(activeByNpu.get(event.npu), event.name);
        activeByNpu.delete(event.npu);
        active -= 1;
      }
    }
    assert.equal(peak, 3);
    assert.equal(active, 0);
    assert.equal(await readFile(resolve(runDir, "05_screening", "protenix_screening_summary.csv"), "utf8"), "design,decision,hotspot_sequence_positions,hotspot_mapping_error\n");

    await rm(resolve(runDir, "02_proteinmpnn"), { recursive: true, force: true });
    await rm(resolve(runDir, "03_protenix_input_json"), { recursive: true, force: true });
    await rm(resolve(runDir, "04_protenix_output"), { recursive: true, force: true });
    await rm(resolve(runDir, "05_screening"), { recursive: true, force: true });
    await writeFile(eventsPath, "");
    let failureOutput = "";
    assert.throws(() => {
      execFileSync(bash, commonArgs, {
        encoding: "utf8",
        env: {
          ...process.env,
          ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV: "0",
          SCIENCE_AGENT_PROTENIX_TEST_EVENTS: eventsPath,
          SCIENCE_AGENT_PROTENIX_FAIL_NAME: "output_000004_dldesign_0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    }, (error: unknown) => {
      const execError = error as { stdout?: Buffer | string; stderr?: Buffer | string };
      failureOutput = `${execError.stdout ?? ""}${execError.stderr ?? ""}`;
      return true;
    });
    assert.match(failureOutput, /Protenix jobs failed: output_000004_dldesign_0/);
    assert.match(failureOutput, /launched 6\/12, completed 5, skipped 6/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Protenix manager normalizes hotspot formats and rejects invalid diffuser schedules", (context) => {
  const python = pythonForTest();
  if (!python) {
    context.skip("Python interpreter unavailable");
    return;
  }
  const managerScript = resolve(protenixPipelineScriptsDir, "antibody_pipeline_manager.py");
  const code = [
    "import importlib.util",
    "import sys",
    "import tempfile",
    "import types",
    "from pathlib import Path",
    "sys.modules.setdefault('numpy', types.SimpleNamespace(array=lambda values: tuple(values)))",
    `manager_script = ${JSON.stringify(managerScript)}`,
    "spec = importlib.util.spec_from_file_location('antibody_pipeline_manager', manager_script)",
    "manager = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(manager)",
    `screen_script = ${JSON.stringify(resolve(protenixPipelineScriptsDir, "screen_protenix_results.py"))}`,
    "screen_spec = importlib.util.spec_from_file_location('screen_protenix_results', screen_script)",
    "screen = importlib.util.module_from_spec(screen_spec)",
    "screen_spec.loader.exec_module(screen)",
    `pdb_to_json_script = ${JSON.stringify(resolve(protenixPipelineScriptsDir, "pdb_to_protenix_json.py"))}`,
    "pdb_spec = importlib.util.spec_from_file_location('pdb_to_protenix_json', pdb_to_json_script)",
    "pdb_to_json = importlib.util.module_from_spec(pdb_spec)",
    "pdb_spec.loader.exec_module(pdb_to_json)",
    "assert manager.normalize_hotspots('B45,B46,B49') == '[B45,B46,B49]'",
    "assert manager.normalize_hotspots('[B45,B46,B49]') == '[B45,B46,B49]'",
    "base = {'num_designs': 1, 'npus': '0', 'design_loops': '[H1:8]', 'diffuser_t': 15}",
    "valid = dict(base, hotspots=manager.normalize_hotspots('B45,B46,B49'))",
    "assert manager.validate_format(valid) == []",
    "bad_name = dict(valid, run_name=\"bad'name\")",
    "assert any('run_name' in item for item in manager.validate_format(bad_name))",
    "invalid_t = dict(valid, diffuser_t=1)",
    "assert any('diffuser_t' in item for item in manager.validate_format(invalid_t))",
    "assert screen.parse_hotspots('[B45,B46,B49]') == [('B', 45), ('B', 46), ('B', 49)]",
    "chain_map = {'B': {'protenix_chain': 'C', 'residue_map': [{'original_residue': 45, 'protenix_residue': 1}, {'original_residue': 49, 'protenix_residue': 3}]}}",
    "assert screen.mapped_hotspots(chain_map, [('B', 45), ('B', 49)]) == ('C', [('C', 1), ('C', 3)], [], '')",
    "with tempfile.TemporaryDirectory() as tmp:",
    "    pdb = Path(tmp) / 'x.pdb'",
    "    pdb.write_text('ATOM      1  CA  ALA B  45      0.000   0.000   0.000  1.00 10.00           C\\nATOM      2  CA  GLY B  49      1.000   0.000   0.000  1.00 10.00           C\\n', encoding='utf-8')",
    "    _data, generated_map = pdb_to_json.protenix_json_for_pdb(pdb)",
    "    assert generated_map['B']['protenix_chain'] == 'A'",
    "    assert generated_map['B']['residue_map'][1]['original_residue'] == 49",
    "    assert generated_map['B']['residue_map'][1]['protenix_residue'] == 2",
    "    target = Path(tmp) / 'target.pdb'",
    "    target.write_text('ATOM      1  CA  ALA A  45      0.000   0.000   0.000  1.00 10.00           C\\nATOM      2  CA  GLY A  46      1.000   0.000   0.000  1.00 10.00           C\\n', encoding='utf-8')",
    "    rf_map = {'H': {'protenix_chain': 'A', 'sequence_length': 125, 'residue_map': []}, 'T': {'protenix_chain': 'B', 'sequence_length': 2, 'residue_map': [{'original_residue': 126, 'protenix_residue': 1}, {'original_residue': 127, 'protenix_residue': 2}]}}",
    "    assert screen.mapped_hotspots(rf_map, [('A', 45), ('A', 46)], target) == ('B', [('B', 1), ('B', 2)], [], '')",
    "    short_map = {'H': {'protenix_chain': 'A', 'sequence_length': 125, 'residue_map': []}, 'T': {'protenix_chain': 'B', 'sequence_length': 1, 'residue_map': [{'original_residue': 126, 'protenix_residue': 1}]}}",
    "    assert screen.mapped_hotspots(short_map, [('A', 45)], target)[3] == 'target_length_mismatch:A:expected_2:got_1'",
    "    ambiguous_map = {'X': {'protenix_chain': 'A', 'sequence_length': 2, 'residue_map': [{'original_residue': 1, 'protenix_residue': 1}, {'original_residue': 2, 'protenix_residue': 2}]}, 'Y': {'protenix_chain': 'B', 'sequence_length': 2, 'residue_map': [{'original_residue': 1, 'protenix_residue': 1}, {'original_residue': 2, 'protenix_residue': 2}]}}",
    "    assert screen.mapped_hotspots(ambiguous_map, [('A', 45)], target)[3] == 'ambiguous_target_chain'",
    "    cif = Path(tmp) / 'model.cif'",
    "    cif.write_text('loop_\\n_atom_site.group_PDB\\n_atom_site.type_symbol\\n_atom_site.label_atom_id\\n_atom_site.label_alt_id\\n_atom_site.label_comp_id\\n_atom_site.label_asym_id\\n_atom_site.label_entity_id\\n_atom_site.label_seq_id\\n_atom_site.pdbx_PDB_ins_code\\n_atom_site.auth_seq_id\\n_atom_site.auth_comp_id\\n_atom_site.auth_asym_id\\n_atom_site.auth_atom_id\\n_atom_site.B_iso_or_equiv\\n_atom_site.Cartn_x\\n_atom_site.Cartn_y\\n_atom_site.Cartn_z\\n_atom_site.pdbx_PDB_model_num\\n_atom_site.id\\n_atom_site.occupancy\\nATOM C CA . VAL A 1 1 . 1 VAL A CA 37.71 -9.7 14.1 -5.4 1 2 1.0\\nATOM C CA . GLY B 2 1 . 1 GLY B CA 46.60 1.0 2.0 3.0 1 3 1.0\\n', encoding='utf-8')",
    "    atoms, bvals, residues = screen.parse_cif_atoms(cif)",
    "    assert screen.chain_lengths(atoms) == {'A': 1, 'B': 1}",
    "    assert bvals['A'] == [37.71]",
    "    assert ('B', 1) in residues",
    "    protenix_root = Path(tmp) / '04_protenix_output'",
    "    predictions = protenix_root / 'design1' / 'seed_42' / 'predictions'",
    "    predictions.mkdir(parents=True)",
    "    (predictions / 'design1_seed_42_summary_confidence_sample_0.json').write_text('{\"iptm\": 0.9, \"ptm\": 0.8, \"ranking_score\": 0.7}', encoding='utf-8')",
    "    (predictions / 'design1_seed_42_sample_0.cif').write_text(cif.read_text(encoding='utf-8'), encoding='utf-8')",
    "    chain_map_dir = Path(tmp) / '03_protenix_input_json'",
    "    chain_map_dir.mkdir()",
    "    (chain_map_dir / 'design1.chain_map.json').write_text('{\"T\": {\"protenix_chain\": \"B\", \"sequence_length\": 2, \"residue_map\": [{\"original_residue\": 126, \"protenix_residue\": 1}, {\"original_residue\": 127, \"protenix_residue\": 2}]}}', encoding='utf-8')",
    "    old_argv = sys.argv",
    "    sys.argv = ['screen', '--protenix-root', str(protenix_root), '--out-dir', str(Path(tmp) / 'screen_fail'), '--target-pdb', str(target), '--hotspots', '[Z45]']",
    "    try:",
    "        assert screen.main() == 3",
    "    finally:",
    "        sys.argv = old_argv",
  ].join("\n");
  execFileSync(python, ["-c", code]);
});

test("runner NPU Broker loads allowlisted workloads from config", async (context) => {
  const fixture = await workspaceFixture(context);
  const python = pythonForTest();
  if (!python) {
    context.skip("Python interpreter unavailable");
    return;
  }
  const managerScript = resolve(fixture.dataDir, "custom_manager.py");
  await writeFile(managerScript, [
    "import json",
    "import sys",
    "from pathlib import Path",
    "",
    "def read_json(path):",
    "    return json.loads(path.open(encoding='utf-8').read())",
    "",
    "def resolve_config(cfg):",
    "    cfg = dict(cfg)",
    "    workspace = Path(cfg['workspace']).resolve()",
    "    cfg['workspace'] = str(workspace)",
    "    cfg['run_dir'] = str(workspace / 'runs' / cfg.get('run_name', 'custom-test-run'))",
    "    cfg['python'] = sys.executable",
    "    return cfg",
    "",
    "def validate_format(cfg):",
    "    return []",
    "",
    "def validate_paths(cfg):",
    "    return [], []",
    "",
    "def command_for_full_run(cfg):",
    "    code = \"from pathlib import Path; import sys; Path(sys.argv[1]).write_text('custom:' + sys.argv[2], encoding='utf-8'); print('custom workload ok')\"",
    "    return [cfg['python'], '-c', code, str(Path(cfg['workspace']) / 'custom-result.txt'), cfg.get('run_name', '')]",
  ].join("\n"));
  const workloadConfig = resolve(fixture.dataDir, "npu-workloads.json");
  await writeFile(workloadConfig, JSON.stringify({
    workloads: [{
      command: {
        args: [
          "${repo:services/runner/workloads/antibody-manager-adapter.py}",
          managerScript,
          "${input:configPath}",
          "${workspaceRoot}",
        ],
        program: "${python}",
      },
      description: "Run a test configured workload.",
      id: "project.custom.v1",
      label: "Configured custom workload",
      phase: "project",
    }],
  }));
  await mkdir(resolve(fixture.workspaceRoot, "antibody_pipeline"), { recursive: true });
  await writeFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "config.json"), JSON.stringify({
    run_name: "configured-workload-test",
    workspace: "/workspace/antibody_pipeline",
  }));
  const server = createRunnerServer({
    ...config(fixture.dataDir),
    npuPythonPath: python,
    npuWorkloadConfigPath: workloadConfig,
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const workloads = await (await fetch(`${origin}/npu/workloads`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as NpuWorkloadDescriptor[];
  assert.deepEqual(workloads.map((workload) => workload.id), ["project.custom.v1"]);
  assert.deepEqual(workloads[0]?.requiredInputs, ["configPath"]);

  const submitted = await (await fetch(`${origin}/npu/jobs`, signedExecutionInit("runner-test-token", {
    inputs: { configPath: "antibody_pipeline/config.json" },
    jobId: "configured-custom-job",
    sessionId: "session-test",
    workloadId: "project.custom.v1",
    workspaceRoot: fixture.workspaceRoot,
  }))).json() as NpuJob;
  assert.equal(submitted.state, "queued");

  let job = submitted;
  for (let attempt = 0; attempt < 300 && job.state !== "succeeded"; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    job = await (await fetch(`${origin}/npu/jobs/${job.id}?session_id=session-test`, {
      headers: { authorization: "Bearer runner-test-token" },
    })).json() as NpuJob;
  }
  assert.equal(job.state, "succeeded", job.logs.stderr || job.logs.stdout);
  assert.match(job.logs.stdout, /custom workload ok/);
  assert.equal(await readFile(resolve(fixture.workspaceRoot, "antibody_pipeline", "custom-result.txt"), "utf8"), "custom:configured-workload-test");
});

test("runner NPU Broker rejects repo command templates that resolve outside the repository", async (context) => {
  const fixture = await workspaceFixture(context);
  const workloadConfig = resolve(fixture.dataDir, "npu-workloads.json");
  await writeFile(workloadConfig, JSON.stringify({
    workloads: [{
      command: { program: "${repo:..}", args: [] },
      description: "Unsafe repo path test workload.",
      id: "project.repo-escape.v1",
      label: "Repo escape",
      phase: "project",
    }],
  }));
  const server = createRunnerServer({
    ...config(fixture.dataDir),
    npuWorkloadConfigPath: workloadConfig,
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const submitted = await (await fetch(`${origin}/npu/jobs`, signedExecutionInit("runner-test-token", {
    jobId: "repo-escape-job",
    sessionId: "session-test",
    workloadId: "project.repo-escape.v1",
    workspaceRoot: fixture.workspaceRoot,
  }))).json() as NpuJob;
  assert.equal(submitted.state, "queued");

  let job = submitted;
  for (let attempt = 0; attempt < 300 && job.state !== "failed"; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    job = await (await fetch(`${origin}/npu/jobs/${job.id}?session_id=session-test`, {
      headers: { authorization: "Bearer runner-test-token" },
    })).json() as NpuJob;
  }
  assert.equal(job.state, "failed");
  assert.match(job.error ?? "", /repo: path must resolve inside the repository/);
});

test("runner NPU Broker marks active persisted jobs interrupted on restart", async (context) => {
  const fixture = await workspaceFixture(context);
  const now = new Date().toISOString();
  await mkdir(resolve(fixture.dataDir, "npu-jobs"), { recursive: true });
  await writeFile(resolve(fixture.dataDir, "npu-jobs", "jobs.json"), JSON.stringify({
    jobs: [{
      createdAt: now,
      id: "was-running",
      inputs: {},
      logs: { stderr: "", stdout: "", truncated: false },
      sessionId: "session-test",
      state: "running",
      updatedAt: now,
      workloadId: "npu.smoke_test",
      workspaceRoot: fixture.workspaceRoot,
    }],
  }));
  const server = createRunnerServer(config(fixture.dataDir));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const job = await (await fetch(`${origin}/npu/jobs/was-running?session_id=session-test`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as NpuJob;
  assert.equal(job.state, "interrupted");
  assert.match(job.error ?? "", /Runner restarted/);
});

test("runner execute endpoint runs signed Python", async (context) => {
  const fixture = await workspaceFixture(context);
  const server = createRunnerServer(config(fixture.dataDir));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${origin}/execute`, signedExecutionInit("runner-test-token", {
    agentId: "main",
    code: "print('ok')",
    executionId: "http-execution",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  }));
  assert.equal(response.status, 200);
  const body = await response.json() as PythonExecutionResult;
  assert.equal(body.exitCode, 0);
  assert.match(body.stdout, /ok/);
  assert.equal(body.cgroupMode, RESOURCE_LIMIT_MODE);
});

test("runner returns 400 for a signed shell request without agentId and leaves no runtime state", async (context) => {
  const fixture = await workspaceFixture(context);
  const runnerConfig = config(fixture.dataDir);
  const profiles = new SessionEnvProfileStore();
  const shellSessions = new ShellSessionManager({
    bwrapPath: runnerConfig.bwrapPath,
    dataDir: runnerConfig.dataDir,
    execTimeoutMs: runnerConfig.execTimeoutMs,
    idleTimeoutMs: 0,
    maxOutputBytes: runnerConfig.maxOutputBytes,
    maxWorkspaceBytes: runnerConfig.maxWorkspaceBytes,
  }, profiles);
  const server = createRunnerServer(runnerConfig, undefined, undefined, shellSessions, profiles);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${origin}/execute-shell`, signedExecutionInit("runner-test-token", {
    code: "export SHOULD_NOT_EXIST=invalid",
    executionId: "missing-agent-id",
    kernelMode: "persistent",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  }));
  assert.equal(response.status, 400);
  assert.equal(typeof (await response.json() as { error?: unknown }).error, "string");

  const status = await (await fetch(`${origin}/status`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as RunnerRuntimeStatus;
  assert.deepEqual(status.activeExecutions, []);
  assert.deepEqual(status.kernels, []);
  assert.deepEqual(shellSessions.list(), []);
  assert.equal(profiles.get("session-test", undefined as unknown as string, "epoch-test"), undefined);
});

test("runner status reports an active execution and removes it after completion", async (context) => {
  const fixture = await workspaceFixture(context);
  const server = createRunnerServer(config(fixture.dataDir));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const execution = fetch(`${origin}/execute`, signedExecutionInit("runner-test-token", {
    agentId: "main",
    code: "import time\ntime.sleep(0.2)\nprint('done')",
    executionId: "status-execution",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  }));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  const active = await (await fetch(`${origin}/status`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as RunnerRuntimeStatus;
  assert.equal(active.activeExecutions[0]?.agentId, "main");
  assert.equal(active.activeExecutions[0]?.executionId, "status-execution");
  assert.equal(active.activeExecutions[0]?.sessionId, "session-test");
  assert.equal(active.activeExecutions[0]?.status, "running");

  assert.equal((await execution).status, 200);
  const completed = await (await fetch(`${origin}/status`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as RunnerRuntimeStatus;
  assert.deepEqual(completed.activeExecutions, []);
});

test("runner aborts a disconnected sandbox and removes cancelled queued work from status", async (context) => {
  const fixture = await workspaceFixture(context);
  const server = createRunnerServer({ ...config(fixture.dataDir), execTimeoutMs: 0 });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const status = async () => await (await fetch(`${origin}/status`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as RunnerRuntimeStatus;
  const waitFor = async (predicate: (value: RunnerRuntimeStatus) => boolean) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await status();
      if (predicate(current)) return current;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    throw new Error("Runner status did not reach the expected state");
  };

  const runningController = new AbortController();
  const running = fetch(`${origin}/execute`, {
    ...signedExecutionInit("runner-test-token", {
      agentId: "main",
      code: "import time\ntime.sleep(30)",
      executionId: "cancel-running",
      executionTimeoutMs: 0,
      permissionEpoch: epoch(),
      workspaceRoot: fixture.workspaceRoot,
    }),
    signal: runningController.signal,
  }).then(() => "completed", (error: Error) => error.name);
  await waitFor((current) => current.activeExecutions.some(
    (execution) => execution.executionId === "cancel-running" && execution.status === "running",
  ));

  const queuedController = new AbortController();
  const queued = fetch(`${origin}/execute`, {
    ...signedExecutionInit("runner-test-token", {
      agentId: "main",
      code: "print('must not run')",
      executionId: "cancel-queued",
      executionTimeoutMs: 0,
      permissionEpoch: epoch(),
      workspaceRoot: fixture.workspaceRoot,
    }),
    signal: queuedController.signal,
  }).then(() => "completed", (error: Error) => error.name);
  await waitFor((current) => current.activeExecutions.some(
    (execution) => execution.executionId === "cancel-queued" && execution.status === "queued",
  ));

  queuedController.abort();
  assert.equal(await queued, "AbortError");
  const afterQueuedCancellation = await waitFor((current) => current.activeExecutions.length === 1);
  assert.equal(afterQueuedCancellation.activeExecutions[0]?.executionId, "cancel-running");

  runningController.abort();
  assert.equal(await running, "AbortError");
  await waitFor((current) => current.activeExecutions.length === 0);
});

test("runner executes different Session-Agent queues concurrently", async (context) => {
  const fixture = await workspaceFixture(context);
  let active = 0;
  let maximumActive = 0;
  let entered = 0;
  let releaseBoth!: () => void;
  const bothEntered = new Promise<void>((resolveBoth) => { releaseBoth = resolveBoth; });
  const shellSessions = {
    close: async () => undefined,
    execute: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      entered += 1;
      if (entered === 2) releaseBoth();
      try {
        await Promise.race([
          bothEntered,
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("different Session-Agent execution was serialized")), 500);
          }),
        ]);
        const now = new Date().toISOString();
        return {
          cgroupMode: "none",
          createdFiles: [],
          environmentRevisionId: "system-shell-bwrap-v1",
          environmentVariables: {},
          executionId: request.executionId,
          exitCode: 0,
          finishedAt: now,
          kernelId: `shell-${request.agentId}`,
          kernelMode: "persistent",
          language: "shell",
          modifiedFiles: [],
          networkPolicy: "none",
          runnerVersion: "test",
          sandbox: "bubblewrap",
          startedAt: now,
          stderr: "",
          stdout: request.agentId,
          workingDirectory: "/workspace",
        };
      } finally {
        active -= 1;
      }
    },
    list: () => [],
    teardownKernel: async () => 0,
    teardownSession: async () => 0,
    touchAgent: () => undefined,
  } as unknown as ShellSessionManager;
  const server = createRunnerServer(config(fixture.dataDir), undefined, undefined, shellSessions);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const responses = await Promise.all(["subagent:one", "subagent:two"].map((agentId, index) => (
    fetch(`${origin}/execute-shell`, signedExecutionInit("runner-test-token", {
      agentId,
      code: "echo overlap",
      executionId: `overlap-${index}`,
      kernelMode: "persistent",
      permissionEpoch: epoch(),
      workspaceRoot: fixture.workspaceRoot,
    }))
  )));

  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(maximumActive, 2);
  const status = await (await fetch(`${origin}/status`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as RunnerRuntimeStatus;
  assert.deepEqual(status.activeExecutions, []);
});

test("runner shell endpoint keeps a persistent session per Session-Agent and downgrades once-scoped grants", async (context) => {
  const fixture = await workspaceFixture(context);
  const server = createRunnerServer(config(fixture.dataDir));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const first = await (await fetch(`${origin}/execute-shell`, signedExecutionInit("runner-test-token", {
    agentId: "main",
    code: "export FOO=http\necho first",
    executionId: "shell-http-one",
    kernelMode: "persistent",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  }))).json() as ShellExecutionResult;
  assert.equal(first.exitCode, 0);
  assert.equal(first.kernelMode, "persistent");
  assert.equal(first.workingDirectory, "/workspace");
  assert.equal(first.environmentVariables.FOO, "http");

  const second = await (await fetch(`${origin}/execute-shell`, signedExecutionInit("runner-test-token", {
    agentId: "main",
    code: "echo \"FOO=$FOO\"",
    executionId: "shell-http-two",
    kernelMode: "persistent",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  }))).json() as ShellExecutionResult;
  assert.equal(second.kernelId, first.kernelId);
  assert.equal(second.stdout.trim(), "FOO=http");

  const kernels = await (await fetch(`${origin}/kernels`, {
    headers: { authorization: "Bearer runner-test-token" },
  })).json() as Array<{ agentId: string; id: string; language: string }>;
  assert.equal(kernels.some((kernel) => (
    kernel.agentId === "main" && kernel.id === first.kernelId && kernel.language === "shell"
  )), true);

  // The sedimented profile reaches a later ephemeral python execution.
  const python = await (await fetch(`${origin}/execute`, signedExecutionInit("runner-test-token", {
    agentId: "main",
    code: "import os\nprint(os.environ.get('FOO'))",
    executionId: "shell-profile-python",
    permissionEpoch: epoch(),
    workspaceRoot: fixture.workspaceRoot,
  }))).json() as PythonExecutionResult;
  assert.equal(python.exitCode, 0);
  assert.equal(python.stdout.trim(), "http");

  const once = await (await fetch(`${origin}/execute-shell`, signedExecutionInit("runner-test-token", {
    agentId: "main",
    code: "echo once",
    executionId: "shell-http-once",
    kernelMode: "persistent",
    permissionEpoch: { ...epoch(), executeGrantScope: "once" },
    workspaceRoot: fixture.workspaceRoot,
  }))).json() as ShellExecutionResult;
  assert.equal(once.kernelMode, "ephemeral");

  const teardown = await (await fetch(`${origin}/kernels/teardown`, {
    body: JSON.stringify({ reason: "test cleanup", sessionId: "session-test" }),
    headers: { authorization: "Bearer runner-test-token", "content-type": "application/json" },
    method: "POST",
  })).json() as { count: number };
  assert.equal(teardown.count, 1);
});
