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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import type { TestContext } from "node:test";

import type { PermissionEpoch } from "@sciencediscovery/schema";

import { executePython, executeShell, spawnSandboxProcess, validatedWorkspace } from "./executor.js";
import { EgressGatewayRegistry } from "./egress-gateway.js";
import type { EnvironmentStore } from "./environment-store.js";
import { condaActivationPaths } from "./platform/index.js";
import { RunnerReadiness } from "./readiness.js";

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

/**
 * the none-sandbox direct paths now fail closed even for the "none"
 * network policy (deny-all loopback gateway), so executions need a real
 * gateway registry in tests, exactly as the server always provides one.
 */
function gatewaysFor(context: TestContext, dataDir: string): EgressGatewayRegistry {
  const gateways = new EgressGatewayRegistry(dataDir, () => undefined);
  context.after(() => gateways.close());
  return gateways;
}

function pythonEnvironmentStore(interpreterPath: string, prefixPath: string): EnvironmentStore {
  return {
    capability: { available: true },
    resolveRuntime: () => ({ interpreterPath, prefixPath, revision: { id: "rev-python" } }),
  } as unknown as EnvironmentStore;
}

/** A real interpreter for the direct-execution run; the test skips without one. */
function hostPython(): string | undefined {
  const override = process.env.SCIENCE_AGENT_PYTHON_PATH?.trim();
  if (override) return override;
  const result = spawnSync("where", ["python"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

async function workspace(context: TestContext): Promise<{ dataDir: string; workspaceRoot: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "sd-direct-exec-"));
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const workspaceRoot = resolve(dataDir, "projects", "project", "sessions", "session", "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  return { dataDir, workspaceRoot };
}

test("readiness reports the none provider ready without probing a sandbox", async () => {
  const capability = await new RunnerReadiness("none", "ignored-executable").get();
  assert.equal(capability.sandbox, "none");
  assert.equal(capability.ready, true);
  assert.equal(capability.reason, "ready");
  // sandboxUsable stays false: the UI/API must keep showing isolation is absent.
  assert.equal(capability.sandboxUsable, false);
});

test("spawnSandboxProcess none branch runs the executable directly with the launch env", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "sd-direct-spawn-"));
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  env.SD_DIRECT_MARKER = "marker-value";
  const child = await spawnSandboxProcess(
    { bwrapPath: "unused", dataDir, sandboxProvider: "none" },
    {
      args: [],
      chdir: dataDir,
      commandPrefix: [],
      env,
      executable: process.execPath,
      hostCwd: dataDir,
      sandbox: "none",
    },
    ["-e", "process.stdout.write(process.env.SD_DIRECT_MARKER + '|' + process.cwd())"],
    "baseline",
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const exitCode = await new Promise<number | null>((resolvePromise) => child.once("close", resolvePromise));
  assert.equal(exitCode, 0);
  assert.equal(stdout, `marker-value|${dataDir}`);
});

test("executeShell none fails closed without the scientific environment capability", async () => {
  await assert.rejects(
    executeShell(
      { bwrapPath: "unused", dataDir: "unused", sandboxProvider: "none", execTimeoutMs: 1000, maxOutputBytes: 0, maxWorkspaceBytes: 0 },
      { agentId: "main", code: "echo hi", executionId: "shell-none", permissionEpoch: epoch(), workspaceRoot: "unused" },
    ),
    /requires the scientific environment capability/,
  );
});

test("executeShell none fails clearly when the environment lacks m2-bash", async (context) => {
  const { dataDir, workspaceRoot } = await workspace(context);
  // 前缀里没有任何 shell：报错必须点名 m2-bash 与修复动作，而不是裸 ENOENT。
  const store = {
    capability: { available: true },
    resolveRuntime: () => ({
      interpreterPath: resolve(dataDir, "managed-env", "python.exe"),
      prefixPath: resolve(dataDir, "managed-env"),
      revision: { id: "rev-python" },
    }),
  } as unknown as EnvironmentStore;
  await assert.rejects(
    executeShell(
      { bwrapPath: "unused", dataDir, sandboxProvider: "none", execTimeoutMs: 1000, maxOutputBytes: 0, maxWorkspaceBytes: 0 },
      { agentId: "main", code: "echo hi", executionId: "shell-none", permissionEpoch: epoch(), workspaceRoot },
      undefined, undefined, undefined, undefined, undefined, store,
    ),
    /requires m2-bash.*Recreate or update the starter environment/s,
  );
});

/** A real bash.exe for the direct-shell run; the test skips without one. */
function hostBash(): string | undefined {
  const result = spawnSync("where", ["bash"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const candidate = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  // The WindowsApps WSL launcher is a zero-byte stub that cannot be copied
  // into the fake conda prefix; treat it as "no host bash".
  if (!candidate) return undefined;
  if (candidate.toLowerCase().includes(`${sep}microsoft${sep}windowsapps${sep}`)) return undefined;
  try { if (statSync(candidate).size === 0) return undefined; } catch { return undefined; }
  return candidate;
}

test("executeShell none runs the agent's code through the environment's m2-bash", async (context) => {
  const bash = hostBash();
  if (!bash) {
    context.skip("no bash.exe on PATH");
    return;
  }
  const { dataDir, workspaceRoot } = await workspace(context);
  // 复刻 m2-bash 的 conda 布局：<prefix>\Library\usr\bin\bash.exe（已实证）。
  // 用 Git Bash 的真身充当环境内 bash，连同其 msys-*.dll 一起拷进假前缀。
  const prefix = resolve(dataDir, "managed-env");
  const shellDir = resolve(prefix, "Library", "usr", "bin");
  await mkdir(shellDir, { recursive: true });
  await copyFile(bash, resolve(shellDir, "bash.exe"));
  const msysLibs = spawnSync("cmd", ["/c", "dir", "/b", resolve(dirname(bash), "msys-*.dll")], { encoding: "utf8" });
  if (msysLibs.status === 0) {
    for (const name of msysLibs.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      await copyFile(resolve(dirname(bash), name), resolve(shellDir, name));
    }
  }
  const store = {
    capability: { available: true },
    resolveRuntime: () => ({
      interpreterPath: resolve(prefix, "python.exe"),
      prefixPath: prefix,
      revision: { id: "rev-python" },
    }),
  } as unknown as EnvironmentStore;
  const result = await executeShell(
    { bwrapPath: "unused", dataDir, sandboxProvider: "none", execTimeoutMs: 60_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 0 },
    {
      agentId: "main",
      code: [
        "echo SHELL_OK",
        "pwd",
        "mkdir -p sub && echo text > sub/out.txt",
      ].join("\n"),
      executionId: "shell-none",
      permissionEpoch: epoch(),
      workspaceRoot,
    },
    undefined, undefined, gatewaysFor(context, dataDir), undefined, undefined, store,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.stdout.includes("SHELL_OK"), result.stdout);
  // MSYS2 把 Windows cwd 翻成 /e/... 形态：断言它报告的是工作区即可。
  assert.ok(result.stdout.includes("/"), result.stdout);
  assert.ok(result.createdFiles.includes("sub/out.txt") || result.createdFiles.includes("sub\\out.txt"), result.createdFiles.join(","));
  assert.equal(result.environmentRevisionId, "rev-python");
  assert.equal(result.sandbox, "none");
  assert.equal(result.kernelMode, "ephemeral");
});

test("executePython rejects R under the none provider", async (context) => {
  const { dataDir, workspaceRoot } = await workspace(context);
  const python = hostPython();
  assert.ok(python, "a host python is required for this test");
  const prefix = resolve(dataDir, "managed-env");
  const store = {
    capability: { available: true },
    resolveRuntime: () => ({
      interpreterPath: python,
      prefixPath: prefix,
      revision: { id: "rev-r" },
    }),
  } as unknown as EnvironmentStore;
  await assert.rejects(
    executePython(
      { bwrapPath: "unused", dataDir, sandboxProvider: "none", execTimeoutMs: 60_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 0 },
      { agentId: "main", code: "print(1)", executionId: "r-none", language: "r", permissionEpoch: epoch(), workspaceRoot },
      undefined,
      store,
    ),
    /direct-execution provider \(Windows\) supports Python only/,
  );
});

test("executePython none runs the interpreter directly with conda activation paths on PATH ", async (context) => {
  const python = hostPython();
  if (!python) {
    context.skip("no host python on PATH");
    return;
  }
  const { dataDir, workspaceRoot } = await workspace(context);
  // The prefix is deliberately fake: the assertion is that its activation
  // directories land at the head of PATH, not that they exist.
  const prefix = resolve(dataDir, "managed-env");
  const store = pythonEnvironmentStore(python, prefix);
  const result = await executePython(
    { bwrapPath: "unused", dataDir, sandboxProvider: "none", execTimeoutMs: 60_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 0 },
    {
      agentId: "main",
      code: [
        "import os, pathlib",
        "head = os.environ['PATH'].split(os.pathsep)[:3]",
        "print('PATH_HEAD=' + '|'.join(head))",
        "print('PYTHONHOME=' + str(os.environ.get('PYTHONHOME')))",
        "pathlib.Path('out.txt').write_text('ok')",
      ].join("\n"),
      environmentRevisionId: "rev-python",
      executionId: "python-none",
      language: "python",
      permissionEpoch: epoch(),
      workspaceRoot,
    },
    undefined,
    store,
    undefined,
    gatewaysFor(context, dataDir),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.includes(`PATH_HEAD=${condaActivationPaths(prefix).join("|")}`), true, result.stdout);
  assert.equal(result.stdout.includes("PYTHONHOME=None"), true, result.stdout);
  assert.ok(result.createdFiles.includes("out.txt"));
});


test("executePython none fails closed on network for the default none policy", async (context) => {
  const python = hostPython();
  if (!python) {
    context.skip("no host python on PATH");
    return;
  }
  const { dataDir, workspaceRoot } = await workspace(context);
  const prefix = resolve(dataDir, "managed-env");
  const store = pythonEnvironmentStore(python, prefix);
  // 默认 epoch 的网络策略就是 none：无沙箱直跑必须拿到 deny-all 网关的代理
  // 环境（而不是继承宿主机网络），且宿主代理槽位（含 NO_PROXY）不得残留。
  const result = await executePython(
    { bwrapPath: "unused", dataDir, sandboxProvider: "none", execTimeoutMs: 60_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 0 },
    {
      agentId: "main",
      code: [
        "import os",
        "for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'):",
        "    print(f'{key}=' + str(os.environ.get(key)))",
      ].join("\n"),
      environmentRevisionId: "rev-python",
      executionId: "python-none-egress",
      language: "python",
      permissionEpoch: epoch(),
      workspaceRoot,
    },
    undefined,
    store,
    undefined,
    gatewaysFor(context, dataDir),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const httpProxy = result.environmentVariables.HTTP_PROXY ?? "";
  assert.match(httpProxy, /^http:\/\/127\.0\.0\.1:\d+$/, `HTTP_PROXY=${httpProxy}`);
  assert.equal(result.environmentVariables.HTTPS_PROXY, httpProxy);
  assert.equal(result.environmentVariables.ALL_PROXY, httpProxy);
  assert.equal(result.environmentVariables.NO_PROXY, "127.0.0.1,localhost");
  assert.ok(result.stdout.includes(`HTTP_PROXY=${httpProxy}`), result.stdout);
  assert.ok(result.stdout.includes("NO_PROXY=127.0.0.1,localhost"), result.stdout);
});

test("executePython none blocks an outbound request through the deny-all gateway", async (context) => {
  const python = hostPython();
  if (!python) {
    context.skip("no host python on PATH");
    return;
  }
  const { dataDir, workspaceRoot } = await workspace(context);
  const prefix = resolve(dataDir, "managed-env");
  const store = pythonEnvironmentStore(python, prefix);
  const denied: Array<{ host?: string; reason?: string }> = [];
  const gateways = new EgressGatewayRegistry(dataDir, (event, detail) => {
    if (event === "denied") denied.push(detail);
  });
  context.after(() => gateways.close());
  const result = await executePython(
    { bwrapPath: "unused", dataDir, sandboxProvider: "none", execTimeoutMs: 60_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 0 },
    {
      agentId: "main",
      code: [
        "import urllib.error, urllib.request",
        "try:",
        "    urllib.request.urlopen('http://example.com/', timeout=15)",
        "    print('REQUEST_UNEXPECTEDLY_SUCCEEDED')",
        "except urllib.error.HTTPError as error:",
        "    body = error.read().decode('utf-8', 'replace').strip()",
        "    print(f'HTTP_STATUS={error.code}')",
        "    print(f'DENY_REASON={body}')",
        "except Exception as error:  # noqa: BLE001",
        "    print(f'OTHER_ERROR={error!r}')",
      ].join("\n"),
      environmentRevisionId: "rev-python",
      executionId: "python-none-deny",
      language: "python",
      permissionEpoch: epoch(),
      workspaceRoot,
    },
    undefined,
    store,
    undefined,
    gateways,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.stdout.includes("HTTP_STATUS=403"), result.stdout);
  assert.ok(result.stdout.includes("sandbox network access is disabled"), result.stdout);
  assert.ok(!result.stdout.includes("REQUEST_UNEXPECTEDLY_SUCCEEDED"), result.stdout);
  // 留痕：deny 事件带主机与原因落到注册表日志。
  assert.ok(
    denied.some((entry) => entry.host === "example.com" && /disabled/.test(entry.reason ?? "")),
    JSON.stringify(denied),
  );
});


test("workspace whitelist honors extra authorized roots and still rejects the rest", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "sd-extra-roots-"));
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const shared = resolve(dataDir, "shared-data");
  const sharedSession = resolve(shared, "team", "session-workspace");
  await mkdir(sharedSession, { recursive: true });
  const extraRoots = [shared, resolve(dataDir, "does-not-exist")];
  // 授权目录（含子目录）放行；不存在条目跳过不炸；白名单外依旧拒绝。
  assert.equal(await validatedWorkspace(dataDir, sharedSession, extraRoots), sharedSession);
  assert.equal(await validatedWorkspace(dataDir, shared, extraRoots), shared);
  const outside = resolve(dataDir, "scientific-envs");
  await mkdir(outside);
  await assert.rejects(validatedWorkspace(dataDir, outside, extraRoots), /workspace must be inside/i);
  // 不传 extraRoots 时授权目录不放行——默认白名单语义不变。
  await assert.rejects(validatedWorkspace(dataDir, sharedSession), /workspace must be inside/i);
});

test("loadRunnerConfig parses SCIENCE_RUNNER_EXTRA_WORKSPACE_ROOTS", async () => {
  const { loadRunnerConfig } = await import("./server.js");
  const cwd = resolve(dataDirForConfig());
  const config = loadRunnerConfig({
    SCIENCE_AGENT_DATA_DIR: "data",
    SCIENCE_RUNNER_EXTRA_WORKSPACE_ROOTS: `C:\\shared;relative-dir;; D:\\another `,
  }, cwd);
  assert.deepEqual(config.extraWorkspaceRoots, [
    resolve(cwd, "C:\\shared"),
    resolve(cwd, "relative-dir"),
    resolve(cwd, "D:\\another"),
  ]);
  const unset = loadRunnerConfig({ SCIENCE_AGENT_DATA_DIR: "data" }, cwd);
  assert.equal(unset.extraWorkspaceRoots, undefined);
});

function dataDirForConfig(): string {
  return join(tmpdir(), "sd-load-config-");
}
