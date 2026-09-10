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

import { execFile } from "node:child_process";
import { createReadStream, rmSync } from "node:fs";
import { chmod, link, lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RunnerSkillPackages } from "./skill-packages.js";

import { createOperationalLogger, shortErrorMessage } from "@sciencediscovery/operational-logging";
import {
  detectSandboxCapability,
  detectSeatbeltCapability,
  disableUsernsOmittedMessage,
  procFallbackMessage,
  sandboxUnusableMessage,
  seatbeltUnusableMessage,
} from "@sciencediscovery/sandbox-capability";

import type {
  ApiError,
  CreateEnvironmentRequest,
  CreateNpuJobRequest,
  InstallEnvironmentRequest,
  PythonExecutionRequest,
  RunnerExecutionStatus,
  RunnerHealth,
  RunnerRuntimeStatus,
  RemoteWorkspaceFile,
  RemoteWorkspaceSnapshot,
  SandboxNetworkCapability,
  ScientificEnvsCapability,
  SetupScientificEnvironmentsRequest,
  ShellExecutionRequest,
  UninstallEnvironmentRequest,
} from "@sciencediscovery/schema";

import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_WORKSPACE_BYTES,
  executePython,
  executeShell,
  executorSandboxKind,
  MAX_RUNNER_FILE_BYTES,
  RESOURCE_LIMIT_MODE,
  RUNNER_VERSION,
  sandboxLaunchProfile,
  validatedWorkspace,
  type ExecutorConfig,
} from "./executor.js";
import { collectNpuInventory, NpuInventoryCache } from "./npu-devices.js";
import {
  EXECUTION_SIGNATURE_HEADER,
  EXECUTION_TIMESTAMP_HEADER,
  verifyExecutionSignature,
} from "./request-auth.js";
import { resolveEgressInterpreter } from "./egress-bridge.js";
import { EgressGatewayRegistry } from "./egress-gateway.js";
import { SECCOMP_BASELINE_VERSION } from "./seccomp.js";
import { EnvironmentStore } from "./environment-store.js";
import { collectRunnerResources } from "./resources.js";
import { KernelManager } from "./kernel-manager.js";
import { SessionEnvProfileStore } from "./session-env-profile.js";
import { ShellSessionManager } from "./shell-session-manager.js";
import { agentExecutionKey, KeyedTaskQueue, requestAgentExecutionKey } from "./agent-execution.js";
import { ExecutionManager } from "./execution-manager.js";
import { committedWorkspaceSnapshot, publishWorkspaceFile, RefStore, streamSnapshotFile, VersionStore, withWorkspaceMutation,
  workspaceSnapshotFiles, type AgentStateRef, type SnapshotFile } from "@sciencediscovery/cas";
import { HostNpuJobBroker } from "./npu-broker.js";

const execFileAsync = promisify(execFile);
const REQUIRED_BWRAP_OPTIONS = [
  "--cap-drop",
  "--die-with-parent",
  "--new-session",
  "--seccomp",
  "--unshare-all",
  "--unshare-user",
] as const;

export interface RunnerConfig extends ExecutorConfig {
  authToken: string;
  host: string;
  port: number;
  /**
   * When set, the runner listens on this Unix socket instead of a TCP port.
   * An SSH-deployed runner uses it so the remote host exposes no listening
   * port at all: the control plane forwards a loopback port onto the socket.
   */
  socketPath?: string;
  provisionerPath?: string;
  scientificAllowedChannels?: string[];
  scientificEnvsEnabled?: boolean;
  scientificKernelIdleMs?: number;
  scientificPackageCacheDir?: string;
  /** Idle TTL for persistent shell sessions; falls back to the kernel idle TTL. */
  shellSessionIdleMs?: number;
  npuBrokerEnabled: boolean;
  npuProtenixScriptPath?: string;
  npuPythonPath?: string;
  npuSmokeScriptPath?: string;
  npuWorkloadConfigPath?: string;
}

const MAX_BODY_BYTES = 2_000_000;
/**
 * A whole selected Skill set arrives in one body, so it gets its own budget
 * rather than the command limit — but still a budget: Skills are documents and
 * scripts, and 64 MiB of base64 is far past anything a Session should select.
 */
const MAX_SKILL_BUNDLE_BYTES = 67_108_864;
type RunnerInstallEnvironmentRequest = InstallEnvironmentRequest & { workspaceRoot?: string; runnerWorkspaceKey?: string };
interface NpuJobSessionRequest {
  sessionId?: string;
}
const moduleDirectory = resolve(fileURLToPath(import.meta.url), "..");
const repositoryRoot = resolve(moduleDirectory, "../../..");

const DISABLED_SCIENTIFIC_ENVS: ScientificEnvsCapability = {
  available: false,
  enabled: false,
  languages: [],
  provisioner: null,
  startersReady: false,
  unavailableReason: "Scientific environments are disabled by configuration",
};

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<string> {
  return (await readBytes(request, MAX_BODY_BYTES)).toString("utf8");
}

async function readBytes(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (maxBytes > 0 && total > maxBytes) throw new Error(`Request body exceeds the ${maxBytes} byte limit`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function requireEphemeralExecution(request: PythonExecutionRequest | ShellExecutionRequest): void {
  // A persistent worker can keep writing after its call returns and releases
  // the Workspace lease. Background lifetime belongs to managed Executions.
  if (request.kernelMode !== undefined && request.kernelMode !== "ephemeral") {
    throw new Error("Runner executions must be ephemeral; persistent runtimes are no longer supported. Use managed Shell Execution for background tasks");
  }
  request.kernelMode = "ephemeral";
}

function validateRunnerWorkspaceKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 500 || key.includes("\\") || isAbsolute(key)) {
    throw new Error("Invalid remote workspace key");
  }
  const parts = key.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error("Invalid remote workspace key");
  }
  return parts.join("/");
}

async function remoteWorkspaceRoot(dataDir: string, keyValue: string): Promise<string> {
  const key = validateRunnerWorkspaceKey(keyValue);
  const base = resolve(dataDir, "remote-workspaces");
  const root = resolve(base, key);
  if (!root.startsWith(`${base}${sep}`)) throw new Error("Remote workspace escapes the runner data directory");
  // Validate each existing component before creating descendants, so a link in
  // a persisted workspace key cannot redirect writes outside this Runner.
  let current = dataDir;
  for (const part of ["remote-workspaces", ...key.split("/")]) {
    current = resolve(current, part);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const details = await lstat(current);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Remote workspace path must not contain symbolic links");
  }
  return root;
}

function validateRelativeWorkspacePath(value: string): string {
  const path = value.trim();
  if (!path || path.length > 2_000 || path.includes("\\") || isAbsolute(path)) {
    throw new Error("Workspace path must be a non-empty relative POSIX path");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Workspace path contains an invalid segment");
  }
  return parts.join("/");
}

async function readableWorkspaceFile(root: string, pathValue: string): Promise<string> {
  const path = validateRelativeWorkspacePath(pathValue);
  const candidate = resolve(root, path);
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(candidate);
  if (!canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error("Workspace path escapes through a symbolic link");
  if (!(await stat(canonical)).isFile()) throw new Error("Workspace path is not a regular file");
  return canonical;
}

async function writableWorkspaceFile(root: string, pathValue: string): Promise<string> {
  const path = validateRelativeWorkspacePath(pathValue);
  const candidate = resolve(root, path);
  let parent = root;
  for (const segment of path.split("/").slice(0, -1)) {
    const next = resolve(parent, segment);
    try {
      const details = await lstat(next);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error("Workspace parent must be a real directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(next);
    }
    parent = next;
  }
  try {
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error("Workspace target is a symbolic link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return candidate;
}

async function listRemoteWorkspaceFiles(root: string, selectedPaths?: string[]): Promise<RemoteWorkspaceFile[]> {
  const files = new Map<string, RemoteWorkspaceFile>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const details = await stat(absolute);
        const path = relative(root, absolute).split(sep).join("/");
        files.set(path, {
          modifiedAt: details.mtime.toISOString(),
          path,
          size: details.size,
        });
      }
    }
  };
  if (!selectedPaths?.length) await visit(root);
  else {
    const canonicalRoot = await realpath(root);
    for (const pathValue of selectedPaths) {
      const path = validateRelativeWorkspacePath(pathValue);
      const candidate = resolve(root, path);
      let details;
      try { details = await lstat(candidate); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (details.isSymbolicLink()) continue;
      const canonical = await realpath(candidate);
      if (!canonical.startsWith(`${canonicalRoot}${sep}`)) {
        throw new Error("Workspace path escapes through a symbolic link");
      }
      if (details.isDirectory()) await visit(canonical);
      else if (details.isFile()) {
        files.set(path, { modifiedAt: details.mtime.toISOString(), path, size: details.size });
      }
    }
  }
  return [...files.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

async function resolveExecutionWorkspace(
  config: RunnerConfig,
  execution: PythonExecutionRequest | ShellExecutionRequest,
): Promise<void> {
  if (execution.runnerWorkspaceKey) {
    execution.workspaceRoot = await remoteWorkspaceRoot(config.dataDir, execution.runnerWorkspaceKey);
    delete execution.readOnlyWorkspaceRoot;
  }
  execution.workspaceRoot = await validatedWorkspace(config.dataDir, execution.workspaceRoot);
}

function currentExecutionUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER?.trim() || "unknown";
  }
}

function requireNpuSessionId(url: URL): string {
  const sessionId = url.searchParams.get("session_id")?.trim() || url.searchParams.get("sessionId")?.trim() || "";
  if (!sessionId) throw new Error("session_id is required for NPU job access");
  return sessionId;
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env, cwd = repositoryRoot): RunnerConfig {
  const port = Number(env.SCIENCE_AGENT_RUNNER_PORT?.trim() || "4311");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("SCIENCE_AGENT_RUNNER_PORT must be an integer between 0 and 65535");
  }
  const scientificKernelIdleMs = Number(env.SCIENCE_AGENT_KERNEL_IDLE_MS?.trim() || 0);
  if (!Number.isSafeInteger(scientificKernelIdleMs) || scientificKernelIdleMs < 0) {
    throw new Error("SCIENCE_AGENT_KERNEL_IDLE_MS must be a non-negative integer");
  }
  const shellSessionIdleMs = Number(env.SCIENCE_AGENT_SHELL_IDLE_MS?.trim() || scientificKernelIdleMs);
  if (!Number.isSafeInteger(shellSessionIdleMs) || shellSessionIdleMs < 0) {
    throw new Error("SCIENCE_AGENT_SHELL_IDLE_MS must be a non-negative integer");
  }
  const execTimeoutMs = Number(env.SCIENCE_AGENT_EXEC_TIMEOUT_MS?.trim() || DEFAULT_EXECUTION_TIMEOUT_MS);
  if (!Number.isSafeInteger(execTimeoutMs) || execTimeoutMs < 0) {
    throw new Error("SCIENCE_AGENT_EXEC_TIMEOUT_MS must be a non-negative integer");
  }
  const parseByteQuota = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer number of bytes`);
    }
    return value;
  };
  const requestedProvider = env.SCIENCE_AGENT_SANDBOX_PROVIDER?.trim() || "auto";
  if (!["auto", "bubblewrap", "seatbelt"].includes(requestedProvider)) {
    throw new Error("SCIENCE_AGENT_SANDBOX_PROVIDER must be auto, bubblewrap, or seatbelt");
  }
  const sandboxProvider = requestedProvider === "auto"
    ? (process.platform === "darwin" ? "seatbelt" : "bubblewrap")
    : requestedProvider as "bubblewrap" | "seatbelt";
  return {
    authToken: env.SCIENCE_AGENT_RUNNER_TOKEN?.trim() || "sciencediscovery-runner-local",
    bwrapPath: env.SCIENCE_AGENT_BWRAP_PATH?.trim() || "bwrap",
    sandboxProvider,
    seatbeltPath: env.SCIENCE_AGENT_SEATBELT_PATH?.trim() || "/usr/bin/sandbox-exec",
    dataDir: resolve(cwd, env.SCIENCE_AGENT_DATA_DIR?.trim() || ".sciencediscovery-data"),
    execTimeoutMs,
    maxOutputBytes: parseByteQuota("SCIENCE_AGENT_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES),
    maxWorkspaceBytes: parseByteQuota("SCIENCE_AGENT_MAX_WORKSPACE_BYTES", DEFAULT_MAX_WORKSPACE_BYTES),
    host: env.SCIENCE_AGENT_RUNNER_HOST?.trim() || "127.0.0.1",
    ...(env.SCIENCE_AGENT_RUNNER_SOCKET?.trim() ? { socketPath: resolve(cwd, env.SCIENCE_AGENT_RUNNER_SOCKET.trim()) } : {}),
    npuBrokerEnabled: /^(?:1|true|yes)$/i.test(env.SCIENCE_AGENT_NPU_BROKER?.trim() || "0"),
    npuProtenixScriptPath: env.SCIENCE_AGENT_NPU_PROTENIX_SCRIPT?.trim() || undefined,
    npuPythonPath: env.SCIENCE_AGENT_NPU_PYTHON?.trim() || undefined,
    npuSmokeScriptPath: env.SCIENCE_AGENT_NPU_SMOKE_SCRIPT?.trim() || undefined,
    npuWorkloadConfigPath: env.SCIENCE_AGENT_NPU_WORKLOAD_CONFIG?.trim()
      ? resolve(cwd, env.SCIENCE_AGENT_NPU_WORKLOAD_CONFIG.trim())
      : undefined,
    pythonPath: env.SCIENCE_AGENT_PYTHON_PATH?.trim() || undefined,
    port,
    provisionerPath: env.SCIENCE_AGENT_PROVISIONER_PATH?.trim()
      ? resolve(cwd, env.SCIENCE_AGENT_PROVISIONER_PATH.trim())
      : undefined,
    scientificAllowedChannels: (env.SCIENCE_AGENT_SCIENTIFIC_CHANNELS?.trim() || "conda-forge")
      .split(",").map((channel) => channel.trim()).filter(Boolean),
    scientificEnvsEnabled: /^(?:1|true|yes)$/i.test(env.SCIENTIFIC_ENVS?.trim() || "1"),
    scientificKernelIdleMs,
    scientificPackageCacheDir: env.SCIENCE_AGENT_PACKAGE_CACHE_DIR?.trim()
      ? resolve(cwd, env.SCIENCE_AGENT_PACKAGE_CACHE_DIR.trim())
      : undefined,
    shellSessionIdleMs,
  };
}

export function createRunnerServer(
  config: RunnerConfig,
  environmentStore?: EnvironmentStore,
  kernelManager?: KernelManager,
  shellSessionManager?: ShellSessionManager,
  envProfiles?: SessionEnvProfileStore,
  npuBroker = new HostNpuJobBroker({
    dataDir: config.dataDir,
    enabled: config.npuBrokerEnabled,
    maxOutputBytes: config.maxOutputBytes,
    protenixScriptPath: config.npuProtenixScriptPath,
    pythonPath: config.npuPythonPath,
    resolveEnvironmentPython: environmentStore
      ? (revisionId) => environmentStore.resolveRuntime(revisionId, "python").interpreterPath
      : undefined,
    resolveEnvironmentPythonPath: environmentStore
      ? (revisionId) => {
          const runtime = environmentStore.resolveRuntime(revisionId, "python");
          const version = runtime.revision.languageVersion.match(/^(\d+)\.(\d+)/u);
          if (!version) throw new Error(`Invalid managed Python version: ${runtime.revision.languageVersion}`);
          return resolve(runtime.prefixPath, "lib", `python${version[1]}.${version[2]}`, "site-packages");
        }
      : undefined,
    smokeScriptPath: config.npuSmokeScriptPath,
    workloadConfigPath: config.npuWorkloadConfigPath,
  }),
  egressGateways?: EgressGatewayRegistry,
): Server {
  const skillPackages = new RunnerSkillPackages(config.dataDir);
  const logger = createOperationalLogger({ category: "runner", dataDir: config.dataDir, service: "runner" });
  const profiles = envProfiles ?? new SessionEnvProfileStore();
  const gateways = egressGateways ?? new EgressGatewayRegistry(config.dataDir, (event, detail) => {
    logger[event === "allowed" ? "info" : "warn"]("sandbox_network_request", { event, ...detail });
  });
  const shellSessions = shellSessionManager ?? new ShellSessionManager({
    bwrapPath: config.bwrapPath,
    sandboxProvider: config.sandboxProvider,
    seatbeltPath: config.seatbeltPath,
    dataDir: config.dataDir,
    execTimeoutMs: config.execTimeoutMs,
    idleTimeoutMs: config.shellSessionIdleMs ?? config.scientificKernelIdleMs,
    maxOutputBytes: config.maxOutputBytes,
    maxWorkspaceBytes: config.maxWorkspaceBytes,
  }, profiles, gateways);
  // Probing NPUs costs one throwaway sandbox per card, so the inventory is
  // cached: a status poll must not re-probe the whole machine every few seconds.
  const npuInventory = new NpuInventoryCache();
  const readNpuInventory = async () => await npuInventory.get(async () => await collectNpuInventory({
    bwrapPath: config.bwrapPath,
    ...await sandboxLaunchProfile(config.bwrapPath),
  }));
  // Executions share the cached inventory so an NPU run re-validates its
  // cards without re-probing the whole machine.
  const executorConfig: RunnerConfig = { ...config, npuInventory: readNpuInventory };
  const executionQueues = new KeyedTaskQueue();
  const managedExecutions = new ExecutionManager(config.dataDir);
  const workspaceVersions = new VersionStore(config.dataDir);
  const seenExecutions = new Map<string, number>();
  const activeExecutions = new Map<string, RunnerExecutionStatus>();
  const executionUser = currentExecutionUser();
  const executeQueued = async <T>(
    execution: PythonExecutionRequest | ShellExecutionRequest,
    language: RunnerExecutionStatus["language"],
    kernelMode: RunnerExecutionStatus["kernelMode"],
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const status: RunnerExecutionStatus = {
      agentId: execution.agentId,
      executionId: execution.executionId,
      kernelMode,
      language,
      queuedAt: new Date().toISOString(),
      sessionId: execution.permissionEpoch.sessionId,
      status: "queued",
    };
    activeExecutions.set(status.executionId, status);
    const removeCancelledQueueEntry = () => {
      if (status.status === "queued") activeExecutions.delete(status.executionId);
    };
    signal.addEventListener("abort", removeCancelledQueueEntry, { once: true });
    try {
      let workspaceSnapshot: AgentStateRef | undefined;
      const result = await executionQueues.run(requestAgentExecutionKey(execution), () => withWorkspaceMutation(workspaceVersions, execution.workspaceRoot, async () => {
        if (signal.aborted) throw new Error("Runner execution aborted before start");
        status.startedAt = new Date().toISOString();
        status.status = "running";
        if (language !== "shell" && environmentStore?.capability.available) {
          const request = execution as PythonExecutionRequest;
          const environmentId = request.environmentRevisionId
            ? environmentStore.getRevision(request.environmentRevisionId)?.environmentId
            : `starter-${request.language ?? "python"}`;
          if (!environmentId) throw new Error("Unknown environment revision; select a current environment");
          return await environmentStore.withRuntime(environmentId, async (runtime) => {
            if (signal.aborted) throw new Error("Runner execution aborted before start");
            if (request.environmentRevisionId && runtime.revision.id !== request.environmentRevisionId) {
              throw new Error("Historical environment revisions are audit-only; select the latest environment");
            }
            return operation();
          });
        }
        return await operation();
      }, { kind: "legacy-execution", id: execution.executionId, onCommitted: (tree) => { workspaceSnapshot = tree; } }, signal), execution.permissionEpoch.sessionId);
      if (result && typeof result === "object") Object.assign(result, { workspaceSnapshot });
      return result;
    } catch (error) {
      const errorMessage = shortErrorMessage(error);
      const interrupted = signal.aborted;
      const timedOut = /timed out/i.test(errorMessage);
      logger[interrupted || timedOut ? "warn" : "error"]("execution_failed", {
        errorMessage,
        executionId: execution.executionId,
        reason: interrupted ? "client_disconnect" : timedOut ? "timeout" : "execution_error",
        sessionId: execution.permissionEpoch.sessionId,
      });
      throw error;
    } finally {
      signal.removeEventListener("abort", removeCancelledQueueEntry);
      activeExecutions.delete(status.executionId);
    }
  };
  const abortOnDisconnect = async <T>(
    response: ServerResponse,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const abort = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", abort);
    try {
      return await operation(controller.signal);
    } finally {
      response.removeListener("close", abort);
    }
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://runner.local");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          cgroupDelegated: false,
          cgroupMode: RESOURCE_LIMIT_MODE,
          cgroupRoot: "",
          executionAuth: "bearer+hmac-sha256",
          executionUser,
          executionTimeoutMs: config.execTimeoutMs,
          maxFileBytes: MAX_RUNNER_FILE_BYTES,
          maxOutputBytes: config.maxOutputBytes,
          maxWorkspaceBytes: config.maxWorkspaceBytes,
          networkPolicy: "none",
          noNewPrivileges: executorSandboxKind(config) === "bubblewrap",
          npuBroker: npuBroker.capability(),
          platform: process.platform,
          runnerVersion: RUNNER_VERSION,
          sandbox: executorSandboxKind(config),
          sandboxNetwork: await sandboxNetworkCapability(executorSandboxKind(config)),
          scientificEnvs: environmentStore?.capability ?? DISABLED_SCIENTIFIC_ENVS,
          seccompBaseline: executorSandboxKind(config) === "bubblewrap" ? SECCOMP_BASELINE_VERSION : null,
          status: "ok",
          workerConcurrency: null,
        } satisfies RunnerHealth);
        return;
      }
      if (!authorized(request, config.authToken)) {
        sendJson(response, 401, { error: "Unauthorized" } satisfies ApiError);
        return;
      }
      if (request.method === "GET" && url.pathname === "/resources") {
        sendJson(response, 200, await collectRunnerResources(config.dataDir, {
          npuInventory: readNpuInventory,
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/npu/devices") {
        // Same inventory the status surface shows, exposed on its own so the
        // selection UI can force a refresh without waiting for a status poll.
        if (url.searchParams.get("refresh") === "1") npuInventory.invalidate();
        sendJson(response, 200, await readNpuInventory());
        return;
      }
      const skillMatch = /^\/skill-packages\/([a-f0-9]{64})$/.exec(url.pathname);
      if (request.method === "GET" && skillMatch) {
        sendJson(response, 200, await skillPackages.get(skillMatch[1]!));
        return;
      }
      if (request.method === "POST" && url.pathname === "/skill-packages") {
        const bundle = JSON.parse((await readBytes(request, MAX_SKILL_BUNDLE_BYTES)).toString("utf8"));
        sendJson(response, 200, await abortOnDisconnect(response, (signal) => skillPackages.put(bundle, signal)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/status") {
        sendJson(response, 200, {
          activeExecutions: [...activeExecutions.values()].map((execution) => ({ ...execution })),
          capturedAt: new Date().toISOString(),
          kernels: [...(kernelManager?.list() ?? []), ...shellSessions.list()],
          npuJobs: npuBroker.listJobSummaries()
            .filter((job) => job.state === "queued" || job.state === "running"),
          runnerVersion: RUNNER_VERSION,
          status: "ok",
        } satisfies RunnerRuntimeStatus);
        return;
      }
      if (request.method === "POST" && url.pathname === "/remote-workspace/snapshots") {
        const input = JSON.parse(await readBody(request)) as { workspace: string; paths?: string[] };
        const workspace = validateRunnerWorkspaceKey(input.workspace);
        if (input.paths && (!Array.isArray(input.paths) || input.paths.length > 50)) throw new Error("Snapshot accepts at most 50 paths");
        const root = await remoteWorkspaceRoot(config.dataDir, workspace);
        const tree = await committedWorkspaceSnapshot(workspaceVersions, root);
        const files = await workspaceSnapshotFiles(workspaceVersions, tree, input.paths);
        const id = randomUUID();
        const capturedAt = new Date().toISOString();
        const record = await workspaceVersions.putRecord("WorkspaceExport", { workspace, tree, files, capturedAt });
        const refs = await RefStore.open(workspaceVersions);
        try { await refs.commit(workspaceVersions, `workspace-exports/${id}`, null, record); } finally { refs.close(); }
        sendJson(response, 201, { id, workspace, capturedAt,
          files: files.map((file) => ({ path: file.path, size: file.content.size, sha256: file.content.digest.slice(7), executable: file.executable })),
        } satisfies RemoteWorkspaceSnapshot);
        return;
      }
      const snapshotFileMatch = url.pathname.match(/^\/remote-workspace\/snapshots\/([a-f0-9-]{36})\/file$/);
      if (request.method === "GET" && snapshotFileMatch) {
        const workspace = validateRunnerWorkspaceKey(url.searchParams.get("workspace") ?? "");
        const refs = await RefStore.open(workspaceVersions);
        let exported: AgentStateRef | null;
        try { exported = refs.head(`workspace-exports/${snapshotFileMatch[1]}`); } finally { refs.close(); }
        if (!exported) throw new Error("Workspace snapshot not found");
        const record = await workspaceVersions.readRecord<{ workspace: string; files: SnapshotFile[] }>(exported, "WorkspaceExport");
        if (record.value.workspace !== workspace) throw new Error("Workspace snapshot belongs to another Workspace");
        const path = validateRelativeWorkspacePath(url.searchParams.get("path") ?? "");
        const file = record.value.files.find((entry) => entry.path === path);
        if (!file) throw new Error("File was not selected in this Workspace snapshot");
        response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
        await pipeline(streamSnapshotFile(workspaceVersions, file.content), response);
        return;
      }
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/remote-workspace/files") {
        const input = request.method === "POST"
          ? JSON.parse(await readBody(request)) as { paths?: string[]; workspace?: string }
          : undefined;
        const root = await remoteWorkspaceRoot(
          config.dataDir,
          input?.workspace ?? url.searchParams.get("workspace") ?? "",
        );
        if (input?.paths && (!Array.isArray(input.paths) || input.paths.length > 50)) {
          throw new Error("Remote workspace paths must contain at most 50 entries");
        }
        sendJson(response, 200, await listRemoteWorkspaceFiles(root, input?.paths));
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/remote-workspace") {
        const root = await remoteWorkspaceRoot(config.dataDir, url.searchParams.get("workspace") ?? "");
        await withWorkspaceMutation(workspaceVersions, root, async () => {
          // Keep the identity/root stable while clearing files and committing its empty version.
          for (const name of await readdir(root)) await rm(resolve(root, name), { force: true, recursive: true });
        }, { kind: "workspace-clear" });
        sendJson(response, 200, { deleted: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/remote-workspace/file") {
        const root = await remoteWorkspaceRoot(config.dataDir, url.searchParams.get("workspace") ?? "");
        const file = await readableWorkspaceFile(root, url.searchParams.get("path") ?? "");
        const details = await stat(file);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": details.size,
          "content-type": "application/octet-stream",
          "x-content-type-options": "nosniff",
        });
        createReadStream(file).pipe(response);
        return;
      }
      if (request.method === "PUT" && url.pathname === "/remote-workspace/transfer-file") {
        const root = await remoteWorkspaceRoot(config.dataDir, url.searchParams.get("workspace") ?? "");
        const path = validateRelativeWorkspacePath(url.searchParams.get("path") ?? "");
        const conflict = url.searchParams.get("conflict") ?? "reject";
        const size = Number(request.headers["x-workspace-size"]);
        const sha256 = request.headers["x-workspace-sha256"];
        const executable = Number(request.headers["x-workspace-executable"] ?? 0);
        if (!Number.isSafeInteger(size) || size < 0 || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
          || !Number.isInteger(executable) || executable < 0 || (executable & ~0o111) !== 0
          || !["reject", "overwrite"].includes(conflict)) throw new Error("Invalid verified upload metadata");
        const result = await abortOnDisconnect(response, (signal) => withWorkspaceMutation(workspaceVersions, root, async () => {
          if (config.maxWorkspaceBytes > 0) {
            const files = await listRemoteWorkspaceFiles(root);
            const existing = files.find((file) => file.path === path)?.size ?? 0;
            if (files.reduce((total, file) => total + file.size, 0) - existing + size > config.maxWorkspaceBytes) throw new Error("Remote workspace exceeds its execution quota");
          }
          // Publish under the outer mutation; CAS/refs commit before the HTTP success receipt.
          return publishWorkspaceFile({ root, path, chunks: request, signal, expectedBytes: size, expectedHash: sha256,
            maxBytes: size || 1, executable, conflict: conflict as "reject" | "overwrite" });
        }, { kind: "workspace-transfer" }, signal));
        sendJson(response, 201, { path, size: result.bytes, sha256: result.sha256 });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/remote-workspace/file") {
        const root = await remoteWorkspaceRoot(config.dataDir, url.searchParams.get("workspace") ?? "");
        const conflict = url.searchParams.get("conflict") ?? "reject";
        if (conflict !== "reject" && conflict !== "overwrite") throw new Error("Invalid workspace conflict policy");
        const bytes = await readBytes(request, config.maxWorkspaceBytes);
        const result = await withWorkspaceMutation(workspaceVersions, root, async () => {
          const file = await writableWorkspaceFile(root, url.searchParams.get("path") ?? "");
          if (conflict === "reject") {
            try {
              await lstat(file);
              return { conflict: true as const };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          if (config.maxWorkspaceBytes > 0) {
            const currentBytes = (await listRemoteWorkspaceFiles(root)).reduce((total, entry) => total + entry.size, 0);
            let replacedBytes = 0;
            try { replacedBytes = (await stat(file)).size; } catch { /* New file. */ }
            if (currentBytes - replacedBytes + bytes.length > config.maxWorkspaceBytes) {
              throw new Error("Remote workspace exceeds its execution quota");
            }
          }
          const temporary = `${file}.sync-${process.pid}-${Date.now()}`;
          try {
            await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
            if (conflict === "overwrite") await rename(temporary, file);
            else {
              try { await link(temporary, file); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") return { conflict: true as const };
                throw error;
              }
            }
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
          return { path: relative(root, file).split(sep).join("/"), size: bytes.length };
        }, { kind: "workspace-upload" });
        if ("conflict" in result) sendJson(response, 409, { error: "Remote workspace file already exists" } satisfies ApiError);
        else sendJson(response, 201, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/npu/workloads") {
        sendJson(response, 200, npuBroker.listWorkloads());
        return;
      }
      if (request.method === "GET" && url.pathname === "/npu/jobs") {
        sendJson(response, 200, npuBroker.listJobSummaries(requireNpuSessionId(url)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/npu/jobs") {
        const body = await readBody(request);
        const timestamp = request.headers[EXECUTION_TIMESTAMP_HEADER] as string | undefined;
        const signature = request.headers[EXECUTION_SIGNATURE_HEADER] as string | undefined;
        if (!verifyExecutionSignature(config.authToken, timestamp, body, signature)) {
          sendJson(response, 401, { error: "Invalid or expired NPU job signature" } satisfies ApiError);
          return;
        }
        sendJson(response, 201, await npuBroker.submit(JSON.parse(body) as CreateNpuJobRequest));
        return;
      }
      const npuJobMatch = url.pathname.match(/^\/npu\/jobs\/([^/]+)(?:\/(logs|result|cancel))?$/);
      if (npuJobMatch) {
        const jobId = decodeURIComponent(npuJobMatch[1]!);
        const action = npuJobMatch[2];
        if (request.method === "GET" && !action) {
          const job = npuBroker.getJob(jobId, requireNpuSessionId(url));
          if (!job) {
            sendJson(response, 404, { error: "NPU job not found" } satisfies ApiError);
            return;
          }
          sendJson(response, 200, job);
          return;
        }
        if (request.method === "GET" && action === "logs") {
          sendJson(response, 200, npuBroker.logs(jobId, requireNpuSessionId(url)));
          return;
        }
        if (request.method === "GET" && action === "result") {
          const sessionId = requireNpuSessionId(url);
          const job = npuBroker.getJob(jobId, sessionId);
          if (!job) {
            sendJson(response, 404, { error: "NPU job not found" } satisfies ApiError);
            return;
          }
          if (job.state === "queued" || job.state === "running") {
            sendJson(response, 409, { error: "NPU job is not terminal" } satisfies ApiError);
            return;
          }
          sendJson(response, 200, { job: npuBroker.result(jobId, sessionId) });
          return;
        }
        if (request.method === "POST" && action === "cancel") {
          const body = await readBody(request);
          const timestamp = request.headers[EXECUTION_TIMESTAMP_HEADER] as string | undefined;
          const signature = request.headers[EXECUTION_SIGNATURE_HEADER] as string | undefined;
          if (!verifyExecutionSignature(config.authToken, timestamp, body, signature)) {
            sendJson(response, 401, { error: "Invalid or expired NPU job cancel signature" } satisfies ApiError);
            return;
          }
          const input = body.trim() ? JSON.parse(body) as NpuJobSessionRequest : {};
          if (!input.sessionId?.trim()) throw new Error("sessionId is required for NPU job cancel");
          sendJson(response, 200, await npuBroker.cancel(jobId, input.sessionId));
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/environments") {
        if (!environmentStore) throw new Error("Scientific environments are unavailable");
        sendJson(response, 200, environmentStore.list());
        return;
      }
      if (request.method === "GET" && url.pathname === "/environment-setup") {
        if (!environmentStore) throw new Error("Scientific environments are unavailable");
        sendJson(response, 200, environmentStore.setup);
        return;
      }
      if (request.method === "POST" && url.pathname === "/environment-setup") {
        if (!environmentStore) throw new Error("Scientific environments are unavailable");
        const input = JSON.parse(await readBody(request)) as SetupScientificEnvironmentsRequest;
        if (input.confirmed !== true) throw new Error("Scientific environment setup requires explicit confirmation");
        sendJson(response, 202, environmentStore.startManagedEnvironmentSetup());
        return;
      }
      if (request.method === "GET" && url.pathname === "/environment-revisions") {
        if (!environmentStore) throw new Error("Scientific environments are unavailable");
        sendJson(response, 200, environmentStore.listRevisions());
        return;
      }
      if (request.method === "GET" && url.pathname === "/kernels") {
        sendJson(response, 200, [...(kernelManager?.list() ?? []), ...shellSessions.list()]);
        return;
      }
      if (request.method === "POST" && url.pathname === "/kernels/teardown") {
        const input = JSON.parse(await readBody(request)) as { reason?: string; sessionId?: string };
        if (!input.sessionId?.trim()) throw new Error("sessionId is required");
        const reason = input.reason?.trim() || "Persistent kernel memory was cleared";
        const count = await executionQueues.runGroupExclusive(input.sessionId, async () => (
          (kernelManager ? await kernelManager.teardownSession(input.sessionId!, reason) : 0)
          + await shellSessions.teardownSession(input.sessionId!, reason)
        ));
        sendJson(response, 200, { count, reason });
        return;
      }
      const kernelTeardownMatch = url.pathname.match(/^\/kernels\/([^/]+)\/teardown$/);
      if (kernelTeardownMatch && request.method === "POST") {
        const input = JSON.parse(await readBody(request)) as { reason?: string };
        const kernelId = decodeURIComponent(kernelTeardownMatch[1]!);
        const reason = input.reason?.trim() || "Persistent kernel memory was cleared";
        const target = [...(kernelManager?.list() ?? []), ...shellSessions.list()]
          .find((kernel) => kernel.id === kernelId);
        const teardown = async () => (
          (kernelManager ? await kernelManager.teardownKernel(kernelId, reason) : 0)
          || await shellSessions.teardownKernel(kernelId, reason)
        );
        const count = target
          ? await executionQueues.run(
            agentExecutionKey(target.sessionId, target.agentId),
            teardown,
            target.sessionId,
          )
          : await teardown();
        sendJson(response, 200, { count, kernelId, reason });
        return;
      }
      const snapshotMatch = url.pathname.match(/^\/environment-revisions\/([^/]+)\/snapshot$/);
      if (snapshotMatch && request.method === "GET") {
        if (!environmentStore) throw new Error("Scientific environments are unavailable");
        const bytes = await environmentStore.snapshotBytes(decodeURIComponent(snapshotMatch[1]!));
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": bytes.length,
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(bytes);
        return;
      }
      if (request.method === "POST" && url.pathname === "/environments") {
        if (!environmentStore) throw new Error("Scientific environments are unavailable");
        const input = JSON.parse(await readBody(request)) as CreateEnvironmentRequest;
        sendJson(response, 201, await environmentStore.createTask(input.name, input.language, input.baseEnvironmentId));
        return;
      }
      const environmentMatch = url.pathname.match(/^\/environments\/([^/]+)$/);
      if (environmentMatch && request.method === "DELETE") {
        if (!environmentStore) throw new Error("Scientific environments are unavailable");
        const id = decodeURIComponent(environmentMatch[1]!);
        const revisionIds = environmentStore.listRevisions()
          .filter((revision) => revision.environmentId === id)
          .map((revision) => revision.id);
        if (kernelManager) {
          for (const revisionId of revisionIds) {
            await kernelManager.teardownRevision(revisionId, "Environment was deleted; persistent memory was lost");
          }
        }
        await environmentStore.deleteTask(id);
        sendJson(response, 200, { deleted: id });
        return;
      }
      const installMatch = url.pathname.match(/^\/environments\/([^/]+)\/install$/);
      if (installMatch && request.method === "POST") {
        if (!environmentStore) throw new Error("Scientific environments are unavailable");
        const input = JSON.parse(await readBody(request)) as RunnerInstallEnvironmentRequest;
        const environmentId = decodeURIComponent(installMatch[1]!);
        const workspaceRoot = input.runnerWorkspaceKey
          ? await validatedWorkspace(config.dataDir, await remoteWorkspaceRoot(config.dataDir, input.runnerWorkspaceKey))
          : input.workspaceRoot ? await validatedWorkspace(config.dataDir, input.workspaceRoot) : undefined;
        const previousRevisionId = environmentStore.list().find((environment) => environment.id === environmentId)?.currentRevisionId;
        const revision = await environmentStore.install(
          environmentId,
          input.packages,
          input.channels,
          input.manager,
          workspaceRoot,
          input.indexUrl,
        );
        if (kernelManager && previousRevisionId) {
          await kernelManager.teardownRevision(previousRevisionId, "Environment Revision changed; persistent memory was lost");
        }
        sendJson(response, 201, revision);
        return;
      }
      const uninstallMatch = url.pathname.match(/^\/environments\/([^/]+)\/uninstall$/);
      if (uninstallMatch && request.method === "POST") {
        if (!environmentStore) throw new Error("Scientific environments are unavailable");
        const input = JSON.parse(await readBody(request)) as UninstallEnvironmentRequest;
        const environmentId = decodeURIComponent(uninstallMatch[1]!);
        const previousRevisionId = environmentStore.list().find((environment) => environment.id === environmentId)?.currentRevisionId;
        const revision = await environmentStore.uninstall(environmentId, input.packages);
        if (kernelManager && previousRevisionId) {
          await kernelManager.teardownRevision(previousRevisionId, "Environment Revision changed; persistent memory was lost");
        }
        sendJson(response, 201, revision);
        return;
      }
      const managedMatch = url.pathname.match(/^\/shell-executions\/([^/]+)(?:\/(logs|cancel))?$/);
      if (managedMatch) {
        const id = decodeURIComponent(managedMatch[1]!);
        const owner = { sessionId: url.searchParams.get("sessionId") ?? "", agentId: url.searchParams.get("agentId") ?? "" };
        if (request.method === "GET" && managedMatch[2] === "logs") {
          sendJson(response, 200, managedExecutions.logs(id, owner, Number(url.searchParams.get("cursor") ?? "0")));
          return;
        }
        if (request.method === "GET" && !managedMatch[2]) {
          sendJson(response, 200, managedExecutions.get(id, owner));
          return;
        }
        if (request.method === "POST" && managedMatch[2] === "cancel") {
          sendJson(response, 202, managedExecutions.cancel(id, owner));
          return;
        }
      }
      if (request.method === "POST" && url.pathname === "/shell-executions") {
        const body = await readBody(request);
        if (!verifyExecutionSignature(config.authToken, request.headers[EXECUTION_TIMESTAMP_HEADER] as string | undefined,
          body, request.headers[EXECUTION_SIGNATURE_HEADER] as string | undefined)) {
          sendJson(response, 401, { error: "Invalid or expired execution signature" });
          return;
        }
        const execution = JSON.parse(body) as ShellExecutionRequest;
        requireEphemeralExecution(execution);
        await resolveExecutionWorkspace(config, execution);
        execution.executionTimeoutMs = 0; // waiting deadlines are a client concern, not process lifetime
        execution.maxOutputBytes ??= config.maxOutputBytes;
        const accepted = managedExecutions.start(execution, (signal, log) => execution.environmentId
          ? environmentStore?.withRuntime(execution.environmentId, (runtime) => {
              if (signal.aborted) throw new Error("Execution cancelled before environment admission");
              return executeShell(executorConfig, execution, signal, undefined, gateways, runtime, log);
            }) ?? Promise.reject(new Error("Scientific environments are unavailable"))
          : executeShell(executorConfig, execution, signal, undefined, gateways, undefined, log));
        sendJson(response, 202, accepted);
        return;
      }
      if (request.method === "POST" && url.pathname === "/execute-shell") {
        const body = await readBody(request);
        const timestamp = request.headers[EXECUTION_TIMESTAMP_HEADER] as string | undefined;
        const signature = request.headers[EXECUTION_SIGNATURE_HEADER] as string | undefined;
        if (!verifyExecutionSignature(config.authToken, timestamp, body, signature)) {
          sendJson(response, 401, { error: "Invalid or expired execution signature" } satisfies ApiError);
          return;
        }
        const execution = JSON.parse(body) as ShellExecutionRequest;
        requireEphemeralExecution(execution);
        await resolveExecutionWorkspace(config, execution);
        const now = Date.now();
        for (const [id, seenAt] of seenExecutions) {
          if (now - seenAt > 60_000) seenExecutions.delete(id);
        }
        if (seenExecutions.has(execution.executionId)) {
          sendJson(response, 409, { error: "Execution ID has already been used" } satisfies ApiError);
          return;
        }
        seenExecutions.set(execution.executionId, now);
        sendJson(response, 200, await abortOnDisconnect(response, (signal) => executeQueued(
          execution,
          "shell",
          execution.kernelMode ?? "ephemeral",
          signal,
          () => execution.environmentId
            ? environmentStore?.withRuntime(execution.environmentId, (runtime) => {
                if (signal.aborted) throw new Error("Runner execution aborted before start");
                return executeShell(executorConfig, execution, signal, undefined, gateways, runtime);
              }) ?? Promise.reject(new Error("Scientific environments are unavailable"))
            : executeShell(executorConfig, execution, signal, undefined, gateways),
        )));
        return;
      }
      if (request.method === "POST" && url.pathname === "/execute") {
        const body = await readBody(request);
        const timestamp = request.headers[EXECUTION_TIMESTAMP_HEADER] as string | undefined;
        const signature = request.headers[EXECUTION_SIGNATURE_HEADER] as string | undefined;
        if (!verifyExecutionSignature(config.authToken, timestamp, body, signature)) {
          sendJson(response, 401, { error: "Invalid or expired execution signature" } satisfies ApiError);
          return;
        }
        const execution = JSON.parse(body) as PythonExecutionRequest;
        requireEphemeralExecution(execution);
        await resolveExecutionWorkspace(config, execution);
        const now = Date.now();
        for (const [id, seenAt] of seenExecutions) {
          if (now - seenAt > 60_000) seenExecutions.delete(id);
        }
        if (seenExecutions.has(execution.executionId)) {
          sendJson(response, 409, { error: "Execution ID has already been used" } satisfies ApiError);
          return;
        }
        seenExecutions.set(execution.executionId, now);
        sendJson(response, 200, await abortOnDisconnect(response, (signal) => executeQueued(
          execution,
          execution.language ?? "python",
          execution.kernelMode ?? "ephemeral",
          signal,
          () => executePython(executorConfig, execution, signal, environmentStore, undefined, gateways),
        )));
        return;
      }
      sendJson(response, 404, { error: "Not found" } satisfies ApiError);
    } catch (error) {
      logger.error("request_failed", {
        errorMessage: shortErrorMessage(error),
        method: request.method ?? "UNKNOWN",
        path: (request.url ?? "/").split("?", 1)[0] || "/",
      });
      if (response.headersSent) response.destroy();
      else sendJson(response, 400, { error: error instanceof Error ? error.message : "Runner request failed" } satisfies ApiError);
    }
  });
  server.once("close", () => {
    void managedExecutions.close();
    void shellSessions.close();
    void gateways.close();
  });
  return server;
}

/**
 * `domain-allowlist` needs a host interpreter for the in-sandbox egress
 * bridge. Report it so the API can tell an admin why the mode is unavailable
 * instead of letting every execution fail with the same error.
 *
 * Every agent run reads runner health before it starts, so this only consults
 * the process-wide interpreter probe: no subprocess per request, and no data
 * directory writes. Staging the bridge script stays on the launch path.
 */
async function sandboxNetworkCapability(sandbox: "bubblewrap" | "seatbelt"): Promise<SandboxNetworkCapability> {
  if (sandbox === "seatbelt") return { available: true, modes: ["none", "domain-allowlist"] };
  try {
    await resolveEgressInterpreter();
    return { available: true, modes: ["none", "domain-allowlist"] };
  } catch (error) {
    return {
      available: false,
      modes: ["none"],
      unavailableReason: error instanceof Error ? error.message : "The sandbox egress bridge is unavailable",
    };
  }
}

export async function startRunnerServer(config = loadRunnerConfig()): Promise<Server> {
  const logger = createOperationalLogger({ category: "runner", dataDir: config.dataDir, service: "runner" });
  const sandbox = executorSandboxKind(config);
  if (sandbox === "seatbelt") {
    if (process.platform !== "darwin") throw new Error("Seatbelt sandbox is available only on macOS");
    const capability = await detectSeatbeltCapability(config.seatbeltPath ?? "/usr/bin/sandbox-exec");
    if (!capability.sandboxUsable) {
      logger.error("sandbox_validation_failed", { detail: capability.detail, reason: capability.reason });
      throw new Error(seatbeltUnusableMessage(config.seatbeltPath ?? "/usr/bin/sandbox-exec", capability));
    }
  } else {
    let help: string;
    try {
      const result = await execFileAsync(config.bwrapPath, ["--help"], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      help = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("sandbox_validation_failed", { errorMessage: shortErrorMessage(error) });
      throw new Error(`Could not execute bubblewrap at "${config.bwrapPath}": ${message}`, { cause: error });
    }
    const missingOptions = REQUIRED_BWRAP_OPTIONS.filter((option) => !help.includes(option));
    if (missingOptions.length) {
      throw new Error(
        `bubblewrap at "${config.bwrapPath}" lacks required sandbox options: ${missingOptions.join(", ")}`,
      );
    }
    // Probe the exact Linux profile so startup and execution cannot disagree.
    const capability = await detectSandboxCapability(config.bwrapPath);
    if (!capability.sandboxUsable) {
    // No sandbox builds here at all. The degradation warnings below both end in
    // "executions still run", which would be false — and `disableUserns` is
    // also false in this state, so reporting it would name the wrong cause.
    logger.warn("sandbox_unusable", { detail: capability.detail, reason: capability.reason });
    console.warn(sandboxUnusableMessage(config.bwrapPath, capability));
    } else {
    // The sandbox works but may be degraded on either axis, and both can be
    // degraded at once, so report them independently rather than as a chain.
    if (capability.procFallback) {
      logger.warn("sandbox_proc_fallback", {
        detail: capability.procDetail,
        procMode: capability.procMode,
      });
      console.warn(procFallbackMessage(config.bwrapPath, capability));
    }
    if (!capability.disableUserns) {
      logger.warn("sandbox_option_unavailable", {
        detail: capability.detail,
        option: "--disable-userns",
        reason: capability.reason,
      });
      console.warn(disableUsernsOmittedMessage(config.bwrapPath, capability));
    }
    }
  }
  const environmentStore = new EnvironmentStore({
    allowedChannels: config.scientificAllowedChannels ?? ["conda-forge"],
    enabled: config.scientificEnvsEnabled === true,
    packageCacheDir: config.scientificPackageCacheDir,
    provisionerPath: config.provisionerPath,
    root: resolve(config.dataDir, "scientific-envs"),
    runnerVersion: RUNNER_VERSION,
  });
  await environmentStore.initialize();
  const envProfiles = new SessionEnvProfileStore();
  const egressGateways = new EgressGatewayRegistry(config.dataDir, (event, detail) => {
    logger[event === "allowed" ? "info" : "warn"]("sandbox_network_request", { event, ...detail });
  });
  const shellSessionManager = new ShellSessionManager({
    bwrapPath: config.bwrapPath,
    sandboxProvider: config.sandboxProvider,
    seatbeltPath: config.seatbeltPath,
    dataDir: config.dataDir,
    execTimeoutMs: config.execTimeoutMs,
    idleTimeoutMs: config.shellSessionIdleMs ?? config.scientificKernelIdleMs,
    maxOutputBytes: config.maxOutputBytes,
    maxWorkspaceBytes: config.maxWorkspaceBytes,
  }, envProfiles, egressGateways);
  const kernelManager = new KernelManager({
    bwrapPath: config.bwrapPath,
    sandboxProvider: config.sandboxProvider,
    seatbeltPath: config.seatbeltPath,
    dataDir: config.dataDir,
    execTimeoutMs: config.execTimeoutMs,
    idleTimeoutMs: config.scientificKernelIdleMs,
    maxOutputBytes: config.maxOutputBytes,
    maxWorkspaceBytes: config.maxWorkspaceBytes,
  }, environmentStore, (sessionId, agentId, permissionEpochId) => (
    envProfiles.get(sessionId, agentId, permissionEpochId)
  ), egressGateways);
  const server = createRunnerServer(
    config,
    environmentStore,
    kernelManager,
    shellSessionManager,
    envProfiles,
    // `undefined` keeps the parameter default: the broker this server builds itself.
    undefined,
    egressGateways,
  );
  server.once("close", () => { void kernelManager.close(); });
  if (config.socketPath) {
    // A stale socket file from a killed runner would make bind fail; only this
    // product writes into the directory it hands out, so removing it is safe.
    await mkdir(dirname(config.socketPath), { mode: 0o700, recursive: true });
    await rm(config.socketPath, { force: true });
  }
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    const ready = (): void => {
      server.off("error", reject);
      resolveListen();
    };
    if (config.socketPath) server.listen(config.socketPath, ready);
    else server.listen(config.port, config.host, ready);
  });
  if (config.socketPath) {
    const socketPath = config.socketPath;
    await chmod(socketPath, 0o600);
    server.once("close", () => { void rm(socketPath, { force: true }); });
    // A socket-mode runner is tied to the SSH session that started it, and that
    // session ends with a hangup rather than a graceful stop. Removing the
    // socket here keeps a dead address from being left behind on the host.
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        rmSync(socketPath, { force: true });
        process.exit(0);
      });
    }
    logger.info("service_started", { socketPath });
    console.log(`ScienceDiscovery runner listening on unix:${socketPath}`);
  } else {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    logger.info("service_started", { host: config.host, port });
    console.log(`ScienceDiscovery runner listening on http://${config.host}:${port}`);
  }
  const workspaceLabel = config.maxWorkspaceBytes === 0
    ? "unlimited"
    : `${config.maxWorkspaceBytes} bytes`;
  const outputLabel = config.maxOutputBytes === 0
    ? "unlimited (no truncation)"
    : `${config.maxOutputBytes} bytes (truncate)`;
  const sandboxNetwork = await sandboxNetworkCapability(sandbox);
  console.log(
    `Sandbox: ${sandbox} (${RUNNER_VERSION}); sandbox network access: default none`
    + `${sandboxNetwork.available ? ", domain-allowlist available" : ` (domain-allowlist unavailable: ${sandboxNetwork.unavailableReason})`}`
    + "; no CPU/memory quotas; "
    + `workspace quota: ${workspaceLabel}; output budget: ${outputLabel}; `
    + `execution timeout: ${config.execTimeoutMs === 0 ? "unlimited" : `${config.execTimeoutMs / 1000}s`}`,
  );
  if (config.scientificEnvsEnabled === true) {
    void environmentStore.setupManagedEnvironments().catch((error) => {
      logger.warn("scientific_environment_bootstrap_failed", { errorMessage: shortErrorMessage(error) });
    });
  }
  return server;
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
if (isMain) {
  startRunnerServer().catch((error: unknown) => {
    try {
      const config = loadRunnerConfig();
      createOperationalLogger({ category: "runner", dataDir: config.dataDir, service: "runner" })
        .error("service_start_failed", { errorMessage: shortErrorMessage(error) });
    } catch {
      // Invalid logging configuration must not hide the original startup error.
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
