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

import { spawn } from "node:child_process";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  detectSandboxCapability,
  procMountArguments,
  type SandboxProcMode,
} from "@science-agent/sandbox-capability";
import {
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  type PythonExecutionRequest,
  type PythonExecutionResult,
  type ScientificLanguage,
  type ShellExecutionRequest,
  type ShellExecutionResult,
} from "@science-agent/schema";

import { ensureBaselineSeccompFilter } from "./seccomp.js";
import { profileKeyAllowed, sedimentableCwd, type SessionEnvProfile } from "./session-env-profile.js";
import type { EnvironmentStore } from "./environment-store.js";

export const RUNNER_VERSION = "m4-isolation-only-v1";

/**
 * The two parts of the sandbox shape this host may refuse, resolved together so
 * every launch site agrees.
 *
 * `--proc /proc` gives the sandbox its own procfs, but Docker's default
 * readonlyPaths/maskedPaths refuse the mount; the fallback binds the existing
 * `/proc` instead. `--disable-userns` forbids nested user namespaces, but it is
 * implemented by writing `user.max_user_namespaces`, which old bubblewrap does
 * not know and a read-only `/proc/sys` refuses. Both are probed for real rather
 * than guessed from a version, and the launcher preflight calls the same
 * detection, so its verdict and this one cannot disagree.
 */
export async function sandboxLaunchProfile(
  bwrapPath: string,
): Promise<{ disableUserns: boolean; procMode: SandboxProcMode }> {
  const capability = await detectSandboxCapability(bwrapPath);
  return { disableUserns: capability.disableUserns, procMode: capability.procMode };
}

/** Default workspace total quota: 10 GiB. 0 disables the quota. */
export const DEFAULT_MAX_WORKSPACE_BYTES = 10_737_418_240;
/** Default retained stdout+stderr budget. 0 disables truncation. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_073_741_824;
/** @deprecated Per-file execution quota was removed. Kept as 0 for /health. */
export const MAX_RUNNER_FILE_BYTES = 0;
/** @deprecated Prefer DEFAULT_MAX_WORKSPACE_BYTES / config.maxWorkspaceBytes. */
export const MAX_RUNNER_WORKSPACE_BYTES = DEFAULT_MAX_WORKSPACE_BYTES;
/** Product default: executions are unlimited until explicitly configured. */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 0;

/** Provenance label: no resource quotas; isolation is bubblewrap + seccomp. */
export const RESOURCE_LIMIT_MODE = "none" as const;

const OUTPUT_TRUNCATION_MARKER = (limit: number) =>
  `\n...[output truncated: exceeded ${limit} bytes; set SCIENCE_AGENT_MAX_OUTPUT_BYTES=0 to disable]...\n`;

export interface ExecutorConfig {
  bwrapPath: string;
  dataDir: string;
  /** Wall-clock limit for a single execution. */
  execTimeoutMs: number;
  /** Workspace total quota in bytes; 0 disables. */
  maxWorkspaceBytes: number;
  /** Combined stdout+stderr retain budget; 0 disables truncation. */
  maxOutputBytes: number;
}

export function executionTimeoutMs(value: number | undefined, fallback: number): number {
  const timeoutMs = value ?? fallback;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("Execution timeout must be a non-negative integer number of milliseconds");
  }
  return timeoutMs;
}

export function resolveQuotaBytes(value: number | undefined, fallback: number, label: string): number {
  const bytes = value ?? fallback;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`${label} must be a non-negative integer number of bytes`);
  }
  return bytes;
}

export function workspaceQuotaExceededMessage(limit: number): string {
  return `Workspace exceeded the ${limit} byte execution quota `
    + `(current limit from system quota settings / SCIENCE_AGENT_MAX_WORKSPACE_BYTES; set to 0 for unlimited)`;
}

export function workspaceQuotaPrecheckMessage(limit: number): string {
  return `Workspace exceeds the ${limit} byte execution quota `
    + `(current limit from system quota settings / SCIENCE_AGENT_MAX_WORKSPACE_BYTES; set to 0 for unlimited)`;
}

export async function workspaceSnapshot(workspaceRoot: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await stat(fullPath);
      snapshot.set(relative(workspaceRoot, fullPath).split(sep).join("/"), `${metadata.size}:${metadata.mtimeMs}`);
    }
  }

  await visit(workspaceRoot);
  return snapshot;
}

export async function workspaceUsageBytes(workspaceRoot: string): Promise<number> {
  let total = 0;
  for (const fingerprint of (await workspaceSnapshot(workspaceRoot)).values()) {
    total += Number(fingerprint.slice(0, fingerprint.indexOf(":")));
  }
  return total;
}

/** Keep the head and tail of oversized text; never throws. */
export function truncateHeadTail(text: string, maxBytes: number): string {
  if (maxBytes === 0 || Buffer.byteLength(text) <= maxBytes) return text;
  const marker = OUTPUT_TRUNCATION_MARKER(maxBytes);
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes >= maxBytes) return marker.slice(0, maxBytes);
  const budget = maxBytes - markerBytes;
  const headBudget = Math.floor(budget / 2);
  const tailBudget = budget - headBudget;
  const buffer = Buffer.from(text);
  return Buffer.concat([
    buffer.subarray(0, headBudget),
    Buffer.from(marker),
    buffer.subarray(buffer.length - tailBudget),
  ]).toString();
}

/**
 * Truncate to a concrete byte budget.
 * Unlike config `0 = unlimited`, a remaining room of `0` means drop the content.
 */
export function truncateToBudget(text: string, roomBytes: number): string {
  if (roomBytes <= 0) return "";
  return truncateHeadTail(text, roomBytes);
}

/**
 * Append to a stream under a shared stdout+stderr byte budget.
 * When the budget is exceeded, truncate with a head/tail marker instead of failing.
 * Config `maxBytes === 0` means unlimited; a computed remaining room of `0` does not.
 */
export function appendBounded(
  current: string,
  chunk: Buffer,
  maxBytes: number,
  otherStreamBytes: number,
): { text: string; truncated: boolean } {
  const addition = chunk.toString();
  if (maxBytes === 0) {
    return { text: current + addition, truncated: false };
  }
  const room = Math.max(0, maxBytes - otherStreamBytes);
  const combined = current + addition;
  if (Buffer.byteLength(combined) <= room) {
    return { text: combined, truncated: false };
  }
  return { text: truncateToBudget(combined, room), truncated: true };
}

export async function validatedWorkspace(dataDir: string, requested: string): Promise<string> {
  const projectsRoot = await realpath(resolve(dataDir, "projects"));
  const workspaceRoot = await realpath(requested);
  if (workspaceRoot !== projectsRoot && !workspaceRoot.startsWith(`${projectsRoot}${sep}`)) {
    throw new Error("Runner workspace must be inside the configured projects directory");
  }
  return workspaceRoot;
}

function relativeDescendantPath(parent: string, child: string): string | undefined {
  const relativePath = relative(parent, child);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.split(sep).join("/");
}

export function workspaceBindArguments(workspaceRoot: string, readOnlyWorkspaceRoot: string | undefined): {
  args: string[];
  chdir: string;
} {
  const writablePath = readOnlyWorkspaceRoot
    ? relativeDescendantPath(readOnlyWorkspaceRoot, workspaceRoot)
    : undefined;
  if (readOnlyWorkspaceRoot && writablePath) {
    const sandboxWritablePath = `/workspace/${writablePath}`;
    return {
      args: [
        "--ro-bind", readOnlyWorkspaceRoot, "/workspace",
        "--bind", workspaceRoot, sandboxWritablePath,
      ],
      chdir: sandboxWritablePath,
    };
  }
  return {
    args: [
      ...(readOnlyWorkspaceRoot ? ["--ro-bind", readOnlyWorkspaceRoot, "/parent_workspace"] : []),
      "--bind", workspaceRoot, "/workspace",
    ],
    chdir: "/workspace",
  };
}

export async function hostInterpreterMaskArguments(): Promise<string[]> {
  const entries = await readdir("/usr/bin");
  return entries
    .filter((name) => /^(?:python(?:3(?:\.\d+)?)?|R|Rscript)$/.test(name))
    .flatMap((name) => ["--ro-bind", "/dev/null", `/usr/bin/${name}`]);
}

export async function hostRuntimeSupportArguments(): Promise<string[]> {
  const args: string[] = [];
  try {
    await access("/etc/alternatives");
    args.push("--ro-bind", "/etc/alternatives", "/etc/alternatives");
  } catch {
    // Optional host runtime support.
  }
  try {
    await access("/etc/fonts");
    args.push("--ro-bind", "/etc/fonts", "/etc/fonts");
  } catch {
    // Fontconfig falls back without this, but matplotlib is quieter with it.
  }
  return args;
}

export function environmentPrefixBindArguments(prefixPath: string): string[] {
  // Conda packages may embed their installation prefix. Bind only this revision at
  // both the stable tool path and its original absolute path; no parent is exposed.
  return [
    "--ro-bind", prefixPath, "/opt/science-env",
    "--ro-bind", prefixPath, prefixPath,
  ];
}

async function assertWorkspaceWithinQuota(workspaceRoot: string, maxWorkspaceBytes: number): Promise<void> {
  if (maxWorkspaceBytes === 0) return;
  if (await workspaceUsageBytes(workspaceRoot) > maxWorkspaceBytes) {
    throw new Error(workspaceQuotaPrecheckMessage(maxWorkspaceBytes));
  }
}

const LOCAL_PYTHON_PACKAGES_MOUNT = "/opt/science-agent-python-packages";

export async function localPythonPackageCandidatePaths(dataDir: string): Promise<string[]> {
  const packageRoot = resolve(dataDir, "python-packages");
  let versionedPackagePaths: string[] = [];
  try {
    const entries = await readdir(packageRoot, { withFileTypes: true });
    versionedPackagePaths = entries
      .filter((entry) => entry.isDirectory() && /^py\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => {
        const [, leftMajor, leftMinor] = /^py(\d+)\.(\d+)$/.exec(left) ?? [];
        const [, rightMajor, rightMinor] = /^py(\d+)\.(\d+)$/.exec(right) ?? [];
        return Number(rightMajor) - Number(leftMajor) || Number(rightMinor) - Number(leftMinor);
      })
      .map((name) => resolve(packageRoot, name));
  } catch {
    // Fall back to stable package locations when no versioned layout exists yet.
  }
  return [
    ...versionedPackagePaths,
    resolve(packageRoot, "py3"),
    packageRoot,
  ].filter((path, index, paths) => paths.indexOf(path) === index);
}

async function localPythonPackagePath(config: ExecutorConfig): Promise<string | undefined> {
  const packagePaths = await localPythonPackageCandidatePaths(config.dataDir);
  for (const packagePath of packagePaths) {
    try {
      await access(packagePath);
      return packagePath;
    } catch {
      // Try the next, less-specific package directory.
    }
  }
  return undefined;
}

function localPythonPackageBindArguments(packagePath: string | undefined): string[] {
  return packagePath ? ["--ro-bind", packagePath, LOCAL_PYTHON_PACKAGES_MOUNT] : [];
}

async function runSandboxed(
  config: ExecutorConfig,
  bwrapArguments: string[],
  stdin: string,
  timeoutMs: number,
  workspaceRoot: string,
  signal: AbortSignal | undefined,
  timeoutLabel: string,
  maxWorkspaceBytes: number,
  maxOutputBytes: number,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const seccompFilter = await open(
    await ensureBaselineSeccompFilter(config.dataDir),
    "r",
  );

  try {
    return await new Promise<{ exitCode: number; stderr: string; stdout: string }>((resolveRun, reject) => {
      const child = spawn(config.bwrapPath, bwrapArguments, {
        stdio: ["pipe", "pipe", "pipe", seccompFilter.fd],
      });
      void seccompFilter.close();
      if (!child.stdin || !child.stdout || !child.stderr) {
        child.kill("SIGKILL");
        throw new Error("Runner failed to create isolated process streams");
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      let checkingQuota = false;

      const finish = (error?: Error, exitCode = 1) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(quotaTimer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolveRun({ exitCode, stderr, stdout });
      };
      const abort = () => {
        child.kill("SIGKILL");
        finish(new Error(`${timeoutLabel} aborted`));
      };
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error(`${timeoutLabel} timed out after ${timeoutMs} ms`));
          }, timeoutMs)
        : undefined;
      const quotaTimer = maxWorkspaceBytes > 0
        ? setInterval(() => {
            if (checkingQuota || settled) return;
            checkingQuota = true;
            void workspaceUsageBytes(workspaceRoot)
              .then((bytes) => {
                if (bytes > maxWorkspaceBytes && !settled) {
                  child.kill("SIGKILL");
                  finish(new Error(workspaceQuotaExceededMessage(maxWorkspaceBytes)));
                }
              })
              .catch((error: Error) => {
                if (!settled) {
                  child.kill("SIGKILL");
                  finish(error);
                }
              })
              .finally(() => { checkingQuota = false; });
          }, 100)
        : undefined;

      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        const next = appendBounded(stdout, chunk, maxOutputBytes, Buffer.byteLength(stderr));
        stdout = next.text;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const next = appendBounded(stderr, chunk, maxOutputBytes, Buffer.byteLength(stdout));
        stderr = next.text;
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code) => finish(undefined, code ?? 1));
      child.stdin.end(stdin);
    });
  } catch (error) {
    await seccompFilter.close().catch(() => undefined);
    throw error;
  }
}

/** A fully computed sandbox launch: bwrap args plus the exact env and cwd it uses. */
export interface SandboxLaunch {
  args: string[];
  chdir: string;
  env: Record<string, string>;
}

/**
 * Resolve the sandbox cwd for a launch: a Session env profile may carry the
 * shell's cwd over, but only when it still maps to an existing directory
 * under the mounted workspace; otherwise fall back to the mount default.
 */
export async function resolveProfileChdir(
  envProfile: SessionEnvProfile | undefined,
  workspaceBinds: { args: string[]; chdir: string },
  workspaceRoot: string,
  readOnlyWorkspaceRoot: string | undefined,
): Promise<string> {
  const requested = envProfile ? sedimentableCwd(envProfile.cwd) : undefined;
  if (!requested || requested === workspaceBinds.chdir) return workspaceBinds.chdir;
  const relativePart = requested === "/workspace" ? "" : requested.slice("/workspace/".length);
  const segments = relativePart ? relativePart.split("/") : [];
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return workspaceBinds.chdir;
  }
  // In the nested subagent layout the sandbox /workspace root is the read-only parent.
  const hostWorkspace = readOnlyWorkspaceRoot && workspaceBinds.chdir !== "/workspace"
    ? readOnlyWorkspaceRoot
    : workspaceRoot;
  try {
    if ((await stat(resolve(hostWorkspace, ...segments))).isDirectory()) return requested;
  } catch {
    // The captured cwd no longer exists; use the mount default.
  }
  return workspaceBinds.chdir;
}

export function buildSandboxLaunch(options: {
  chdir: string;
  disableUserns: boolean;
  environmentBinds: string[];
  envProfile?: SessionEnvProfile;
  hostInterpreterMasks: string[];
  hostRuntimeSupport: string[];
  language: "python" | "r" | "shell";
  pathEnv: string;
  procMode: SandboxProcMode;
  pythonPathEnv?: string;
  workspaceBindArgs: string[];
}): SandboxLaunch {
  // Runner-owned baseline first; profile variables never override it
  // (profileKeyAllowed re-checks the reserved/blocked policy defensively).
  const env: Record<string, string> = { HOME: "/tmp", PATH: options.pathEnv };
  if (options.pythonPathEnv) env.PYTHONPATH = options.pythonPathEnv;
  if (options.language === "python" || options.pythonPathEnv) env.PYTHONNOUSERSITE = "1";
  if (options.language === "r") env.R_ENVIRON_USER = "/dev/null";
  for (const [name, value] of Object.entries(options.envProfile?.variables ?? {})) {
    if (profileKeyAllowed(name)) env[name] = value;
  }
  return {
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--unshare-user",
      ...(options.disableUserns ? ["--disable-userns"] : []),
      "--cap-drop", "ALL",
      "--ro-bind", "/usr", "/usr",
      ...options.hostRuntimeSupport,
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64",
      ...procMountArguments(options.procMode),
      "--dev", "/dev",
      ...options.hostInterpreterMasks,
      "--tmpfs", "/tmp",
      ...options.environmentBinds,
      ...options.workspaceBindArgs,
      "--chdir", options.chdir,
      "--clearenv",
      ...Object.entries(env).flatMap(([name, value]) => ["--setenv", name, value]),
      "--seccomp", "3",
    ],
    chdir: options.chdir,
    env,
  };
}

export async function executePython(
  config: ExecutorConfig,
  request: PythonExecutionRequest,
  signal?: AbortSignal,
  environmentStore?: EnvironmentStore,
  envProfile?: SessionEnvProfile,
): Promise<PythonExecutionResult> {
  const language: ScientificLanguage = request.language ?? "python";
  const kernelMode = request.kernelMode ?? "ephemeral";
  if (!request.code.trim()) throw new Error(`${language === "python" ? "Python" : "R"} code is required`);
  if (!request.executionId?.trim()) throw new Error("Execution ID is required");
  if (kernelMode !== "ephemeral") throw new Error("Persistent execution requires the kernel manager");
  if (request.permissionEpoch.networkPolicy !== "none") throw new Error("M1 runner requires networkPolicy=none");
  if (request.permissionEpoch.mounts.length !== 1
    || request.permissionEpoch.mounts[0]?.source !== "workspace"
    || request.permissionEpoch.mounts[0]?.mode !== "read-write") {
    throw new Error("M1 runner accepts exactly one read-write workspace mount");
  }

  const maxWorkspaceBytes = resolveQuotaBytes(request.maxWorkspaceBytes, config.maxWorkspaceBytes, "maxWorkspaceBytes");
  const maxOutputBytes = resolveQuotaBytes(request.maxOutputBytes, config.maxOutputBytes, "maxOutputBytes");
  const workspaceRoot = await validatedWorkspace(config.dataDir, request.workspaceRoot);
  await assertWorkspaceWithinQuota(workspaceRoot, maxWorkspaceBytes);
  const readOnlyWorkspaceRoot = request.readOnlyWorkspaceRoot
    ? await validatedWorkspace(config.dataDir, request.readOnlyWorkspaceRoot)
    : undefined;
  const before = await workspaceSnapshot(workspaceRoot);
  const startedAt = new Date().toISOString();
  const runtime = environmentStore?.capability.available
    ? environmentStore.resolveRuntime(request.environmentRevisionId, language)
    : undefined;
  if (!runtime && language !== "python") {
    throw new Error("R execution requires the scientific environment capability");
  }
  if (!runtime && request.environmentRevisionId
    && request.environmentRevisionId !== request.permissionEpoch.environmentRevisionId) {
    throw new Error("Named environment execution requires the scientific environment capability");
  }
  if (runtime) await access(runtime.interpreterPath);
  const environmentRevisionId = runtime?.revision.id
    ?? request.environmentRevisionId
    ?? request.permissionEpoch.environmentRevisionId;
  const hostInterpreterMasks = runtime ? await hostInterpreterMaskArguments() : [];
  const hostRuntimeSupport = await hostRuntimeSupportArguments();
  const localPythonPackages = !runtime && language === "python"
    ? await localPythonPackagePath(config)
    : undefined;
  const workspaceBinds = workspaceBindArguments(workspaceRoot, readOnlyWorkspaceRoot);
  const launch = buildSandboxLaunch({
    chdir: await resolveProfileChdir(envProfile, workspaceBinds, workspaceRoot, readOnlyWorkspaceRoot),
    ...await sandboxLaunchProfile(config.bwrapPath),
    environmentBinds: runtime
      ? environmentPrefixBindArguments(runtime.prefixPath)
      : localPythonPackageBindArguments(localPythonPackages),
    envProfile,
    hostInterpreterMasks,
    hostRuntimeSupport,
    language,
    pathEnv: runtime ? "/opt/science-env/bin:/usr/bin" : "/usr/bin",
    pythonPathEnv: localPythonPackages ? LOCAL_PYTHON_PACKAGES_MOUNT : undefined,
    workspaceBindArgs: workspaceBinds.args,
  });
  const bwrapArguments = [
    ...launch.args,
    runtime ? `/opt/science-env/bin/${language === "python" ? "python" : "R"}` : "/usr/bin/python3",
    ...(language === "python" ? [
      ...(localPythonPackages ? [] : ["-I"]),
      "-",
    ] : ["--vanilla", "--slave"]),
  ];

  const processResult = await runSandboxed(
    config,
    bwrapArguments,
    request.code,
    executionTimeoutMs(request.executionTimeoutMs, config.execTimeoutMs),
    workspaceRoot,
    signal,
    language === "python" ? "Python execution" : "R execution",
    maxWorkspaceBytes,
    maxOutputBytes,
  );
  await assertWorkspaceWithinQuota(workspaceRoot, maxWorkspaceBytes);

  const after = await workspaceSnapshot(workspaceRoot);
  const createdFiles = [...after.keys()].filter((path) => !before.has(path)).toSorted();
  const modifiedFiles = [...after.entries()]
    .filter(([path, fingerprint]) => before.has(path) && before.get(path) !== fingerprint)
    .map(([path]) => path)
    .toSorted();

  return {
    ...processResult,
    cgroupMode: RESOURCE_LIMIT_MODE,
    createdFiles,
    environmentRevisionId,
    environmentVariables: launch.env,
    executionId: request.executionId,
    finishedAt: new Date().toISOString(),
    modifiedFiles,
    kernelId: `ephemeral:${request.executionId}`,
    kernelMode,
    language,
    networkPolicy: "none",
    runnerVersion: RUNNER_VERSION,
    sandbox: "bubblewrap",
    startedAt,
    workingDirectory: launch.chdir,
  };
}

export async function executeShell(
  config: ExecutorConfig,
  request: ShellExecutionRequest,
  signal?: AbortSignal,
  envProfile?: SessionEnvProfile,
): Promise<ShellExecutionResult> {
  if (!request.code.trim()) throw new Error("Shell code is required");
  if (!request.executionId?.trim()) throw new Error("Execution ID is required");
  if (request.permissionEpoch.networkPolicy !== "none") throw new Error("Shell execution requires networkPolicy=none");
  if (request.permissionEpoch.mounts.length !== 1
    || request.permissionEpoch.mounts[0]?.source !== "workspace"
    || request.permissionEpoch.mounts[0]?.mode !== "read-write") {
    throw new Error("Shell execution accepts exactly one read-write workspace mount");
  }

  const maxWorkspaceBytes = resolveQuotaBytes(request.maxWorkspaceBytes, config.maxWorkspaceBytes, "maxWorkspaceBytes");
  const maxOutputBytes = resolveQuotaBytes(request.maxOutputBytes, config.maxOutputBytes, "maxOutputBytes");
  const workspaceRoot = await validatedWorkspace(config.dataDir, request.workspaceRoot);
  await assertWorkspaceWithinQuota(workspaceRoot, maxWorkspaceBytes);
  const readOnlyWorkspaceRoot = request.readOnlyWorkspaceRoot
    ? await validatedWorkspace(config.dataDir, request.readOnlyWorkspaceRoot)
    : undefined;
  const before = await workspaceSnapshot(workspaceRoot);
  const startedAt = new Date().toISOString();
  const hostRuntimeSupport = await hostRuntimeSupportArguments();
  const localPythonPackages = await localPythonPackagePath(config);
  const workspaceBinds = workspaceBindArguments(workspaceRoot, readOnlyWorkspaceRoot);
  const launch = buildSandboxLaunch({
    chdir: await resolveProfileChdir(envProfile, workspaceBinds, workspaceRoot, readOnlyWorkspaceRoot),
    ...await sandboxLaunchProfile(config.bwrapPath),
    environmentBinds: localPythonPackageBindArguments(localPythonPackages),
    envProfile,
    hostInterpreterMasks: [],
    hostRuntimeSupport,
    language: "shell",
    pathEnv: "/usr/bin",
    pythonPathEnv: localPythonPackages ? LOCAL_PYTHON_PACKAGES_MOUNT : undefined,
    workspaceBindArgs: workspaceBinds.args,
  });
  const bwrapArguments = [
    ...launch.args,
    "/usr/bin/bash",
    "--noprofile",
    "--norc",
    "-euo",
    "pipefail",
    "-s",
  ];

  const processResult = await runSandboxed(
    config,
    bwrapArguments,
    request.code,
    executionTimeoutMs(request.executionTimeoutMs, config.execTimeoutMs),
    workspaceRoot,
    signal,
    "Shell execution",
    maxWorkspaceBytes,
    maxOutputBytes,
  );
  await assertWorkspaceWithinQuota(workspaceRoot, maxWorkspaceBytes);

  const after = await workspaceSnapshot(workspaceRoot);
  const shellCreatedFiles = [...after.keys()].filter((path) => !before.has(path)).toSorted();
  const shellModifiedFiles = [...after.entries()]
    .filter(([path, fingerprint]) => before.has(path) && before.get(path) !== fingerprint)
    .map(([path]) => path);
  return {
    ...processResult,
    cgroupMode: RESOURCE_LIMIT_MODE,
    createdFiles: shellCreatedFiles,
    environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
    environmentVariables: launch.env,
    executionId: request.executionId,
    finishedAt: new Date().toISOString(),
    kernelId: `ephemeral:${request.executionId}`,
    kernelMode: "ephemeral",
    language: "shell",
    modifiedFiles: shellModifiedFiles.toSorted(),
    networkPolicy: "none",
    runnerVersion: RUNNER_VERSION,
    sandbox: "bubblewrap",
    startedAt,
    workingDirectory: launch.chdir,
  };
}
