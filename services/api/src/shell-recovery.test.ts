// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { VersionStore } from "@sciencediscovery/cas";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { AgentShellExecution, ExecutionRecovery, ManagedExecution, RecoveryContext, ShellExecutionRequest, ShellExecutionResult } from "@sciencediscovery/schema";
import { ShellExecutions } from "./shell-executions.js";
import { AgentNotifications } from "./agent-notifications.js";

const owner = { sessionId: "session", agentId: "main" };
const identity = { runnerId: "remote", workspaceId: "workspace", turnId: "turn" };
const digest = `sha256:${"a".repeat(64)}` as const;
const recovery: ExecutionRecovery = { schemaVersion: 1, capability: "supported",
  manifestRef: { storeId: "remote-store", pool: "agent-state", objectId: digest, size: 1, mediaType: "application/json" },
  manifest: { schemaVersion: 1, executionId: "parent", adapter: { id: "fixture", version: "1" }, producedAt: "now",
    execution: { ...owner, executionId: "parent", workspaceKey: "workspace", environmentRevisionId: "env", processTerminated: true, exitCode: 1 },
    workUnits: [{ id: "one", state: "completed" }, { id: "two", state: "failed" }],
    objects: [], continuation: { capability: "supported", points: [{ id: "point", entryPointId: "resume", mode: "resume",
      codeDigest: "b".repeat(64), cwd: ".", requiredObjectIds: [], requiredInputs: [], prerequisites: [] }] } } };
const context: RecoveryContext = { parentExecutionId: "parent", recoveryPointId: "point", manifestDigest: digest, attemptToken: "intent-1" };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "shell-recovery-"));
  const db = new DatabaseSync(join(root, "api.sqlite"));
  const versions = new VersionStore(root);
  const notifications = new AgentNotifications(db, () => false);
  const service = new ShellExecutions(db, versions, notifications, 1);
  t.after(async () => { db.close(); await rm(root, { force: true, recursive: true }); });
  const ref = await versions.put("agent-state", "workspace");
  const parent: AgentShellExecution = { ...owner, ...identity, id: "parent", queuedAt: "now", state: "failed",
    accepted: true, provenance: "committed", runnerVersionId: digest, recovery };
  const saveParent = (patch: Partial<AgentShellExecution> = {}) => db.prepare("INSERT OR REPLACE INTO shell_executions VALUES (?, ?, ?, ?)")
    .run("parent", owner.sessionId, owner.agentId, JSON.stringify({ ...parent, ...patch }));
  return { db, versions, notifications, service, ref, saveParent };
}

test("metadata persists across API restart, is read-only and remains remote-store scoped in Agent CAS", async t => {
  const f = await fixture(t); let submitted = 0;
  const runner = { startShellExecution: async (request: ShellExecutionRequest): Promise<ManagedExecution> => {
    submitted++;
    return { ...owner, id: request.executionId, state: "failed", queuedAt: "now", version: f.ref, recovery,
      result: { exitCode: 1, workspaceSnapshot: f.ref } as ShellExecutionResult };
  } } as RunnerClient;
  const accepted = await f.service.start(owner, identity, () => runner, (id, dispatch) => dispatch({ executionId: id } as ShellExecutionRequest));
  await f.service.wait(accepted.id, owner, 1000);
  const restarted = new ShellExecutions(f.db, f.versions, f.notifications, 1);
  const record = await restarted.get(accepted.id, owner);
  assert.equal(record.state, "failed"); assert.equal(record.provenance, "committed");
  assert.deepEqual(record.recovery, recovery);
  for (let i = 0; i < 3; i++) await restarted.wait(accepted.id, owner, 0);
  assert.equal(submitted, 1);
  const snapshot = await f.versions.putRecord("AgentRecoveryInspection", record);
  await f.versions.validateClosure(snapshot); // remote objectIds must not be interpreted as local digests
  await assert.rejects(restarted.get(accepted.id, { ...owner, agentId: "other" }), /not found/);
});

test("same resume token reserves one child, survives lost response/restart and rejects changed requests", async t => {
  const f = await fixture(t); f.saveParent(); let submitted = 0;
  const runner = { startShellExecution: async () => { submitted++; throw new Error("response lost"); } } as unknown as RunnerClient;
  const start = (service = f.service, requestDigest = "b".repeat(64)) => service.start(owner, identity, () => runner,
    (id, dispatch) => dispatch({ executionId: id, recoveryContext: context } as ShellExecutionRequest), { context, requestDigest });
  const [one, two] = await Promise.all([start(), start()]);
  assert.equal(one.id, two.id); assert.notEqual(one.id, "parent");
  assert.equal(submitted, 1);
  assert.equal((await f.service.wait(one.id, owner, 1000)).state, "unknown");
  const restarted = new ShellExecutions(f.db, f.versions, f.notifications, 1);
  assert.equal((await start(restarted)).id, one.id); assert.equal(submitted, 1);
  await assert.rejects(start(restarted, "c".repeat(64)), /RECOVERY_ATTEMPT_CONFLICT/);
  assert.equal(submitted, 1);
  assert.deepEqual((await restarted.get(one.id, owner)).recoveryContext, context);
  assert.equal((await restarted.get("parent", owner)).state, "failed");
});

test("unconfirmed, running, cancelled, unsupported and cross-owner/target originals never dispatch", async t => {
  const f = await fixture(t); let submitted = 0;
  const runner = { startShellExecution: async () => { submitted++; throw new Error("must not dispatch"); } } as unknown as RunnerClient;
  const start = (who = owner, target = identity) => f.service.start(who, target, () => runner,
    (id, dispatch) => dispatch({ executionId: id } as ShellExecutionRequest), { context, requestDigest: "b".repeat(64) });
  for (const state of ["queued", "running", "unknown", "completed", "cancelled"] as const) {
    f.saveParent({ state }); await assert.rejects(start(), /ORIGINAL_NOT_RECOVERABLE/);
  }
  f.saveParent({ provenance: "unconfirmed" }); await assert.rejects(start(), /ORIGINAL_NOT_RECOVERABLE/);
  f.saveParent({ recovery: { schemaVersion: 1, capability: "unsupported", reason: "no checkpoint" } });
  await assert.rejects(start(), /ORIGINAL_NOT_RECOVERABLE/);
  f.saveParent(); await assert.rejects(start({ ...owner, agentId: "other" }), /not found/);
  await assert.rejects(start(owner, { ...identity, runnerId: "different" }), /RECOVERY_TARGET_MISMATCH/);
  assert.equal(submitted, 0);
});

test("old records explicitly expose unknown recovery without requiring metadata", async t => {
  const f = await fixture(t); f.saveParent({ recovery: undefined });
  assert.deepEqual((await f.service.get("parent", owner)).recovery, { schemaVersion: 1, capability: "unknown", reason: "NOT_REPORTED" });
  assert.equal(f.service.list(owner)[0]!.recovery?.capability, "unknown");
});

test("a reservation winner appearing after the initial read is reconciled, not dispatched again", async t => {
  const f = await fixture(t); f.saveParent(); let submitted = 0;
  const runner = { startShellExecution: async () => { submitted++; throw new Error("response lost"); } } as unknown as RunnerClient;
  const start = (requestDigest = "b".repeat(64)) => f.service.start(owner, identity, () => runner,
    (id, dispatch) => dispatch({ executionId: id } as ShellExecutionRequest), { context, requestDigest });
  const winner = await start();
  await f.service.wait(winner.id, owner, 1000);
  // Emulate a concurrent process committing immediately after this process's initial SELECT.
  // The real database still enforces UNIQUE, so the contender must roll back its child intent.
  const prepare = f.db.prepare.bind(f.db);
  let hideRead = true;
  const mock = t.mock.method(f.db, "prepare", (sql: string) => {
    const statement = prepare(sql);
    if (hideRead && sql.startsWith("SELECT request_digest, execution FROM recovery_attempts")) {
      hideRead = false;
      return new Proxy(statement, { get(target, property) {
        if (property === "get") return () => undefined;
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    return statement;
  });
  assert.equal((await start()).id, winner.id);
  hideRead = true;
  await assert.rejects(start("c".repeat(64)), /RECOVERY_ATTEMPT_CONFLICT/);
  mock.mock.restore();
  assert.equal(submitted, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM shell_executions").get()!.count, 2);
});
