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

import type {
  RunnerCheckResult,
  AgentShellExecution,
  Environment,
  KernelMode,
  ResolvedProxy,
} from "@sciencediscovery/schema";
import type { WorkspaceAgentOptions } from "@sciencediscovery/workspace";
import { RunnerUnavailableError } from "@sciencediscovery/workspace";
import { createHash, randomUUID } from "node:crypto";
import { createOperationalLogger } from "@sciencediscovery/operational-logging";

import type { ProvenanceRecorder } from "@sciencediscovery/provenance";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { SessionStore } from "../store.js";
import { resolveEnvironmentInstallRequest } from "../environment-sources.js";
import type { AgentPermissionRuntime } from "@sciencediscovery/governance";
import { syncScientificEnvironmentCatalog } from "../scientific-environment-catalog.js";
import { readPreparedSkillBundle, readPreparedSkillManifest } from "../skill-sandbox.js";

type ExecutionBindings = Pick<
  WorkspaceAgentOptions,
  "directExecution" | "environmentManagement" | "executePython" | "executeScientific" | "executeShell" | "npuBroker" | "observeNpuJob" | "workspaceTransfers" | "shellExecutions" | "timers" | "runnerReadiness"
>;

/**
 * A remote machine this Session is allowed to use. Resolution happens per call
 * rather than per run so a machine removed from the allowlist stops working
 * immediately, and so a run that never names one never touches SSH at all.
 */
export interface RemoteExecutionTarget {
  runnerId: string;
  hostAlias: string;
  /** Throws with an actionable message when the machine is no longer allowed or not connected. */
  runnerClient: () => RunnerClient;
  /** Logical workspace on that machine; keeps its files out of local provenance. */
  workspaceKey: string;
}

export interface WorkspaceExecutionBindingOptions {
  beginExternalWait?: () => (() => void);
  agentId: string;
  rootRunId?: string;
  artifactPathPrefix?: string;
  executionId: string;
  executionTimeoutMs?: number;
  kernelIdleTimeoutMs?: number;
  maxOutputBytes?: number;
  maxWorkspaceBytes?: number;
  npuBrokerEnabled?: boolean;
  permission: AgentPermissionRuntime;
  permissionScopeLabel: string;
  provenanceRecorder: ProvenanceRecorder;
  readOnlyWorkspaceRoot?: string;
  skillPackagesRoot?: string;
  /** The built-in Runner, used by default only when selected for this Session. */
  runnerClient: RunnerClient;
  remoteTargets?: RemoteExecutionTarget[];
  scientificEnvironments?: Environment[];
  sessionId: string;
  store: SessionStore;
  workspaceRoot: string;
  /** When set, this workspace runs inside a subagent: passed through to
   * provenanceRecorder.execute* so products hang off the subagent's child
   * SubTask instead of a per-execution SubTask. Absent in main-agent context. */
  parentSubagentId?: string;
}

/** Build the shared governed handlers; only identity and observability policy differ. */
export function createWorkspaceExecutionBindings(
  options: WorkspaceExecutionBindingOptions,
): ExecutionBindings {
  const executionLogger = () => createOperationalLogger({ category: "api", service: "api", dataDir: options.store.dataDir });
  const requireEnvironmentMutation = async (summary: string, signal?: AbortSignal, runnerId?: string): Promise<void> => {
    options.store.assertSessionWritable(options.sessionId);
    await options.permission.requirePrivilege({
      action: "code",
      executionId: options.executionId,
      resource: "scientific-environments",
      signal,
      summary: runnerId && runnerId !== "local" ? `${summary} on Runner ${runnerId}` : summary,
    });
  };
  const refreshEnvironmentCatalog = async () => {
    await syncScientificEnvironmentCatalog(options.store, options.runnerClient, options.provenanceRecorder);
  };
  /**
   * Resolve the egress route for this execution at call time, so a proxy
   * registry edit lands on the next run without waiting for an epoch rotation.
   * Spread into the recorder options, which keeps the field absent — rather
   * than explicitly undefined — for a sandbox with no network.
   */
  const sandboxEgressProxy = (): { sandboxEgressProxy?: ResolvedProxy } => {
    const resolved = options.store.resolveSandboxEgressProxy(options.permission.getEpoch());
    return resolved ? { sandboxEgressProxy: resolved } : {};
  };
  /**
   * The NPU cards the operator ticked for whichever Runner this execution
   * lands on. Resolved per execution rather than per Session: the selection is
   * a property of the machine, and a Session that switches machines must get
   * that machine's cards. Spread so an empty selection leaves the field absent
   * and the sandbox stays exactly as it is without NPUs.
   */
  const npuDevices = (runnerId: string): { npuDevices?: number[] } => {
    const selected = options.store.npuDeviceSelection(runnerId);
    return selected.length > 0 ? { npuDevices: selected } : {};
  };
  /**
   * Where one execution runs. Anything but the local machine has to be named
   * explicitly, and only names on this Session's allowlist resolve: being
   * allowed to use a remote machine never moves the default off this one.
   */
  const resolveExecutionTarget = (machine: string | undefined): {
    remoteHostAlias?: string;
    runnerId: string;
    runnerClient: RunnerClient;
    runnerWorkspaceKey?: string;
    skillPackagesRoot?: string;
  } => {
    const requested = machine?.trim();
    options.store.assertSessionAllowsRunner(options.sessionId, requested || "local");
    if (!requested || requested === "local") {
      return {
        runnerId: "local",
        runnerClient: options.runnerClient,
        ...(options.skillPackagesRoot ? { skillPackagesRoot: options.skillPackagesRoot } : {}),
      };
    }
    const target = options.remoteTargets?.find((candidate) => candidate.runnerId === requested);
    if (!target) {
      const allowed = options.remoteTargets?.map((candidate) => candidate.runnerId) ?? [];
      throw new Error(allowed.length
        ? `This Session may not run on ${requested}; allowed machines: local, ${allowed.join(", ")}`
        : `This Session may only run on the local machine`);
    }
    return {
      runnerId: target.runnerId,
      remoteHostAlias: target.hostAlias,
      // Resolve connection lazily: an offline remote is a readiness outcome,
      // not a failure while merely constructing an approval description.
      get runnerClient() { return target.runnerClient(); },
      runnerWorkspaceKey: target.workspaceKey,
    };
  };
  /**
   * The execution's machine, with this run's frozen Skill packages already on
   * it. A remote Runner cannot mount this machine's staging root, so the
   * selected packages are synced to that Runner and it reports back its own
   * mount path; a failed sync fails the execution rather than running without
   * the Skills the Session selected.
   */
  // These records describe FAILED calls, not scheduled executions. They only
  // let this agent explicitly ask the user about an operation it attempted.
  const blockedOperations = new Map<string, { runner: RunnerCheckResult; toolCallId?: string; summary: string }>();
  const waitingOperations = new Set<string>();
  const checkRunner = async (machine?: string, signal?: AbortSignal, refresh = true): Promise<RunnerCheckResult> => {
    signal?.throwIfAborted();
    options.store.assertSessionWritable(options.sessionId);
    const runnerId = machine?.trim() || "local";
    options.store.assertSessionAllowsRunner(options.sessionId, runnerId);
    if (runnerId !== "local" && !options.remoteTargets?.some(x => x.runnerId === runnerId)) {
      throw new Error("Runner is not available to this Agent");
    }
    let result: RunnerCheckResult;
    try {
      const capability = await resolveExecutionTarget(runnerId).runnerClient.executionCapability(refresh, signal);
      const ready = capability.ready === true;
      result = { runnerId, checkedAt: capability.checkedAt ?? new Date().toISOString(), connected: true, ready,
        reason: ready ? "ready" : capability.detail || capability.reason || "Runner execution readiness is unknown",
        capability,
        suggestions: ready ? [] : [capability.reason === "dependency-unavailable"
          ? "Install or repair the sandbox executable on the target Runner; check its configured path."
          : "Inspect the target Runner logs and host/container sandbox permissions. Do not disable isolation automatically.",
          "After repair use check_runner, or explicitly request user help with wait_for_runner."] };
    } catch (error) {
      result = { runnerId, checkedAt: new Date().toISOString(), connected: false, ready: false,
        reason: error instanceof Error ? error.message : String(error),
        suggestions: ["Check the target Runner service, connection, authentication and version. A healthy API is not proof of Runner readiness.",
          "Do not replay an already submitted execution if its outcome is unknown."] };
    }
    signal?.throwIfAborted();
    options.store.assertSessionAllowsRunner(options.sessionId, runnerId);
    return result;
  };
  const prepareExecutionTarget = async (machine: string | undefined, signal?: AbortSignal, toolCallId?: string, summary = "Scientific execution") => {
    const runner = await checkRunner(machine, signal, false);
    if (!runner.ready) {
      const operationId = randomUUID();
      if (blockedOperations.size >= 128) {
        const removable = [...blockedOperations.keys()].find(id => !waitingOperations.has(id));
        if (removable) blockedOperations.delete(removable);
        else throw new Error("Too many pending Runner decisions; resolve existing requests first");
      }
      blockedOperations.set(operationId, { runner, toolCallId, summary: summary.slice(0, 500) });
      throw new RunnerUnavailableError({ code: "RUNNER_UNAVAILABLE", dispatched: false, operationId, runner,
        instruction: "This call has finished without dispatching code. Decide whether to continue other work, explain the blocker and finish, or wait for user help. If you decide to wait, including when the user requested a pause for their decision, call wait_for_runner(operation_id); text saying 'paused' or 'waiting' does not create a pending operation or interactive card. Showing the card does not repair, install, switch machines or execute code and needs no extra confirmation merely to display the requested choices. Preserve the user's constraints after receiving their decision. check_runner is diagnostic only. Do not repeatedly retry unchanged failures. Nothing will execute automatically." });
    }
    let target = resolveExecutionTarget(machine);
    if (target.runnerId !== "local" && options.skillPackagesRoot) {
      const root = options.skillPackagesRoot;
      const mounted = await target.runnerClient.prepareSkillPackages(
        await readPreparedSkillManifest(root),
        () => readPreparedSkillBundle(root),
        signal,
      );
      // A transfer takes time, so the machine is resolved again: a Session that
      // lost this machine meanwhile must not still run on it.
      target = { ...resolveExecutionTarget(machine), skillPackagesRoot: mounted };
    }
    options.store.assertSessionWritable(options.sessionId);
    signal?.throwIfAborted();
    return target;
  };
  const prepareShell = async (
      code: string,
      kernelMode: KernelMode,
      signal?: AbortSignal,
      toolCallId?: string,
      machine?: string,
      environment?: { environmentId?: string; cwd?: string },
    ) => {
      options.store.assertSessionWritable(options.sessionId);
      let target = resolveExecutionTarget(machine);
      await options.permission.requirePrivilege({
        action: "code",
        executionId: options.executionId,
        resource: "workspace-code",
        signal,
        ...(toolCallId ? { toolCallId } : {}),
        summary: `Run a shell script ${target.remoteHostAlias ? `on ${target.remoteHostAlias} ` : ""}${options.permissionScopeLabel}`,
      });
      target = await prepareExecutionTarget(machine, signal, toolCallId, "Run shell: " + code);
      return {
        agentId: options.agentId,
        code,
        ...(environment?.environmentId ? { environmentId: environment.environmentId } : {}),
        ...(environment?.cwd !== undefined ? { cwd: environment.cwd } : {}),
        artifactPathPrefix: options.artifactPathPrefix,
        executionTimeoutMs: options.executionTimeoutMs,
        kernelIdleTimeoutMs: options.kernelIdleTimeoutMs,
        kernelMode,
        maxOutputBytes: options.maxOutputBytes,
        maxWorkspaceBytes: options.maxWorkspaceBytes,
        permissionEpoch: options.permission.getEpoch(),
        ...(options.readOnlyWorkspaceRoot ? { readOnlyWorkspaceRoot: options.readOnlyWorkspaceRoot } : {}),
        ...(target.skillPackagesRoot ? { skillPackagesRoot: target.skillPackagesRoot } : {}),
        runnerId: target.runnerId,
        runnerClient: target.runnerClient,
        ...npuDevices(target.runnerId),
        ...(target.remoteHostAlias ? { remoteHostAlias: target.remoteHostAlias } : {}),
        ...(target.runnerWorkspaceKey ? { runnerWorkspaceKey: target.runnerWorkspaceKey } : {}),
        ...sandboxEgressProxy(),
        sessionId: options.sessionId,
        signal,
        ...(toolCallId ? { toolCallId } : {}),
        turnId: options.executionId,
        workspaceRoot: options.workspaceRoot,
        parentSubagentId: options.parentSubagentId,
      };
  };
  const executionOwner = { sessionId: options.sessionId, agentId: options.agentId };
  const pending = (record: Pick<AgentShellExecution, "state">) => record.state === "queued" || record.state === "running";
  /**
   * A terminal record returned through an Agent tool is delivered: the owner's
   * model has read how the execution ended, so the completion notice retained
   * for it is marked read and cannot start another turn for the same result.
   * A record still queued or running leaves the notice in place; that wake is
   * the one the inbox exists for.
   */
  const delivered = <T extends Pick<AgentShellExecution, "id" | "state">>(record: T): T => {
    if (!pending(record)) options.store.notifications.markRead(executionOwner, "execution", record.id);
    return record;
  };
  const readSessionNpuJob = async (jobId: string) => {
    const job = await options.runnerClient.getNpuJob(jobId, options.sessionId);
    if (job.sessionId !== options.sessionId) throw new Error("NPU job not found in this Session");
    return job;
  };
  // Per-binding tickets cannot be inherited by a child or a later Agent run.
  const directTickets = new Map<string, { command: string; cwd: string; target: string; account: string; workspaceRoot: string; runnerId: string; runnerWorkspaceKey?: string; grantId?: string }>();
  const directScope = async (runnerId: string, cwdValue: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const target = resolveExecutionTarget(runnerId);
    options.store.assertSessionWritable(options.sessionId);
    if (!options.rootRunId) throw new Error("Direct execution requires an active owning run");
    const run = await options.store.getSessionRun(options.sessionId, options.rootRunId);
    if (!run || !["running", "blocked"].includes(run.status)) throw new Error("Direct execution consent ended with its run");
    if (options.store.shellExecutions.list(executionOwner).some(record => record.runnerId === runnerId && record.state === "unknown")) {
      throw new Error("Reconcile the unknown target execution outcome before authorizing more host side effects");
    }
    const runner = await checkRunner(runnerId, signal, true);
    if (!runner.connected || runner.ready) throw new Error("Direct execution requires a reachable Runner with unavailable sandbox");
    const capability = await target.runnerClient.directExecutionCapability(signal, {
      ...(target.runnerWorkspaceKey ? { runnerWorkspaceKey: target.runnerWorkspaceKey } : { workspaceRoot: options.workspaceRoot }), cwd: cwdValue,
    });
    if (!capability.available || capability.workspaceRoot === undefined || capability.cwd === undefined) throw new Error("Target direct shell workspace capability is unavailable");
    // Re-resolve after network I/O: removal from the Session must revoke access.
    resolveExecutionTarget(runnerId);
    signal?.throwIfAborted();
    return { cwd: capability.cwd, workspaceRoot: capability.workspaceRoot, target: capability.target, account: capability.account,
      runnerId, ...(target.runnerWorkspaceKey ? { runnerWorkspaceKey: target.runnerWorkspaceKey } : {}) };
  };
  const common: ExecutionBindings = {
    directExecution: {
      request: async (input, signal, toolCallId) => {
        const blocked = blockedOperations.get(input.operationId);
        if (!blocked || !blocked.runner.connected) throw new Error("Direct consent requires this Agent's failed, undispatched operation");
        if (!input.command.trim() || input.command.length > 20000) throw new Error("Provide a nonempty command of at most 20000 characters");
        const scope = await directScope(blocked.runner.runnerId, input.cwd, signal);
        const resource = "direct:" + createHash("sha256").update(JSON.stringify({ ...scope,
          run: options.executionId, agent: options.agentId, session: options.sessionId, command: input.command })).digest("hex");
        const authorization = await options.permission.requirePrivilege({ action: "direct_code", executionId: options.executionId,
          toolCallId, resource, signal,
          summary: `DIRECT HOST EXECUTION: Runner ${scope.runnerId}, ${scope.target}, account ${scope.account}, workspace ${scope.workspaceRoot}, cwd ${scope.cwd || "."}. No sandbox filesystem, process or network isolation; host credentials may be accessible. Host effects cannot all be tracked or rolled back. Matching consent covers only this exact command and scope during this Agent run, with no fixed TTL. Approval does not execute. Command:\n${input.command}` });
        signal?.throwIfAborted();
        if (authorization.action !== "direct_code" || authorization.outcome !== "allowed" || authorization.resource !== resource) throw new Error("Direct authorization scope mismatch");
        const current = await directScope(blocked.runner.runnerId, input.cwd, signal);
        if (JSON.stringify(current) !== JSON.stringify(scope)) throw new Error("Target or workspace changed during consent; request new consent");
        if (directTickets.size >= 128) throw new Error("Too many unused direct approvals in this run");
        directTickets.set(authorization.id, { ...scope, command: input.command, grantId: authorization.permissionGrantId });
        return { authorizationId: authorization.id, ...scope, command: input.command, dispatched: false,
          instruction: "No code executed. Confirm these values in a NEW run_direct_shell call. Use a new consent request for any changed scope." };
      },
      start: async (input, signal, toolCallId) => {
        signal?.throwIfAborted();
        const ticket = directTickets.get(input.authorizationId);
        if (!ticket || ticket.command !== input.command || ticket.cwd !== input.cwd || ticket.target !== input.target || ticket.account !== input.account) {
          throw new Error("Missing, consumed or mismatched direct execution authorization");
        }
        // Consume before the first await: simultaneous calls cannot both dispatch.
        directTickets.delete(input.authorizationId);
        const scope = await directScope(ticket.runnerId, input.cwd, signal);
        if (scope.runnerWorkspaceKey !== ticket.runnerWorkspaceKey || scope.cwd !== ticket.cwd || scope.workspaceRoot !== ticket.workspaceRoot || scope.target !== ticket.target || scope.account !== ticket.account) throw new Error("Direct target/account/workspace changed");
        if (ticket.grantId && options.store.getPermissionGrant(ticket.grantId)?.state !== "active") throw new Error("Direct execution grant was revoked");
        signal?.throwIfAborted();
        const directAuthorization = { authorizationId: input.authorizationId, ...scope, runId: options.executionId, agentId: options.agentId };
        return delivered(await options.store.shellExecutions.start(executionOwner, {
          runnerId: ticket.runnerId, turnId: options.executionId, workspaceId: options.store.workspaceIdentity(options.sessionId, options.agentId, ticket.runnerId).id,
        }, () => resolveExecutionTarget(ticket.runnerId).runnerClient,
        (id, dispatch, completionStatus) => options.provenanceRecorder.executeShell({
          agentId: options.agentId, code: ticket.command, cwd: ticket.cwd, directAuthorization,
          executionId: id, dispatch, completionStatus, executionTimeoutMs: options.executionTimeoutMs,
          maxOutputBytes: options.maxOutputBytes, maxWorkspaceBytes: options.maxWorkspaceBytes,
          artifactPathPrefix: options.artifactPathPrefix, parentSubagentId: options.parentSubagentId,
          permissionEpoch: options.permission.getEpoch(), runnerId: ticket.runnerId, runnerClient: resolveExecutionTarget(ticket.runnerId).runnerClient,
          ...(ticket.runnerWorkspaceKey ? { runnerWorkspaceKey: ticket.runnerWorkspaceKey } : {}),
          ...(resolveExecutionTarget(ticket.runnerId).remoteHostAlias ? { remoteHostAlias: resolveExecutionTarget(ticket.runnerId).remoteHostAlias } : {}),
          sessionId: options.sessionId, toolCallId, turnId: options.executionId, workspaceRoot: ticket.workspaceRoot,
        })));
      },
    },
    runnerReadiness: {
      check: (machine, signal) => checkRunner(machine, signal),
      wait: async (operationId, signal, waitToolCallId) => {
        signal?.throwIfAborted();
        const operation = blockedOperations.get(operationId);
        if (!operation || waitingOperations.has(operationId)) throw new Error("Unknown, expired or already waiting operation for this Agent run");
        options.store.assertSessionWritable(options.sessionId);
        options.store.assertSessionAllowsRunner(options.sessionId, operation.runner.runnerId);
        waitingOperations.add(operationId);
        let release: (() => void) | undefined;
        try {
          release = options.beginExternalWait?.();
          const alternatives = [];
          for (const runnerId of options.store.effectiveRunnerIds(options.sessionId)) {
            if (runnerId === operation.runner.runnerId) continue;
            try {
              if ((await checkRunner(runnerId, signal, false)).ready) alternatives.push({ runnerId, label: runnerId });
            } catch { signal?.throwIfAborted(); }
          }
          const blocked = { sessionId: options.sessionId, executionId: options.executionId,
            agentId: options.agentId, operationId, toolCallId: operation.toolCallId,
            runnerId: operation.runner.runnerId, reason: operation.runner.reason,
            suggestions: operation.runner.suggestions, summary: operation.summary, alternatives };
          executionLogger().info("runner_wait_requested", { ...blocked, waitToolCallId });
          const decision = await options.store.executionBlocks.wait(blocked, signal);
          blockedOperations.delete(operationId);
          signal?.throwIfAborted();
          options.store.assertSessionWritable(options.sessionId);
          executionLogger().info("execution_decision", { ...blocked, decision });
          if (decision.action === "cancel") return { action: "cancel", operationId, dispatched: false,
            instruction: "This operation was cancelled or the wait expired. Do not resubmit it without a new user request. You may continue unrelated work." };
          const runner = await checkRunner(decision.action === "switch" ? decision.runnerId : operation.runner.runnerId, signal);
          operation.runner = runner;
          if (!runner.ready) blockedOperations.set(operationId, operation);
          // Never execute here: a completed failed call cannot come back to life.
          return { action: decision.action, operationId, dispatched: false, runner,
            instruction: runner.ready
              ? "Runner is ready. No code was executed. Decide whether to issue a NEW execution call. For a switched Runner prepare its workspace, inputs and environment first; normal permissions still apply."
              : "Runner is still unavailable. No code was executed. Decide whether to wait again, do other work or finish; do not automatically retry." };
        } finally {
          release?.(); waitingOperations.delete(operationId);
          // Failed rechecks can be discussed and explicitly waited on again.
          if (signal?.aborted) blockedOperations.delete(operationId);
        }
      },
    },
    timers: {
      create: async (input) => {
        options.store.assertSessionWritable(options.sessionId);
        if ((input.afterMs === undefined) === (input.at === undefined)) throw new Error("Provide exactly one of after_ms or at");
        if (input.afterMs !== undefined && (!Number.isSafeInteger(input.afterMs) || input.afterMs <= 0)) throw new Error("after_ms must be a positive integer");
        if (input.at !== undefined && !/(Z|[+-]\d{2}:\d{2})$/.test(input.at)) throw new Error("at requires an ISO timestamp with timezone");
        const owner = { sessionId: options.sessionId, agentId: options.agentId };
        if (input.executionId) await options.store.shellExecutions.get(input.executionId, owner);
        return options.store.notifications.createTimer(owner, { dueAt: input.at !== undefined ? Date.parse(input.at) : Date.now() + input.afterMs!,
          message: input.message, executionId: input.executionId });
      },
      list: () => options.store.notifications.timers({ sessionId: options.sessionId, agentId: options.agentId }),
      cancel: (id) => {
        const owner = { sessionId: options.sessionId, agentId: options.agentId };
        options.store.notifications.cancelTimer(owner, id);
        return options.store.notifications.timers(owner).find((timer) => timer.id === id);
      },
    },
    workspaceTransfers: {
      workspaces: () => {
        const candidates = [{ runnerId: "local", description: "Local Workspace" }, ...(options.remoteTargets ?? []).map((target) => ({ runnerId: target.runnerId, description: target.hostAlias }))];
        return candidates.filter((candidate) => {
          try { if (candidate.runnerId !== "local") options.store.assertSessionAllowsRemoteRunner(options.sessionId, candidate.runnerId); return true; } catch { return false; }
        }).map((candidate) => ({ ...candidate, id: options.store.workspaceIdentity(options.sessionId, options.agentId, candidate.runnerId).id }));
      },
      list: () => options.store.transfers.list({ sessionId: options.sessionId, agentId: options.agentId }),
      get: (id: string) => options.store.transfers.get(id, { sessionId: options.sessionId, agentId: options.agentId }),
      cancel: (id: string) => options.store.transfers.cancel(id, { sessionId: options.sessionId, agentId: options.agentId }),
      start: async (input: import("@sciencediscovery/schema").WorkspaceTransferInput, signal?: AbortSignal) => {
        const resolve = (id: string): import("../workspace-transfers.js").TransferEndpoint => {
          options.store.assertSessionWritable(options.sessionId);
          if (id === options.store.workspaceIdentity(options.sessionId, options.agentId).id) return { id, root: options.workspaceRoot };
          const target = options.remoteTargets?.find((target) => options.store.workspaceIdentity(options.sessionId, options.agentId, target.runnerId).id === id);
          if (!target) throw new Error("Workspace is not owned by this Agent or its allowed Runners");
          options.store.assertSessionAllowsRemoteRunner(options.sessionId, target.runnerId);
          return { id, runner: target.runnerClient(), workspaceKey: target.workspaceKey };
        };
        resolve(input.sourceWorkspaceId); resolve(input.targetWorkspaceId);
        await options.permission.requirePrivilege({ action: "host", executionId: options.executionId,
          resource: `workspace-transfer:${input.sourceWorkspaceId}:${input.targetWorkspaceId}`, signal,
          summary: `Copy ${input.files.length} selected files between authorized Workspaces` });
        signal?.throwIfAborted();
        resolve(input.sourceWorkspaceId); resolve(input.targetWorkspaceId);
        return options.store.transfers.start({ sessionId: options.sessionId, agentId: options.agentId }, input, { resolve,
          committed: async (file, transfer) => {
            if (transfer.targetWorkspaceId !== options.store.workspaceIdentity(options.sessionId, options.agentId).id) return;
            await options.store.recordWorkspaceFileRevision(options.sessionId, {
              path: options.artifactPathPrefix ? `${options.artifactPathPrefix}/${file.targetPath}` : file.targetPath,
              mode: "write", origin: "system", size: file.size, contentHash: file.sha256, modifiedAt: new Date().toISOString(),
              ...(options.parentSubagentId ? { subagentId: options.parentSubagentId } : {}),
              originMeta: { transferId: transfer.id, sourceSnapshotId: transfer.sourceSnapshotId!,
                sourceWorkspaceId: transfer.sourceWorkspaceId, workspaceId: transfer.targetWorkspaceId },
            });
          },
        });
      },
    },
    ...(options.npuBrokerEnabled ? { npuBroker: {
      cancel: async (jobId: string, signal?: AbortSignal) => {
        options.store.assertSessionWritable(options.sessionId);
        await readSessionNpuJob(jobId);
        await options.permission.requirePrivilege({
          action: "code",
          executionId: options.executionId,
          resource: `npu-job:${jobId}`,
          signal,
          summary: `Cancel host NPU job ${jobId} ${options.permissionScopeLabel}`,
        });
        return await options.runnerClient.cancelNpuJob(jobId, options.sessionId);
      },
      get: async (jobId: string) => await readSessionNpuJob(jobId),
      listWorkloads: async () => await options.runnerClient.listNpuWorkloads(),
      logs: async (jobId: string) => {
        await readSessionNpuJob(jobId);
        return await options.runnerClient.npuJobLogs(jobId, options.sessionId);
      },
      result: async (jobId: string) => {
        await readSessionNpuJob(jobId);
        return await options.runnerClient.npuJobResult(jobId, options.sessionId);
      },
      submit: async (input: Parameters<NonNullable<WorkspaceAgentOptions["npuBroker"]>["submit"]>[0], signal?: AbortSignal) => {
        resolveExecutionTarget("local");
        await options.permission.requirePrivilege({
          action: "code",
          executionId: options.executionId,
          resource: `npu:${input.workloadId}`,
          signal,
          summary: `Run host NPU workload ${input.workloadId} ${options.permissionScopeLabel}`,
        });
        resolveExecutionTarget("local");
        const { environmentId: selectedId, ...request } = input;
        let environmentId = selectedId;
        const epochRevision = options.permission.getEpoch().environmentRevisionId;
        if (!environmentId && epochRevision) {
          // An epoch freezes audit context, not the executable environment version.
          const revisions = await options.runnerClient.listEnvironmentRevisions();
          environmentId = revisions.find((revision) => revision.id === epochRevision)?.environmentId;
        }
        const environment = environmentId
          ? (await options.runnerClient.listEnvironments()).find((entry) => entry.id === environmentId) : undefined;
        if (environmentId && (!environment || environment.status !== "ready")) throw new Error("Managed environment is missing or not ready");
        return await options.runnerClient.submitNpuJob({
          ...request,
          ...(environment ? { environmentRevisionId: environment.currentRevisionId } : {}),
          sessionId: options.sessionId,
          workspaceRoot: options.workspaceRoot,
        });
      },
    }, observeNpuJob: (job: import("@sciencediscovery/schema").NpuJob, artifacts: Array<{ artifact_id: string; path: string; version: number }>) => {
      // Fire-and-forget mirror: the recorder swallows its own failures (it
      // skips non-terminal jobs and the sink catches its own errors). Wrap in
      // a try/catch here too so a synchronous throw inside the recorder never
      // surfaces to the surrounding ``result`` binding, which would otherwise
      // tear down the agent's view of its own result.
      try {
        options.provenanceRecorder.observeNpuJob(job, {
          artifacts,
          parentSubagentId: options.parentSubagentId,
          sessionId: options.sessionId,
          turnId: options.executionId,
        });
      } catch {
        // Intentional: memory-graph mirror is fire-and-forget.
      }
    } } : {}),
    executePython: async (code: string, signal?: AbortSignal, toolCallId?: string, machine?: string) => {
      options.store.assertSessionWritable(options.sessionId);
      let target = resolveExecutionTarget(machine);
      await options.permission.requirePrivilege({
        action: "code",
        executionId: options.executionId,
        resource: "workspace-code",
        signal,
        ...(toolCallId ? { toolCallId } : {}),
        summary: `Run Python code ${target.remoteHostAlias ? `on ${target.remoteHostAlias} ` : ""}${options.permissionScopeLabel}`,
      });
      target = await prepareExecutionTarget(machine, signal, toolCallId, "Run Python: " + code);
      return options.provenanceRecorder.executePython({
        agentId: options.agentId,
        code,
        artifactPathPrefix: options.artifactPathPrefix,
        executionTimeoutMs: options.executionTimeoutMs,
        kernelIdleTimeoutMs: options.kernelIdleTimeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        maxWorkspaceBytes: options.maxWorkspaceBytes,
        permissionEpoch: options.permission.getEpoch(),
        ...(options.readOnlyWorkspaceRoot ? { readOnlyWorkspaceRoot: options.readOnlyWorkspaceRoot } : {}),
        ...(target.skillPackagesRoot ? { skillPackagesRoot: target.skillPackagesRoot } : {}),
        runnerId: target.runnerId,
        runnerClient: target.runnerClient,
        ...npuDevices(target.runnerId),
        ...(target.remoteHostAlias ? { remoteHostAlias: target.remoteHostAlias } : {}),
        ...(target.runnerWorkspaceKey ? { runnerWorkspaceKey: target.runnerWorkspaceKey } : {}),
        ...sandboxEgressProxy(),
        sessionId: options.sessionId,
        signal,
        ...(toolCallId ? { toolCallId } : {}),
        turnId: options.executionId,
        workspaceRoot: options.workspaceRoot,
        parentSubagentId: options.parentSubagentId,
      });
    },
    executeShell: async (...args) => options.provenanceRecorder.executeShell(await prepareShell(...args)),
    shellExecutions: {
      start: async (code, environment, signal, toolCallId, runnerId) => {
        const prepared = await prepareShell(code, "ephemeral", signal, toolCallId, runnerId, environment);
        return delivered(await options.store.shellExecutions.start(executionOwner, {
          runnerId: prepared.runnerId!, turnId: options.executionId,
          workspaceId: options.store.workspaceIdentity(options.sessionId, options.agentId, prepared.runnerId).id,
        }, () => resolveExecutionTarget(runnerId).runnerClient,
        (id, dispatch, completionStatus) => options.provenanceRecorder.executeShell({ ...prepared, signal: undefined, executionId: id, dispatch, completionStatus })));
      },
      wait: async (id, waitMs, signal) => {
        const record = await options.store.shellExecutions.get(id, executionOwner);
        if (record.runnerId !== "local") options.store.assertSessionAllowsRemoteRunner(options.sessionId, record.runnerId);
        return delivered(await options.store.shellExecutions.wait(id, executionOwner, waitMs, signal));
      },
      list: () => options.store.shellExecutions.list(executionOwner).filter((record) => {
        try { if (record.runnerId !== "local") options.store.assertSessionAllowsRemoteRunner(options.sessionId, record.runnerId); return true; } catch { return false; }
      }).map(delivered),
      get: async (id) => {
        const record = await options.store.shellExecutions.get(id, executionOwner);
        if (record.runnerId !== "local") options.store.assertSessionAllowsRemoteRunner(options.sessionId, record.runnerId);
        return delivered(record);
      },
      logs: async (id, cursor) => {
        const page = await options.store.shellExecutions.logs(id, executionOwner, (runnerId) => resolveExecutionTarget(runnerId).runnerClient, cursor);
        // The Runner's page says nothing about the outcome, so a finished
        // execution reports it here: the model that read these logs now knows
        // how the command ended, and nothing is left for a wake to tell it.
        const record = delivered(options.store.shellExecutions.find(id, executionOwner));
        return pending(record) ? page : { ...page, state: record.state, ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}) };
      },
      cancel: async (id) => delivered(await options.store.shellExecutions.cancel(id, executionOwner, (runnerId) => resolveExecutionTarget(runnerId).runnerClient)),
    },
    ...(options.scientificEnvironments || options.remoteTargets?.length ? {
      environmentManagement: {
        create: async (
          input: Parameters<NonNullable<WorkspaceAgentOptions["environmentManagement"]>["create"]>[0],
          signal?: AbortSignal,
          runnerId?: string,
        ) => {
          resolveExecutionTarget(runnerId);
          await requireEnvironmentMutation(`Create named ${input.language} environment ${input.name}`, signal, runnerId);
          const target = resolveExecutionTarget(runnerId);
          const environment = await target.runnerClient.createEnvironment(input);
          if (!target.runnerWorkspaceKey) await refreshEnvironmentCatalog();
          return environment;
        },
        delete: async (environmentId: string, signal?: AbortSignal, runnerId?: string) => {
          resolveExecutionTarget(runnerId);
          await requireEnvironmentMutation(`Delete named environment ${environmentId}`, signal, runnerId);
          const target = resolveExecutionTarget(runnerId);
          await target.runnerClient.deleteEnvironment(environmentId);
          if (!target.runnerWorkspaceKey) await refreshEnvironmentCatalog();
        },
        install: async (
          environmentId: string,
          input: Parameters<NonNullable<WorkspaceAgentOptions["environmentManagement"]>["install"]>[1],
          signal?: AbortSignal,
          runnerId?: string,
        ) => {
          resolveExecutionTarget(runnerId);
          const manager = input.manager ?? "conda";
          await requireEnvironmentMutation(`Install ${manager} packages in named environment ${environmentId}`, signal, runnerId);
          const target = resolveExecutionTarget(runnerId);
          const resolved = resolveEnvironmentInstallRequest(input, options.store.getEnvironmentSourceSettings(),
            target.runnerWorkspaceKey ? undefined : options.workspaceRoot);
          const revision = await target.runnerClient.installEnvironment(
            environmentId,
            { ...resolved, ...(target.runnerWorkspaceKey ? { runnerWorkspaceKey: target.runnerWorkspaceKey } : {}) },
          );
          if (!target.runnerWorkspaceKey) await refreshEnvironmentCatalog();
          return revision;
        },
        list: async (_signal?: AbortSignal, runnerId?: string) => {
          const target = resolveExecutionTarget(runnerId);
          if (target.runnerWorkspaceKey) return target.runnerClient.listEnvironments();
          await refreshEnvironmentCatalog();
          return options.store.listEnvironments();
        },
        setup: async (retry: boolean, signal?: AbortSignal, runnerId?: string) => {
          resolveExecutionTarget(runnerId);
          if (retry) await requireEnvironmentMutation("Set up scientific environments on the selected Runner", signal, runnerId);
          const target = resolveExecutionTarget(runnerId);
          return retry ? target.runnerClient.setupScientificEnvironments() : target.runnerClient.getEnvironmentSetup();
        },
        uninstall: async (
          environmentId: string,
          input: Parameters<NonNullable<WorkspaceAgentOptions["environmentManagement"]>["uninstall"]>[1],
          signal?: AbortSignal,
          runnerId?: string,
        ) => {
          resolveExecutionTarget(runnerId);
          await requireEnvironmentMutation(`Uninstall packages from named environment ${environmentId}`, signal, runnerId);
          const target = resolveExecutionTarget(runnerId);
          const revision = await target.runnerClient.uninstallEnvironment(environmentId, input);
          if (!target.runnerWorkspaceKey) await refreshEnvironmentCatalog();
          return revision;
        },
      },
      executeScientific: async (
        language: Parameters<NonNullable<WorkspaceAgentOptions["executeScientific"]>>[0],
        code: string,
        environmentRevisionId: string | undefined,
        kernelMode: Parameters<NonNullable<WorkspaceAgentOptions["executeScientific"]>>[3],
        signal?: AbortSignal,
        toolCallId?: string,
        machine?: string,
      ) => {
        options.store.assertSessionWritable(options.sessionId);
        let target = resolveExecutionTarget(machine);
        await options.permission.requirePrivilege({
          action: "code",
          executionId: options.executionId,
          resource: "workspace-code",
          signal,
          ...(toolCallId ? { toolCallId } : {}),
          summary: `Run ${language} code ${target.remoteHostAlias ? `on ${target.remoteHostAlias} ` : ""}${options.permissionScopeLabel}`,
        });
        target = await prepareExecutionTarget(machine, signal, toolCallId, "Run scientific code: " + code);
        return options.provenanceRecorder.executeScientific({
          agentId: options.agentId,
          code,
          artifactPathPrefix: options.artifactPathPrefix,
          environmentRevisionId,
          executionTimeoutMs: options.executionTimeoutMs,
          kernelIdleTimeoutMs: options.kernelIdleTimeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          maxWorkspaceBytes: options.maxWorkspaceBytes,
          kernelMode,
          language,
          permissionEpoch: options.permission.getEpoch(),
          ...(options.readOnlyWorkspaceRoot ? { readOnlyWorkspaceRoot: options.readOnlyWorkspaceRoot } : {}),
          ...(target.skillPackagesRoot ? { skillPackagesRoot: target.skillPackagesRoot } : {}),
          runnerId: target.runnerId,
          runnerClient: target.runnerClient,
          ...npuDevices(target.runnerId),
          ...(target.remoteHostAlias ? { remoteHostAlias: target.remoteHostAlias } : {}),
          ...(target.runnerWorkspaceKey ? { runnerWorkspaceKey: target.runnerWorkspaceKey } : {}),
          ...sandboxEgressProxy(),
          sessionId: options.sessionId,
          signal,
          ...(toolCallId ? { toolCallId } : {}),
          turnId: options.executionId,
          workspaceRoot: options.workspaceRoot,
          parentSubagentId: options.parentSubagentId,
        });
      },
    } : {}),
  };
  return common;
}
