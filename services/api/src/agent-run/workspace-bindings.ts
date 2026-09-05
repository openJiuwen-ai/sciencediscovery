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
  Environment,
  KernelMode,
  ResolvedProxy,
} from "@sciencediscovery/schema";
import type { WorkspaceAgentOptions } from "@sciencediscovery/workspace";

import type { ProvenanceRecorder } from "@sciencediscovery/provenance";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { SessionStore } from "../store.js";
import { resolveEnvironmentInstallRequest } from "../environment-sources.js";
import type { AgentPermissionRuntime } from "@sciencediscovery/governance";
import { syncScientificEnvironmentCatalog } from "../scientific-environment-catalog.js";

type ExecutionBindings = Pick<
  WorkspaceAgentOptions,
  "environmentManagement" | "executePython" | "executeScientific" | "executeShell" | "npuBroker"
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
  agentId: string;
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
  /** The local runner: always available, and the default for every execution. */
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
  const requireEnvironmentMutation = async (summary: string, signal?: AbortSignal): Promise<void> => {
    options.store.assertSessionWritable(options.sessionId);
    await options.permission.requirePrivilege({
      action: "code",
      executionId: options.executionId,
      resource: "scientific-environments",
      signal,
      summary,
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
    // Skill packages are staged on this machine, so a remote execution reads
    // its Skill resources through the tool instead of a mounted package.
    return {
      runnerId: target.runnerId,
      remoteHostAlias: target.hostAlias,
      runnerClient: target.runnerClient(),
      runnerWorkspaceKey: target.workspaceKey,
    };
  };
  const readSessionNpuJob = async (jobId: string) => {
    const job = await options.runnerClient.getNpuJob(jobId, options.sessionId);
    if (job.sessionId !== options.sessionId) throw new Error("NPU job not found in this Session");
    return job;
  };
  const common = {
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
        options.store.assertSessionWritable(options.sessionId);
        await options.permission.requirePrivilege({
          action: "code",
          executionId: options.executionId,
          resource: `npu:${input.workloadId}`,
          signal,
          summary: `Run host NPU workload ${input.workloadId} ${options.permissionScopeLabel}`,
        });
        return await options.runnerClient.submitNpuJob({
          ...input,
          environmentRevisionId: input.environmentRevisionId
            ?? options.permission.getEpoch().environmentRevisionId,
          sessionId: options.sessionId,
          workspaceRoot: options.workspaceRoot,
        });
      },
    } } : {}),
    executePython: async (code: string, signal?: AbortSignal, toolCallId?: string, machine?: string) => {
      options.store.assertSessionWritable(options.sessionId);
      const target = resolveExecutionTarget(machine);
      await options.permission.requirePrivilege({
        action: "code",
        executionId: options.executionId,
        resource: "workspace-code",
        signal,
        ...(toolCallId ? { toolCallId } : {}),
        summary: `Run Python code ${target.remoteHostAlias ? `on ${target.remoteHostAlias} ` : ""}${options.permissionScopeLabel}`,
      });
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
    executeShell: async (
      code: string,
      kernelMode: KernelMode,
      signal?: AbortSignal,
      toolCallId?: string,
      machine?: string,
    ) => {
      options.store.assertSessionWritable(options.sessionId);
      const target = resolveExecutionTarget(machine);
      await options.permission.requirePrivilege({
        action: "code",
        executionId: options.executionId,
        resource: "workspace-code",
        signal,
        ...(toolCallId ? { toolCallId } : {}),
        summary: `Run a shell script ${target.remoteHostAlias ? `on ${target.remoteHostAlias} ` : ""}${options.permissionScopeLabel}`,
      });
      return options.provenanceRecorder.executeShell({
        agentId: options.agentId,
        code,
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
    ...(options.scientificEnvironments || options.remoteTargets?.length ? {
      environmentManagement: {
        create: async (
          input: Parameters<NonNullable<WorkspaceAgentOptions["environmentManagement"]>["create"]>[0],
          signal?: AbortSignal,
        ) => {
          await requireEnvironmentMutation(`Create named ${input.language} environment ${input.name}`, signal);
          const environment = await options.runnerClient.createEnvironment(input);
          await refreshEnvironmentCatalog();
          return environment;
        },
        delete: async (environmentId: string, signal?: AbortSignal) => {
          await requireEnvironmentMutation(`Delete named environment ${environmentId}`, signal);
          await options.runnerClient.deleteEnvironment(environmentId);
          await refreshEnvironmentCatalog();
        },
        install: async (
          environmentId: string,
          input: Parameters<NonNullable<WorkspaceAgentOptions["environmentManagement"]>["install"]>[1],
          signal?: AbortSignal,
        ) => {
          const manager = input.manager ?? "conda";
          await requireEnvironmentMutation(`Install ${manager} packages in named environment ${environmentId}`, signal);
          const revision = await options.runnerClient.installEnvironment(
            environmentId,
            resolveEnvironmentInstallRequest(
              input,
              options.store.getEnvironmentSourceSettings(),
              options.workspaceRoot,
            ),
          );
          await refreshEnvironmentCatalog();
          return revision;
        },
        list: async (_signal?: AbortSignal, runnerId?: string) => {
          const target = resolveExecutionTarget(runnerId);
          if (target.runnerWorkspaceKey) return target.runnerClient.listEnvironments();
          await refreshEnvironmentCatalog();
          return options.store.listEnvironments();
        },
        uninstall: async (
          environmentId: string,
          input: Parameters<NonNullable<WorkspaceAgentOptions["environmentManagement"]>["uninstall"]>[1],
          signal?: AbortSignal,
        ) => {
          await requireEnvironmentMutation(`Uninstall packages from named environment ${environmentId}`, signal);
          const revision = await options.runnerClient.uninstallEnvironment(environmentId, input);
          await refreshEnvironmentCatalog();
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
        const target = resolveExecutionTarget(machine);
        await options.permission.requirePrivilege({
          action: "code",
          executionId: options.executionId,
          resource: "workspace-code",
          signal,
          ...(toolCallId ? { toolCallId } : {}),
          summary: `Run ${language} code ${target.remoteHostAlias ? `on ${target.remoteHostAlias} ` : ""}${options.permissionScopeLabel}`,
        });
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
