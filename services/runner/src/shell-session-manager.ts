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
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  type KernelSession,
  type ShellExecutionRequest,
  type ShellExecutionResult,
} from "@science-agent/schema";

import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_WORKSPACE_BYTES,
  RESOURCE_LIMIT_MODE,
  RUNNER_VERSION,
  buildSandboxLaunch,
  sandboxLaunchProfile,
  executionTimeoutMs,
  hostRuntimeSupportArguments,
  resolveQuotaBytes,
  truncateToBudget,
  validatedWorkspace,
  workspaceBindArguments,
  workspaceQuotaExceededMessage,
  workspaceQuotaPrecheckMessage,
  workspaceSnapshot,
  workspaceUsageBytes,
} from "./executor.js";
import { ensureBaselineSeccompFilter } from "./seccomp.js";
import { agentExecutionKey, KeyedTaskQueue } from "./agent-execution.js";
import { SessionEnvProfileStore } from "./session-env-profile.js";

/**
 * Persistent shell worker. The driver loop runs inside
 * the sandboxed bash process itself so `cd` / `export` / `source` performed by
 * evaluated snippets persist in the session. Protocol: one request per stdin
 * line (`<id> <base64(code)>`); one response line
 * `__SA_RESULT__ <id> <exitCode> <b64 stdout> <b64 stderr> <b64 cwd> <b64 env -0>`.
 * User code stdin is /dev/null and its stdout/stderr go to files, so the
 * protocol pipe stays driver-only. Unlike the ephemeral `-euo pipefail` shell,
 * a session behaves like an interactive shell: a failing command reports its
 * exit code but does not abort the session (`set -e` / `exit` in user code
 * still end the whole session, which is then recreated with memory lost).
 */
const SHELL_SESSION_WORKER = String.raw`
__sa_out=/tmp/.science-agent-shell-stdout
__sa_err=/tmp/.science-agent-shell-stderr
__sa_current=''
__sa_emit() {
  printf '%s %s %s %s %s %s %s\n' __SA_RESULT__ "$1" "$2" \
    "$(base64 -w0 <"$__sa_out" 2>/dev/null)" \
    "$(base64 -w0 <"$__sa_err" 2>/dev/null)" \
    "$(printf %s "$(pwd -P)" | base64 -w0)" \
    "$(env -0 | base64 -w0)"
}
__sa_on_exit() {
  __sa_rc=$?
  if [ -n "$__sa_current" ]; then __sa_emit "$__sa_current" "$__sa_rc"; fi
}
trap __sa_on_exit EXIT
while IFS=' ' read -r __sa_id __sa_code; do
  __sa_code=$(printf %s "$__sa_code" | base64 -d)
  : >"$__sa_out"
  : >"$__sa_err"
  __sa_current=$__sa_id
  eval "$__sa_code" </dev/null >"$__sa_out" 2>"$__sa_err"
  __sa_rc=$?
  { set +e +u +o pipefail; } 2>/dev/null
  __sa_current=''
  __sa_emit "$__sa_id" "$__sa_rc"
done
`;

const RESULT_MARKER = "__SA_RESULT__";

interface ShellEvalResponse {
  cwd: string;
  env: Record<string, string>;
  exitCode: number;
  id: string;
  stderr: string;
  stdout: string;
}

interface PendingShellEval {
  abort?: () => void;
  maxOutputBytes: number;
  reject: (error: Error) => void;
  resolve: (response: ShellEvalResponse) => void;
  signal?: AbortSignal;
  timer?: NodeJS.Timeout;
}

function decodeField(field: string): string {
  return Buffer.from(field, "base64").toString("utf8");
}

function parseEnvDump(field: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of decodeField(field).split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

class ManagedShellSession {
  readonly session: KernelSession;
  private pending?: PendingShellEval;
  private idleTimer?: NodeJS.Timeout;
  private stderrTail = "";
  private stopped = false;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    session: KernelSession,
    readonly workspaceRoot: string,
    readonly readOnlyWorkspaceRoot: string | undefined,
    private idleTimeoutMs: number,
    /** Invoked exactly once, on every stop path (idle, teardown, exit, error). */
    private readonly onStopped: (shellSession: ManagedShellSession, reason: string) => void,
  ) {
    this.session = session;
    this.idleTimer = this.armIdleTimer();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const pending = this.pending;
      if (!pending) return;
      const parts = line.split(" ");
      if (parts[0] !== RESULT_MARKER || parts.length !== 7) return;
      const [, id, exitCodeText, stdoutField, stderrField, cwdField, envField] = parts as [
        string, string, string, string, string, string, string,
      ];
      let stdout = decodeField(stdoutField);
      let stderr = decodeField(stderrField);
      const maxOutputBytes = pending.maxOutputBytes;
      if (maxOutputBytes > 0) {
        const stdoutBytes = Buffer.byteLength(stdout);
        const stderrBytes = Buffer.byteLength(stderr);
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          // remaining room 0 means drop that stream — do not reuse config "0 = unlimited"
          stdout = truncateToBudget(stdout, Math.min(stdoutBytes, Math.floor(maxOutputBytes * 3 / 4)));
          stderr = truncateToBudget(stderr, Math.max(0, maxOutputBytes - Buffer.byteLength(stdout)));
        }
      }
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
      this.pending = undefined;
      pending.resolve({
        cwd: decodeField(cwdField),
        env: parseEnvDump(envField),
        exitCode: Number.parseInt(exitCodeText, 10) || 0,
        id,
        stderr,
        stdout,
      });
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-64 * 1024);
    });
    child.once("error", (error) => this.markStopped(error.message));
    child.once("close", (code) => this.markStopped(this.stderrTail.trim()
      ? `Persistent shell session exited (code ${code ?? "unknown"}): ${this.stderrTail.trim()}`
      : `Persistent shell session exited (code ${code ?? "unknown"})`));
  }

  get configuredIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  get isStopped(): boolean {
    // The child may have exited (user `exit`, crash) before its `close` event
    // delivered markStopped — treat an exited process as stopped immediately
    // so a follow-up execute never writes to a dead stdin.
    return this.stopped || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  async evaluate(
    code: string,
    timeoutMs: number,
    idleTimeoutMs: number,
    maxOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<ShellEvalResponse> {
    if (this.stopped) throw new Error("Persistent shell session is stopped");
    if (this.pending) throw new Error("Persistent shell session is already evaluating code");
    if (!code.trim()) throw new Error("Shell code is required");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimeoutMs = idleTimeoutMs;
    const id = randomUUID();
    const response = await new Promise<ShellEvalResponse>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            reject(new Error(`Persistent shell evaluation timed out after ${timeoutMs} ms`));
            void this.stop(`Persistent shell evaluation timed out after ${timeoutMs} ms`);
          }, timeoutMs)
        : undefined;
      const abort = () => {
        reject(new Error("Persistent shell eval aborted"));
        void this.stop("Shell eval aborted");
      };
      this.pending = { abort, maxOutputBytes, reject, resolve, signal, timer };
      signal?.addEventListener("abort", abort, { once: true });
      const payload = `${id} ${Buffer.from(code).toString("base64")}\n`;
      this.child.stdin.write(payload, (error) => {
        if (error) {
          signal?.removeEventListener("abort", abort);
          if (timer) clearTimeout(timer);
          this.pending = undefined;
          reject(error);
        }
      });
    });
    this.touch();
    return response;
  }

  /** Session activity (any execution in the Session) keeps the shell alive. */
  touch(): void {
    if (this.stopped) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const now = new Date();
    this.session.lastUsedAt = now.toISOString();
    if (this.idleTimeoutMs > 0) {
      this.session.expiresAt = new Date(now.getTime() + this.idleTimeoutMs).toISOString();
    } else {
      delete this.session.expiresAt;
    }
    this.idleTimer = this.armIdleTimer();
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.markStopped(reason);
    this.child.kill("SIGKILL");
  }

  private markStopped(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.session.memoryLostReason = reason;
    this.session.status = "stopped";
    this.failPending(new Error(reason));
    this.onStopped(this, reason);
  }

  private armIdleTimer(): NodeJS.Timeout | undefined {
    return this.idleTimeoutMs > 0
      ? setTimeout(() => {
          void this.stop(`Persistent shell session idle timeout after ${this.idleTimeoutMs} ms`);
        }, this.idleTimeoutMs)
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
}

export interface ShellSessionManagerConfig {
  bwrapPath: string;
  dataDir: string;
  /** Wall-clock limit for a single evaluation inside a session. */
  execTimeoutMs: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  maxWorkspaceBytes?: number;
}

/**
 * One persistent shell session per (Session, Agent, Permission Epoch). Each
 * evaluation also sediments the shell's
 * post-eval cwd + exported env into the SessionEnvProfileStore so later
 * python/r/ephemeral-shell executions inherit the whitelisted subset (C).
 */
export class ShellSessionManager {
  private readonly sessions = new Map<string, ManagedShellSession>();
  private readonly lostState = new Map<string, string>();
  private readonly executionQueue = new KeyedTaskQueue();
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly config: ShellSessionManagerConfig,
    private readonly profiles: SessionEnvProfileStore,
  ) {
    this.idleTimeoutMs = config.idleTimeoutMs ?? 0;
  }

  list(): KernelSession[] {
    return [...this.sessions.values()].map((shellSession) => ({ ...shellSession.session }));
  }

  /** Re-arm idle timers on activity from the shell's owning Agent. */
  touchAgent(sessionId: string, agentId: string): void {
    for (const shellSession of this.sessions.values()) {
      if (shellSession.session.sessionId === sessionId && shellSession.session.agentId === agentId) {
        shellSession.touch();
      }
    }
  }

  async execute(request: ShellExecutionRequest, signal?: AbortSignal): Promise<ShellExecutionResult> {
    const queueKey = agentExecutionKey(request.permissionEpoch.sessionId, request.agentId);
    const runtimeKey = JSON.stringify([
      request.permissionEpoch.sessionId,
      request.agentId,
      "shell",
      SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
      request.permissionEpoch.id,
    ]);
    return await this.executionQueue.run(
      queueKey,
      () => this.executeSerialized(request, runtimeKey, signal),
    );
  }

  private async executeSerialized(
    request: ShellExecutionRequest,
    key: string,
    signal?: AbortSignal,
  ): Promise<ShellExecutionResult> {
    if ((request.kernelMode ?? "ephemeral") !== "persistent") {
      throw new Error("Shell session manager requires persistent mode");
    }
    if (!request.executionId?.trim()) throw new Error("Execution ID is required");
    if (request.permissionEpoch.executeGrantScope === "once") {
      throw new Error("Persistent shell sessions are not allowed for once-scoped execute grants");
    }
    if (request.permissionEpoch.networkPolicy !== "none") {
      throw new Error("Persistent shell sessions require networkPolicy=none");
    }
    if (request.permissionEpoch.mounts.length !== 1
      || request.permissionEpoch.mounts[0]?.source !== "workspace"
      || request.permissionEpoch.mounts[0]?.mode !== "read-write") {
      throw new Error("Persistent shell sessions accept exactly one read-write workspace mount");
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

    const sessionId = request.permissionEpoch.sessionId;
    const agentKey = agentExecutionKey(sessionId, request.agentId);
    for (const [existingKey, existing] of this.sessions) {
      if (existingKey === key || existing.session.sessionId !== sessionId) continue;
      if (existing.session.agentId !== request.agentId) continue;
      await existing.stop("Permission Epoch changed; the persistent shell environment was lost");
    }
    let shellSession = this.sessions.get(key);
    if (shellSession?.isStopped) {
      this.lostState.set(agentKey, shellSession.session.memoryLostReason
        ?? "Persistent shell session exited; the persistent shell environment was lost");
      this.sessions.delete(key);
      this.profiles.clear(sessionId, request.agentId, request.permissionEpoch.id);
      shellSession = undefined;
    }
    if (!shellSession) {
      shellSession = await this.startSession(request, key, workspaceRoot, readOnlyWorkspaceRoot);
      this.sessions.set(key, shellSession);
    } else if (shellSession.workspaceRoot !== workspaceRoot
      || shellSession.readOnlyWorkspaceRoot !== readOnlyWorkspaceRoot) {
      throw new Error("Persistent shell Session-Agent identity cannot be reused with different workspace mounts");
    }
    // Snapshot before evaluating: a loss caused by THIS evaluation (e.g. user
    // `exit`) must surface on the NEXT call, not consume itself here.
    const memoryStateLost = this.lostState.has(agentKey) ? this.takeLostState(agentKey) : undefined;

    const before = await workspaceSnapshot(workspaceRoot);
    const startedAt = new Date().toISOString();
    let checkingQuota = false;
    const quotaTimer = maxWorkspaceBytes > 0
      ? setInterval(() => {
          if (checkingQuota) return;
          checkingQuota = true;
          void workspaceUsageBytes(workspaceRoot).then((bytes) => {
            if (bytes > maxWorkspaceBytes) void shellSession!.stop(workspaceQuotaExceededMessage(maxWorkspaceBytes));
          }).finally(() => { checkingQuota = false; });
        }, 100)
      : undefined;
    let response: ShellEvalResponse;
    try {
      response = await shellSession.evaluate(
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
    // Sediment the post-eval shell state for later cross-language injection.
    // Skipped when the session died mid-eval (the exit trap still reported).
    if (!shellSession.isStopped) {
      this.profiles.update(sessionId, request.agentId, request.permissionEpoch.id, response.cwd, response.env);
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
      environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
      environmentVariables: response.env,
      executionId: request.executionId,
      exitCode: response.exitCode,
      finishedAt: new Date().toISOString(),
      kernelId: shellSession.session.id,
      kernelMode: "persistent",
      language: "shell",
      ...(memoryStateLost !== undefined ? { memoryStateLost } : {}),
      modifiedFiles,
      networkPolicy: "none",
      runnerVersion: RUNNER_VERSION,
      sandbox: "bubblewrap",
      startedAt,
      stderr: response.stderr,
      stdout: response.stdout,
      workingDirectory: response.cwd,
    };
  }

  async teardownSession(sessionId: string, reason: string): Promise<number> {
    let count = 0;
    for (const shellSession of [...this.sessions.values()]) {
      if (shellSession.session.sessionId !== sessionId) continue;
      await shellSession.stop(reason);
      count += 1;
    }
    this.profiles.clearSession(sessionId);
    return count;
  }

  async teardownKernel(kernelId: string, reason: string): Promise<number> {
    for (const shellSession of [...this.sessions.values()]) {
      if (shellSession.session.id !== kernelId) continue;
      await shellSession.stop(reason);
      return 1;
    }
    return 0;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((shellSession) => shellSession.stop("Runner stopped")));
    this.sessions.clear();
    this.lostState.clear();
  }

  private takeLostState(agentKey: string): string {
    const reason = this.lostState.get(agentKey)!;
    this.lostState.delete(agentKey);
    return reason;
  }

  private async startSession(
    request: ShellExecutionRequest,
    key: string,
    workspaceRoot: string,
    readOnlyWorkspaceRoot: string | undefined,
  ): Promise<ManagedShellSession> {
    const id = `shell-${randomUUID()}`;
    const filter = await open(await ensureBaselineSeccompFilter(this.config.dataDir), "r");
    const workspaceBinds = workspaceBindArguments(workspaceRoot, readOnlyWorkspaceRoot);
    // A fresh session always starts from the clearenv baseline: the profile is
    // produced by this shell, not consumed by it.
    const launch = buildSandboxLaunch({
      chdir: workspaceBinds.chdir,
      ...await sandboxLaunchProfile(this.config.bwrapPath),
      environmentBinds: [],
      hostInterpreterMasks: [],
      hostRuntimeSupport: await hostRuntimeSupportArguments(),
      language: "shell",
      pathEnv: "/usr/bin",
      workspaceBindArgs: workspaceBinds.args,
    });
    const bwrapArguments = [...launch.args, "/usr/bin/bash", "--noprofile", "--norc", "-c", SHELL_SESSION_WORKER];
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
      throw new Error("Runner failed to create persistent shell streams");
    }
    const now = new Date();
    const idleTimeoutMs = executionTimeoutMs(request.kernelIdleTimeoutMs, this.idleTimeoutMs);
    const session: KernelSession = {
      agentId: request.agentId,
      createdAt: now.toISOString(),
      environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
      ...(idleTimeoutMs > 0 ? { expiresAt: new Date(now.getTime() + idleTimeoutMs).toISOString() } : {}),
      id,
      kernelMode: "persistent",
      language: "shell",
      lastUsedAt: now.toISOString(),
      permissionEpochId: request.permissionEpoch.id,
      sessionId: request.permissionEpoch.sessionId,
      status: "running",
    };
    return new ManagedShellSession(
      child as ChildProcessWithoutNullStreams,
      session,
      workspaceRoot,
      readOnlyWorkspaceRoot,
      idleTimeoutMs,
      (shellSession, reason) => {
        if (this.sessions.get(key) === shellSession) this.sessions.delete(key);
        this.lostState.set(agentExecutionKey(shellSession.session.sessionId, shellSession.session.agentId), reason);
        this.profiles.clear(
          shellSession.session.sessionId,
          shellSession.session.agentId,
          shellSession.session.permissionEpochId,
        );
      },
    );
  }
}
