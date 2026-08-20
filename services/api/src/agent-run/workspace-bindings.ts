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
} from "@science-agent/schema";
import type { WorkspaceAgentOptions } from "@science-agent/context";

import type { ProvenanceRecorder } from "@science-agent/provenance";
import type { RunnerClient } from "@science-agent/executor";
import type { SessionStore } from "../store.js";
import { resolveEnvironmentInstallRequest } from "../environment-sources.js";
import type { AgentPermissionRuntime } from "@science-agent/governance";
import { syncScientificEnvironmentCatalog } from "../scientific-environment-catalog.js";

type ExecutionBindings = Pick<
  WorkspaceAgentOptions,
  "environmentManagement" | "executePython" | "executeScientific" | "executeShell" | "npuBroker"
>;

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
  runnerClient: RunnerClient;
  scientificEnvironments?: Environment[];
  sessionId: string;
  store: SessionStore;
  workspaceRoot: string;
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
    executePython: async (code: string, signal?: AbortSignal) => {
      options.store.assertSessionWritable(options.sessionId);
      await options.permission.requirePrivilege({
        action: "code",
        executionId: options.executionId,
        resource: "workspace-code",
        signal,
        summary: `Run Python code ${options.permissionScopeLabel}`,
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
        runnerClient: options.runnerClient,
        sessionId: options.sessionId,
        signal,
        turnId: options.executionId,
        workspaceRoot: options.workspaceRoot,
      });
    },
    executeShell: async (code: string, kernelMode: KernelMode, signal?: AbortSignal) => {
      options.store.assertSessionWritable(options.sessionId);
      await options.permission.requirePrivilege({
        action: "code",
        executionId: options.executionId,
        resource: "workspace-code",
        signal,
        summary: `Run a shell script ${options.permissionScopeLabel}`,
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
        runnerClient: options.runnerClient,
        sessionId: options.sessionId,
        signal,
        turnId: options.executionId,
        workspaceRoot: options.workspaceRoot,
      });
    },
    ...(options.scientificEnvironments ? {
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
        list: async () => {
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
      ) => {
        options.store.assertSessionWritable(options.sessionId);
        await options.permission.requirePrivilege({
          action: "code",
          executionId: options.executionId,
          resource: "workspace-code",
          signal,
          summary: `Run ${language} code ${options.permissionScopeLabel}`,
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
          runnerClient: options.runnerClient,
          sessionId: options.sessionId,
          signal,
          turnId: options.executionId,
          workspaceRoot: options.workspaceRoot,
        });
      },
    } : {}),
  };
  return common;
}
