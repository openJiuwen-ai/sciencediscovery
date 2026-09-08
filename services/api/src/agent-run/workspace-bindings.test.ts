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

test("Transfer binding exposes only owned Workspaces and rechecks Runner access after permission", async () => {
  let allowed = true; let starts = 0;
  const store = {
    workspaceIdentity: (_session: string, agent: string, runner = "local") => ({ id: `${agent}-${runner}` }),
    assertSessionWritable() {}, assertSessionAllowsRemoteRunner() { if (!allowed) throw new Error("revoked"); },
    transfers: { start() { starts++; return {}; } },
  } as unknown as SessionStore;
  const binding = createWorkspaceExecutionBindings({
    agentId: "child", sessionId: "session", executionId: "run", workspaceRoot: "/workspace", store,
    permissionScopeLabel: "child", provenanceRecorder: {} as ProvenanceRecorder, runnerClient: {} as RunnerClient,
    permission: { requirePrivilege: async () => { allowed = false; } } as unknown as AgentPermissionRuntime,
    remoteTargets: [{ runnerId: "remote", hostAlias: "Allowed", workspaceKey: "child-key", runnerClient: () => ({} as RunnerClient) }],
  }).workspaceTransfers!;
  assert.deepEqual(binding.workspaces().map((item) => item.id), ["child-local", "child-remote"]);
  await assert.rejects(binding.start({ sourceWorkspaceId: "parent-local", targetWorkspaceId: "child-local", files: [{ sourcePath: "secret", targetPath: "secret" }] }), /not owned/);
  await assert.rejects(binding.start({ sourceWorkspaceId: "child-local", targetWorkspaceId: "child-remote", files: [{ sourcePath: "in", targetPath: "out" }] }), /revoked/);
  assert.equal(starts, 0);
  assert.deepEqual(binding.workspaces().map((item) => item.id), ["child-local"]);
});

test("main and child execution bindings route by Runner ID and record isolated workspace ownership", async () => {
  const executed: Array<{
    agentId: string;
    executionTimeoutMs?: number;
    kernelIdleTimeoutMs?: number;
    runnerId?: string;
    remoteHostAlias?: string;
    runnerWorkspaceKey?: string;
    skillPackagesRoot?: string;
    turnId: string;
  }> = [];
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
        runnerId?: string;
    remoteHostAlias?: string;
        runnerWorkspaceKey?: string;
        skillPackagesRoot?: string;
        turnId: string;
      }) => {
        executed.push({
          agentId: options.agentId,
          runnerId: options.runnerId,
          ...(options.executionTimeoutMs !== undefined ? { executionTimeoutMs: options.executionTimeoutMs } : {}),
          ...(options.kernelIdleTimeoutMs !== undefined ? { kernelIdleTimeoutMs: options.kernelIdleTimeoutMs } : {}),
          ...(options.remoteHostAlias ? { remoteHostAlias: options.remoteHostAlias } : {}),
          ...(options.runnerWorkspaceKey ? { runnerWorkspaceKey: options.runnerWorkspaceKey } : {}),
          ...(options.skillPackagesRoot ? { skillPackagesRoot: options.skillPackagesRoot } : {}),
          turnId: options.turnId,
        });
        return { createdFiles: [], exitCode: 0, stderr: "", stdout: "" };
      },
    } as unknown as ProvenanceRecorder,
    runnerClient: {} as RunnerClient,
    sessionId: "session-1",
    skillPackagesRoot: "/data/projects/project/sessions/session-1/skill-snapshots/run-1",
    store: {
      assertSessionWritable() {},
      // No network in this epoch, so the binding resolves no outbound route.
      resolveSandboxEgressProxy: () => undefined,
    } as unknown as SessionStore,
    workspaceRoot: "/workspace",
  };
  const main = createWorkspaceExecutionBindings({
    ...common,
    agentId: "main",
    executionId: "main-execution",
    executionTimeoutMs: 45_000,
    kernelIdleTimeoutMs: 60_000,
    remoteTargets: [{
      runnerId: "runner-1",
      hostAlias: "institution-linux",
      runnerClient: () => ({} as RunnerClient),
      workspaceKey: "project-1/session-1",
    }],
  });
  const subagent = createWorkspaceExecutionBindings({
    ...common,
    agentId: "subagent:subagent-1",
    executionId: "subagent-execution",
    remoteTargets: [{ runnerId: "runner-1", hostAlias: "institution-linux",
      runnerClient: () => ({} as RunnerClient), workspaceKey: "project-1/session-1/agents/subagent-1" }],
  });

  // Being allowed a remote machine does not move the default off this one.
  await main.executePython("print('main')");
  await main.executePython("print('remote')", undefined, undefined, "runner-1");
  await subagent.executePython("print('subagent')");
  await subagent.executePython("print('remote child')", undefined, undefined, "runner-1");
  assert.deepEqual(executed, [
    {
      agentId: "main", runnerId: "local", executionTimeoutMs: 45_000, kernelIdleTimeoutMs: 60_000,
      skillPackagesRoot: "/data/projects/project/sessions/session-1/skill-snapshots/run-1", turnId: "main-execution",
    },
    {
      agentId: "main", executionTimeoutMs: 45_000, kernelIdleTimeoutMs: 60_000,
      runnerId: "runner-1", remoteHostAlias: "institution-linux",
      runnerWorkspaceKey: "project-1/session-1",
      turnId: "main-execution",
    },
    {
      agentId: "subagent:subagent-1", runnerId: "local",
      skillPackagesRoot: "/data/projects/project/sessions/session-1/skill-snapshots/run-1",
      turnId: "subagent-execution",
    },
    { agentId: "subagent:subagent-1", runnerId: "runner-1", remoteHostAlias: "institution-linux",
      runnerWorkspaceKey: "project-1/session-1/agents/subagent-1", turnId: "subagent-execution" },
  ]);
  // A machine outside the allowlist is refused, and a Session with none can
  // only ever be told about the local machine.
  await assert.rejects(
    main.executePython("print('nope')", undefined, undefined, "someone-elses-box"),
    /may not run on someone-elses-box/,
  );
  await assert.rejects(
    subagent.executePython("print('nope')", undefined, undefined, "institution-linux"),
    /may not run on institution-linux/,
  );
});

test("main and child scientific environment operations use the selected Runner and recheck authorization", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let allowed = true;
  let revokeOnApproval = false;
  let approvals = 0;
  const remote = Object.fromEntries(["createEnvironment", "deleteEnvironment", "installEnvironment", "uninstallEnvironment",
    "listEnvironments", "getEnvironmentSetup", "setupScientificEnvironments"].map((method) => [method, async (...args: unknown[]) => {
    calls.push({ method, args });
    return method === "listEnvironments" ? [] : {};
  }])) as unknown as RunnerClient;
  for (const agentId of ["main", "subagent:child"]) {
    const workspaceKey = agentId === "main" ? "project/session" : "project/session/agents/child";
    const binding = createWorkspaceExecutionBindings({
      agentId, executionId: "test", sessionId: "session", permissionScopeLabel: "test", workspaceRoot: "/local/workspace",
      permission: { requirePrivilege: async () => { approvals++; if (revokeOnApproval) allowed = false; } } as unknown as AgentPermissionRuntime,
      store: { assertSessionWritable() {}, getEnvironmentSourceSettings: () => ({ condaSource: "upstream", pipSource: "upstream" }),
        replaceScientificEnvironmentCatalog: async () => { throw new Error("remote catalog must not replace local catalog"); },
      } as unknown as SessionStore,
      runnerClient: new Proxy({} as RunnerClient, { get() { throw new Error("must not call local Runner"); } }),
      provenanceRecorder: {} as ProvenanceRecorder,
      remoteTargets: [{ runnerId: "runner-1", hostAlias: "remote", workspaceKey,
        runnerClient: () => { if (!allowed) throw new Error("authorization revoked"); return remote; } }],
    }).environmentManagement!;
    await binding.list(undefined, "runner-1");
    await binding.create({ name: "science", language: "python" }, undefined, "runner-1");
    await binding.install("task-test", { manager: "pip", packages: ["wheels/science-1-py3-none-any.whl"] }, undefined, "runner-1");
    assert.deepEqual(calls.at(-1)?.args, ["task-test", {
      manager: "pip", packages: ["wheels/science-1-py3-none-any.whl"],
      indexUrl: "https://pypi.org/simple", runnerWorkspaceKey: workspaceKey,
    }]);
    await binding.uninstall("task-test", { packages: ["numpy"] }, undefined, "runner-1");
    await binding.delete("task-test", undefined, "runner-1");
    const beforeStatus = approvals;
    await binding.setup!(false, undefined, "runner-1");
    assert.equal(approvals, beforeStatus);
    await binding.setup!(true, undefined, "runner-1");
    assert.equal(approvals, beforeStatus + 1);
    await assert.rejects(binding.create({ name: "no", language: "r" }, undefined, "not-allowed"), /may not run/);
    const beforeRevocation = calls.length;
    revokeOnApproval = true;
    await assert.rejects(binding.delete("task-test", undefined, "runner-1"), /revoked/);
    assert.equal(calls.length, beforeRevocation);
    revokeOnApproval = false;
    allowed = true;
  }
  assert.equal(calls.length, 14);
});

test("scientific executions forward the current outbound route and omit it for no-network epochs", async () => {
  const executed: Array<Record<string, unknown>> = [];
  const epoch = { id: "epoch-1" };
  const proxy = { mode: "url", url: "http://proxy.test:3128" } as const;
  let resolved: typeof proxy | undefined = proxy;
  const bindings = createWorkspaceExecutionBindings({
    agentId: "main",
    executionId: "run-1",
    permission: {
      getEpoch: () => epoch,
      requirePrivilege: async () => undefined,
    } as unknown as AgentPermissionRuntime,
    permissionScopeLabel: "in test",
    provenanceRecorder: {
      executeScientific: async (options: Record<string, unknown>) => {
        executed.push(options);
        return { createdFiles: [], exitCode: 0, stderr: "", stdout: "" };
      },
    } as unknown as ProvenanceRecorder,
    runnerClient: {} as RunnerClient,
    scientificEnvironments: [],
    sessionId: "session-1",
    store: {
      assertSessionWritable() {},
      resolveSandboxEgressProxy: () => resolved,
    } as unknown as SessionStore,
    workspaceRoot: "/workspace",
  });

  await bindings.executeScientific!("python", "print('proxied')", undefined, "ephemeral");
  resolved = undefined;
  await bindings.executeScientific!("python", "print('offline')", undefined, "ephemeral");

  assert.deepEqual(executed.map((input) => ({
    hasSandboxEgressProxy: Object.hasOwn(input, "sandboxEgressProxy"),
    permissionEpoch: input.permissionEpoch,
    sandboxEgressProxy: input.sandboxEgressProxy,
  })), [
    { hasSandboxEgressProxy: true, permissionEpoch: epoch, sandboxEgressProxy: proxy },
    { hasSandboxEgressProxy: false, permissionEpoch: epoch, sandboxEgressProxy: undefined },
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
    store: {
      assertSessionWritable() {},
      // No network in this epoch, so the binding resolves no outbound route.
      resolveSandboxEgressProxy: () => undefined,
    } as unknown as SessionStore,
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
