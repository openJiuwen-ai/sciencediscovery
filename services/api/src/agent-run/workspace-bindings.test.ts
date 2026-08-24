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

import assert from "node:assert/strict";
import test from "node:test";

import type { NpuJob } from "@sciencediscovery/schema";
import type { ProvenanceRecorder } from "@sciencediscovery/provenance";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { SessionStore } from "../store.js";
import type { AgentPermissionRuntime } from "@sciencediscovery/governance";
import { createWorkspaceExecutionBindings } from "./workspace-bindings.js";

test("execution bindings apply stable Agent identity with the same permission and provenance path", async () => {
  const executed: Array<{ agentId: string; executionTimeoutMs?: number; kernelIdleTimeoutMs?: number; turnId: string }> = [];
  const permission = {
    getEpoch: () => ({ id: "epoch-1" }),
    requirePrivilege: async () => undefined,
  } as unknown as AgentPermissionRuntime;
  const common = {
    permission,
    permissionScopeLabel: "in test",
    provenanceRecorder: {
      executePython: async (options: {
        agentId: string;
        executionTimeoutMs?: number;
        kernelIdleTimeoutMs?: number;
        turnId: string;
      }) => {
        executed.push({
          agentId: options.agentId,
          ...(options.executionTimeoutMs !== undefined ? { executionTimeoutMs: options.executionTimeoutMs } : {}),
          ...(options.kernelIdleTimeoutMs !== undefined ? { kernelIdleTimeoutMs: options.kernelIdleTimeoutMs } : {}),
          turnId: options.turnId,
        });
        return { createdFiles: [], exitCode: 0, stderr: "", stdout: "" };
      },
    } as unknown as ProvenanceRecorder,
    runnerClient: {} as RunnerClient,
    sessionId: "session-1",
    store: { assertSessionWritable() {} } as unknown as SessionStore,
    workspaceRoot: "/workspace",
  };
  const main = createWorkspaceExecutionBindings({
    ...common,
    agentId: "main",
    executionId: "main-execution",
    executionTimeoutMs: 45_000,
    kernelIdleTimeoutMs: 60_000,
  });
  const subagent = createWorkspaceExecutionBindings({
    ...common,
    agentId: "subagent:subagent-1",
    executionId: "subagent-execution",
  });

  await main.executePython("print('main')");
  await subagent.executePython("print('subagent')");
  assert.deepEqual(executed, [
    { agentId: "main", executionTimeoutMs: 45_000, kernelIdleTimeoutMs: 60_000, turnId: "main-execution" },
    { agentId: "subagent:subagent-1", turnId: "subagent-execution" },
  ]);
});

test("environment install forwards the trusted workspace only from the Agent binding", async () => {
  const installInputs: unknown[] = [];
  const permissionSummaries: string[] = [];
  const revision = {
    channels: ["https://pypi.org/simple"], createdAt: new Date().toISOString(), environmentId: "task-python",
    id: "rev-pip", language: "python", languageVersion: "3.12", packages: [], packageSpecHash: "a".repeat(64),
    platform: "linux-x64", provisioner: "micromamba", runnerVersion: "test",
    snapshot: { hash: "a".repeat(64), size: 1 },
  } as const;
  const bindings = createWorkspaceExecutionBindings({
    agentId: "main",
    executionId: "run-1",
    permission: {
      getEpoch: () => ({ id: "epoch-1" }),
      requirePrivilege: async (input: { summary: string }) => { permissionSummaries.push(input.summary); },
    } as unknown as AgentPermissionRuntime,
    permissionScopeLabel: "in test",
    provenanceRecorder: { cas: { verify: async () => true } } as unknown as ProvenanceRecorder,
    runnerClient: {
      installEnvironment: async (_environmentId: string, input: unknown) => { installInputs.push(input); return revision; },
      listEnvironmentRevisions: async () => [],
      listEnvironments: async () => [],
    } as unknown as RunnerClient,
    scientificEnvironments: [],
    sessionId: "session-1",
    store: {
      assertSessionWritable() {},
      getEnvironmentSourceSettings: () => ({ condaSource: "tsinghua", pipSource: "ustc" }),
      replaceScientificEnvironmentCatalog: async () => undefined,
    } as unknown as SessionStore,
    workspaceRoot: "/data/projects/session-1",
  });

  await bindings.environmentManagement!.install("task-python", {
    manager: "pip",
    packages: ["wheels/example_pkg-1.2.3-py3-none-any.whl"],
  });
  await bindings.environmentManagement!.install("task-python", {
    indexUrl: "https://download.pytorch.org/whl/cpu",
    manager: "pip",
    packages: ["torch", "torchvision"],
  });

  assert.deepEqual(installInputs, [
    {
      indexUrl: "https://mirrors.ustc.edu.cn/pypi/simple",
      manager: "pip",
      packages: ["wheels/example_pkg-1.2.3-py3-none-any.whl"],
      workspaceRoot: "/data/projects/session-1",
    },
    {
      indexUrl: "https://download.pytorch.org/whl/cpu",
      manager: "pip",
      packages: ["torch", "torchvision"],
      workspaceRoot: "/data/projects/session-1",
    },
  ]);
  assert.deepEqual(permissionSummaries, [
    "Install pip packages in named environment task-python",
    "Install pip packages in named environment task-python",
  ]);
});

test("NPU broker bindings submit through Runner with permission and enforce Session ownership", async () => {
  const permissionSummaries: string[] = [];
  const submitted: unknown[] = [];
  const baseJob: NpuJob = {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "npu-job-1",
    inputs: { configPath: "antibody_pipeline/config.json" },
    logs: { stderr: "", stdout: "ok", truncated: false },
    sessionId: "session-1",
    state: "succeeded",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workloadId: "antibody.protenix.v1",
    workspaceRoot: "/data/projects/project/sessions/session-1/workspace",
  };
  const bindings = createWorkspaceExecutionBindings({
    agentId: "main",
    executionId: "run-1",
    npuBrokerEnabled: true,
    permission: {
      getEpoch: () => ({ environmentRevisionId: "epoch-revision", id: "epoch-1" }),
      requirePrivilege: async (input: { summary: string }) => { permissionSummaries.push(input.summary); },
    } as unknown as AgentPermissionRuntime,
    permissionScopeLabel: "in test",
    provenanceRecorder: {} as ProvenanceRecorder,
    runnerClient: {
      cancelNpuJob: async (jobId: string) => ({ ...baseJob, id: jobId, state: "cancelled" }),
      getNpuJob: async (jobId: string) => jobId === "foreign-job"
        ? { ...baseJob, id: jobId, sessionId: "session-2" }
        : { ...baseJob, id: jobId },
      listNpuWorkloads: async () => [{ description: "protenix", id: "antibody.protenix.v1", label: "Protenix", phase: "builtin" }],
      npuJobLogs: async () => baseJob.logs,
      npuJobResult: async () => ({ job: baseJob }),
      submitNpuJob: async (input: unknown) => {
        submitted.push(input);
        return baseJob;
      },
    } as unknown as RunnerClient,
    sessionId: "session-1",
    store: { assertSessionWritable() {} } as unknown as SessionStore,
    workspaceRoot: "/data/projects/project/sessions/session-1/workspace",
  });

  const job = await bindings.npuBroker!.submit({
    inputs: { configPath: "antibody_pipeline/config.json" },
    workloadId: "antibody.protenix.v1",
  });
  assert.equal(job.id, "npu-job-1");
  assert.deepEqual(submitted, [{
    environmentRevisionId: "epoch-revision",
    inputs: { configPath: "antibody_pipeline/config.json" },
    sessionId: "session-1",
    workloadId: "antibody.protenix.v1",
    workspaceRoot: "/data/projects/project/sessions/session-1/workspace",
  }]);
  assert.deepEqual(permissionSummaries, ["Run host NPU workload antibody.protenix.v1 in test"]);

  await assert.rejects(bindings.npuBroker!.get("foreign-job"), /NPU job not found in this Session/);
});
