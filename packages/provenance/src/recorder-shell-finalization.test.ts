// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { canonicalize, snapshotWorkspace, VersionStore } from "@sciencediscovery/cas";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { ArtifactDerivation, EnvironmentRevision, ExecutionRun, ShellExecutionResult, WorkspaceFileRevision } from "@sciencediscovery/schema";
import { prepareShellExecutionContext, ProvenanceRecorder, type ProvenanceStore, type ShellExecutionContext } from "./recorder.js";

const timestamp = "2026-10-20T01:00:00.000Z";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown) => canonicalize(JSON.parse(JSON.stringify(value)));

function storeFixture() {
  const runs = new Map<string, ExecutionRun>();
  const derivations = new Map<string, ArtifactDerivation>();
  const outputs = new Map<string, WorkspaceFileRevision>();
  let environmentRevisions: EnvironmentRevision[] = [];
  let failDerivationAcknowledgement = false;
  const store: ProvenanceStore = {
    async appendExecutionRun(run) {
      const existing = runs.get(run.id);
      if (existing) assert.equal(canonical(run), canonical(existing));
      else runs.set(run.id, structuredClone(run));
    },
    async listExecutionRuns() { return [...runs.values()]; },
    async appendArtifactDerivations(_sessionId, additions) {
      for (const addition of additions) {
        const existing = derivations.get(addition.id);
        if (existing) assert.deepEqual(addition, existing);
        else derivations.set(addition.id, structuredClone(addition));
      }
      if (failDerivationAcknowledgement) {
        failDerivationAcknowledgement = false;
        throw new Error("lost derivation commit acknowledgement");
      }
    },
    async listArtifactDerivations() { return [...derivations.values()]; },
    async recordWorkspaceFileRevisions(sessionId, inputs) {
      return inputs.map((input) => {
        const key = `${input.executionRunId}:${input.path}`;
        const existing = outputs.get(key);
        if (existing) return existing;
        const revision = { ...input, id: key, sessionId, artifactVersionIds: [], createdAt: timestamp,
          fileId: input.path, projectId: "project" } satisfies WorkspaceFileRevision;
        outputs.set(key, revision);
        return revision;
      });
    },
    async recordWorkspaceFileRevision(sessionId, input) {
      return (await store.recordWorkspaceFileRevisions(sessionId, [input]))[0]!;
    },
    listArtifacts() { return []; },
    listArtifactVersions() { return []; },
    listEnvironmentRevisions() { return environmentRevisions; },
    async replaceScientificEnvironmentCatalog(_environments, revisions) { environmentRevisions = revisions; },
    async createArtifactVersion() { throw new Error("implicit artifact creation is forbidden"); },
    updateArtifactVersionReferences() { throw new Error("unexpected artifact mutation"); },
  };
  return { store, runs, derivations, outputs, loseNextDerivationAcknowledgement() { failDerivationAcknowledgement = true; } };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "shell-finalizer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const catalog = storeFixture();
  const context: ShellExecutionContext = {
    agentId: "main", code: "echo done", executionId: "execution-1", sessionId: "session-1",
    turnId: "turn-1", toolCallId: "tool-call-1", runnerId: "runner-1", workspaceRoot,
    permissionEpoch: { id: "epoch-1", createdAt: timestamp, environmentRevisionId: "system-shell-bwrap-v1",
      mounts: [], networkPolicy: "none", reason: "test", secretRefs: [], sessionId: "session-1" },
  };
  const result: ShellExecutionResult = {
    cgroupMode: "none", createdFiles: [], modifiedFiles: [], environmentRevisionId: "system-shell-bwrap-v1",
    environmentVariables: { LANG: "C.UTF-8", HOME: "/home/sandbox" }, executionId: context.executionId,
    exitCode: 0, finishedAt: timestamp, startedAt: timestamp, kernelId: `ephemeral:${context.executionId}`,
    kernelMode: "ephemeral", language: "shell", networkPolicy: "none", runnerVersion: "test",
    sandbox: "bubblewrap", stdout: "done\n", stderr: "", workingDirectory: "/workspace",
  };
  // This dependency exposes no computation/dispatch capability at all.
  const reader = {
    async listEnvironments() { throw new Error("unexpected environment fetch"); },
    async listEnvironmentRevisions() { throw new Error("unexpected environment fetch"); },
    async environmentSnapshot() { throw new Error("unexpected environment fetch"); },
  };
  return { root, context, result, reader, ...catalog, recorder: new ProvenanceRecorder(root, catalog.store) };
}

test("shell context is serializable and excludes transports, callbacks, and proxy credentials", async (t) => {
  const f = await fixture(t);
  const prepared = prepareShellExecutionContext({ ...f.context, runnerClient: f.reader as unknown as RunnerClient,
    signal: new AbortController().signal, dispatch: async () => f.result, completionStatus: () => "succeeded",
    sandboxEgressProxy: { mode: "url", url: "https://user:password@proxy.invalid" } });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), f.context);
  prepared.permissionEpoch.secretRefs.push("audit-reference");
  assert.deepEqual(f.context.permissionEpoch.secretRefs, [], "the snapshot must not share mutable permission objects");
});

test("existing shell results commit without dispatch and reenter after recorder restart", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.recorder.commitExistingShellExecutionResult(f.context, f.result, f.reader), f.result);
  const restarted = new ProvenanceRecorder(f.root, f.store);
  const reordered = { ...f.result, environmentVariables: { HOME: "/home/sandbox", LANG: "C.UTF-8" } };
  await restarted.commitExistingShellExecutionResult(JSON.parse(JSON.stringify(f.context)), reordered, f.reader);
  assert.equal(f.runs.size, 1);
  const run = f.runs.get(f.context.executionId)!;
  assert.equal(run.status, "succeeded");
  assert.equal(run.resultDigest?.length, 64);
  assert.equal((await f.recorder.cas.read(run.stdout.hash)).toString(), "done\n");
});

test("existing shell result rejects changed identity, result, status, or workspace references", async (t) => {
  const f = await fixture(t);
  await f.recorder.commitExistingShellExecutionResult(f.context, f.result, f.reader);
  for (const changed of [
    { ...f.result, executionId: "another-execution" },
    { ...f.result, stdout: "different output" },
    { ...f.result, workspaceSnapshot: { pool: "agent-state" as const, digest: `sha256:${"a".repeat(64)}` as const,
      size: 1, mediaType: "application/json" } },
  ]) {
    await assert.rejects(f.recorder.commitExistingShellExecutionResult(f.context, changed, f.reader), /EXECUTION_RESULT_CONFLICT/);
  }
  await assert.rejects(f.recorder.commitExistingShellExecutionResult(f.context, f.result, f.reader, "cancelled"), /EXECUTION_RESULT_CONFLICT/);
  assert.equal(f.runs.size, 1);
  assert.equal(f.runs.get(f.context.executionId)!.status, "succeeded");
});

test("provenance conflicts carry a structured EXECUTION_RESULT_CONFLICT code and keep the original run untouched", async (t) => {
  const f = await fixture(t);
  const conflict = (promise: Promise<unknown>) => assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error, "conflict must be an Error");
    assert.equal((error as Error & { code?: string }).code, "EXECUTION_RESULT_CONFLICT");
    assert.match(error.message, /EXECUTION_RESULT_CONFLICT/);
    return true;
  });
  await f.recorder.commitExistingShellExecutionResult(f.context, f.result, f.reader);
  await conflict(f.recorder.commitExistingShellExecutionResult(f.context, { ...f.result, stdout: "different output" }, f.reader));
  await conflict(f.recorder.commitExistingShellExecutionResult(f.context, f.result, f.reader, "cancelled"));
  await conflict(f.recorder.commitExistingShellExecutionResult(f.context, { ...f.result, executionId: "another-execution" }, f.reader));
  await conflict(f.recorder.commitExistingShellExecutionFailure(f.context, { state: "failed", error: "changed failure", finishedAt: timestamp }));
  assert.equal(f.runs.size, 1, "a conflict must not append or replace the existing immutable run");
  assert.equal(f.runs.get(f.context.executionId)!.status, "succeeded");
  assert.equal(f.derivations.size, 0);
});

test("environment snapshot failure leaves no execution provenance and retries the original revision", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('{"version":"original"}');
  const revision: EnvironmentRevision = {
    id: "revision-original", environmentId: "environment-1", channels: [], createdAt: timestamp, language: "shell",
    languageVersion: "1", packages: [], packageSpecHash: hash("spec"), platform: "linux", provisioner: "test",
    runnerVersion: "test", snapshot: { hash: hash(bytes), size: bytes.length },
  };
  let corrupt = true;
  const requested: string[] = [];
  const reader = {
    async listEnvironments() { return []; },
    async listEnvironmentRevisions() { return [revision, { ...revision, id: "revision-latest" }]; },
    async environmentSnapshot(id: string) { requested.push(id); return corrupt ? Buffer.from("corrupt") : bytes; },
  };
  const context = { ...f.context, environmentId: revision.environmentId };
  const result = { ...f.result, environmentRevisionId: revision.id };
  await assert.rejects(f.recorder.commitExistingShellExecutionResult(context, result, reader), /snapshot mismatch/);
  assert.equal(f.runs.size, 0);
  assert.equal(f.derivations.size, 0);
  corrupt = false;
  await new ProvenanceRecorder(f.root, f.store).commitExistingShellExecutionResult(context, result, reader);
  assert.deepEqual(requested, [revision.id, revision.id]);
  assert.equal(f.runs.get(context.executionId)!.environmentRevisionId, revision.id);
});

test("shell output retry after lost commit acknowledgement preserves immutable derivations", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.context.workspaceRoot, "result.txt"), "original");
  const snapshot = await snapshotWorkspace(new VersionStore(f.root), f.context.workspaceRoot);
  const result = { ...f.result, createdFiles: ["result.txt"], workspaceSnapshot: snapshot };
  f.loseNextDerivationAcknowledgement();
  await assert.rejects(f.recorder.commitExistingShellExecutionResult(f.context, result, f.reader), /lost derivation/);
  await writeFile(join(f.context.workspaceRoot, "result.txt"), "changed later");
  await new ProvenanceRecorder(f.root, f.store).commitExistingShellExecutionResult(f.context, result, f.reader);
  assert.equal(f.runs.size, 1);
  assert.equal(f.outputs.size, 1);
  assert.equal(f.derivations.size, 1);
  assert.equal([...f.derivations.values()][0]!.content.hash, hash("original"));
});

test("remote shell output references stay in the Runner namespace without local CAS reads", async (t) => {
  const f = await fixture(t);
  const result = { ...f.result, createdFiles: ["remote-only.txt"], workspaceSnapshot: {
    pool: "agent-state" as const, digest: `sha256:${"a".repeat(64)}` as const, size: 50, mediaType: "application/json",
  } };
  const returned = await f.recorder.commitExistingShellExecutionResult({ ...f.context, runnerWorkspaceKey: "remote-workspace" }, result, f.reader);
  assert.deepEqual(returned.workspaceSnapshot, result.workspaceSnapshot);
  assert.equal(f.derivations.size, 0);
  assert.equal(f.outputs.size, 0);
  assert.equal(f.runs.get(f.context.executionId)!.runnerId, "runner-1");
});

test("normal shell completion uses the finalizer and managed observation loss records uncertainty", async (t) => {
  const f = await fixture(t);
  let dispatches = 0;
  const runner = { ...f.reader, async health() { return { sandbox: "bubblewrap" }; },
    async executeShell() { dispatches++; return f.result; } } as unknown as RunnerClient;
  await f.recorder.executeShell({ ...f.context, runnerClient: runner });
  assert.equal(dispatches, 1);
  assert.equal(f.runs.size, 1);
  assert.ok(f.runs.get(f.context.executionId)!.resultDigest);
  await assert.rejects(f.recorder.executeShell({ ...f.context, executionId: "unobserved", runnerClient: runner,
    dispatch: async () => { throw new Error("observation unavailable"); } }), /observation unavailable/);
  assert.equal(f.runs.size, 2);
  assert.equal(f.runs.get("unobserved")!.status, "unconfirmed");
  assert.equal(f.runs.get("unobserved")!.exitCode, null);
  assert.equal(f.runs.get("unobserved")!.resultDigest, undefined);
  assert.equal(dispatches, 1);
});

test("verified no-result failures commit idempotent audits without inventing runtime evidence", async (t) => {
  const f = await fixture(t);
  const failure = { state: "failed" as const, error: "Rejected before launch", finishedAt: timestamp };
  await f.recorder.commitExistingShellExecutionFailure(f.context, failure);
  await new ProvenanceRecorder(f.root, f.store).commitExistingShellExecutionFailure(f.context, failure);
  assert.equal(f.runs.size, 1);
  const run = f.runs.get(f.context.executionId)!;
  assert.equal(run.status, "failed");
  assert.equal(run.environmentRevisionId, null);
  assert.equal(run.exitCode, null);
  assert.equal(run.envSnapshot, null);
  assert.equal(run.sandbox, "unavailable");
  assert.equal(run.kernelMode, null);
  assert.equal(run.startedAt, failure.finishedAt);
  await assert.rejects(f.recorder.commitExistingShellExecutionFailure(f.context,
    { ...failure, error: "changed failure" }), /EXECUTION_RESULT_CONFLICT/);
  await assert.rejects(f.recorder.commitExistingShellExecutionResult(f.context, f.result, f.reader), /EXECUTION_RESULT_CONFLICT/);
  const cancelled = { ...f.context, executionId: "cancelled-before-launch" };
  await f.recorder.commitExistingShellExecutionFailure(cancelled, { ...failure, state: "cancelled" });
  assert.equal(f.runs.get(cancelled.executionId)!.status, "cancelled");
  await assert.rejects(f.recorder.commitExistingShellExecutionFailure(cancelled,
    { state: "cancelled", finishedAt: "" }), /stable completion time/);
});

test("synchronous shell dispatch failure still records its existing failed/cancelled audit", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const runner = { ...f.reader, async health() { return { sandbox: "bubblewrap" }; },
    async executeShell() { throw new Error("cancelled"); } } as unknown as RunnerClient;
  await assert.rejects(f.recorder.executeShell({ ...f.context, runnerClient: runner, signal: controller.signal }), /cancelled/);
  assert.equal(f.runs.get(f.context.executionId)!.status, "cancelled");
});

test("managed lost observation records unconfirmed then finalizes the same ID idempotently", async t => {
  const f = await fixture(t);
  const history: ExecutionRun[] = [];
  f.store.listExecutionRuns = async () => history;
  f.store.appendExecutionRun = async run => {
    const prior = history.findLast(item => item.id === run.id);
    if (prior && prior.status !== "unconfirmed") assert.equal(canonical(prior), canonical(run));
    else history.push(structuredClone(run));
  };
  let launches = 0;
  const runner = { ...f.reader, async health() { return { sandbox: "bubblewrap" }; } } as unknown as RunnerClient;
  await assert.rejects(f.recorder.executeShell({ ...f.context, runnerClient: runner,
    dispatch: async () => { launches++; throw new Error("lost acknowledgement"); }, completionStatus: () => "unconfirmed" }), /lost acknowledgement/);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.status, "unconfirmed");
  await f.recorder.commitExistingShellExecutionResult(f.context, f.result, f.reader);
  await f.recorder.commitExistingShellExecutionResult(f.context, f.result, f.reader);
  assert.equal(history.length, 2);
  assert.equal(history[1]!.status, "succeeded");
  assert.equal(history[0]!.id, history[1]!.id);
  assert.equal(launches, 1);
  await assert.rejects(f.recorder.commitExistingShellExecutionResult(f.context, { ...f.result, exitCode: 127 }, f.reader), /EXECUTION_RESULT_CONFLICT/);
});
