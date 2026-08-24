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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createOperationalLogger, shortErrorMessage } from "@sciencediscovery/operational-logging";
import {
  detectSandboxCapability,
  disableUsernsOmittedMessage,
  procFallbackMessage,
  sandboxUnusableMessage,
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
  MAX_RUNNER_FILE_BYTES,
  RESOURCE_LIMIT_MODE,
  RUNNER_VERSION,
  validatedWorkspace,
  type ExecutorConfig,
} from "./executor.js";
import {
  EXECUTION_SIGNATURE_HEADER,
  EXECUTION_TIMESTAMP_HEADER,
  verifyExecutionSignature,
} from "./request-auth.js";
import { resolveEgressInterpreter } from "./egress-bridge.js";
import { EgressGatewayRegistry } from "./egress-gateway.js";
import { SECCOMP_BASELINE_VERSION } from "./seccomp.js";
import { EnvironmentStore } from "./environment-store.js";
import { KernelManager } from "./kernel-manager.js";
import { SessionEnvProfileStore } from "./session-env-profile.js";
import { ShellSessionManager } from "./shell-session-manager.js";
import { agentExecutionKey, KeyedTaskQueue, requestAgentExecutionKey } from "./agent-execution.js";
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
type RunnerInstallEnvironmentRequest = InstallEnvironmentRequest & { workspaceRoot?: string };
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
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body exceeds the 2 MB limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  return {
    authToken: env.SCIENCE_AGENT_RUNNER_TOKEN?.trim() || "sciencediscovery-runner-local",
    bwrapPath: env.SCIENCE_AGENT_BWRAP_PATH?.trim() || "bwrap",
    dataDir: resolve(cwd, env.SCIENCE_AGENT_DATA_DIR?.trim() || ".sciencediscovery-data"),
    execTimeoutMs,
    maxOutputBytes: parseByteQuota("SCIENCE_AGENT_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES),
    maxWorkspaceBytes: parseByteQuota("SCIENCE_AGENT_MAX_WORKSPACE_BYTES", DEFAULT_MAX_WORKSPACE_BYTES),
    host: env.SCIENCE_AGENT_RUNNER_HOST?.trim() || "127.0.0.1",
    npuBrokerEnabled: /^(?:1|true|yes)$/i.test(env.SCIENCE_AGENT_NPU_BROKER?.trim() || "0"),
    npuProtenixScriptPath: env.SCIENCE_AGENT_NPU_PROTENIX_SCRIPT?.trim() || undefined,
    npuPythonPath: env.SCIENCE_AGENT_NPU_PYTHON?.trim() || undefined,
    npuSmokeScriptPath: env.SCIENCE_AGENT_NPU_SMOKE_SCRIPT?.trim() || undefined,
    npuWorkloadConfigPath: env.SCIENCE_AGENT_NPU_WORKLOAD_CONFIG?.trim()
      ? resolve(cwd, env.SCIENCE_AGENT_NPU_WORKLOAD_CONFIG.trim())
      : undefined,
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
  const logger = createOperationalLogger({ category: "runner", dataDir: config.dataDir, service: "runner" });
  const profiles = envProfiles ?? new SessionEnvProfileStore();
  const gateways = egressGateways ?? new EgressGatewayRegistry(config.dataDir, (event, detail) => {
    logger[event === "allowed" ? "info" : "warn"]("sandbox_network_request", { event, ...detail });
  });
  const shellSessions = shellSessionManager ?? new ShellSessionManager({
    bwrapPath: config.bwrapPath,
    dataDir: config.dataDir,
    execTimeoutMs: config.execTimeoutMs,
    idleTimeoutMs: config.shellSessionIdleMs ?? config.scientificKernelIdleMs,
    maxOutputBytes: config.maxOutputBytes,
    maxWorkspaceBytes: config.maxWorkspaceBytes,
  }, profiles, gateways);
  const executionQueues = new KeyedTaskQueue();
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
      return await executionQueues.run(requestAgentExecutionKey(execution), async () => {
        if (signal.aborted) throw new Error("Runner execution aborted before start");
        status.startedAt = new Date().toISOString();
        status.status = "running";
        try {
          return await operation();
        } finally {
          activeExecutions.delete(status.executionId);
        }
      }, execution.permissionEpoch.sessionId);
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
          noNewPrivileges: true,
          npuBroker: npuBroker.capability(),
          runnerVersion: RUNNER_VERSION,
          sandbox: "bubblewrap",
          sandboxNetwork: await sandboxNetworkCapability(),
          scientificEnvs: environmentStore?.capability ?? DISABLED_SCIENTIFIC_ENVS,
          seccompBaseline: SECCOMP_BASELINE_VERSION,
          status: "ok",
          workerConcurrency: null,
        } satisfies RunnerHealth);
        return;
      }
      if (!authorized(request, config.authToken)) {
        sendJson(response, 401, { error: "Unauthorized" } satisfies ApiError);
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
        const workspaceRoot = input.workspaceRoot
          ? await validatedWorkspace(config.dataDir, input.workspaceRoot)
          : undefined;
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
      if (request.method === "POST" && url.pathname === "/execute-shell") {
        const body = await readBody(request);
        const timestamp = request.headers[EXECUTION_TIMESTAMP_HEADER] as string | undefined;
        const signature = request.headers[EXECUTION_SIGNATURE_HEADER] as string | undefined;
        if (!verifyExecutionSignature(config.authToken, timestamp, body, signature)) {
          sendJson(response, 401, { error: "Invalid or expired execution signature" } satisfies ApiError);
          return;
        }
        const execution = JSON.parse(body) as ShellExecutionRequest;
        if (execution.permissionEpoch.executeGrantScope === "once") execution.kernelMode = "ephemeral";
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
          () => execution.kernelMode === "persistent"
            ? shellSessions.execute(execution, signal)
            : executeShell(config, execution, signal,
                profiles.get(execution.permissionEpoch.sessionId, execution.agentId, execution.permissionEpoch.id),
                gateways),
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
        if (execution.permissionEpoch.executeGrantScope === "once") execution.kernelMode = "ephemeral";
        const now = Date.now();
        for (const [id, seenAt] of seenExecutions) {
          if (now - seenAt > 60_000) seenExecutions.delete(id);
        }
        if (seenExecutions.has(execution.executionId)) {
          sendJson(response, 409, { error: "Execution ID has already been used" } satisfies ApiError);
          return;
        }
        seenExecutions.set(execution.executionId, now);
        // Activity keeps only this Agent's persistent shell alive.
        shellSessions.touchAgent(execution.permissionEpoch.sessionId, execution.agentId);
        sendJson(response, 200, await abortOnDisconnect(response, (signal) => executeQueued(
          execution,
          execution.language ?? "python",
          execution.kernelMode ?? "ephemeral",
          signal,
          () => execution.kernelMode === "persistent"
            ? kernelManager?.execute(execution, signal)
              ?? Promise.reject(new Error("Persistent kernels are unavailable"))
            : executePython(config, execution, signal, environmentStore,
                profiles.get(execution.permissionEpoch.sessionId, execution.agentId, execution.permissionEpoch.id),
                gateways),
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
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Runner request failed" } satisfies ApiError);
    }
  });
  server.once("close", () => {
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
async function sandboxNetworkCapability(): Promise<SandboxNetworkCapability> {
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
  // Resolve the option by probing, not by reading --help: the same call warms
  // the cache every execution reads, so the startup warning and the arguments a
  // real launch uses always describe the same sandbox.
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
  const environmentStore = new EnvironmentStore({
    allowedChannels: config.scientificAllowedChannels ?? ["conda-forge"],
    enabled: config.scientificEnvsEnabled === true,
    packageCacheDir: config.scientificPackageCacheDir,
    provisionerPath: config.provisionerPath,
    root: resolve(config.dataDir, "scientific-envs"),
    runnerVersion: RUNNER_VERSION,
  }, async (provisionerPath, arguments_) => {
    // Trusted control-plane install job (not agent code). Network is allowlisted by the provisioner;
    // agent execution remains bubblewrap with networkPolicy=none.
    const result = await execFileAsync(provisionerPath, arguments_, {
      encoding: "utf8",
      env: {
        ...process.env,
        MAMBA_ROOT_PREFIX: resolve(config.dataDir, "scientific-envs", "provisioner"),
        ...(config.scientificPackageCacheDir ? { CONDA_PKGS_DIRS: config.scientificPackageCacheDir } : {}),
      },
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout;
  });
  await environmentStore.initialize();
  const envProfiles = new SessionEnvProfileStore();
  const egressGateways = new EgressGatewayRegistry(config.dataDir, (event, detail) => {
    logger[event === "allowed" ? "info" : "warn"]("sandbox_network_request", { event, ...detail });
  });
  const shellSessionManager = new ShellSessionManager({
    bwrapPath: config.bwrapPath,
    dataDir: config.dataDir,
    execTimeoutMs: config.execTimeoutMs,
    idleTimeoutMs: config.shellSessionIdleMs ?? config.scientificKernelIdleMs,
    maxOutputBytes: config.maxOutputBytes,
    maxWorkspaceBytes: config.maxWorkspaceBytes,
  }, envProfiles, egressGateways);
  const kernelManager = new KernelManager({
    bwrapPath: config.bwrapPath,
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
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  logger.info("service_started", { host: config.host, port });
  console.log(`ScienceDiscovery runner listening on http://${config.host}:${port}`);
  const workspaceLabel = config.maxWorkspaceBytes === 0
    ? "unlimited"
    : `${config.maxWorkspaceBytes} bytes`;
  const outputLabel = config.maxOutputBytes === 0
    ? "unlimited (no truncation)"
    : `${config.maxOutputBytes} bytes (truncate)`;
  const sandboxNetwork = await sandboxNetworkCapability();
  console.log(
    `Sandbox: bubblewrap (${RUNNER_VERSION}); sandbox network access: default none`
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
