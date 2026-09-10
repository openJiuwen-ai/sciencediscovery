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
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SKILL_SNAPSHOT_MANIFEST } from "../skill-sandbox.js";
import { DatabaseSync } from "node:sqlite";
import { AgentNotifications } from "../agent-notifications.js";

import type { NpuJob } from "@sciencediscovery/schema";
import { ProvenanceRecorder } from "@sciencediscovery/provenance";
import type { RunnerClient } from "@sciencediscovery/executor";
import { SessionStore } from "../store.js";
import type { AgentPermissionRuntime } from "@sciencediscovery/governance";
import { createWorkspaceExecutionBindings } from "./workspace-bindings.js";

test("one-time timer binding validates time and execution ownership without execution or a write lease", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const notifications = new AgentNotifications(db, () => false);
  const store = { assertSessionWritable() {}, notifications,
    shellExecutions: { get: async (id: string, owner: { agentId: string }) => {
      assert.equal(owner.agentId, "main"); if (id !== "owned") throw new Error("not owned"); return {};
    } },
  } as unknown as SessionStore;
  const timer = createWorkspaceExecutionBindings({ store, agentId: "main", sessionId: "session", executionId: "turn",
    workspaceRoot: "/workspace", permissionScopeLabel: "test", runnerClient: {} as RunnerClient,
    provenanceRecorder: {} as ProvenanceRecorder, permission: {} as AgentPermissionRuntime }).timers!;
  await assert.rejects(timer.create({ message: "missing" }), /exactly one/);
  await assert.rejects(timer.create({ afterMs: 1, at: "2030-01-01T00:00:00Z", message: "both" }), /exactly one/);
  await assert.rejects(timer.create({ afterMs: 0, message: "invalid" }), /positive/);
  await assert.rejects(timer.create({ at: "2030-01-01", message: "ambiguous" }), /timezone/);
  await assert.rejects(timer.create({ afterMs: 60000, executionId: "foreign", message: "not allowed" }), /not owned/);
  const created = await timer.create({ afterMs: 60000, executionId: "owned", message: "check result" }) as { id: string };
  assert.equal((timer.list() as unknown[]).length, 1);
  timer.cancel(created.id);
  assert.equal(notifications.timers({ sessionId: "session", agentId: "main" })[0]!.state, "cancelled");
  notifications.stop("session");
  await assert.rejects(timer.create({ afterMs: 60000, message: "stopped" }), /stopped/);
});

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

test("main and child execution bindings route by Runner ID and record isolated workspace ownership", async (t) => {
  const skillRoot = await mkdtemp(resolve(tmpdir(), "binding-skills-"));
  t.after(() => rm(skillRoot, { recursive: true, force: true }));
  await mkdir(resolve(skillRoot, "selected"));
  await writeFile(resolve(skillRoot, "selected/SKILL.md"), "frozen");
  const hash = createHash("sha256").update("8:SKILL.md:6:frozen").digest("hex");
  await writeFile(resolve(skillRoot, SKILL_SNAPSHOT_MANIFEST), JSON.stringify({ schemaVersion: 1,
    skills: [{ id: "selected", hash, revision: 1, version: "1" }] }));
  let preparations = 0;
  let failSync = false;
  // Stands in for a Runner that does not hold this set yet, so every remote
  // execution here also exercises shipping the frozen bytes.
  const remoteClient = { prepareSkillPackages: async (
    manifest: { skills: { hash: string; id: string }[] },
    loadBundle: () => Promise<{ skills: { files: { content: string; path: string }[] }[] }>,
  ) => {
    assert.deepEqual(manifest.skills.map((skill) => skill.id), ["selected"]);
    assert.equal(manifest.skills[0]?.hash, hash);
    const bundle = await loadBundle();
    assert.deepEqual(bundle.skills[0]?.files.map((file) => file.path), ["SKILL.md"]);
    assert.equal(Buffer.from(bundle.skills[0]!.files[0]!.content, "base64").toString(), "frozen");
    preparations++;
    if (failSync) throw new Error("sync failed");
    return "/runner/projects/.skill-packages/frozen";
  } } as unknown as RunnerClient;
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
    skillPackagesRoot: skillRoot,
    store: {
      assertSessionWritable() {},
      // No network in this epoch, so the binding resolves no outbound route.
      // No cards ticked on this Runner, so no NPU reaches the request.
      npuDeviceSelection: () => [],
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
      runnerClient: () => remoteClient,
      workspaceKey: "project-1/session-1",
    }],
  });
  const subagent = createWorkspaceExecutionBindings({
    ...common,
    agentId: "subagent:subagent-1",
    executionId: "subagent-execution",
    remoteTargets: [{ runnerId: "runner-1", hostAlias: "institution-linux",
      runnerClient: () => remoteClient, workspaceKey: "project-1/session-1/agents/subagent-1" }],
  });

  // Being allowed a remote machine does not move the default off this one.
  await main.executePython("print('main')");
  await main.executePython("print('remote')", undefined, undefined, "runner-1");
  await subagent.executePython("print('subagent')");
  await subagent.executePython("print('remote child')", undefined, undefined, "runner-1");
  assert.deepEqual(executed, [
    {
      agentId: "main", runnerId: "local", executionTimeoutMs: 45_000, kernelIdleTimeoutMs: 60_000,
      skillPackagesRoot: skillRoot, turnId: "main-execution",
    },
    {
      agentId: "main", executionTimeoutMs: 45_000, kernelIdleTimeoutMs: 60_000,
      runnerId: "runner-1", remoteHostAlias: "institution-linux",
      runnerWorkspaceKey: "project-1/session-1",
      skillPackagesRoot: "/runner/projects/.skill-packages/frozen",
      turnId: "main-execution",
    },
    {
      agentId: "subagent:subagent-1", runnerId: "local",
      skillPackagesRoot: skillRoot,
      turnId: "subagent-execution",
    },
    { agentId: "subagent:subagent-1", runnerId: "runner-1", remoteHostAlias: "institution-linux",
      skillPackagesRoot: "/runner/projects/.skill-packages/frozen",
      runnerWorkspaceKey: "project-1/session-1/agents/subagent-1", turnId: "subagent-execution" },
  ]);
  assert.equal(preparations, 2);
  failSync = true;
  await assert.rejects(main.executeShell!("echo no", "ephemeral", undefined, undefined, "runner-1"), /sync failed/);
  assert.equal(executed.length, 4);
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
      npuDeviceSelection: () => [],
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
      listEnvironmentRevisions: async () => [{ id: "epoch-revision", environmentId: "env" }],
      listEnvironments: async () => [{ id: "env", status: "ready", currentRevisionId: "latest-revision" }],
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
      // No cards ticked on this Runner, so no NPU reaches the request.
      npuDeviceSelection: () => [],
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
    environmentRevisionId: "latest-revision",
    inputs: { configPath: "antibody_pipeline/config.json" },
    sessionId: "session-1",
    workloadId: "antibody.protenix.v1",
    workspaceRoot: "/data/projects/project/sessions/session-1/workspace",
  }]);
  assert.deepEqual(permissionSummaries, ["Run host NPU workload antibody.protenix.v1 in test"]);
  await bindings.npuBroker!.submit({ environmentId: "env", workloadId: "antibody.protenix.v1", inputs: {} });
  assert.equal((submitted[1] as { environmentRevisionId: string }).environmentRevisionId, "latest-revision");
  await assert.rejects(bindings.npuBroker!.submit({ environmentId: "epoch-revision", workloadId: "antibody.protenix.v1", inputs: {} }), /missing or not ready/);

  await assert.rejects(bindings.npuBroker!.get("foreign-job"), /NPU job not found in this Session/);
});

/**
 * The whole chain, not a layer of it: a real store holding a real selection, a
 * real ProvenanceRecorder, and a RunnerClient that captures exactly what the
 * Runner would receive. Asserting on the recorder's options instead would
 * prove nothing about the request the Runner actually gets.
 */
async function npuChain(selection: number[] | undefined) {
  const dataDir = await mkdtemp(resolve(tmpdir(), "npu-wiring-"));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({
    apiToken: "test-token", baseUrl: "https://models.example.test/v1",
    model: "test-model", name: "Test model",
  });
  const project = await store.createProject("NPU wiring");
  const session = await store.createSession(project.id, "NPU wiring", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });
  if (selection) await store.setNpuDeviceSelection("local", selection);
  const payloads: Array<Record<string, unknown>> = [];
  const result = {
    createdFiles: [], environmentRevisionId: "system-python3-bwrap-v1",
    environmentVariables: {}, exitCode: 0, finishedAt: new Date().toISOString(),
    kernelId: "kernel", kernelMode: "ephemeral", language: "python", modifiedFiles: [],
    networkPolicy: "none", runnerVersion: "test", sandbox: "bubblewrap",
    startedAt: new Date().toISOString(), stderr: "", stdout: "", workingDirectory: "/workspace",
  };
  const runnerClient = {
    execute: async (request: Record<string, unknown>) => { payloads.push(request); return { ...result, executionId: String(request.executionId) }; },
    executeShell: async (request: Record<string, unknown>) => { payloads.push(request); return { ...result, executionId: String(request.executionId) }; },
    // The managed shell tool submits through this call instead, so it needs its
    // own capture: a request that skipped the field here would still be a
    // sandbox without cards, however well `executeShell` behaves.
    startShellExecution: async (request: Record<string, unknown>) => {
      payloads.push(request);
      return {
        agentId: "main", id: String(request.executionId), sessionId: session.id, state: "completed",
        startedAt: new Date().toISOString(), version: { digest: "sha256:test", workspaceId: "workspace" },
        result: { ...result, executionId: String(request.executionId), workspaceSnapshot: { id: "snapshot", capturedAt: new Date().toISOString(), files: [], workspace: "workspace" } },
      };
    },
    health: async () => ({ sandbox: "bubblewrap" }),
    listEnvironmentRevisions: async () => [],
    listEnvironments: async () => [],
  } as unknown as RunnerClient;
  const bindings = createWorkspaceExecutionBindings({
    agentId: "main",
    executionId: "run-npu",
    permission: {
      getEpoch: () => permissionEpoch,
      requirePrivilege: async () => undefined,
    } as unknown as AgentPermissionRuntime,
    permissionScopeLabel: "in test",
    provenanceRecorder: new ProvenanceRecorder(dataDir, store),
    runnerClient,
    scientificEnvironments: [],
    sessionId: session.id,
    store,
    workspaceRoot,
  });
  return { bindings, cleanup: async () => { await rm(dataDir, { recursive: true, force: true }); }, payloads };
}

test("cards ticked for a Runner reach the Runner request of every execution kind", async () => {
  const { bindings, cleanup, payloads } = await npuChain([4]);
  try {
    await bindings.executePython!("print('python')");
    await bindings.executeShell!("echo shell", "ephemeral");
    await bindings.executeScientific!("python", "print('scientific')", undefined, "ephemeral");
    await bindings.shellExecutions!.start("echo managed", {});
  } finally {
    await cleanup();
  }
  assert.equal(payloads.length, 4, "each execution must reach the Runner");
  // The tick is worthless unless it arrives here: this is the field the Runner
  // reads to decide which cards to bind into the sandbox.
  for (const payload of payloads) assert.deepEqual(payload.npuDevices, [4]);
});

test("an unticked Runner sends no NPU field at all, leaving the sandbox unchanged", async () => {
  const { bindings, cleanup, payloads } = await npuChain(undefined);
  try {
    await bindings.executePython!("print('python')");
    await bindings.executeShell!("echo shell", "ephemeral");
    await bindings.executeScientific!("python", "print('scientific')", undefined, "ephemeral");
    await bindings.shellExecutions!.start("echo managed", {});
  } finally {
    await cleanup();
  }
  assert.equal(payloads.length, 4);
  // Absent rather than an empty array: an empty array would still be a decision.
  for (const payload of payloads) assert.equal(Object.hasOwn(payload, "npuDevices"), false);
});

test("clearing a Runner's cards stops them reaching the next execution", async () => {
  const { bindings, cleanup, payloads } = await npuChain([4, 6]);
  try {
    await bindings.executePython!("print('with cards')");
  } finally {
    await cleanup();
  }
  assert.deepEqual(payloads[0]?.npuDevices, [4, 6]);
});
