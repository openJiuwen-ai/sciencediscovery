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

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  detectSandboxCapability,
  procMountArguments,
  type SandboxProcMode,
} from "@sciencediscovery/sandbox-capability";
import {
  SANDBOX_SKILL_EXTENSIONS_ROOT,
  SANDBOX_SKILL_PACKAGES_ROOT,
  SKILL_EXTENSIONS_ENVIRONMENT_VARIABLE,
  SKILL_EXTENSIONS_WORKSPACE_PATH,
  SKILL_PACKAGES_ENVIRONMENT_VARIABLE,
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  SYSTEM_SHELL_SEATBELT_ENVIRONMENT_REVISION_ID,
  epochSandboxNetworkAccess,
  type PythonExecutionRequest,
  type PythonExecutionResult,
  type ResolvedProxy,
  type SandboxNetworkAccess,
  type SandboxKind,
  type ScientificLanguage,
  type ShellExecutionRequest,
  type ShellExecutionResult,
} from "@sciencediscovery/schema";

import {
  EgressBridgeUnavailableError,
  egressBridgeBindArguments,
  egressBridgeCommandPrefix,
  egressEnvironment,
  egressEnvironmentForUrl,
  resolveEgressBridge,
} from "./egress-bridge.js";
import type { EgressGatewayRegistry } from "./egress-gateway.js";
import type { SandboxNpu } from "./npu-devices.js";
import { ensureSeccompFilter, type SeccompVariant } from "./seccomp.js";
import { profileKeyAllowed, sedimentableCwd, type SessionEnvProfile } from "./session-env-profile.js";
import type { EnvironmentStore } from "./environment-store.js";
import { buildSeatbeltProfile, seatbeltWorkspaceMapping } from "./seatbelt.js";
import { RunnerSkillPackages } from "./skill-packages.js";

import { RUNNER_VERSION } from "./version.js";
export { RUNNER_VERSION } from "./version.js";

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

export interface SandboxRuntimeConfig {
  bwrapPath: string;
  /** Resolved sandbox implementation. Defaults from the host platform. */
  sandboxProvider?: "bubblewrap" | "seatbelt";
  /** macOS Seatbelt launcher. */
  seatbeltPath?: string;
  dataDir: string;
}

export interface ExecutorConfig extends SandboxRuntimeConfig {
  /** Packaged Python interpreter used when no managed environment is selected. */
  pythonPath?: string;
  /** Wall-clock limit for a single execution. */
  execTimeoutMs: number;
  /** Workspace total quota in bytes; 0 disables. */
  maxWorkspaceBytes: number;
  /** Combined stdout+stderr retain budget; 0 disables truncation. */
  maxOutputBytes: number;
}

export function executorSandboxKind(config: SandboxRuntimeConfig): SandboxKind {
  // Programmatic callers that predate multi-platform support keep the Linux
  // contract. The process entrypoint always resolves and sets the provider.
  return config.sandboxProvider ?? "bubblewrap";
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
  const workspaceRoot = await realpath(requested);
  // Remote runners have their own persistent workspace tree and need not have
  // the control API's local projects tree. Never authorize the whole data dir.
  const dataRoot = await realpath(dataDir);
  for (const directory of ["projects", "remote-workspaces"]) {
    const root = await realpath(resolve(dataRoot, directory)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!root) continue;
    if (directory === "remote-workspaces" && root !== resolve(dataRoot, directory)) continue;
    if (workspaceRoot === root || workspaceRoot.startsWith(`${root}${sep}`)) return workspaceRoot;
  }
  throw new Error("Runner workspace must be inside the configured projects or remote-workspaces directory");
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

export interface SandboxSkillRoots {
  extensionsRoot: string;
  packagesRoot: string;
}

export async function resolveSandboxSkillRoots(
  dataDir: string,
  workspaceRoot: string,
  requestedPackagesRoot: string | undefined,
): Promise<SandboxSkillRoots | undefined> {
  if (!requestedPackagesRoot) return undefined;
  const packagesRoot = await validatedWorkspace(dataDir, requestedPackagesRoot);
  // A snapshot this Runner published for a remote execution is only mountable
  // while it still matches the manifest it was published under, so a damaged or
  // half-written tree fails the execution instead of being mounted.
  const managedParent = resolve(dataDir, "projects", ".skill-packages");
  if (packagesRoot === managedParent || packagesRoot.startsWith(managedParent + sep)) {
    const snapshot = await new RunnerSkillPackages(dataDir).get(relative(managedParent, packagesRoot));
    if (snapshot.root !== packagesRoot) throw new Error("Unpublished Skill snapshot");
  }
  if (!(await stat(packagesRoot)).isDirectory()) throw new Error("Runner Skill packages root must be a directory");
  const extensionsRoot = resolve(workspaceRoot, SKILL_EXTENSIONS_WORKSPACE_PATH);
  await mkdir(extensionsRoot, { recursive: true });
  return { extensionsRoot, packagesRoot };
}

export async function hostInterpreterMaskArguments(binDirectory = "/usr/bin"): Promise<string[]> {
  const entries = await readdir(binDirectory);
  const names = entries.filter((name) => /^(?:python(?:3(?:\.\d+)?)?|R|Rscript)$/.test(name));
  // Mask the *resolved* target, not the name. On Debian-family hosts these are
  // real files and the two are the same; on RHEL-family hosts they are symlinks
  // through /etc/alternatives, and binding onto a symlink makes bwrap follow it
  // and try to create the mountpoint at the far end — inside the read-only
  // /usr bind, which fails the whole launch with
  //   bwrap: Can't create file at /usr/bin/python: No such file or directory
  // and takes every run_python with it. Masking the shared target instead
  // leaves each symlink pointing at /dev/null, which is what the mask is for.
  const targets = new Set<string>();
  for (const name of names) {
    try {
      targets.add(await realpath(`${binDirectory}/${name}`));
    } catch {
      // A dangling alternatives link has nothing to mask; skip it rather than
      // failing every sandbox launch on this host.
    }
  }
  return [...targets].sort().flatMap((target) => ["--ro-bind", "/dev/null", target]);
}

/**
 * Optional host resources the sandbox may use. Every one of them is absent on
 * some host, so each is probed before it is bound, and the environment is only
 * populated for what was actually found.
 */
export interface HostRuntimeSupport {
  /** bubblewrap binds exposing the resources this host actually has. */
  bindArgs: string[];
  /** Environment pointing TLS clients at the trust store that was bound. */
  env: Record<string, string>;
}

/**
 * Hashed certificate directories OpenSSL scans, by distribution family.
 *
 * The sandbox keeps `--ro-bind /usr /usr` but assembles a fresh `/etc`, so
 * without a trust store bind no CA bundle exists inside it and every TLS client
 * fails before the handshake — curl reports exit 77 on the missing bundle
 * rather than any HTTP status. Binding a trust store grants no reachability: an
 * outbound connection still needs `domain-allowlist` and the egress gateway, so
 * `none` stays offline and unlisted domains stay refused.
 */
const HOST_CA_DIRECTORIES = [
  "/etc/ssl/certs",      // Debian, Ubuntu, Alpine, Arch, SUSE
  "/etc/pki/tls/certs",  // RHEL, Fedora, CentOS
];
/** Trees the certificate directories link into on the RHEL family. */
const HOST_CA_SUPPORT_DIRECTORIES = ["/etc/pki/ca-trust"];
/** Concatenated bundles, in the order a client looks for them. */
const HOST_CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

async function hostPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveHostRuntimeSupport(): Promise<HostRuntimeSupport> {
  const bindArgs: string[] = [];
  if (await hostPathExists("/etc/alternatives")) {
    bindArgs.push("--ro-bind", "/etc/alternatives", "/etc/alternatives");
  }
  // Fontconfig falls back without this, but matplotlib is quieter with it.
  if (await hostPathExists("/etc/fonts")) {
    bindArgs.push("--ro-bind", "/etc/fonts", "/etc/fonts");
  }

  const certificateDirectories: string[] = [];
  for (const directory of [...HOST_CA_DIRECTORIES, ...HOST_CA_SUPPORT_DIRECTORIES]) {
    if (!await hostPathExists(directory)) continue;
    bindArgs.push("--ro-bind", directory, directory);
    certificateDirectories.push(directory);
  }
  const env: Record<string, string> = {};
  for (const bundle of HOST_CA_BUNDLES) {
    if (!await hostPathExists(bundle)) continue;
    // Bind the bundle only when no bound directory already carries it; binding
    // it twice would target a path inside a read-only mount.
    if (!certificateDirectories.some((directory) => bundle.startsWith(`${directory}/`))) {
      bindArgs.push("--ro-bind", bundle, bundle);
    }
    // curl and OpenSSL find their compiled-in default once the file is there;
    // these make an interpreter shipped with its own prefix (a conda Python,
    // whose OPENSSLDIR points inside the environment) use the same store.
    env.SSL_CERT_FILE = bundle;
    env.CURL_CA_BUNDLE = bundle;
    env.REQUESTS_CA_BUNDLE = bundle;
    break;
  }
  const hashedDirectory = certificateDirectories.find((directory) => HOST_CA_DIRECTORIES.includes(directory));
  if (hashedDirectory) env.SSL_CERT_DIR = hashedDirectory;
  return { bindArgs, env };
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

const LOCAL_PYTHON_PACKAGES_MOUNT = "/opt/sciencediscovery-python-packages";

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

async function nativePythonPath(config: ExecutorConfig, sandbox: SandboxKind): Promise<string> {
  if (config.pythonPath) return config.pythonPath;
  if (sandbox === "seatbelt") {
    const commandLineToolsPython = "/Library/Developer/CommandLineTools/usr/bin/python3";
    try {
      await access(commandLineToolsPython);
      return commandLineToolsPython;
    } catch {
      // A packaged release supplies pythonPath; source installs may fall back
      // to the system shim when Command Line Tools are not installed.
    }
  }
  return "/usr/bin/python3";
}

function localPythonPackageBindArguments(packagePath: string | undefined): string[] {
  return packagePath ? ["--ro-bind", packagePath, LOCAL_PYTHON_PACKAGES_MOUNT] : [];
}

async function runSandboxed(
  config: ExecutorConfig,
  launch: SandboxLaunch,
  commandArguments: string[],
  stdin: string,
  timeoutMs: number,
  workspaceRoot: string,
  signal: AbortSignal | undefined,
  timeoutLabel: string,
  maxWorkspaceBytes: number,
  maxOutputBytes: number,
  seccompVariant: SeccompVariant = "baseline",
  onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  try {
    return await new Promise<{ exitCode: number; stderr: string; stdout: string }>((resolveRun, reject) => {
      let child: ChildProcessWithoutNullStreams | undefined;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let checkingQuota = false;
      let stopError: Error | undefined;

      const finish = (error?: Error, exitCode = 1) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(quotaTimer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolveRun({ exitCode, stderr, stdout });
      };
      const stop = (error: Error) => {
        stopError ??= error;
        if (child) killSandboxProcess(child);
      };
      // Do not release a writer or clean up its mounts until the process has exited.
      const abort = () => stop(new Error(`${timeoutLabel} aborted`));
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
            stop(new Error(`${timeoutLabel} timed out after ${timeoutMs} ms`));
          }, timeoutMs)
        : undefined;
      const quotaTimer = maxWorkspaceBytes > 0
        ? setInterval(() => {
            if (checkingQuota || settled) return;
            checkingQuota = true;
            void workspaceUsageBytes(workspaceRoot)
              .then((bytes) => {
                if (bytes > maxWorkspaceBytes && !settled) {
                  stop(new Error(workspaceQuotaExceededMessage(maxWorkspaceBytes)));
                }
              })
              .catch((error: Error) => {
                if (!settled) {
                  stop(error);
                }
              })
              .finally(() => { checkingQuota = false; });
          }, 100)
        : undefined;

      void spawnSandboxProcess(config, launch, commandArguments, seccompVariant).then((started) => {
        child = started;
        if (stopError) killSandboxProcess(child);
        if (!child.stdin || !child.stdout || !child.stderr) {
          killSandboxProcess(child);
          finish(new Error("Runner failed to create isolated process streams"));
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdout.on("data", (chunk: Buffer) => {
          try { onOutput?.("stdout", chunk); } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
          const next = appendBounded(stdout, chunk, maxOutputBytes, Buffer.byteLength(stderr));
          stdout = next.text;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          try { onOutput?.("stderr", chunk); } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
          const next = appendBounded(stderr, chunk, maxOutputBytes, Buffer.byteLength(stdout));
          stderr = next.text;
        });
        child.once("error", (error) => finish(error));
        child.once("close", (code) => finish(stopError, code ?? 1));
        // The sandbox can already be gone by the time its payload is written —
        // that is what an aborted or crashed execution looks like from here.
        // A stream error with no listener becomes an uncaught exception, so a
        // broken pipe would take the whole Runner down on the way to the
        // outcome the process's own events already carry.
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EPIPE") return;
          stop(error);
        });
        child.stdin.end(stdin);
      }).catch((error: Error) => finish(error));
    });
  } finally {
    await launch.cleanup?.().catch(() => undefined);
  }
}

/** A fully computed sandbox launch: bwrap args plus the exact env and cwd it uses. */
export interface SandboxLaunch {
  args: string[];
  chdir: string;
  /** Host executable that establishes the sandbox boundary. */
  executable?: string;
  /** Host cwd used by Seatbelt; Bubblewrap changes cwd internally. */
  hostCwd?: string;
  /**
   * Argv that must precede the real command inside the sandbox. Empty unless
   * sandbox network access is on, where it starts the egress bridge that then
   * executes the real command as its child.
   */
  commandPrefix: string[];
  env: Record<string, string>;
  sandbox?: SandboxKind;
  /** Translate a host cwd observed by a native sandbox back to `/workspace`. */
  toLogicalPath?: (hostPath: string) => string;
  /** Release per-launch resources such as a private temp directory. */
  cleanup?: () => Promise<void>;
}

/**
 * Everything a `domain-allowlist` launch needs: the bwrap binds that expose the
 * bridge and the gateway socket, the argv prefix that starts the bridge, and
 * the outbound environment ordinary HTTP clients look for.
 */
export interface SandboxEgress {
  bindArgs: string[];
  commandPrefix: string[];
  env: Record<string, string>;
  /** Seatbelt permits only this runner-owned loopback port. */
  proxyPort?: number;
}

/**
 * Resolve the egress plumbing for one execution. `none` needs nothing;
 * `domain-allowlist` fails closed when the host has no bridge interpreter or
 * the runner has no gateway registry, rather than running unfiltered.
 */
export async function prepareSandboxEgress(
  dataDir: string,
  access: SandboxNetworkAccess,
  gateways: EgressGatewayRegistry | undefined,
  sandbox: SandboxKind = "bubblewrap",
  /**
   * Outbound route for traffic the allowlist accepts, resolved by the API from
   * the policy this epoch snapshotted. It never reaches the sandbox: only the
   * runner-side gateway dials through it.
   */
  proxy?: ResolvedProxy,
): Promise<SandboxEgress | undefined> {
  if (access.mode === "none") return undefined;
  if (!gateways) {
    throw new EgressBridgeUnavailableError("this runner was started without an egress gateway registry");
  }
  if (sandbox === "seatbelt") {
    const gateway = await gateways.acquireTcp(access, proxy);
    return {
      bindArgs: [],
      commandPrefix: [],
      env: egressEnvironmentForUrl(gateway.proxyUrl()),
      proxyPort: gateway.proxyPort(),
    };
  }
  const [bridge, gateway] = await Promise.all([resolveEgressBridge(dataDir), gateways.acquire(access, proxy)]);
  return {
    bindArgs: egressBridgeBindArguments(bridge, gateway.socketPath),
    commandPrefix: egressBridgeCommandPrefix(),
    env: egressEnvironment(),
  };
}

export function seccompVariantFor(access: SandboxNetworkAccess): SeccompVariant {
  return access.mode === "none" ? "baseline" : "network";
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
  /** Sandbox network access plumbing; absent keeps the sandbox without network. */
  egress?: SandboxEgress;
  environmentBinds: string[];
  envProfile?: SessionEnvProfile;
  hostInterpreterMasks: string[];
  hostRuntimeSupport: HostRuntimeSupport;
  language: "python" | "r" | "shell";
  /** Selected NPU cards, already renumbered from 0; absent keeps the sandbox without NPUs. */
  npu?: SandboxNpu;
  pathEnv: string;
  procMode: SandboxProcMode;
  pythonPathEnv?: string;
  skillRoots?: SandboxSkillRoots;
  workspaceBindArgs: string[];
}): SandboxLaunch {
  // Runner-owned baseline first; profile variables never override it
  // (profileKeyAllowed re-checks the reserved/blocked policy defensively).
  const env: Record<string, string> = { HOME: "/tmp", PATH: options.pathEnv };
  // CANN's operator compiler is imported as ordinary Python, so its search path
  // has to join PYTHONPATH rather than replace whatever the environment set.
  const pythonPathEntries = [
    ...(options.pythonPathEnv ? [options.pythonPathEnv] : []),
    ...(options.npu?.pythonPath ?? []),
  ];
  if (pythonPathEntries.length > 0) env.PYTHONPATH = pythonPathEntries.join(":");
  if (options.language === "python" || options.pythonPathEnv) env.PYTHONNOUSERSITE = "1";
  if (options.language === "r") env.R_ENVIRON_USER = "/dev/null";
  if (options.skillRoots) {
    env[SKILL_PACKAGES_ENVIRONMENT_VARIABLE] = SANDBOX_SKILL_PACKAGES_ROOT;
    env[SKILL_EXTENSIONS_ENVIRONMENT_VARIABLE] = SANDBOX_SKILL_EXTENSIONS_ROOT;
  }
  Object.assign(env, options.hostRuntimeSupport.env);
  Object.assign(env, options.npu?.env ?? {});
  Object.assign(env, options.egress?.env ?? {});
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
      ...options.hostRuntimeSupport.bindArgs,
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64",
      ...procMountArguments(options.procMode),
      // A fresh /dev, then only the selected cards. Binding the host's /dev
      // instead would offer every card at once, and the Ascend driver fails the
      // whole enumeration when any visible card cannot be claimed.
      "--dev", "/dev",
      ...(options.npu?.bindArgs ?? []),
      ...options.hostInterpreterMasks,
      "--tmpfs", "/tmp",
      ...options.environmentBinds,
      ...(options.egress?.bindArgs ?? []),
      ...options.workspaceBindArgs,
      ...(options.skillRoots ? [
        "--ro-bind", options.skillRoots.packagesRoot, SANDBOX_SKILL_PACKAGES_ROOT,
        "--bind", options.skillRoots.extensionsRoot, SANDBOX_SKILL_EXTENSIONS_ROOT,
      ] : []),
      "--chdir", options.chdir,
      "--clearenv",
      ...Object.entries(env).flatMap(([name, value]) => ["--setenv", name, value]),
      "--seccomp", "3",
    ],
    chdir: options.chdir,
    commandPrefix: options.egress?.commandPrefix ?? [],
    env,
    sandbox: "bubblewrap",
  };
}

interface NativeSandboxLaunchOptions {
  chdir: string;
  egress?: SandboxEgress;
  envProfile?: SessionEnvProfile;
  language: "python" | "r" | "shell";
  pathEnv: string;
  pythonPathEnv?: string;
  readOnlyWorkspaceRoot?: string;
  readPaths: string[];
  skillRoots?: SandboxSkillRoots;
  workspaceRoot: string;
}

function launchEnvironment(options: {
  egress?: SandboxEgress;
  envProfile?: SessionEnvProfile;
  home: string;
  language: "python" | "r" | "shell";
  pathEnv: string;
  pythonPathEnv?: string;
  skillRoots?: SandboxSkillRoots;
  temp?: string;
}): Record<string, string> {
  const env: Record<string, string> = { HOME: options.home, PATH: options.pathEnv };
  if (options.temp) {
    env.TMPDIR = options.temp;
    env.TMP = options.temp;
    env.TEMP = options.temp;
  }
  if (options.pythonPathEnv) env.PYTHONPATH = options.pythonPathEnv;
  if (options.language === "python" || options.pythonPathEnv) env.PYTHONNOUSERSITE = "1";
  if (options.language === "r") env.R_ENVIRON_USER = "/dev/null";
  if (options.skillRoots) {
    env[SKILL_PACKAGES_ENVIRONMENT_VARIABLE] = options.skillRoots.packagesRoot;
    env[SKILL_EXTENSIONS_ENVIRONMENT_VARIABLE] = options.skillRoots.extensionsRoot;
  }
  Object.assign(env, options.egress?.env ?? {});
  for (const [name, value] of Object.entries(options.envProfile?.variables ?? {})) {
    if (profileKeyAllowed(name)) env[name] = value;
  }
  return env;
}

async function buildSeatbeltLaunch(
  config: SandboxRuntimeConfig,
  options: NativeSandboxLaunchOptions,
): Promise<SandboxLaunch> {
  const tempRoot = resolve(config.dataDir, "runner-runtime", "tmp");
  await mkdir(tempRoot, { recursive: true });
  const privateTemp = await mkdtemp(resolve(tempRoot, "seatbelt-"));
  const mapping = seatbeltWorkspaceMapping(
    options.workspaceRoot,
    options.readOnlyWorkspaceRoot,
    options.chdir,
  );
  const env = launchEnvironment({
    ...options,
    home: privateTemp,
    temp: privateTemp,
  });
  const profile = await buildSeatbeltProfile({
    proxyPort: options.egress?.proxyPort,
    readPaths: [
      options.workspaceRoot,
      ...(options.readOnlyWorkspaceRoot ? [options.readOnlyWorkspaceRoot] : []),
      ...(options.skillRoots ? [options.skillRoots.packagesRoot] : []),
      ...options.readPaths,
    ],
    writePaths: [options.workspaceRoot, privateTemp],
  });
  return {
    args: ["-p", profile],
    chdir: options.chdir,
    cleanup: async () => { await rm(privateTemp, { force: true, recursive: true }); },
    commandPrefix: [],
    env,
    executable: config.seatbeltPath ?? "/usr/bin/sandbox-exec",
    hostCwd: mapping.hostCwd,
    sandbox: "seatbelt",
    toLogicalPath: mapping.toLogicalPath,
  };
}

export interface PreparedSandboxOptions {
  chdir: string;
  egress?: SandboxEgress;
  environmentBinds: string[];
  /** Host paths corresponding to environmentBinds for native Seatbelt. */
  environmentPaths: string[];
  envProfile?: SessionEnvProfile;
  hostInterpreterMasks: string[];
  hostRuntimeSupport: HostRuntimeSupport;
  language: "python" | "r" | "shell";
  /** Selected NPU cards for this execution; absent keeps the sandbox without NPUs. */
  npu?: SandboxNpu;
  pathEnv: string;
  pythonPathEnv?: string;
  readOnlyWorkspaceRoot?: string;
  skillRoots?: SandboxSkillRoots;
  workspaceBindArgs: string[];
  workspaceRoot: string;
}

/** Build one platform-neutral launch used by ephemeral and persistent tools. */
export async function prepareSandboxLaunch(
  config: SandboxRuntimeConfig,
  options: PreparedSandboxOptions,
): Promise<SandboxLaunch> {
  if (executorSandboxKind(config) === "seatbelt") {
    return await buildSeatbeltLaunch(config, { ...options, readPaths: options.environmentPaths });
  }
  const launch = buildSandboxLaunch({
    ...options,
    ...await sandboxLaunchProfile(config.bwrapPath),
  });
  launch.executable = config.bwrapPath;
  return launch;
}

/** Host path for a command or injected runtime, preserving Linux mount paths. */
export function sandboxCommandPath(launch: SandboxLaunch, linuxPath: string, hostPath: string): string {
  return launch.sandbox === "seatbelt" ? hostPath : linuxPath;
}

const sandboxProcessGroups = new WeakSet<ChildProcessWithoutNullStreams>();

/** Kill the namespace init as well as the monitor, including during bwrap setup. */
export function killSandboxProcess(child: ChildProcessWithoutNullStreams): boolean {
  if (!sandboxProcessGroups.has(child) || !child.pid) return child.kill("SIGKILL");
  try {
    process.kill(-child.pid, "SIGKILL");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Spawn through the selected sandbox and attach Linux seccomp when applicable. */
export async function spawnSandboxProcess(
  config: SandboxRuntimeConfig,
  launch: SandboxLaunch,
  commandArguments: string[],
  seccompVariant: SeccompVariant,
): Promise<ChildProcessWithoutNullStreams> {
  let filter: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if ((launch.sandbox ?? executorSandboxKind(config)) === "bubblewrap") {
      filter = await open(await ensureSeccompFilter(config.dataDir, seccompVariant), "r");
    }
    const processGroup = (launch.sandbox ?? executorSandboxKind(config)) === "bubblewrap";
    const child = spawn(launch.executable ?? config.bwrapPath, [
      // Node establishes a new session before exec. Keep bwrap's namespace init
      // in that group: --new-session would move it out of reach of group kill.
      ...launch.args.filter((arg) => !processGroup || arg !== "--new-session"),
      ...launch.commandPrefix,
      ...commandArguments,
    ], {
      detached: processGroup,
      ...(launch.hostCwd ? { cwd: launch.hostCwd } : {}),
      env: launch.sandbox === "seatbelt" ? launch.env : undefined,
      stdio: filter ? ["pipe", "pipe", "pipe", filter.fd] : ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    if (processGroup) {
      sandboxProcessGroups.add(child);
      child.once("close", () => sandboxProcessGroups.delete(child));
    }
    await filter?.close();
    return child;
  } catch (error) {
    await filter?.close().catch(() => undefined);
    await launch.cleanup?.().catch(() => undefined);
    throw error;
  }
}

export async function executePython(
  config: ExecutorConfig,
  request: PythonExecutionRequest,
  signal?: AbortSignal,
  environmentStore?: EnvironmentStore,
  envProfile?: SessionEnvProfile,
  gateways?: EgressGatewayRegistry,
): Promise<PythonExecutionResult> {
  const language: ScientificLanguage = request.language ?? "python";
  const kernelMode = request.kernelMode ?? "ephemeral";
  if (!request.code.trim()) throw new Error(`${language === "python" ? "Python" : "R"} code is required`);
  if (!request.executionId?.trim()) throw new Error("Execution ID is required");
  if (kernelMode !== "ephemeral") throw new Error("Persistent execution requires the kernel manager");
  const networkAccess = epochSandboxNetworkAccess(request.permissionEpoch);
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
  const skillRoots = await resolveSandboxSkillRoots(config.dataDir, workspaceRoot, request.skillPackagesRoot);
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
  const hostRuntimeSupport = await resolveHostRuntimeSupport();
  const localPythonPackages = !runtime && language === "python"
    ? await localPythonPackagePath(config)
    : undefined;
  const workspaceBinds = workspaceBindArguments(workspaceRoot, readOnlyWorkspaceRoot);
  const sandbox = executorSandboxKind(config);
  const hostPython = !runtime && language === "python" ? await nativePythonPath(config, sandbox) : undefined;
  const launch = await prepareSandboxLaunch(config, {
    chdir: await resolveProfileChdir(envProfile, workspaceBinds, workspaceRoot, readOnlyWorkspaceRoot),
    egress: await prepareSandboxEgress(config.dataDir, networkAccess, gateways, sandbox, request.sandboxEgressProxy),
    environmentBinds: runtime
      ? environmentPrefixBindArguments(runtime.prefixPath)
      : localPythonPackageBindArguments(localPythonPackages),
    environmentPaths: [
      ...(runtime ? [runtime.prefixPath] : []),
      ...(localPythonPackages ? [localPythonPackages] : []),
      ...(hostPython ? [dirname(dirname(hostPython))] : []),
    ],
    envProfile,
    hostInterpreterMasks,
    hostRuntimeSupport,
    language,
    pathEnv: runtime
      ? (sandbox === "seatbelt" ? `${resolve(runtime.prefixPath, "bin")}:/usr/bin:/bin` : "/opt/science-env/bin:/usr/bin")
      : "/usr/bin:/bin",
    pythonPathEnv: localPythonPackages
      ? (sandbox === "seatbelt" ? localPythonPackages : LOCAL_PYTHON_PACKAGES_MOUNT)
      : undefined,
    readOnlyWorkspaceRoot,
    skillRoots,
    workspaceBindArgs: workspaceBinds.args,
    workspaceRoot,
  });
  const commandArguments = [
    runtime
      ? sandboxCommandPath(
          launch,
          `/opt/science-env/bin/${language === "python" ? "python" : "R"}`,
          runtime.interpreterPath,
        )
      : hostPython ?? "/usr/bin/python3",
    ...(language === "python" ? [
      ...(localPythonPackages ? [] : ["-I"]),
      "-",
    ] : ["--vanilla", "--slave"]),
  ];

  const processResult = await runSandboxed(
    config,
    launch,
    commandArguments,
    request.code,
    executionTimeoutMs(request.executionTimeoutMs, config.execTimeoutMs),
    workspaceRoot,
    signal,
    language === "python" ? "Python execution" : "R execution",
    maxWorkspaceBytes,
    maxOutputBytes,
    seccompVariantFor(networkAccess),
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
    networkAccessRevision: networkAccess.revision,
    networkPolicy: networkAccess.mode,
    runnerVersion: RUNNER_VERSION,
    sandbox,
    startedAt,
    workingDirectory: launch.chdir,
  };
}

export async function executeShell(
  config: ExecutorConfig,
  request: ShellExecutionRequest,
  signal?: AbortSignal,
  envProfile?: SessionEnvProfile,
  gateways?: EgressGatewayRegistry,
  runtime?: import("./environment-store.js").EnvironmentRuntime,
  onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void,
): Promise<ShellExecutionResult> {
  if (!request.code.trim()) throw new Error("Shell code is required");
  if (!request.executionId?.trim()) throw new Error("Execution ID is required");
  const networkAccess = epochSandboxNetworkAccess(request.permissionEpoch);
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
  const skillRoots = await resolveSandboxSkillRoots(config.dataDir, workspaceRoot, request.skillPackagesRoot);
  const before = await workspaceSnapshot(workspaceRoot);
  const startedAt = new Date().toISOString();
  const hostRuntimeSupport = await resolveHostRuntimeSupport();
  const localPythonPackages = await localPythonPackagePath(config);
  const workspaceBinds = workspaceBindArguments(workspaceRoot, readOnlyWorkspaceRoot);
  const sandbox = executorSandboxKind(config);
  if (request.environmentId && runtime?.environment.id !== request.environmentId) {
    throw new Error("Selected environment requires an active Runner environment lease");
  }
  let chdir = await resolveProfileChdir(envProfile, workspaceBinds, workspaceRoot, readOnlyWorkspaceRoot);
  if (request.cwd !== undefined) {
    if (isAbsolute(request.cwd)) throw new Error("cwd must be workspace-relative");
    const directory = await realpath(resolve(workspaceRoot, request.cwd));
    const relativePath = relative(workspaceRoot, directory);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error("cwd must remain inside the writable workspace");
    }
    if (!(await stat(directory)).isDirectory()) throw new Error("cwd must be a directory");
    chdir = sandbox === "seatbelt" ? directory : `${workspaceBinds.chdir}/${relativePath}`;
  }
  const launch = await prepareSandboxLaunch(config, {
    chdir,
    egress: await prepareSandboxEgress(config.dataDir, networkAccess, gateways, sandbox, request.sandboxEgressProxy),
    environmentBinds: runtime ? environmentPrefixBindArguments(runtime.prefixPath) : localPythonPackageBindArguments(localPythonPackages),
    environmentPaths: runtime ? [runtime.prefixPath] : localPythonPackages ? [localPythonPackages] : [],
    envProfile,
    hostInterpreterMasks: [],
    hostRuntimeSupport,
    language: "shell",
    pathEnv: runtime
      ? `${sandbox === "seatbelt" ? resolve(runtime.prefixPath, "bin") : "/opt/science-env/bin"}:/usr/bin:/bin`
      : "/usr/bin:/bin",
    pythonPathEnv: !runtime && localPythonPackages
      ? (sandbox === "seatbelt" ? localPythonPackages : LOCAL_PYTHON_PACKAGES_MOUNT)
      : undefined,
    readOnlyWorkspaceRoot,
    skillRoots,
    workspaceBindArgs: workspaceBinds.args,
    workspaceRoot,
  });
  const commandArguments = [
    sandboxCommandPath(launch, "/usr/bin/bash", "/bin/bash"),
    "--noprofile",
    "--norc",
    "-euo",
    "pipefail",
    "-s",
  ];

  const processResult = await runSandboxed(
    config,
    launch,
    commandArguments,
    request.code,
    executionTimeoutMs(request.executionTimeoutMs, config.execTimeoutMs),
    workspaceRoot,
    signal,
    "Shell execution",
    maxWorkspaceBytes,
    maxOutputBytes,
    seccompVariantFor(networkAccess),
    onOutput,
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
    environmentRevisionId: runtime?.revision.id ?? (sandbox === "seatbelt"
      ? SYSTEM_SHELL_SEATBELT_ENVIRONMENT_REVISION_ID
      : SYSTEM_SHELL_ENVIRONMENT_REVISION_ID),
    environmentVariables: launch.env,
    executionId: request.executionId,
    finishedAt: new Date().toISOString(),
    kernelId: `ephemeral:${request.executionId}`,
    kernelMode: "ephemeral",
    language: "shell",
    modifiedFiles: shellModifiedFiles.toSorted(),
    networkAccessRevision: networkAccess.revision,
    networkPolicy: networkAccess.mode,
    runnerVersion: RUNNER_VERSION,
    sandbox,
    startedAt,
    workingDirectory: launch.chdir,
  };
}
