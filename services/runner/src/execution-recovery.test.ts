// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { RefStore, VersionStore, type AgentStateRef } from "@sciencediscovery/cas";
import type { ExecutionOwner, ManagedExecution, RecoveryManifest, ShellExecutionRequest, ShellExecutionResult } from "@sciencediscovery/schema";
import { RECOVERY_OBJECT_MAX_BYTES } from "@sciencediscovery/schema";
import { ExecutionManager, type ExecutionLogSink } from "./execution-manager.js";
import { readRecoveryFile } from "./execution-recovery.js";

const owner: ExecutionOwner = { sessionId: "recovery-session", agentId: "main" };
const environmentRevisionId = "fixture-environment-v1";
const initialCode = "python3 recovery-fixture.py initial";
const resumeCode = "python3 recovery-fixture.py resume";
const fixtureProgram = new URL("../workloads/recovery-fixture.py", import.meta.url);

function request(workspaceRoot: string, executionId: string, code = initialCode): ShellExecutionRequest {
  return { executionId, agentId: owner.agentId, workspaceRoot, code, recoveryMetadataPath: "recovery.json",
    permissionEpoch: { sessionId: owner.sessionId } as ShellExecutionRequest["permissionEpoch"] };
}

function result(executionId: string, exitCode = 7, revision = environmentRevisionId): ShellExecutionResult {
  return { executionId, environmentRevisionId: revision, exitCode, stdout: "", stderr: "",
    createdFiles: [], modifiedFiles: [], language: "shell", kernelMode: "ephemeral", kernelId: `ephemeral:${executionId}`,
    cgroupMode: "none", sandbox: "bubblewrap", environmentVariables: {}, networkPolicy: "none", runnerVersion: "fixture",
    workingDirectory: "/workspace", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
}

async function prepare(workspace: string) {
  await mkdir(workspace, { recursive: true });
  await copyFile(fixtureProgram, resolve(workspace, "recovery-fixture.py"));
  await writeFile(resolve(workspace, "input.json"), "[3,5,7,11]\n");
  await writeFile(resolve(workspace, "config.json"), '{"multiplier":2}\n');
}

async function fixture(context: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "recovery-evidence-"));
  const workspace = resolve(root, "workspace");
  await prepare(workspace);
  const value = { root, workspace, manager: new ExecutionManager(root), versions: new VersionStore(root) };
  context.after(async () => { await value.manager.close(); await rm(root, { recursive: true, force: true }); });
  return value;
}

async function finished(manager: ExecutionManager, id: string, scope = owner): Promise<ManagedExecution> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const execution = manager.get(id, scope);
    if (execution.finishedAt && execution.state !== "queued" && execution.state !== "running") return execution;
    await new Promise(done => setTimeout(done, 5));
  }
  throw new Error(`Execution ${id} did not finish`);
}

async function unknownPublication(manager: ExecutionManager, id: string): Promise<ManagedExecution> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const execution = manager.get(id, owner);
    if (execution.state === "unknown") return execution;
    await new Promise(done => setTimeout(done, 5));
  }
  throw new Error(`Execution ${id} did not enter publication recovery`);
}

function rejectQuarantinedContinuation(f: Awaited<ReturnType<typeof fixture>>, input: ShellExecutionRequest) {
  let dispatched = 0;
  assert.throws(() => f.manager.submit(input, async () => { dispatched++; return result(input.executionId, 0); }),
    { code: "EXECUTION_RESOURCE_QUARANTINED", statusCode: 409 });
  assert.equal(dispatched, 0, "uncertain resources must reject before process launch");
  assert.throws(() => f.manager.get(input.executionId, { sessionId: input.permissionEpoch.sessionId, agentId: input.agentId }),
    { code: "EXECUTION_NOT_FOUND" }, "rejected admission must not create an execution");
}

/** CPU-only process fixture, not a substitute for the production sandbox tests. */
function operation(input: ShellExecutionRequest, revision = environmentRevisionId, launched?: () => void) {
  return async (signal: AbortSignal, log: ExecutionLogSink, expectedEnvironmentRevisionId?: string): Promise<ShellExecutionResult> => {
    if (expectedEnvironmentRevisionId !== undefined && expectedEnvironmentRevisionId !== revision) {
      throw new Error("RECOVERY_ENVIRONMENT_CHANGED");
    }
    launched?.();
    const mode = input.code.split(" ").at(-1)!;
    const child = spawn("python3", ["recovery-fixture.py", mode], {
      cwd: input.workspaceRoot, signal,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SCIENCEDISCOVERY_EXECUTION_ID: input.executionId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); log("stdout", chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); log("stderr", chunk); });
    const exitCode = await new Promise<number>((done, reject) => {
      child.once("error", reject);
      child.once("close", code => done(code ?? 1));
    });
    return { ...result(input.executionId, exitCode, revision), stdout, stderr };
  };
}

async function failOriginal(f: Awaited<ReturnType<typeof fixture>>, id = "original",
  editMetadata?: (value: Record<string, any>) => void) {
  const input = request(f.workspace, id);
  f.manager.start(input, async (...args) => {
    const output = await operation(input)(...args);
    if (editMetadata) {
      const path = resolve(f.workspace, "recovery.json");
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
      editMetadata(value);
      await writeFile(path, JSON.stringify(value));
    }
    return output;
  });
  const original = await finished(f.manager, id);
  assert.equal(original.state, "failed", original.error ?? "");
  assert.equal(original.result?.exitCode, 7);
  return original;
}

function continuation(workspace: string, parent: ManagedExecution, id = "resumed"): ShellExecutionRequest {
  return { ...request(workspace, id, resumeCode), recoveryContext: { parentExecutionId: parent.id,
    recoveryPointId: "continue-units", manifestDigest: parent.recovery!.manifestRef!.objectId, attemptToken: id } };
}

async function rejectContinuation(f: Awaited<ReturnType<typeof fixture>>, input: ShellExecutionRequest, pattern: RegExp) {
  let dispatched = 0;
  f.manager.start(input, async () => { dispatched++; return result(input.executionId, 0); });
  const child = await finished(f.manager, input.executionId, { sessionId: input.permissionEpoch.sessionId, agentId: input.agentId });
  assert.equal(child.state, "failed");
  assert.match(child.error ?? "", pattern);
  assert.equal(dispatched, 0, "validation must precede process launch");
  assert.equal(child.startedAt, undefined);
  return child;
}

test("recovery fixture persists immutable evidence across restart and resumes only unfinished units", async context => {
  const f = await fixture(context);
  const original = await failOriginal(f);
  assert.equal(original.recovery?.capability, "supported");
  const manifest = original.recovery!.manifest!;
  assert.deepEqual(manifest.workUnits.map(unit => unit.state), ["completed", "completed", "failed", "not_started"]);
  assert.equal(manifest.objects[0]!.integrity, "verified");
  assert.equal(manifest.objects[1]!.integrity, "unverified");
  assert.equal(manifest.objects[1]!.ref, undefined, "partial output is never frozen as a complete checkpoint");
  await f.versions.validateClosure(original.version!);
  const stored = await f.versions.readRecord<{ recoveryManifest: AgentStateRef }>(original.version!, "WorkspaceExecution");
  assert.equal(stored.value.recoveryManifest.digest, original.recovery!.manifestRef!.objectId);
  assert.equal((await f.versions.readRecord<RecoveryManifest>(stored.value.recoveryManifest, "ExecutionRecovery")).value.execution.executionId, original.id);
  const originalBytes = JSON.stringify(original);
  await f.manager.close();
  const db = new DatabaseSync(resolve(f.root, "runner-executions", "executions.sqlite"));
  db.exec("DELETE FROM logs"); db.close();
  f.manager = new ExecutionManager(f.root);
  const recovered = f.manager.get(original.id, owner);
  assert.equal(JSON.stringify(recovered), originalBytes, "a restart preserves the exact failure and manifest");
  assert.deepEqual(f.manager.logs(original.id, owner).chunks, []);
  const input = continuation(f.workspace, recovered);
  let expectedRevision: string | undefined;
  f.manager.start(input, (signal, log, expected) => {
    expectedRevision = expected;
    return operation(input)(signal, log, expected);
  });
  const resumed = await finished(f.manager, input.executionId);
  assert.equal(resumed.state, "completed", resumed.error ?? "");
  assert.equal(expectedRevision, environmentRevisionId);
  assert.equal(resumed.recoveryContext?.parentExecutionId, original.id);
  assert.notEqual(resumed.id, original.id);
  assert.equal(JSON.stringify(f.manager.get(original.id, owner)), originalBytes, "the parent failure is never overwritten");
  const events = (await readFile(resolve(f.workspace, "executed-units.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events, ["prepare", "unit-1", "unit-2", "unit-3", "unit-4"]);
  const cleanWorkspace = resolve(f.root, "clean");
  await prepare(cleanWorkspace);
  const clean = request(cleanWorkspace, "clean", "python3 recovery-fixture.py clean");
  f.manager.start(clean, operation(clean));
  assert.equal((await finished(f.manager, clean.executionId)).state, "completed");
  assert.deepEqual(await readFile(resolve(f.workspace, "result.json")), await readFile(resolve(cleanWorkspace, "result.json")));
});

test("recovery refuses another owner, workspace, command, directory, or manifest identity", async context => {
  const f = await fixture(context);
  const original = await failOriginal(f);
  assert.throws(() => f.manager.get(original.id, { ...owner, sessionId: "other" }), /not found/);
  assert.throws(() => f.manager.get(original.id, { ...owner, agentId: "other" }), /not found/);
  await rejectContinuation(f, { ...continuation(f.workspace, original, "wrong-agent"), agentId: "other" }, /not found/);
  await rejectContinuation(f, { ...continuation(f.workspace, original, "wrong-session"),
    permissionEpoch: { sessionId: "other" } as ShellExecutionRequest["permissionEpoch"] }, /not found/);
  const otherWorkspace = resolve(f.root, "other-workspace");
  await prepare(otherWorkspace);
  await rejectContinuation(f, continuation(otherWorkspace, original, "wrong-workspace"), /RECOVERY_EVIDENCE_NOT_PUBLISHED/);
  await rejectContinuation(f, { ...continuation(f.workspace, original, "wrong-code"), code: "echo unauthorized" }, /RECOVERY_REQUEST_CHANGED/);
  await rejectContinuation(f, { ...continuation(f.workspace, original, "wrong-cwd"), cwd: "other" }, /RECOVERY_REQUEST_CHANGED/);
  const wrongManifest = continuation(f.workspace, original, "wrong-manifest");
  wrongManifest.recoveryContext!.manifestDigest = `sha256:${"0".repeat(64)}`;
  await rejectContinuation(f, wrongManifest, /RECOVERY_EVIDENCE_MISMATCH/);
});

test("missing, unsupported, malformed, and stale sidecars never manufacture support", async context => {
  const f = await fixture(context);
  const absent = request(f.workspace, "absent");
  delete absent.recoveryMetadataPath;
  f.manager.start(absent, async () => result(absent.executionId));
  assert.equal((await finished(f.manager, absent.executionId)).recovery?.reason, "NOT_REPORTED");
  const unsupported = await failOriginal(f, "unsupported", metadata => {
    metadata.continuation = { capability: "unsupported", reason: "NO_CHECKPOINT_IMPLEMENTATION", points: [] };
  });
  assert.equal(unsupported.recovery?.capability, "unsupported");
  assert.equal(unsupported.recovery?.reason, "NO_CHECKPOINT_IMPLEMENTATION");
  await rejectContinuation(f, continuation(f.workspace, unsupported, "unsupported-child"), /RECOVERY_NOT_SUPPORTED/);
  const unknown = await failOriginal(f, "unknown-adapter", metadata => {
    metadata.continuation = { capability: "unknown", reason: "ADAPTER_CAPABILITY_UNKNOWN", points: [] };
  });
  assert.equal(unknown.recovery?.capability, "unknown");
  await rejectContinuation(f, continuation(f.workspace, unknown, "unknown-child"), /RECOVERY_NOT_SUPPORTED/);
  for (const [id, edit] of [
    ["stale", (metadata: Record<string, any>) => { metadata.executionId = "another-execution"; }],
    ["future", (metadata: Record<string, any>) => { metadata.schemaVersion = 999; }],
    ["dangling", (metadata: Record<string, any>) => { metadata.continuation.points[0].requiredObjectIds = ["absent"]; }],
  ] as const) {
    const execution = await failOriginal(f, id, edit);
    assert.equal(execution.recovery?.capability, "unknown", id);
    assert.equal(execution.recovery?.manifestRef, undefined, id);
    assert.ok(execution.version, "invalid metadata does not discard the ordinary failure receipt");
  }
});

test("partial, semantically unverified, and hash-invalid checkpoints block continuation", async context => {
  const f = await fixture(context);
  for (const [id, edit] of [
    ["partial", (metadata: Record<string, any>) => { metadata.continuation.points[0].requiredObjectIds = ["partial-unit"]; }],
    ["unverified", (metadata: Record<string, any>) => { metadata.objects[0].validation = { status: "unverified" }; }],
    ["wrong-hash", (metadata: Record<string, any>) => { metadata.objects[0].sha256 = "0".repeat(64); }],
    ["wrong-size", (metadata: Record<string, any>) => { metadata.objects[0].size++; }],
  ] as const) {
    const original = await failOriginal(f, id, edit);
    assert.equal(original.recovery?.capability, "supported", "capability is distinct from current eligibility");
    await rejectContinuation(f, continuation(f.workspace, original, `${id}-child`), /INVALID_CHECKPOINT/);
  }
});

test("invalid complete objects consume the attempted I/O budget before another checkpoint is read", async context => {
  const f = await fixture(context);
  const original = await failOriginal(f, "quota", metadata => {
    const valid = metadata.objects[0];
    metadata.objects = [
      ...Array.from({ length: 4 }, (_, index) => ({ ...valid, id: `invalid-${index}`,
        size: RECOVERY_OBJECT_MAX_BYTES, sha256: "0".repeat(64) })),
      valid,
    ];
  });
  assert.equal(original.recovery?.capability, "supported");
  assert.equal(original.recovery!.manifest!.objects.length, 5);
  for (const object of original.recovery!.manifest!.objects) {
    assert.equal(object.integrity, "invalid", object.id);
    assert.equal(object.ref, undefined, object.id);
  }
  await rejectContinuation(f, continuation(f.workspace, original), /INVALID_CHECKPOINT/);
});

test("changed checkpoint, input, configuration, or program cannot be reused", async context => {
  for (const path of ["checkpoint.json", "input.json", "config.json", "recovery-fixture.py"]) {
    const f = await fixture(context);
    const original = await failOriginal(f);
    const modified = await readFile(resolve(f.workspace, path));
    modified[0] = modified[0]! ^ 1;
    await writeFile(resolve(f.workspace, path), modified);
    await rejectContinuation(f, continuation(f.workspace, original), path === "checkpoint.json" ? /RECOVERY_OUTPUT_CHANGED/ : /RECOVERY_PRECONDITION_CHANGED/);
  }
});

test("checkpoint integrity is checked at dequeue rather than only when continuation is requested", async context => {
  const f = await fixture(context);
  const original = await failOriginal(f);
  let release!: () => void;
  const latch = new Promise<void>(done => { release = done; });
  let started!: () => void;
  const admitted = new Promise<void>(done => { started = done; });
  f.manager.start(request(f.workspace, "writer", "writer"), async () => {
    started(); await latch;
    await writeFile(resolve(f.workspace, "checkpoint.json"), "new checkpoint\n");
    return result("writer", 0);
  });
  await admitted;
  let dispatched = 0;
  const child = continuation(f.workspace, original);
  assert.equal(f.manager.start(child, async () => { dispatched++; return result(child.executionId, 0); }).state, "queued");
  release();
  const execution = await finished(f.manager, child.executionId);
  assert.equal(execution.state, "failed");
  assert.match(execution.error!, /RECOVERY_OUTPUT_CHANGED/);
  assert.equal(dispatched, 0);
});

test("environment changes are rejected by the launch callback before the process starts", async context => {
  const f = await fixture(context);
  const original = await failOriginal(f);
  const input = continuation(f.workspace, original);
  let launched = 0;
  f.manager.start(input, operation(input, "fixture-environment-v2", () => { launched++; }));
  const child = await finished(f.manager, input.executionId);
  assert.equal(child.state, "failed");
  assert.match(child.error!, /RECOVERY_ENVIRONMENT_CHANGED/);
  assert.equal(launched, 0);
});

test("recovery rejects unsafe paths, symlinked leaves and parents, and oversized files", async context => {
  const f = await fixture(context);
  await writeFile(resolve(f.root, "outside"), "private outside bytes");
  await symlink(resolve(f.root, "outside"), resolve(f.workspace, "linked-file"));
  await symlink(f.root, resolve(f.workspace, "linked-directory"));
  for (const path of ["../outside", "/etc/passwd", "nested/../outside", "a\\b", "a\0b", "linked-file", "linked-directory/outside"]) {
    await assert.rejects(readRecoveryFile(f.workspace, path, 1024), path);
  }
  await assert.rejects(readRecoveryFile(f.workspace, "input.json", 1), /INVALID_RECOVERY_FILE/);
  await assert.rejects(readRecoveryFile(f.workspace, "missing", 1024), /ENOENT/);
  const original = await failOriginal(f);
  await rm(resolve(f.workspace, "checkpoint.json"));
  await symlink(resolve(f.root, "outside"), resolve(f.workspace, "checkpoint.json"));
  await rejectContinuation(f, continuation(f.workspace, original), /ELOOP|UNSAFE_RECOVERY_PATH/);
});

test("deleted or corrupted immutable checkpoint objects prevent any new computation", async context => {
  for (const corruption of ["delete", "overwrite"] as const) {
    const f = await fixture(context);
    const original = await failOriginal(f);
    const ref = original.recovery!.manifest!.objects[0]!.ref!;
    const path = f.versions.objectPath({ pool: ref.pool, digest: ref.objectId, size: ref.size, mediaType: ref.mediaType });
    if (corruption === "delete") await rm(path);
    else await writeFile(path, "corrupted");
    await rejectContinuation(f, continuation(f.workspace, original), /ENOENT|integrity failure/i);
  }
});

test("queued, running, cancelled, and unknown originals are not failed-process evidence", async context => {
  for (const state of ["queued", "running", "cancelled", "unknown"] as const) {
    const f = await fixture(context);
    const original = await failOriginal(f);
    await f.manager.close();
    const db = new DatabaseSync(resolve(f.root, "runner-executions", "executions.sqlite"));
    const stored = { ...original, id: `parent-${state}`, state };
    db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?)").run(stored.id, stored.sessionId, stored.agentId, JSON.stringify(stored));
    db.close();
    f.manager = new ExecutionManager(f.root);
    const parent = f.manager.get(stored.id, owner);
    if (state === "queued" || state === "running") assert.equal(parent.state, "unknown");
    const input = continuation(f.workspace, parent, `child-${state}`);
    if (state === "cancelled") await rejectContinuation(f, input, /ORIGINAL_NOT_CONFIRMED_FAILED/);
    else rejectQuarantinedContinuation(f, input);
  }
});

test("unverified prerequisites and direct or explicit handoff modes never bypass normal execution scope", async context => {
  const f = await fixture(context);
  const original = await failOriginal(f, "manual", metadata => { metadata.continuation.points[0].prerequisites = ["Install an unverified dependency"]; });
  await rejectContinuation(f, continuation(f.workspace, original), /RECOVERY_PREREQUISITES_UNVERIFIED/);
  await rejectContinuation(f, { ...continuation(f.workspace, original, "handoff"), explicitHandoff: true }, /RECOVERY_EXECUTION_MODE_UNSUPPORTED/);
  await rejectContinuation(f, { ...continuation(f.workspace, original, "direct"),
    directAuthorization: {} as NonNullable<ShellExecutionRequest["directAuthorization"]> }, /RECOVERY_EXECUTION_MODE_UNSUPPORTED/);
});

test("failed ref publication never exposes an unrooted recovery manifest", async context => {
  const f = await fixture(context);
  const input = request(f.workspace, "unrooted");
  f.manager.start(input, async (...args) => {
    const output = await operation(input)(...args);
    context.mock.method(RefStore.prototype, "commit", async () => { throw new Error("injected recovery ref failure"); });
    return output;
  });
  const execution = await unknownPublication(f.manager, input.executionId);
  assert.equal(execution.state, "unknown");
  assert.equal(execution.finishedAt, undefined, "publication failure is not a finalized process result");
  assert.equal(execution.evidence?.processTerminated, true, "joined process evidence is retained while publication is unresolved");
  assert.match(execution.error!, /injected recovery ref failure/);
  assert.equal(execution.version, undefined);
  assert.equal(execution.recovery?.manifestRef, undefined);
  assert.equal(execution.recovery?.capability, "unknown");
});

test("a known failed parent cannot resume while an unknown historical Runner writer may still be alive", async context => {
  const f = await fixture(context);
  const original = await failOriginal(f);
  await f.manager.close();
  const db = new DatabaseSync(resolve(f.root, "runner-executions", "executions.sqlite"));
  const orphan = { id: "unknown-writer", sessionId: "another-session", agentId: "other-agent", state: "unknown", queuedAt: "before-restart" };
  db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?)").run(orphan.id, orphan.sessionId, orphan.agentId, JSON.stringify(orphan));
  db.close();
  f.manager = new ExecutionManager(f.root);
  rejectQuarantinedContinuation(f, continuation(f.workspace, original));
  assert.deepEqual(f.manager.get(original.id, owner), original);
});


test("publication recovery preserves continuation evidence and same-ID submission never replays the failed process", async context => {
  const f = await fixture(context);
  const input = request(f.workspace, "recover-published-failure");
  let launches = 0;
  let restoreCommit = () => {};
  f.manager.submit(input, async (...args) => {
    const output = await operation(input, environmentRevisionId, () => { launches++; })(...args);
    const blockedCommit = context.mock.method(RefStore.prototype, "commit", async () => { throw new Error("injected publication interruption"); });
    restoreCommit = () => blockedCommit.mock.restore();
    return output;
  });
  const interrupted = await unknownPublication(f.manager, input.executionId);
  assert.equal(interrupted.recovery?.manifestRef, undefined, "unpublished evidence cannot be exposed as ready");
  assert.equal(interrupted.version, undefined);
  assert.equal(launches, 1);
  await f.manager.close();
  const db = new DatabaseSync(resolve(f.root, "runner-executions", "executions.sqlite"));
  const journal = JSON.parse(String(db.prepare("SELECT record FROM execution_publications WHERE id = ?").get(input.executionId)!.record));
  db.close();
  assert.equal(journal.execution.recovery.capability, "supported", "the durable completion journal retains bounded recovery metadata");
  restoreCommit();
  f.manager = new ExecutionManager(f.root);
  await f.manager.ready();
  const recovered = f.manager.get(input.executionId, owner);
  assert.equal(recovered.state, "failed");
  assert.deepEqual(recovered.recovery, journal.execution.recovery);
  assert.equal(recovered.evidence?.workspaceVersionDigest, recovered.version?.digest);
  await f.versions.validateClosure(recovered.version!);
  const duplicate = f.manager.submit(input, async () => { launches++; throw new Error("original replayed"); });
  assert.equal(duplicate.accepted, false);
  assert.deepEqual(duplicate.execution, recovered);
  assert.equal(launches, 1);
  const resume = continuation(f.workspace, recovered, "resume-after-publication-recovery");
  f.manager.submit(resume, operation(resume));
  assert.equal((await finished(f.manager, resume.executionId)).state, "completed");
  assert.deepEqual(f.manager.get(input.executionId, owner), recovered, "continuation never rewrites the original execution");
});
