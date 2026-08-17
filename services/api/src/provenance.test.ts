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
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  type ComposerReference,
  type Environment,
  type EnvironmentRevision,
  type PythonExecutionRequest,
  type PythonExecutionResult,
  type ShellExecutionRequest,
  type ShellExecutionResult,
} from "@science-agent/schema";

import { MemoryGraphClient, MemoryGraphSink } from "./memory-graph.js";
import { ProvenanceRecorder } from "./provenance.js";
import type { RunnerClient } from "./runner-client.js";
import { SessionStore } from "./store.js";

test("multi-step persistent R executions create separate runs and an artifact derivation", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `r-provenance-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({
    apiToken: "test-token",
    baseUrl: "https://models.example.test/v1",
    model: "test-model",
    name: "Test model",
  });
  const project = await store.createProject("R provenance");
  const session = await store.createSession(project.id, "R analysis", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });

  const snapshot = Buffer.from("{\"format\":\"test-r-environment\"}\n");
  const snapshotHash = createHash("sha256").update(snapshot).digest("hex");
  const environment: Environment = {
    createdAt: new Date().toISOString(),
    currentRevisionId: "rev-r-test",
    id: "starter-r",
    kind: "starter",
    language: "r",
    name: "Starter R",
    updatedAt: new Date().toISOString(),
  };
  const revision: EnvironmentRevision = {
    channels: ["conda-forge"],
    createdAt: new Date().toISOString(),
    environmentId: environment.id,
    id: environment.currentRevisionId,
    language: "r",
    languageVersion: "4.4",
    packages: ["r-base=4.4=test"],
    packageSpecHash: snapshotHash,
    platform: "linux-x64",
    provisioner: "test",
    runnerVersion: "test",
    snapshot: { hash: snapshotHash, size: snapshot.length },
  };
  let evaluations = 0;
  const runnerClient = {
    environmentSnapshot: async () => snapshot,
    execute: async (request: PythonExecutionRequest): Promise<PythonExecutionResult> => {
      evaluations += 1;
      const createdFiles = evaluations === 2 ? ["r-summary.csv"] : [];
      if (createdFiles.length) await writeFile(resolve(workspaceRoot, createdFiles[0]!), "metric,value\nanswer,42\n");
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none",
        createdFiles,
        environmentRevisionId: revision.id,
        environmentVariables: { HOME: "/tmp", PATH: "/opt/science-env/bin:/usr/bin" },
        executionId: request.executionId,
        exitCode: 0,
        finishedAt: timestamp,
        kernelId: "kernel-r-test",
        kernelMode: "persistent",
        language: "r",
        modifiedFiles: [],
        networkPolicy: "none",
        runnerVersion: "test",
        sandbox: "bubblewrap",
        startedAt: timestamp,
        workingDirectory: "/workspace",
        stderr: "",
        stdout: evaluations === 1 ? "stored state\n" : "42\n",
      };
    },
    listEnvironmentRevisions: async () => [revision],
    listEnvironments: async () => [environment],
  } as unknown as RunnerClient;
  const recorder = new ProvenanceRecorder(dataDir, store);
  for (const code of ["x <- 41", "write.csv(data.frame(metric='answer', value=x + 1), 'r-summary.csv')"]) {
    await recorder.executeScientific({
      agentId: "main",
      code,
      environmentRevisionId: revision.id,
      kernelMode: "persistent",
      language: "r",
      permissionEpoch,
      runnerClient,
      sessionId: session.id,
      turnId: "turn-r",
      workspaceRoot,
    });
  }

  const runs = await store.listExecutionRuns(session.id);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((run) => run.tool), ["run_r", "run_r"]);
  assert.deepEqual(runs.map((run) => run.kernelMode), ["persistent", "persistent"]);
  assert.deepEqual(runs.map((run) => run.environmentRevisionId), [revision.id, revision.id]);
  const derivations = await store.listArtifactDerivations(session.id);
  assert.equal(derivations.length, 1);
  assert.equal(derivations[0]?.path, "r-summary.csv");
  assert.deepEqual(derivations[0]?.executionRunIds, [runs[1]!.id]);
  assert.equal(await recorder.cas.verify(revision.snapshot.hash), true);
});

test("shell execution records authoritative code, logs, environment, and generated files", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `shell-provenance-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Shell provenance");
  const session = await store.createSession(project.id, "Legacy pipeline", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });

  const runnerClient = {
    executeShell: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      await writeFile(resolve(workspaceRoot, "shell-output.txt"), "42\n");
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none",
        createdFiles: ["shell-output.txt"],
        environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" },
        executionId: request.executionId,
        exitCode: 0,
        finishedAt: timestamp,
        kernelId: `ephemeral:${request.executionId}`,
        kernelMode: "ephemeral",
        language: "shell",
        modifiedFiles: [],
        networkPolicy: "none",
        runnerVersion: "test",
        sandbox: "bubblewrap",
        startedAt: timestamp,
        workingDirectory: "/workspace",
        stderr: "",
        stdout: "pipeline complete\n",
      };
    },
  } as unknown as RunnerClient;
  const recorder = new ProvenanceRecorder(dataDir, store);
  await recorder.executeShell({
    agentId: "main",
    code: "/usr/bin/bash run_all.sh",
    permissionEpoch,
    runnerClient,
    sessionId: session.id,
    turnId: "turn-shell",
    workspaceRoot,
  });

  const [run] = await store.listExecutionRuns(session.id);
  assert.equal(run?.tool, "run_shell");
  assert.equal(run?.language, "shell");
  assert.equal(run?.environmentRevisionId, SYSTEM_SHELL_ENVIRONMENT_REVISION_ID);
  assert.equal(await recorder.cas.verify(run!.code.hash), true);
  assert.equal(await recorder.cas.verify(run!.stdout.hash), true);
  assert.equal(run?.workingDirectory, "/workspace");
  assert.ok(run?.envSnapshot);
  assert.deepEqual(
    JSON.parse((await recorder.cas.read(run!.envSnapshot!.hash)).toString("utf8")),
    { HOME: "/tmp", PATH: "/usr/bin" },
  );
  const [derivation] = await store.listArtifactDerivations(session.id);
  assert.equal(derivation?.path, "shell-output.txt");
  assert.deepEqual(derivation?.executionRunIds, [run!.id]);
});

test("execution provenance distinguishes runs by working directory and env snapshot", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `env-provenance-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Env provenance");
  const session = await store.createSession(project.id, "Env continuity", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });

  let calls = 0;
  const runnerClient = {
    executeShell: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      calls += 1;
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none", createdFiles: [],
        environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: calls === 1
          ? { HOME: "/tmp", PATH: "/usr/bin" }
          : { FOO: "bar", HOME: "/tmp", PATH: "/usr/bin" },
        executionId: request.executionId, exitCode: 0, finishedAt: timestamp,
        kernelId: "shell-session-1", kernelMode: request.kernelMode ?? "ephemeral", language: "shell",
        modifiedFiles: [], networkPolicy: "none", runnerVersion: "test",
        sandbox: "bubblewrap", startedAt: timestamp, stderr: "", stdout: "",
        workingDirectory: calls === 1 ? "/workspace" : "/workspace/subdir",
      };
    },
  } as unknown as RunnerClient;
  const recorder = new ProvenanceRecorder(dataDir, store);
  for (const code of ["echo one", "echo two"]) {
    await recorder.executeShell({
      agentId: "main",
      code, kernelMode: "persistent", permissionEpoch, runnerClient,
      sessionId: session.id, turnId: "turn-env", workspaceRoot,
    });
  }

  const runs = await store.listExecutionRuns(session.id);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((run) => run.kernelMode), ["persistent", "persistent"]);
  assert.deepEqual(runs.map((run) => run.workingDirectory), ["/workspace", "/workspace/subdir"]);
  assert.ok(runs[0]!.envSnapshot && runs[1]!.envSnapshot);
  assert.notEqual(runs[0]!.envSnapshot!.hash, runs[1]!.envSnapshot!.hash);
  assert.deepEqual(
    JSON.parse((await recorder.cas.read(runs[1]!.envSnapshot!.hash)).toString("utf8")),
    { FOO: "bar", HOME: "/tmp", PATH: "/usr/bin" },
  );
});

test("subagent execution prefixes generated artifact paths with the private workspace path", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `subagent-artifact-prefix-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Subagent artifact prefix");
  const session = await store.createSession(project.id, "Subagent output", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const parentWorkspaceRoot = store.workspacePath(session.id);
  const subagentPath = "subagents/subagent-1";
  const subagentWorkspaceRoot = resolve(parentWorkspaceRoot, subagentPath);
  await mkdir(subagentWorkspaceRoot, { recursive: true });
  const recorder = new ProvenanceRecorder(dataDir, store);

  await writeFile(resolve(parentWorkspaceRoot, "report.md"), "# Parent report\n");
  const parentArtifact = await recorder.registerWorkspaceArtifact({
    path: "report.md",
    sessionId: session.id,
    turnId: "parent-turn",
    workspaceRoot: parentWorkspaceRoot,
  });
  assert.ok(parentArtifact);

  const runnerClient = {
    executeShell: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      await writeFile(resolve(subagentWorkspaceRoot, "report.md"), "# Subagent report\n");
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none",
        createdFiles: ["report.md"],
        environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" },
        executionId: request.executionId,
        exitCode: 0,
        finishedAt: timestamp,
        kernelId: `ephemeral:${request.executionId}`,
        kernelMode: "ephemeral",
        language: "shell",
        modifiedFiles: [],
        networkPolicy: "none",
        runnerVersion: "test",
        sandbox: "bubblewrap",
        startedAt: timestamp,
        workingDirectory: "/workspace",
        stderr: "",
        stdout: "subagent complete\n",
      };
    },
  } as unknown as RunnerClient;

  await recorder.executeShell({
    agentId: "subagent:subagent-1",
    artifactPathPrefix: subagentPath,
    code: "cat > report.md",
    permissionEpoch,
    runnerClient,
    sessionId: session.id,
    turnId: "subagent-turn",
    workspaceRoot: subagentWorkspaceRoot,
  });

  const derivations = await store.listArtifactDerivations(session.id);
  assert.equal(derivations.at(-1)?.path, "subagents/subagent-1/report.md");
  assert.equal(store.listArtifacts(session.id).length, 1, "execution output is not cataloged until declared");

  const declared = await recorder.declareWorkspaceArtifact({
    name: "subagent-report.md",
    path: "report.md",
    sessionId: session.id,
    sourcePath: "subagents/subagent-1/report.md",
    turnId: "subagent-turn",
    workspaceRoot: subagentWorkspaceRoot,
  });
  assert.equal(declared.artifact.origin, "llm_declared");
  assert.equal(declared.artifact.createdInSessionId, session.id);
  assert.equal(declared.artifact.kind, "markdown", "declare infers preview kind inside provenance");
  assert.equal(declared.version.sourcePath, "subagents/subagent-1/report.md");
  const [subagentVersion] = store.listArtifactVersions(session.id, declared.artifact.id);
  assert.equal((await recorder.cas.read(subagentVersion!.content.hash)).toString("utf8"), "# Subagent report\n");

  await writeFile(resolve(subagentWorkspaceRoot, "payload"), "extensionless\n");
  const extensionless = await recorder.declareWorkspaceArtifact({
    name: "payload",
    path: "payload",
    sessionId: session.id,
    sourcePath: "subagents/subagent-1/payload",
    turnId: "subagent-turn",
    workspaceRoot: subagentWorkspaceRoot,
  });
  assert.equal(extensionless.artifact.kind, "other", "extensionless declarations retain a preview fallback");
});

test("a report version drains the chip references + claim ids accumulated earlier in the run", async (context) => {
  // declare_claim runs in an EARLIER turn than the report-write run, so the
  // referencesProvider already holds the accumulated chip_map + claim ids by
  // the time the report version lands here. Verify the version carries the
  // references and the drain is destructive (a later report starts fresh).
  const dataDir = resolve(process.cwd(), ".tmp", `report-drain-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Report drain");
  const session = await store.createSession(project.id, "Brief", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });

  const chipMap: ComposerReference[] = [{ id: "ev-id-1", kind: "evidence", label: "ev1" }];
  const claimIds: string[] = ["claim-id-1"];
  // No memory-graph sink here (states edges are fire-and-forget; the drain is
  // what matters). The provider mirrors server.ts: splice on drain so a later
  // report starts fresh.
  const recorder = new ProvenanceRecorder(dataDir, store);
  recorder.setReferencesProvider(() => {
    const references = chipMap.splice(0, chipMap.length);
    const drained = claimIds.splice(0, claimIds.length);
    return { references, claimIds: drained };
  });

  const runnerClient = {
    executeShell: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      await writeFile(resolve(workspaceRoot, "report.md"), "# Brief\n[ev1]\n");
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none", createdFiles: ["report.md"], environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" },
        executionId: request.executionId, exitCode: 0, finishedAt: timestamp, kernelId: `ephemeral:${request.executionId}`,
        kernelMode: "ephemeral", language: "shell", modifiedFiles: [], networkPolicy: "none", runnerVersion: "test",
        sandbox: "bubblewrap", startedAt: timestamp, stderr: "", stdout: "done\n", workingDirectory: "/workspace",
      } as ShellExecutionResult;
    },
  } as unknown as RunnerClient;
  await recorder.executeShell({
    agentId: "main",
    code: "cat > report.md", permissionEpoch, runnerClient, sessionId: session.id, turnId: "t1", workspaceRoot,
  });
  assert.equal(store.listArtifacts(session.id).length, 0, "generated report remains physical until declared");
  await recorder.declareWorkspaceArtifact({
    name: "report.md", path: "report.md", sessionId: session.id,
    sourcePath: "report.md", turnId: "t1", workspaceRoot,
  });

  const reportArtifact = store.listArtifacts(session.id).find((a) => a.logicalName === "report.md");
  assert.ok(reportArtifact, "report artifact created");
  const [version] = store.listArtifactVersions(session.id, reportArtifact.id);
  assert.ok(version?.references?.length, "report version carries drained chip references");
  assert.equal(version!.references![0]!.label, "ev1");
  assert.equal(chipMap.length, 0, "chip buffer drained (destructive) so a later report starts fresh");
  assert.equal(claimIds.length, 0, "claim ids drained");
  // A non-report artifact never carries chips.
  const dataRecorder = new ProvenanceRecorder(dataDir, store);
  dataRecorder.setReferencesProvider(() => ({ references: [{ id: "x", kind: "evidence", label: "evidence1" }], claimIds: [] }));
  const dataRunner = {
    executeShell: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      await writeFile(resolve(workspaceRoot, "data.csv"), "a,b\n1,2\n");
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none", createdFiles: ["data.csv"], environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" },
        executionId: request.executionId, exitCode: 0, finishedAt: timestamp, kernelId: `ephemeral:${request.executionId}`,
        kernelMode: "ephemeral", language: "shell", modifiedFiles: [], networkPolicy: "none", runnerVersion: "test",
        sandbox: "bubblewrap", startedAt: timestamp, stderr: "", stdout: "", workingDirectory: "/workspace",
      } as ShellExecutionResult;
    },
  } as unknown as RunnerClient;
  await dataRecorder.executeShell({
    agentId: "main",
    code: "cat > data.csv", permissionEpoch, runnerClient: dataRunner, sessionId: session.id, turnId: "t2", workspaceRoot,
  });
  await dataRecorder.declareWorkspaceArtifact({
    name: "data.csv", path: "data.csv", sessionId: session.id,
    sourcePath: "data.csv", turnId: "t2", workspaceRoot,
  });
  const csvArtifact = store.listArtifacts(session.id).find((a) => a.logicalName === "data.csv");
  const [csvVersion] = store.listArtifactVersions(session.id, csvArtifact!.id);
  assert.ok(!csvVersion?.references?.length, "data artifacts never carry chip references");
});

test("a failed declare_artifact (missing path) does not swallow the chip buffer", async (context) => {
  // Regression: declareWorkspaceArtifact used to drain the chip/claim buffer
  // (referencesProvider → splice) BEFORE registerWorkspaceArtifact read the
  // file. When the LLM declared a path that didn't exist yet (ENOENT), the
  // drain had already emptied the buffer and nothing rolled it back. The LLM
  // then retried declare_artifact with the right path; the version landed,
  // but references=[] so every [alias] chip in the report degraded to plain
  // text — silently, with no error. Register-first/drain-after keeps the
  // buffer intact across the failed declaration.
  const dataDir = resolve(process.cwd(), ".tmp", `drain-then-fail-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Drain then fail");
  const session = await store.createSession(project.id, "EGCG report", { modelId: model.id });
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });
  // Write the real report where the LLM eventually declares it; the first
  // declare uses a bare name that doesn't exist on disk (it's in a subagent
  // subdirectory the leader doesn't know about), mirroring the field case.
  await mkdir(resolve(workspaceRoot, "subagents", "6a0d4dae"), { recursive: true });
  await writeFile(resolve(workspaceRoot, "subagents/6a0d4dae/report.md"), "# Brief\n[ev1]\n");

  const chipMap: ComposerReference[] = [{ id: "ev-id-1", kind: "evidence", label: "ev1" }];
  const claimIds: string[] = ["claim-id-1"];
  const recorder = new ProvenanceRecorder(dataDir, store);
  recorder.setReferencesProvider(() => {
    const references = chipMap.splice(0, chipMap.length);
    const drained = claimIds.splice(0, claimIds.length);
    return { references, claimIds: drained };
  });

  // 1. declare with a path that doesn't exist → ENOENT. Pre-fix this emptied
  //    the buffer; post-fix the drain never fires so the buffer survives.
  await assert.rejects(
    recorder.declareWorkspaceArtifact({
      name: "report.md", path: "report.md", sessionId: session.id,
      sourcePath: "report.md", turnId: "t1", workspaceRoot,
    }),
    /ENOENT|no such file/i,
    "declare with a missing path fails before the version lands",
  );
  assert.equal(chipMap.length, 1, "failed declaration does NOT drain the chip buffer");
  assert.equal(claimIds.length, 1, "failed declaration does NOT drain the claim ids");

  // 2. retry with the correct subagent-prefixed path → version lands and now
  //    drains the surviving buffer onto itself.
  const { version } = await recorder.declareWorkspaceArtifact({
    name: "report.md", path: "subagents/6a0d4dae/report.md", sessionId: session.id,
    sourcePath: "subagents/6a0d4dae/report.md", turnId: "t1", workspaceRoot,
  });
  assert.equal(version.references?.length, 1, "retried declaration carries the surviving chip references");
  assert.equal(version.references?.[0]?.label, "ev1");
  assert.equal(chipMap.length, 0, "successful declaration drains the chip buffer");
  assert.equal(claimIds.length, 0, "successful declaration drains the claim ids");

  // 3. the persisted catalog version also carries the references (the message
  //    reference back-fill in runs/index.ts reads latestReportReferences here).
  const reportArtifact = store.listArtifacts(session.id).find((a) => a.logicalName === "report.md");
  assert.ok(reportArtifact, "report artifact created");
  const [persisted] = store.listArtifactVersions(session.id, reportArtifact.id);
  assert.equal(persisted?.references?.length, 1, "persisted version carries the chip references");
  assert.equal(persisted!.references![0]!.label, "ev1");
});

test("drain is scoped by turnId: a report in one context does not absorb another context's chips", async (context) => {
  // Two execution contexts (leader turnId "leader", subagent turnId "sub")
  // both push chip references. declareWorkspaceArtifact for the leader's report
  // drains ONLY the leader's entries; the subagent's entries stay buffered and
  // are drained only when a report in the subagent context lands.
  const dataDir = resolve(process.cwd(), ".tmp", `turnid-drain-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("TurnId drain");
  const session = await store.createSession(project.id, "Brief", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });

  const buffer: Array<{ turnId: string; reference: ComposerReference }> = [
    { turnId: "leader", reference: { id: "leader-art", kind: "artifact", label: "l1" } },
    { turnId: "sub", reference: { id: "sub-art", kind: "artifact", label: "s1" } },
  ];
  const claimBuffer: Array<{ turnId: string; claimId: string }> = [
    { turnId: "leader", claimId: "claim-leader" },
    { turnId: "sub", claimId: "claim-sub" },
  ];
  const recorder = new ProvenanceRecorder(dataDir, store);
  recorder.setReferencesProvider((turnId?: string) => {
    const drainAll = turnId === undefined;
    const matching = (entry: { turnId: string }): boolean => drainAll || entry.turnId === turnId;
    const references = buffer.filter(matching).map((entry) => entry.reference);
    const claimIds = claimBuffer.filter(matching).map((entry) => entry.claimId);
    const keepRefs = buffer.filter((entry) => !matching(entry));
    const keepClaims = claimBuffer.filter((entry) => !matching(entry));
    buffer.length = 0;
    buffer.push(...keepRefs);
    claimBuffer.length = 0;
    claimBuffer.push(...keepClaims);
    return { references, claimIds };
  });

  const runnerClient = {
    executeShell: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      await writeFile(resolve(workspaceRoot, "report.md"), "# Brief\n[l1]\n");
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none", createdFiles: ["report.md"], environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" },
        executionId: request.executionId, exitCode: 0, finishedAt: timestamp, kernelId: `ephemeral:${request.executionId}`,
        kernelMode: "ephemeral", language: "shell", modifiedFiles: [], networkPolicy: "none", runnerVersion: "test",
        sandbox: "bubblewrap", startedAt: timestamp, stderr: "", stdout: "done\n", workingDirectory: "/workspace",
      } as ShellExecutionResult;
    },
  } as unknown as RunnerClient;
  await recorder.executeShell({
    agentId: "main",
    code: "cat > report.md", permissionEpoch, runnerClient, sessionId: session.id, turnId: "leader", workspaceRoot,
  });
  // The leader declares its report — should drain ONLY the leader entry.
  await recorder.declareWorkspaceArtifact({
    name: "report.md", path: "report.md", sessionId: session.id,
    sourcePath: "report.md", turnId: "leader", workspaceRoot,
  });
  const reportArtifact = store.listArtifacts(session.id).find((a) => a.logicalName === "report.md");
  const [version] = store.listArtifactVersions(session.id, reportArtifact!.id);
  assert.ok(version?.references?.length, "leader report carries drained references");
  assert.equal(version!.references!.length, 1, "only the leader's entry drained, not the subagent's");
  assert.equal(version!.references![0]!.label, "l1");
  // The subagent entry is still buffered — its report (if it declared one) would absorb it.
  assert.equal(buffer.length, 1, "subagent entry stays buffered");
  assert.equal(buffer[0]!.turnId, "sub");
  assert.equal(claimBuffer.length, 1);
  assert.equal(claimBuffer[0]!.turnId, "sub");
});

test("artifact saves create immutable versions, dependencies, and attachable annotations", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `artifact-versions-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Artifact versions");
  const session = await store.createSession(project.id, "Figure edits", { modelId: model.id });
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });
  const recorder = new ProvenanceRecorder(dataDir, store);

  await writeFile(resolve(workspaceRoot, "input.csv"), "value\n1\n");
  const input = await recorder.registerWorkspaceArtifact({ path: "input.csv", sessionId: session.id, workspaceRoot });
  assert.ok(input);
  await writeFile(resolve(workspaceRoot, "plot.svg"), "<svg><text>v1</text></svg>");
  const first = await recorder.registerWorkspaceArtifact({
    inputArtifactVersionIds: [input.version.id],
    path: "plot.svg",
    sessionId: session.id,
    turnId: "turn-1",
    workspaceRoot,
  });
  await writeFile(resolve(workspaceRoot, "plot.svg"), "<svg><text>v2</text></svg>");
  const second = await recorder.registerWorkspaceArtifact({ path: "plot.svg", sessionId: session.id, turnId: "turn-2", workspaceRoot });
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.artifact.id, second.artifact.id);
  assert.deepEqual(store.listArtifactVersions(session.id, first.artifact.id).map((version) => version.version), [1, 2]);
  assert.equal((await recorder.cas.read(first.version.content.hash)).toString("utf8"), "<svg><text>v1</text></svg>");
  assert.equal((await recorder.cas.read(second.version.content.hash)).toString("utf8"), "<svg><text>v2</text></svg>");
  assert.deepEqual(first.version.inputArtifactVersionIds, [input.version.id]);

  const annotation = await store.createArtifactAnnotation(session.id, second.version.id, { note: "Increase label contrast", x: 0.4, y: 0.65 });
  const message = await store.appendMessage(session.id, "user", "Please update the pinned label.", undefined, undefined, [annotation.id]);
  assert.equal(message.annotations?.[0]?.artifactLogicalName, "plot.svg");
  assert.equal(message.annotations?.[0]?.status, "attached");
  assert.equal(store.listArtifactAnnotations(session.id, second.version.id)[0]?.attachedMessageId, message.id);
  await assert.rejects(
    store.appendMessage(session.id, "user", "Reuse annotation", undefined, undefined, [annotation.id]),
    /already attached/,
  );
});

test("declaring an execution output preserves inferred input provenance without auto-cataloging the file", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `derived-from-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Derived from");
  const session = await store.createSession(project.id, "Plot from squares", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });

  const recorder = new ProvenanceRecorder(dataDir, store);
  await writeFile(resolve(workspaceRoot, "squares.csv"), "x,y\n1,1\n2,4\n");
  const input = await recorder.registerWorkspaceArtifact({
    path: "squares.csv", sessionId: session.id, workspaceRoot,
  });
  assert.ok(input);

  const runnerClient = {
    executeShell: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      await writeFile(resolve(workspaceRoot, "plot.svg"), "<svg/>");
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none",
        createdFiles: ["plot.svg"],
        environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" },
        executionId: request.executionId,
        exitCode: 0,
        finishedAt: timestamp,
        kernelId: `ephemeral:${request.executionId}`,
        kernelMode: "ephemeral",
        language: "shell",
        modifiedFiles: [],
        networkPolicy: "none",
        runnerVersion: "test",
        sandbox: "bubblewrap",
        startedAt: timestamp,
        workingDirectory: "/workspace",
        stderr: "",
        stdout: "plotted\n",
      };
    },
  } as unknown as RunnerClient;

  const result = await recorder.executeShell({
    agentId: "main",
    code: "python plot.py squares.csv > plot.svg",
    permissionEpoch,
    runnerClient,
    sessionId: session.id,
    turnId: "turn-1",
    workspaceRoot,
  });

  assert.equal(result.producedArtifacts, undefined);
  assert.equal(store.listArtifacts(session.id).length, 1, "only the explicit input is cataloged");

  const plot = await recorder.declareWorkspaceArtifact({
    name: "plot.svg", path: "plot.svg", sessionId: session.id,
    sourcePath: "plot.svg", turnId: "turn-1", workspaceRoot,
  });
  assert.deepEqual(plot.version.inputArtifactVersionIds, [input!.version.id]);
  assert.deepEqual(plot.version.executionRunIds, [(await store.listExecutionRuns(session.id))[0]!.id]);
});

test("an execution that produces two artifacts in one run does not wire them as inputs to each other", async (context) => {
  // Regression: after two files from one run are explicitly declared, the
  // second declaration can see the first in the catalog. Because the code text
  // names both output paths, provenance must use their shared execution id to
  // avoid misclassifying the first declaration as an input to the second.
  const dataDir = resolve(process.cwd(), ".tmp", `sibling-outputs-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Sibling outputs");
  const session = await store.createSession(project.id, "Two files one run", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });

  const recorder = new ProvenanceRecorder(dataDir, store);
  const runnerClient = {
    executeShell: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      await writeFile(resolve(workspaceRoot, "fig.svg"), "<svg/>");
      await writeFile(resolve(workspaceRoot, "data.csv"), "x,y\n1,2\n");
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none",
        createdFiles: ["fig.svg", "data.csv"],
        environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: {},
        executionId: request.executionId,
        exitCode: 0,
        finishedAt: timestamp,
        kernelId: `ephemeral:${request.executionId}`,
        kernelMode: "ephemeral",
        language: "shell",
        modifiedFiles: [],
        networkPolicy: "none",
        runnerVersion: "test",
        sandbox: "bubblewrap",
        startedAt: timestamp,
        stderr: "",
        stdout: "done\n",
        workingDirectory: "/workspace",
      };
    },
  } as unknown as RunnerClient;

  // Code names both files — the pre-fix heuristic would have matched either.
  const result = await recorder.executeShell({
    agentId: "main",
    code: `python plot.py --out fig.svg --data data.csv`,
    permissionEpoch,
    runnerClient,
    sessionId: session.id,
    turnId: "turn-1",
    workspaceRoot,
  });

  assert.equal(result.producedArtifacts, undefined);
  assert.equal(store.listArtifacts(session.id).length, 0, "execution outputs remain uncataloged until declared");

  const fig = await recorder.declareWorkspaceArtifact({
    name: "fig.svg", path: "fig.svg", sessionId: session.id,
    sourcePath: "fig.svg", turnId: "turn-1", workspaceRoot,
  });
  const data = await recorder.declareWorkspaceArtifact({
    name: "data.csv", path: "data.csv", sessionId: session.id,
    sourcePath: "data.csv", turnId: "turn-1", workspaceRoot,
  });
  assert.deepEqual(fig.version.inputArtifactVersionIds, [], "first declared output has no sibling input");
  assert.deepEqual(data.version.inputArtifactVersionIds, [], "same-run sibling is not wired as an input");
  assert.deepEqual(fig.version.executionRunIds, data.version.executionRunIds, "both declarations retain the shared execution");
});

test("an execution interrupted by a run abort is recorded as cancelled, not failed", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `cancelled-provenance-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Cancelled provenance");
  const session = await store.createSession(project.id, "Stopped run", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });

  // Stopping the run aborts the shared signal, so the in-flight Runner call rejects.
  const stop = new AbortController();
  const runnerClient = {
    executeShell: async (_request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      stop.abort();
      throw new Error("This operation was aborted");
    },
  } as unknown as RunnerClient;
  const recorder = new ProvenanceRecorder(dataDir, store);
  await assert.rejects(recorder.executeShell({
    agentId: "main",
    code: "/usr/bin/bash long_job.sh",
    permissionEpoch,
    runnerClient,
    sessionId: session.id,
    signal: stop.signal,
    turnId: "turn-cancelled",
    workspaceRoot,
  }));

  const [run] = await store.listExecutionRuns(session.id);
  assert.equal(run?.status, "cancelled");
  assert.equal(run?.exitCode, null);

  // A Runner that breaks on its own is still a failure.
  const brokenRunner = {
    executeShell: async (): Promise<ShellExecutionResult> => { throw new Error("Runner is unavailable"); },
  } as unknown as RunnerClient;
  await assert.rejects(recorder.executeShell({
    agentId: "main",
    code: "/usr/bin/bash other_job.sh",
    permissionEpoch,
    runnerClient: brokenRunner,
    sessionId: session.id,
    turnId: "turn-failed",
    workspaceRoot,
  }));
  const runs = await store.listExecutionRuns(session.id);
  assert.equal(runs.at(-1)?.status, "failed");
});

test("recorder mirrors provenance addressing fields to the memory graph on shell execution", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `mirror-provenance-${process.pid}-${Date.now()}`);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Mirror provenance");
  const session = await store.createSession(project.id, "Mirror", { modelId: model.id });
  const permissionEpoch = store.getSessionPermissionEpoch(session.id)!;
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });

  const runnerClient = {
    executeShell: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> => {
      await writeFile(resolve(workspaceRoot, "mirror-output.csv"), "v\n1\n");
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none", createdFiles: ["mirror-output.csv"],
        environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" },
        executionId: request.executionId, exitCode: 0, finishedAt: timestamp,
        kernelId: `ephemeral:${request.executionId}`, kernelMode: "ephemeral",
        language: "shell", modifiedFiles: [], networkPolicy: "none",
        runnerVersion: "test", sandbox: "bubblewrap", startedAt: timestamp,
        stderr: "warn", stdout: "ok", workingDirectory: "/workspace",
      };
    },
  } as unknown as RunnerClient;

  let captured: Record<string, unknown> | null = null;
  const fake = http.createServer((_req, res) => {
    let data = "";
    _req.on("data", (chunk) => { data += chunk; });
    _req.on("end", () => {
      if (_req.url === "/observe/execution") captured = JSON.parse(data) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", written: 2 }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const port = (fake.address() as AddressInfo).port;
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${port}`, token: "t" });
    const sink = new MemoryGraphSink(client, () => true);
    const recorder = new ProvenanceRecorder(dataDir, store, sink);
    await recorder.executeShell({
      agentId: "main",
      code: "echo ok", permissionEpoch, runnerClient,
      sessionId: session.id, turnId: "turn-mirror", workspaceRoot,
    });
    // The sink is fire-and-forget; poll briefly until the POST lands.
    for (let i = 0; i < 50 && !captured; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(captured, "memory graph received observeExecution");
    // The client posts snake_case to the Python sidecar. SubTask messages
    // addressing uses turn_id (manifest_ids was dropped — it raced manifest
    // persistence at mirror time).
    const body = captured as unknown as Record<string, unknown>;
    assert.equal(body.turn_id, "turn-mirror");
    assert.ok(body.stdout_hash, "stdout_hash mirrored");
    assert.ok(body.stderr_hash, "stderr_hash mirrored");
    assert.ok(body.env_hash === null, "env_hash null for shell runs");
    const arts = body.produced_artifacts as Array<Record<string, unknown>>;
    assert.deepEqual(arts, [], "execution alone does not create a graph Artifact");
    assert.equal(body.env_hash, null);  // shell runs have no env snapshot

    captured = null;
    await recorder.declareWorkspaceArtifact({
      name: "mirror-output.csv", path: "mirror-output.csv", sessionId: session.id,
      sourcePath: "mirror-output.csv", turnId: "turn-mirror", workspaceRoot,
    });
    for (let i = 0; i < 50 && !captured; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const declaredBody = captured as unknown as Record<string, unknown>;
    const declaredArtifacts = declaredBody.produced_artifacts as Array<Record<string, unknown>>;
    assert.equal(declaredArtifacts[0]!.turn_id, "turn-mirror");
    assert.equal(declaredArtifacts[0]!.project_id, project.id);
    assert.ok(declaredArtifacts[0]!.content_hash, "declared artifact content_hash mirrored");
  } finally {
    await new Promise<void>((r) => fake.close(() => r()));
  }
});
