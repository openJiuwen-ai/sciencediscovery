// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { VersionStore } from "@sciencediscovery/cas";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { ManagedExecution, ShellExecutionRequest, ShellExecutionResult } from "@sciencediscovery/schema";
import { AgentNotifications } from "./agent-notifications.js";
import { ShellExecutions } from "./shell-executions.js";

const owner = { sessionId: "session", agentId: "main" };
const identity = { runnerId: "remote", workspaceId: "workspace", turnId: "original-turn" };
const request = (id: string) => ({ executionId: id } as ShellExecutionRequest);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "api-executions-"));
  const db = new DatabaseSync(":memory:");
  context.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const versions = new VersionStore(root);
  const notices = new AgentNotifications(db, () => false);
  const service = new ShellExecutions(db, versions, notices, 1);
  const ref = await versions.put("agent-state", "committed");
  const result = { exitCode: 0, stdout: "done", stderr: "", workspaceSnapshot: ref } as ShellExecutionResult;
  return { db, versions, notices, service, ref, result };
}

test("accepted background work outlives waiting and publishes a notice only after provenance", async (context) => {
  const f = await fixture(context);
  const finish = deferred<void>(); const observed = deferred<void>(); const publish = deferred<void>();
  let id = ""; let submitted = 0; let cancelled = 0; let logs = 0;
  const runner = {
    startShellExecution: async (r: ShellExecutionRequest) => { submitted++; id = r.executionId; return { ...owner, id, state: "running", queuedAt: "now" }; },
    getShellExecution: async () => { await finish.promise; return { ...owner, id, state: "completed", queuedAt: "now", result: f.result, version: f.ref }; },
    shellExecutionLogs: async () => { logs++; return { chunks: [{ cursor: 1, stream: "stdout", text: "progress" }], nextCursor: 1 }; },
    cancelShellExecution: async () => { cancelled++; },
  } as unknown as RunnerClient;
  const job = await f.service.start(owner, identity, () => runner, async (executionId, dispatch) => {
    const result = await dispatch(request(executionId));
    observed.resolve(); await publish.promise; return result;
  });
  assert.equal(job.accepted, true); assert.equal(submitted, 1);
  assert.equal((await f.service.wait(job.id, owner, 2)).state, "running");
  const stoppedWait = new AbortController(); stoppedWait.abort();
  assert.equal((await f.service.wait(job.id, owner, 1000, stoppedWait.signal)).state, "running");
  assert.equal(cancelled, 0);
  assert.equal((await f.service.logs(job.id, owner, () => runner)).chunks[0]!.text, "progress");
  assert.equal(logs, 1);
  await assert.rejects(f.service.get(job.id, { ...owner, agentId: "other" }), /not found/);
  await assert.rejects(f.service.cancel(job.id, { ...owner, agentId: "other" }, () => runner), /not found/);
  finish.resolve(); await observed.promise;
  assert.equal((await f.service.get(job.id, owner)).state, "running");
  assert.deepEqual(f.notices.unread(owner), []);
  publish.resolve();
  const result = await f.service.wait(job.id, owner, 1000);
  assert.equal(result.state, "completed"); assert.equal(result.provenance, "committed");
  assert.equal(result.result?.stdout, "done");
  assert.equal(result.turnId, "original-turn");
  assert.equal(f.notices.unread(owner).length, 1);
  assert.ok(f.service.snapshot(owner.sessionId)[0]!.resultRef);
  assert.equal("result" in f.service.snapshot(owner.sessionId)[0]!, false, "result/log bytes live in State Pool, not catalog JSON");
});

test("explicit cancellation retains committed result and stopped Agent inbox without waking it", async (context) => {
  const f = await fixture(context); const finish = deferred<void>(); let id = ""; let reported = "";
  const runner = {
    startShellExecution: async (r: ShellExecutionRequest) => { id = r.executionId; return { ...owner, id, state: "running", queuedAt: "now" }; },
    getShellExecution: async () => { await finish.promise; return { ...owner, id, state: "cancelled", queuedAt: "now", result: { ...f.result, exitCode: -1 }, version: f.ref }; },
    cancelShellExecution: async () => { finish.resolve(); return { ...owner, id, state: "running", queuedAt: "now" }; },
  } as unknown as RunnerClient;
  const job = await f.service.start(owner, identity, () => runner, async (id, dispatch, status) => {
    const result = await dispatch(request(id)); reported = status(); return result;
  });
  f.notices.createTimer(owner, { dueAt: Date.now() + 60_000, message: "reminder", executionId: job.id });
  f.notices.stopAgent(owner);
  await f.service.cancel(job.id, owner, () => runner);
  const result = await f.service.wait(job.id, owner, 1000);
  assert.equal(result.state, "cancelled"); assert.equal(reported, "cancelled");
  assert.equal(result.provenance, "committed");
  assert.equal(f.notices.prepareDelivery(owner), undefined);
  assert.equal(f.notices.unread(owner).length, 1);
  assert.equal(f.notices.timers(owner)[0]!.state, "cancelled");
});

test("lost submission and API restart are unknown, never command replay", async (context) => {
  const f = await fixture(context); let submitted = 0;
  const runner = { startShellExecution: async () => { submitted++; throw new Error("lost response"); } } as unknown as RunnerClient;
  const job = await f.service.start(owner, identity, () => runner, (id, dispatch) => dispatch(request(id)));
  assert.equal(job.state, "unknown"); assert.equal(job.accepted, false);
  await f.service.wait(job.id, owner, 100);
  assert.equal(submitted, 1);
  const pending = { ...job, id: "pending", state: "running", accepted: true, provenance: "pending" };
  f.db.prepare("INSERT INTO shell_executions VALUES (?, ?, ?, ?)").run("pending", owner.sessionId, owner.agentId, JSON.stringify(pending));
  const restarted = new ShellExecutions(f.db, f.versions, f.notices);
  assert.equal((await restarted.get("pending", owner)).state, "unknown");
  assert.match((await restarted.get("pending", owner)).error!, /not replayed/);
  assert.equal(submitted, 1);
});

test("uncommitted Runner result or mismatched identity cannot publish successful completion", async (context) => {
  const f = await fixture(context);
  for (const mismatch of [false, true]) {
    let id = "";
    const runner = {
      startShellExecution: async (r: ShellExecutionRequest) => { id = r.executionId; return { ...owner, id, state: "running", queuedAt: "now" }; },
      getShellExecution: async () => ({ ...owner, id, agentId: mismatch ? "foreign" : owner.agentId, state: "completed",
        queuedAt: "now", result: f.result } as ManagedExecution),
    } as unknown as RunnerClient;
    const job = await f.service.start(owner, identity, () => runner, (id, dispatch) => dispatch(request(id)));
    const result = await f.service.wait(job.id, owner, 1000);
    assert.equal(result.state, "unknown"); assert.equal(result.provenance, "unconfirmed");
    assert.equal(result.result, undefined);
  }
});

test("cancellation before process admission records a terminal outcome without fabricating a snapshot", async (context) => {
  const f = await fixture(context);
  const runner = { startShellExecution: async (r: ShellExecutionRequest) => ({
    ...owner, id: r.executionId, state: "cancelled", queuedAt: "now", error: "Cancelled before admission",
  }) } as unknown as RunnerClient;
  let recorded = false;
  const job = await f.service.start(owner, identity, () => runner, async (id, dispatch, status) => {
    try { return await dispatch(request(id)); }
    catch (error) { assert.equal(status(), "cancelled"); recorded = true; throw error; }
  });
  const result = await f.service.wait(job.id, owner, 1000);
  assert.equal(recorded, true);
  assert.equal(result.state, "cancelled"); assert.equal(result.provenance, "committed");
  assert.equal(result.result, undefined); assert.equal(result.runnerVersionId, undefined);
  assert.equal(f.notices.unread(owner).length, 1);
});
