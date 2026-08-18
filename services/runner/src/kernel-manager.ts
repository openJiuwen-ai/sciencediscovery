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
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

import {
  epochSandboxNetworkAccess,
  type KernelSession,
  type PythonExecutionRequest,
  type PythonExecutionResult,
  type SandboxNetworkAccess,
  type ScientificLanguage,
} from "@science-agent/schema";

import { EnvironmentStore } from "./environment-store.js";
import type { EgressGatewayRegistry } from "./egress-gateway.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_WORKSPACE_BYTES,
  RESOURCE_LIMIT_MODE,
  RUNNER_VERSION,
  buildSandboxLaunch,
  sandboxLaunchProfile,
  environmentPrefixBindArguments,
  executionTimeoutMs,
  hostInterpreterMaskArguments,
  hostRuntimeSupportArguments,
  prepareSandboxEgress,
  resolveProfileChdir,
  resolveQuotaBytes,
  seccompVariantFor,
  truncateToBudget,
  validatedWorkspace,
  workspaceBindArguments,
  workspaceQuotaExceededMessage,
  workspaceQuotaPrecheckMessage,
  workspaceSnapshot,
  workspaceUsageBytes,
  type SandboxLaunch,
} from "./executor.js";
import { ensureSeccompFilter } from "./seccomp.js";
import { agentExecutionKey, KeyedTaskQueue } from "./agent-execution.js";
import type { SessionEnvProfile } from "./session-env-profile.js";
const PYTHON_KERNEL_WORKER = String.raw`
import contextlib, io, json, os, sys, traceback
namespace = {"__name__": "__main__"}
for line in sys.stdin:
    request = json.loads(line)
    stdout, stderr, exit_code = io.StringIO(), io.StringIO(), 0
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compile(request["code"], "<science-agent>", "exec"), namespace, namespace)
    except BaseException:
        exit_code = 1
        traceback.print_exc(file=stderr)
    print(json.dumps({"id": request["id"], "exitCode": exit_code, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "cwd": os.getcwd(), "env": dict(os.environ)}), flush=True)
`;

const R_KERNEL_WORKER = String.raw`
suppressPackageStartupMessages(library(jsonlite))
namespace <- new.env(parent=.GlobalEnv)
input <- file("stdin", open="r")
repeat {
  line <- readLines(input, n=1, warn=FALSE)
  if (length(line) == 0) break
  request <- fromJSON(line)
  error_text <- ""
  output <- capture.output({
    exit_code <- tryCatch({
      eval(parse(text=request$code), envir=namespace)
      0L
    }, error=function(error) {
      error_text <<- paste0(conditionMessage(error), "\n")
      1L
    })
  }, type="output")
  response <- list(id=request$id, exitCode=exit_code, stdout=paste0(paste(output, collapse="\n"), if (length(output)) "\n" else ""), stderr=error_text, cwd=getwd(), env=as.list(Sys.getenv()))
  cat(toJSON(response, auto_unbox=TRUE, null="null"), "\n", sep="")
  flush.console()
}
`;

interface EvalResponse {
  /** Sandbox cwd observed after the evaluation. */
  cwd?: string;
  /** Process environment observed after the evaluation. */
  env?: Record<string, string>;
  exitCode: number;
  id: string;
  stderr: string;
  stdout: string;
}

interface PendingEval {
  abort?: () => void;
  maxOutputBytes: number;
  reject: (error: Error) => void;
  resolve: (response: EvalResponse) => void;
  signal?: AbortSignal;
  timer?: NodeJS.Timeout;
}

class ManagedKernel {
  readonly session: KernelSession;
  private pending?: PendingEval;
  private idleTimer?: NodeJS.Timeout;
  private stderrTail = "";
  private stopped = false;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    session: KernelSession,
    /** Env and cwd the kernel was spawned with; per-eval provenance fallback. */
    readonly launch: SandboxLaunch,
    readonly workspaceRoot: string,
    readonly readOnlyWorkspaceRoot: string | undefined,
    private idleTimeoutMs: number,
    private readonly onIdle: (kernel: ManagedKernel) => void,
    private readonly onUnexpectedExit: (kernel: ManagedKernel, reason: string) => void,
  ) {
    this.session = session;
    this.idleTimer = this.armIdleTimer();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const pending = this.pending;
      if (!pending) return;
      try {
        const response = JSON.parse(line) as EvalResponse;
        const maxOutputBytes = pending.maxOutputBytes;
        if (maxOutputBytes > 0) {
          const stdoutBytes = Buffer.byteLength(response.stdout ?? "");
          const stderrBytes = Buffer.byteLength(response.stderr ?? "");
          if (stdoutBytes + stderrBytes > maxOutputBytes) {
            const stdoutLimit = Math.min(stdoutBytes, Math.floor(maxOutputBytes * 3 / 4));
            // remaining room 0 means drop that stream — do not reuse config "0 = unlimited"
            response.stdout = truncateToBudget(response.stdout ?? "", stdoutLimit);
            response.stderr = truncateToBudget(
              response.stderr ?? "",
              Math.max(0, maxOutputBytes - Buffer.byteLength(response.stdout)),
            );
          }
        }
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
        this.pending = undefined;
        pending.resolve(response);
      } catch (error) {
        pending.reject(new Error("Kernel returned an invalid response", { cause: error }));
        void this.stop("Kernel protocol error");
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-64 * 1024);
    });
    child.once("error", (error) => this.unexpectedExit(error.message));
    child.once("close", () => this.unexpectedExit(this.stderrTail.trim()
      ? `Persistent kernel exited unexpectedly: ${this.stderrTail.trim()}`
      : "Persistent kernel exited unexpectedly"));
  }

  get configuredIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  async evaluate(
    code: string,
    timeoutMs: number,
    idleTimeoutMs: number,
    maxOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<EvalResponse> {
    if (this.stopped) throw new Error("Persistent kernel is stopped");
    if (this.pending) throw new Error("Persistent kernel is already evaluating code");
    if (!code.trim()) throw new Error("Scientific code is required");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimeoutMs = idleTimeoutMs;
    const id = randomUUID();
    const response = await new Promise<EvalResponse>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            reject(new Error(`Persistent kernel evaluation timed out after ${timeoutMs} ms`));
            void this.stop(`Persistent kernel evaluation timed out after ${timeoutMs} ms`);
          }, timeoutMs)
        : undefined;
      const abort = () => {
        reject(new Error("Persistent kernel eval aborted"));
        void this.stop("Kernel eval aborted");
      };
      this.pending = { abort, maxOutputBytes, reject, resolve, signal, timer };
      signal?.addEventListener("abort", abort, { once: true });
      const payload = `${JSON.stringify({ code, id })}\n`;
      this.child.stdin.write(payload, (error) => {
        if (error) {
          signal?.removeEventListener("abort", abort);
          if (timer) clearTimeout(timer);
          this.pending = undefined;
          reject(error);
        }
      });
    });
    const now = new Date();
    this.session.lastUsedAt = now.toISOString();
    if (this.idleTimeoutMs > 0) {
      this.session.expiresAt = new Date(now.getTime() + this.idleTimeoutMs).toISOString();
    } else {
      delete this.session.expiresAt;
    }
    this.idleTimer = this.armIdleTimer();
    return response;
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.session.memoryLostReason = reason;
    this.session.status = "stopped";
    this.failPending(new Error(reason));
    this.child.kill("SIGKILL");
  }

  private armIdleTimer(): NodeJS.Timeout | undefined {
    return this.idleTimeoutMs > 0
      ? setTimeout(() => this.onIdle(this), this.idleTimeoutMs)
      : undefined;
  }

  private failPending(error: Error): void {
    if (!this.pending) return;
    if (this.pending.timer) clearTimeout(this.pending.timer);
    const pending = this.pending;
    this.pending = undefined;
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
    pending.reject(error);
  }

  private unexpectedExit(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer);
    this.session.memoryLostReason = reason;
    this.session.status = "stopped";
    this.failPending(new Error(reason));
    this.onUnexpectedExit(this, reason);
  }
}

export interface KernelManagerConfig {
  bwrapPath: string;
  dataDir: string;
  /** Wall-clock limit for a single evaluation inside a kernel. */
  execTimeoutMs: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  maxWorkspaceBytes?: number;
}

export class KernelManager {
  private readonly kernels = new Map<string, ManagedKernel>();
  private readonly lostState = new Map<string, string>();
  private readonly executionQueue = new KeyedTaskQueue();
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly config: KernelManagerConfig,
    private readonly environmentStore: EnvironmentStore,
    /** Session env profile lookup for spawn-time injection. */
    private readonly profileProvider?: (
      sessionId: string,
      agentId: string,
      permissionEpochId: string,
    ) => SessionEnvProfile | undefined,
    /** Egress gateways for Permission Epochs that grant sandbox network access. */
    private readonly gateways?: EgressGatewayRegistry,
  ) {
    this.idleTimeoutMs = config.idleTimeoutMs ?? 0;
  }

  list(): KernelSession[] {
    return [...this.kernels.values()].map((kernel) => ({ ...kernel.session }));
  }

  async execute(
    request: PythonExecutionRequest,
    signal?: AbortSignal,
  ): Promise<PythonExecutionResult> {
    const language: ScientificLanguage = request.language ?? "python";
    const queueKey = JSON.stringify([
      agentExecutionKey(request.permissionEpoch.sessionId, request.agentId),
      language,
    ]);
    const runtime = this.environmentStore.resolveRuntime(request.environmentRevisionId, language);
    const runtimeKey = JSON.stringify([
      request.permissionEpoch.sessionId,
      request.agentId,
      language,
      runtime.revision.id,
      request.permissionEpoch.id,
    ]);
    return await this.executionQueue.run(
      queueKey,
      () => this.executeSerialized(request, runtime.prefixPath, runtime.revision.id, language, runtimeKey, signal),
    );
  }

  private async executeSerialized(
    request: PythonExecutionRequest,
    prefixPath: string,
    environmentRevisionId: string,
    language: ScientificLanguage,
    key: string,
    signal?: AbortSignal,
  ): Promise<PythonExecutionResult> {
    if ((request.kernelMode ?? "ephemeral") !== "persistent") throw new Error("Kernel manager requires persistent mode");
    if (request.permissionEpoch.executeGrantScope === "once") {
      throw new Error("Persistent kernels are not allowed for once-scoped execute grants");
    }
    const networkAccess = epochSandboxNetworkAccess(request.permissionEpoch);
    if (request.permissionEpoch.mounts.length !== 1
      || request.permissionEpoch.mounts[0]?.source !== "workspace"
      || request.permissionEpoch.mounts[0]?.mode !== "read-write") {
      throw new Error("Persistent kernels accept exactly one read-write workspace mount");
    }
    const workspaceRoot = await validatedWorkspace(this.config.dataDir, request.workspaceRoot);
    const readOnlyWorkspaceRoot = request.readOnlyWorkspaceRoot
      ? await validatedWorkspace(this.config.dataDir, request.readOnlyWorkspaceRoot)
      : undefined;
    const maxWorkspaceBytes = resolveQuotaBytes(
      request.maxWorkspaceBytes,
      this.config.maxWorkspaceBytes ?? DEFAULT_MAX_WORKSPACE_BYTES,
      "maxWorkspaceBytes",
    );
    const maxOutputBytes = resolveQuotaBytes(
      request.maxOutputBytes,
      this.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    if (maxWorkspaceBytes > 0 && await workspaceUsageBytes(workspaceRoot) > maxWorkspaceBytes) {
      throw new Error(workspaceQuotaPrecheckMessage(maxWorkspaceBytes));
    }

    const lostStateKey = JSON.stringify([request.permissionEpoch.sessionId, request.agentId, language]);
    for (const [existingKey, existing] of this.kernels) {
      if (existingKey === key || existing.session.sessionId !== request.permissionEpoch.sessionId
        || existing.session.agentId !== request.agentId || existing.session.language !== language) continue;
      await existing.stop("Permission Epoch or Environment Revision changed; persistent memory was lost");
      this.kernels.delete(existingKey);
      this.lostState.set(lostStateKey, existing.session.memoryLostReason!);
    }

    let kernel = this.kernels.get(key);
    if (kernel?.isStopped) {
      // A kernel stopped mid-eval (timeout, quota, abort) stays in the map
      // until now; replace it and surface the loss on this execution.
      this.kernels.delete(key);
      this.lostState.set(lostStateKey,
        kernel.session.memoryLostReason ?? "Persistent kernel stopped; persistent memory was lost");
      kernel = undefined;
    }
    if (!kernel) {
      kernel = await this.startKernel(
        request,
        prefixPath,
        environmentRevisionId,
        language,
        workspaceRoot,
        readOnlyWorkspaceRoot,
        networkAccess,
      );
      this.kernels.set(key, kernel);
    } else if (kernel.workspaceRoot !== workspaceRoot
      || kernel.readOnlyWorkspaceRoot !== readOnlyWorkspaceRoot) {
      throw new Error("Persistent kernel Session-Agent identity cannot be reused with different workspace mounts");
    }

    const before = await workspaceSnapshot(workspaceRoot);
    const startedAt = new Date().toISOString();
    let checkingQuota = false;
    const quotaTimer = maxWorkspaceBytes > 0
      ? setInterval(() => {
          if (checkingQuota) return;
          checkingQuota = true;
          void workspaceUsageBytes(workspaceRoot).then((bytes) => {
            if (bytes > maxWorkspaceBytes) void kernel!.stop(workspaceQuotaExceededMessage(maxWorkspaceBytes));
          }).finally(() => { checkingQuota = false; });
        }, 100)
      : undefined;
    let response: EvalResponse;
    try {
      response = await kernel.evaluate(
        request.code,
        executionTimeoutMs(request.executionTimeoutMs, this.config.execTimeoutMs),
        executionTimeoutMs(request.kernelIdleTimeoutMs, this.idleTimeoutMs),
        maxOutputBytes,
        signal,
      );
    } finally {
      if (quotaTimer) clearInterval(quotaTimer);
    }
    if (maxWorkspaceBytes > 0 && await workspaceUsageBytes(workspaceRoot) > maxWorkspaceBytes) {
      throw new Error(workspaceQuotaExceededMessage(maxWorkspaceBytes));
    }
    const after = await workspaceSnapshot(workspaceRoot);
    const createdFiles = [...after.keys()].filter((path) => !before.has(path)).toSorted();
    const modifiedFiles = [...after.entries()]
      .filter(([path, fingerprint]) => before.has(path) && before.get(path) !== fingerprint)
      .map(([path]) => path)
      .toSorted();
    return {
      cgroupMode: RESOURCE_LIMIT_MODE,
      createdFiles,
      environmentRevisionId,
      environmentVariables: response.env ?? kernel.launch.env,
      executionId: request.executionId,
      exitCode: response.exitCode,
      finishedAt: new Date().toISOString(),
      kernelId: kernel.session.id,
      kernelMode: "persistent",
      language,
      ...(this.lostState.has(lostStateKey)
        ? { memoryStateLost: this.takeLostState(lostStateKey) }
        : {}),
      modifiedFiles,
      networkAccessRevision: networkAccess.revision,
      networkPolicy: networkAccess.mode,
      runnerVersion: RUNNER_VERSION,
      sandbox: "bubblewrap",
      startedAt,
      stderr: response.stderr,
      stdout: response.stdout,
      workingDirectory: response.cwd ?? kernel.launch.chdir,
    };
  }

  async teardownSession(sessionId: string, reason: string): Promise<number> {
    let count = 0;
    for (const [key, kernel] of this.kernels) {
      if (kernel.session.sessionId !== sessionId) continue;
      await kernel.stop(reason);
      this.kernels.delete(key);
      this.lostState.set(
        JSON.stringify([kernel.session.sessionId, kernel.session.agentId, kernel.session.language]),
        reason,
      );
      count += 1;
    }
    return count;
  }

  async teardownKernel(kernelId: string, reason: string): Promise<number> {
    for (const [key, kernel] of this.kernels) {
      if (kernel.session.id !== kernelId) continue;
      await kernel.stop(reason);
      this.kernels.delete(key);
      this.lostState.set(
        JSON.stringify([kernel.session.sessionId, kernel.session.agentId, kernel.session.language]),
        reason,
      );
      return 1;
    }
    return 0;
  }

  async teardownRevision(revisionId: string, reason: string): Promise<number> {
    let count = 0;
    for (const [key, kernel] of this.kernels) {
      if (kernel.session.environmentRevisionId !== revisionId) continue;
      await kernel.stop(reason);
      this.kernels.delete(key);
      this.lostState.set(
        JSON.stringify([kernel.session.sessionId, kernel.session.agentId, kernel.session.language]),
        reason,
      );
      count += 1;
    }
    return count;
  }

  async close(): Promise<void> {
    await Promise.all([...this.kernels.values()].map((kernel) => kernel.stop("Runner stopped")));
    this.kernels.clear();
    this.lostState.clear();
  }

  private takeLostState(lostStateKey: string): string {
    const reason = this.lostState.get(lostStateKey)!;
    this.lostState.delete(lostStateKey);
    return reason;
  }

  private async startKernel(
    request: PythonExecutionRequest,
    prefixPath: string,
    environmentRevisionId: string,
    language: ScientificLanguage,
    workspaceRoot: string,
    readOnlyWorkspaceRoot: string | undefined,
    networkAccess: SandboxNetworkAccess,
  ): Promise<ManagedKernel> {
    const id = `kernel-${randomUUID()}`;
    const filter = await open(
      await ensureSeccompFilter(this.config.dataDir, seccompVariantFor(networkAccess)),
      "r",
    );
    const interpreter = `/opt/science-env/bin/${language === "python" ? "python" : "R"}`;
    const worker = language === "python" ? PYTHON_KERNEL_WORKER : R_KERNEL_WORKER;
    const hostInterpreterMasks = await hostInterpreterMaskArguments();
    const hostRuntimeSupport = await hostRuntimeSupportArguments();
    const workspaceBinds = workspaceBindArguments(workspaceRoot, readOnlyWorkspaceRoot);
    const envProfile = this.profileProvider?.(
      request.permissionEpoch.sessionId,
      request.agentId,
      request.permissionEpoch.id,
    );
    const launch = buildSandboxLaunch({
      chdir: await resolveProfileChdir(envProfile, workspaceBinds, workspaceRoot, readOnlyWorkspaceRoot),
      ...await sandboxLaunchProfile(this.config.bwrapPath),
      egress: await prepareSandboxEgress(this.config.dataDir, networkAccess, this.gateways),
      environmentBinds: environmentPrefixBindArguments(prefixPath),
      envProfile,
      hostInterpreterMasks,
      hostRuntimeSupport,
      language,
      pathEnv: "/opt/science-env/bin:/usr/bin",
      workspaceBindArgs: workspaceBinds.args,
    });
    const bwrapArguments = [
      ...launch.args,
      ...launch.commandPrefix,
      interpreter,
      ...(language === "python" ? ["-I", "-u", "-c", worker] : ["--vanilla", "--slave", "-e", worker]),
    ];
    let child;
    try {
      child = spawn(this.config.bwrapPath, bwrapArguments, { stdio: ["pipe", "pipe", "pipe", filter.fd] });
    } catch (error) {
      await filter.close();
      throw error;
    }
    await filter.close();
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill("SIGKILL");
      throw new Error("Runner failed to create persistent kernel streams");
    }
    const now = new Date();
    const idleTimeoutMs = executionTimeoutMs(request.kernelIdleTimeoutMs, this.idleTimeoutMs);
    const session: KernelSession = {
      agentId: request.agentId,
      createdAt: now.toISOString(),
      environmentRevisionId,
      ...(idleTimeoutMs > 0 ? { expiresAt: new Date(now.getTime() + idleTimeoutMs).toISOString() } : {}),
      id,
      kernelMode: "persistent",
      language,
      lastUsedAt: now.toISOString(),
      permissionEpochId: request.permissionEpoch.id,
      sessionId: request.permissionEpoch.sessionId,
      status: "running",
    };
    const removeKernel = (kernel: ManagedKernel, reason: string) => {
      for (const [key, candidate] of this.kernels) {
        if (candidate !== kernel) continue;
        this.kernels.delete(key);
        this.lostState.set(
          JSON.stringify([kernel.session.sessionId, kernel.session.agentId, kernel.session.language]),
          reason,
        );
      }
    };
    return new ManagedKernel(
      child as ChildProcessWithoutNullStreams,
      session,
      launch,
      workspaceRoot,
      readOnlyWorkspaceRoot,
      idleTimeoutMs,
      (kernel) => {
        const reason = `Persistent kernel idle timeout after ${kernel.configuredIdleTimeoutMs} ms`;
        void kernel.stop(reason).then(() => {
          removeKernel(kernel, kernel.session.memoryLostReason!);
        });
      },
      removeKernel,
    );
  }
}
