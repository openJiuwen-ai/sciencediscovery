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

import { RefStore, VersionStore } from "@sciencediscovery/cas";
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
  assert.deepEqual(result.result?.workspaceVersion, {
    runnerId: identity.runnerId, pool: f.ref.pool, objectId: f.ref.digest, size: f.ref.size, mediaType: f.ref.mediaType,
  }, "the rooted envelope receipt is scoped to its Runner even without a result field");
  assert.equal(result.turnId, "original-turn");
  assert.equal(f.notices.unread(owner).length, 1);
  assert.ok(f.service.snapshot(owner.sessionId)[0]!.resultRef);
  assert.equal("result" in f.service.snapshot(owner.sessionId)[0]!, false, "result/log bytes live in State Pool, not catalog JSON");
});

test("four consecutive Runner status transport failures do not turn accepted work unknown or replay it", async (context) => {
  const f = await fixture(context);
  let id = ""; let submitted = 0; let observations = 0;
  const runner = {
    startShellExecution: async (r: ShellExecutionRequest) => {
      submitted++; id = r.executionId;
      return { ...owner, id, state: "running", queuedAt: "now" };
    },
    getShellExecution: async () => {
      observations++;
      if (observations <= 4) throw new TypeError("fetch failed");
      return { ...owner, id, state: "completed", queuedAt: "now", result: f.result, version: f.ref };
    },
  } as unknown as RunnerClient;
  const job = await f.service.start(owner, identity, () => runner, (executionId, dispatch) => dispatch(request(executionId)));
  const result = await f.service.wait(job.id, owner, 3_000);
  assert.equal(result.state, "completed");
  assert.equal(result.provenance, "committed");
  assert.equal(result.result?.stdout, "done");
  assert.equal(submitted, 1);
  assert.equal(observations, 5);
});

test("a successful Runner observation clears the consecutive transport failure count", async (context) => {
  const f = await fixture(context);
  const waits: number[] = [];
  const service = new ShellExecutions(f.db, f.versions, f.notices, 200, async (ms) => { waits.push(ms); });
  let id = ""; let observations = 0; let submitted = 0;
  const runner = {
    startShellExecution: async (r: ShellExecutionRequest) => {
      submitted++;
      id = r.executionId;
      return { ...owner, id, state: "running", queuedAt: "now" };
    },
    getShellExecution: async () => {
      observations++;
      if (observations <= 4 || (observations >= 6 && observations <= 9)) throw new TypeError("fetch failed");
      if (observations === 5) return { ...owner, id, state: "running", queuedAt: "now" };
      return { ...owner, id, state: "completed", queuedAt: "now", result: f.result, version: f.ref };
    },
  } as unknown as RunnerClient;
  const job = await service.start(owner, identity, () => runner, (executionId, dispatch) => dispatch(request(executionId)));
  const result = await service.wait(job.id, owner, 3_000);
  assert.equal(result.state, "completed");
  assert.equal(result.provenance, "committed");
  assert.equal(submitted, 1);
  assert.equal(observations, 10);
  assert.deepEqual(waits, [200, 200, 400, 800, 1_600, 200, 200, 400, 800, 1_600],
    "one exponential wait follows each failure, and a successful observation resets the delay");
});

test("retryable Runner status errors include wrapped transport, timeouts, disconnects and gateway HTTP responses", async (context) => {
  const failures: Array<[string, Error]> = [
    ["wrapped fetch failure", new Error("status observation failed", { cause: new TypeError("fetch failed") })],
    ["abort", Object.assign(new Error("This operation was aborted"), { name: "AbortError" })],
    ["timeout", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
    ["disconnected Runner", new Error("Remote runner is not connected")],
    ["gateway 502", Object.assign(new Error("Bad Gateway"), { statusCode: 502 })],
    ["gateway 503", new Error("Runner request failed (503)")],
    ["gateway 504", Object.assign(new Error("Gateway Timeout"), { statusCode: 504 })],
    ["nested socket reset", new Error("status observation failed", { cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }) })],
    ["undici timeout", new Error("status observation failed", { cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_CONNECT_TIMEOUT" }) })],
  ];
  for (const [label, failure] of failures) {
    const f = await fixture(context);
    let id = ""; let submitted = 0; let observations = 0;
    const runner = {
      startShellExecution: async (r: ShellExecutionRequest) => {
        submitted++; id = r.executionId;
        return { ...owner, id, state: "running", queuedAt: "now" };
      },
      getShellExecution: async () => {
        observations++;
        if (observations === 1) throw failure;
        return { ...owner, id, state: "completed", queuedAt: "now", result: f.result, version: f.ref };
      },
    } as unknown as RunnerClient;
    const job = await f.service.start(owner, identity, () => runner, (executionId, dispatch) => dispatch(request(executionId)));
    const result = await f.service.wait(job.id, owner, 1_000);
    assert.equal(result.state, "completed", label);
    assert.equal(result.provenance, "committed", label);
    assert.equal(submitted, 1, label);
    assert.equal(observations, 2, label);
  }
});

test("HTTP 500 status is not retried even when its message resembles a transport failure", async (context) => {
  const f = await fixture(context);
  let observations = 0; let submitted = 0;
  const runner = {
    startShellExecution: async (r: ShellExecutionRequest) => {
      submitted++;
      return { ...owner, id: r.executionId, state: "running", queuedAt: "now" };
    },
    getShellExecution: async () => {
      observations++;
      throw Object.assign(new Error("fetch failed"), { statusCode: 500 });
    },
  } as unknown as RunnerClient;
  const job = await f.service.start(owner, identity, () => runner, (executionId, dispatch) => dispatch(request(executionId)));
  const result = await f.service.wait(job.id, owner, 1_000);
  assert.equal(result.state, "unknown");
  assert.equal(result.provenance, "unconfirmed");
  assert.equal(submitted, 1);
  assert.equal(observations, 1);
});

test("five consecutive Runner status failures remain unconfirmed without replaying accepted work", async (context) => {
  const f = await fixture(context);
  let submitted = 0; let observations = 0;
  const runner = {
    startShellExecution: async (r: ShellExecutionRequest) => {
      submitted++;
      return { ...owner, id: r.executionId, state: "running", queuedAt: "now" };
    },
    getShellExecution: async () => {
      observations++;
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }) });
    },
  } as unknown as RunnerClient;
  const job = await f.service.start(owner, identity, () => runner, (executionId, dispatch) => dispatch(request(executionId)));
  const result = await f.service.wait(job.id, owner, 1_000);
  assert.equal(result.state, "unknown");
  assert.equal(result.provenance, "unconfirmed");
  assert.match(result.error!, /Runner status remained unavailable after 5 consecutive attempts/);
  assert.match(result.error!, /ECONNRESET/);
  assert.equal(submitted, 1);
  assert.equal(observations, 5);
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
    let id = ""; let observations = 0;
    const runner = {
      startShellExecution: async (r: ShellExecutionRequest) => { id = r.executionId; return { ...owner, id, state: "running", queuedAt: "now" }; },
      getShellExecution: async () => {
        observations++;
        return { ...owner, id, agentId: mismatch ? "foreign" : owner.agentId, state: "completed",
          queuedAt: "now", result: f.result } as ManagedExecution;
      },
    } as unknown as RunnerClient;
    const job = await f.service.start(owner, identity, () => runner, (id, dispatch) => dispatch(request(id)));
    const result = await f.service.wait(job.id, owner, 1000);
    assert.equal(result.state, "unknown"); assert.equal(result.provenance, "unconfirmed");
    assert.equal(result.result, undefined);
    assert.equal(observations, 1, "identity or missing provenance is not a retryable status-query failure");
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

test("remote execution observations keep Runner receipts outside the API CAS closure, including saved results", async (context) => {
  const f = await fixture(context);
  const remote = new VersionStore(join(f.versions.dataDir, "remote"));
  const workspace = await remote.putRecord("WorkspaceTree", { entries: [] });
  const version = await remote.putRecord("WorkspaceExecution", { workspace, executionId: "remote-job" });
  const runner = { startShellExecution: async (r: ShellExecutionRequest) => ({
    ...owner, id: r.executionId, state: "completed", queuedAt: "now",
    result: { ...f.result, workspaceSnapshot: workspace, workspaceVersion: version }, version,
  }) } as unknown as RunnerClient;
  let submissions = 0;
  const job = await f.service.start(owner, identity, () => runner, async (id, dispatch) => {
    submissions++;
    const result = await dispatch(request(id));
    assert.deepEqual(result.workspaceVersion, version, "provenance receives the original Runner receipt");
    return result;
  });
  const completed = await f.service.wait(job.id, owner, 1000);
  assert.equal(completed.state, "completed");
  const restarted = new ShellExecutions(f.db, f.versions, f.notices);
  const refs = await RefStore.open(f.versions);
  context.after(() => refs.close());
  for (const [index, result] of [completed, await restarted.get(job.id, owner)].entries()) {
    // Tool observations/actions/events all discover embedded ObjectRefs in the same way.
    const observation = await f.versions.putRecord("ToolObservation", { details: result });
    await refs.commit(f.versions, `observations/${index}`, null, observation);
    assert.equal(result.result?.stdout, "done");
    assert.equal(result.runnerVersionId, version.digest);
    assert.deepEqual(result.result?.workspaceVersion, {
      runnerId: identity.runnerId, pool: version.pool, objectId: version.digest, size: version.size, mediaType: version.mediaType,
    });
  }
  await assert.rejects(f.versions.readState(version), { code: "ENOENT" }, "remote objects were not silently copied");
  const notice = f.notices.prepareDelivery(owner)!;
  f.notices.acknowledge(notice);
  await restarted.wait(job.id, owner, 0);
  assert.equal(f.notices.prepareDelivery(owner), undefined);
  assert.equal(submissions, 1, "status inspection and restart never dispatch a second command");
});

test("local execution results retain strong snapshot dependencies and reject missing local objects", async (context) => {
  const f = await fixture(context);
  const version = await f.versions.putRecord("WorkspaceExecution", {});
  const runner = { startShellExecution: async (r: ShellExecutionRequest) => ({
    ...owner, id: r.executionId, state: "completed", queuedAt: "now", result: f.result, version,
  }) } as unknown as RunnerClient;
  const job = await f.service.start(owner, { ...identity, runnerId: "local" }, () => runner, (id, dispatch) => dispatch(request(id)));
  const result = await f.service.wait(job.id, owner, 1000);
  assert.deepEqual(result.result?.workspaceVersion, version);
  const observation = await f.versions.putRecord("ToolObservation", { details: result });
  await f.versions.validateClosure(observation);
  await rm(f.versions.objectPath(version));
  await assert.rejects(f.versions.validateClosure(observation), { code: "ENOENT" });
});

// Recovery fixtures deliberately cannot submit through the finalizer.
const recoveryContext = (executionId: string) => ({
  ...owner, ...identity, executionId, code: "echo done", workspaceRoot: "/workspace",
  permissionEpoch: { id: "epoch", sessionId: owner.sessionId, networkPolicy: "none",
    createdAt: "2026-01-01T00:00:00.000Z", environmentRevisionId: "shell", mounts: [], reason: "fixture", secretRefs: [] },
} as import("@sciencediscovery/provenance").ShellExecutionContext);
const receipt = (revision = 1) => ({ runnerInstanceId: "original-ledger", runnerBootId: "boot-one",
  revision, requestDigest: "sha256:request", acceptedAt: "2026-01-01T00:00:00.000Z" });
function recoveredTerminal(id: string, f: Awaited<ReturnType<typeof fixture>>, state: "completed" | "failed" = "completed"): ManagedExecution {
  return { ...owner, id, state, queuedAt: "now", receipt: receipt(3), result: f.result, version: f.ref,
    evidence: { runnerInstanceId: "original-ledger", runnerBootId: "boot-one", revision: 3,
      processTerminated: true, terminationReason: "exited", resultDigest: "sha256:result", workspaceVersionDigest: f.ref.digest } };
}
async function lostAck(f: Awaited<ReturnType<typeof fixture>>, lookup: (id: string) => Promise<ManagedExecution>, workspaceId = identity.workspaceId) {
  let submissions = 0;
  const runner = {
    health: async () => ({ runnerInstanceId: "original-ledger", runnerBootId: "boot-one", capabilities: { executionRecoveryVersion: 1 } }),
    startShellExecution: async () => { submissions++; throw new TypeError("fetch failed"); },
    getShellExecution: lookup,
  } as unknown as RunnerClient;
  const job = await f.service.start(owner, { ...identity, workspaceId }, () => runner, (id, dispatch) => dispatch(request(id)), recoveryContext);
  await f.service.wait(job.id, owner, 1000);
  return { job, runner, submissions: () => submissions };
}

test("lost accepted response is recovered with one POST and one finalization under 100 concurrent inspections", async context => {
  const f = await fixture(context); const release = deferred<void>(); let queries = 0; let commits = 0;
  const lost = await lostAck(f, async id => { queries++; await release.promise; return recoveredTerminal(id, f); });
  assert.equal(lost.job.state, "unknown"); assert.equal(lost.job.finishedAt, undefined);
  assert.equal(f.notices.unread(owner).length, 0, "an observation failure is not a completion notice");
  const handlers = { runner: () => lost.runner, finalize: async (_context: unknown, result: ShellExecutionResult) => { commits++; return result; } };
  const reads = Array.from({ length: 100 }, () => f.service.reconcile(lost.job.id, owner, handlers));
  release.resolve(); await Promise.all(reads);
  const final = await f.service.get(lost.job.id, owner);
  assert.equal(final.id, lost.job.id); assert.equal(final.state, "completed"); assert.equal(final.provenance, "committed");
  assert.equal(final.result?.stdout, "done"); assert.equal(final.observation?.status, "fresh");
  assert.equal(queries, 1); assert.equal(commits, 1); assert.equal(lost.submissions(), 1);
  assert.equal(f.notices.unread(owner).length, 1);
  assert.equal("recoveryContext" in final, false); assert.equal("candidateResultRef" in final, false);
  assert.equal("recoveryContext" in f.service.snapshot(owner.sessionId)[0]!, false);
  await f.service.reconcile(lost.job.id, owner, handlers);
  assert.equal(commits, 1); assert.equal(queries, 1);
});

test("fifth status failure remains recoverable and rejoins the same running execution", async context => {
  const f = await fixture(context); let submits = 0; let queries = 0; let reconnect = false;
  const runner = {
    health: async () => ({ runnerInstanceId: "original-ledger" }),
    startShellExecution: async (input: ShellExecutionRequest) => { submits++; return { ...owner, id: input.executionId, state: "running", queuedAt: "now", receipt: receipt() }; },
    getShellExecution: async (id: string) => { queries++; if (!reconnect) throw new TypeError("fetch failed"); return recoveredTerminal(id, f); },
  } as unknown as RunnerClient;
  const job = await f.service.start(owner, identity, () => runner, (id, dispatch) => dispatch(request(id)), recoveryContext);
  assert.equal((await f.service.wait(job.id, owner, 1000)).state, "unknown");
  assert.equal(queries, 5); reconnect = true;
  const final = await f.service.reconcile(job.id, owner, { runner: () => runner, finalize: async (_, result) => result });
  assert.equal(final.state, "completed"); assert.equal(final.observation?.failureCount, 0); assert.equal(submits, 1); assert.equal(queries, 6);
});

test("API recreation rebuilds finalization from durable original context without calling the old closure", async context => {
  const f = await fixture(context); const lost = await lostAck(f, async id => recoveredTerminal(id, f));
  const restarted = new ShellExecutions(f.db, f.versions, f.notices);
  let restoredContext: unknown;
  const recovered = await restarted.reconcile(lost.job.id, owner, {
    runner: () => lost.runner, finalize: async (original, result) => { restoredContext = original; return result; },
  });
  assert.deepEqual(restoredContext, recoveryContext(lost.job.id));
  assert.equal(recovered.turnId, identity.turnId); assert.equal(recovered.state, "completed"); assert.equal(lost.submissions(), 1);
  assert.equal(f.notices.unread(owner).length, 1);
});

test("configured startup reconciliation automatically completes a durable interrupted intent", async context => {
  const f = await fixture(context); const lost = await lostAck(f, async id => recoveredTerminal(id, f));
  const restarted = new ShellExecutions(f.db, f.versions, f.notices); context.after(() => restarted.close());
  restarted.configureRecovery({ runner: () => lost.runner, finalize: async (_, result) => result });
  assert.equal((await restarted.wait(lost.job.id, owner, 1000)).state, "completed");
  assert.equal(lost.submissions(), 1);
});

test("404 and revoked authorization block recovery without a new submission", async context => {
  for (const [status, code] of [[404, "EXECUTION_NOT_FOUND"], [401, "AUTHORIZATION_REVOKED"], [403, "AUTHORIZATION_REVOKED"]] as const) {
    const f = await fixture(context); let queries = 0;
    const lost = await lostAck(f, async () => { queries++; throw Object.assign(new Error("sensitive server body token=secret"), { statusCode: status }); });
    const record = await f.service.reconcile(lost.job.id, owner, { runner: () => lost.runner, finalize: async () => { throw new Error("must not finalize"); } });
    assert.equal(record.state, "unknown"); assert.equal(record.observation?.lastError?.code, code);
    assert.equal(record.observation?.lastError?.retryable, false); assert.equal(record.observation?.nextRetryAt, undefined);
    assert.doesNotMatch(JSON.stringify(record), /secret/); assert.equal(queries, 1); assert.equal(lost.submissions(), 1);
  }
});

test("recovery rejects another owner or replaced Runner identity without publishing its result", async context => {
  for (const mismatch of ["owner", "instance", "no-evidence", "revision"] as const) {
    const f = await fixture(context);
    const lost = await lostAck(f, async id => {
      const value = recoveredTerminal(id, f);
      if (mismatch === "owner") value.agentId = "foreign";
      if (mismatch === "instance") value.receipt!.runnerInstanceId = "replacement-ledger";
      if (mismatch === "no-evidence") delete value.evidence;
      if (mismatch === "revision") value.evidence!.revision = 2;
      return value;
    });
    let finalized = false;
    const result = await f.service.reconcile(lost.job.id, owner, { runner: () => lost.runner, finalize: async (_, result) => { finalized = true; return result; } });
    assert.equal(result.state, "unknown", mismatch); assert.equal(result.result, undefined, mismatch); assert.equal(finalized, false, mismatch);
    assert.equal(lost.submissions(), 1); assert.equal(f.notices.unread(owner).length, 0);
    await assert.rejects(f.service.reconcile(lost.job.id, { ...owner, agentId: "someone-else" }), /not found/);
  }
});

test("Runner restart with no supervisor preserves unknown and never fabricates failure or resume eligibility", async context => {
  const f = await fixture(context);
  const lost = await lostAck(f, async id => ({ ...owner, id, state: "unknown", queuedAt: "now", receipt: receipt(2), error: "process state unverified" }));
  const result = await f.service.reconcile(lost.job.id, owner, { runner: () => lost.runner, finalize: async () => { throw new Error("must not finalize"); } });
  assert.equal(result.state, "unknown"); assert.equal(result.observation?.lastError?.code, "PROCESS_STATE_UNVERIFIABLE");
  assert.equal(result.evidence?.processTerminated, undefined); assert.equal(result.finishedAt, undefined); assert.equal(lost.submissions(), 1);
});

test("failed finalization retries pinned bytes across restart despite later Runner clock conversion", async context => {
  const f = await fixture(context); let reads = 0;
  const lost = await lostAck(f, async id => ({ ...recoveredTerminal(id, f),
    result: { ...f.result, startedAt: `2026-01-01T00:00:0${++reads}.000Z` } }));
  let first: ShellExecutionResult | undefined;
  const interrupted = await f.service.reconcile(lost.job.id, owner, { runner: () => lost.runner, finalize: async (_, result) => { first = result; throw new Error("storage unavailable"); } });
  assert.equal(interrupted.finalization, "failed"); assert.equal(interrupted.state, "unknown");
  const restarted = new ShellExecutions(f.db, f.versions, f.notices);
  const final = await restarted.reconcile(lost.job.id, owner, { runner: () => lost.runner, finalize: async (_, result) => { assert.deepEqual(result, first); return result; } });
  assert.equal(final.state, "completed"); assert.equal(lost.submissions(), 1); assert.equal(reads, 2);
});

test("SQLite observation lease prevents two API instances finalizing the same record", async context => {
  const f = await fixture(context); const release = deferred<void>(); let queries = 0; let commits = 0;
  const lost = await lostAck(f, async id => { queries++; await release.promise; return recoveredTerminal(id, f); });
  const second = new ShellExecutions(f.db, f.versions, f.notices);
  const handlers = { runner: () => lost.runner, finalize: async (_: unknown, result: ShellExecutionResult) => { commits++; return result; } };
  const one = f.service.reconcile(lost.job.id, owner, handlers);
  const two = second.reconcile(lost.job.id, owner, handlers);
  release.resolve(); await Promise.all([one, two]);
  assert.equal(queries, 1); assert.equal(commits, 1); assert.equal(f.notices.unread(owner).length, 1);
});

test("new completion corrects a historical unknown notice once without losing its history", async context => {
  const f = await fixture(context); const lost = await lostAck(f, async id => recoveredTerminal(id, f));
  f.notices.complete(owner, lost.job.id, `Execution ${lost.job.id}: unknown; provenance unconfirmed.`);
  f.notices.markRead(owner, "execution", lost.job.id);
  await f.service.reconcile(lost.job.id, owner, { runner: () => lost.runner, finalize: async (_, result) => result });
  assert.equal(f.notices.unread(owner).length, 1);
  assert.match(f.notices.unread(owner)[0]!.message, /completed/);
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM agent_notifications").get()!.count, 2);
});

test("authoritative failure without result is audited before completion and retries pinned evidence", async context => {
  const f = await fixture(context); let reads = 0; let attempts = 0;
  const lost = await lostAck(f, async id => ({ ...owner, id, state: "failed", queuedAt: "now", receipt: receipt(2),
    finishedAt: `2026-01-01T00:00:0${++reads}.000Z`, error: "Admission denied",
    evidence: { runnerInstanceId: "original-ledger", runnerBootId: "boot-one", revision: 2, processTerminated: true, terminationReason: "not_started" } }));
  let original: unknown;
  const handlers = { runner: () => lost.runner, finalize: async (_: unknown, result: ShellExecutionResult) => result,
    finalizeFailure: async (_: unknown, failure: unknown) => {
      if (++attempts === 1) { original = failure; throw new Error("audit storage unavailable"); }
      assert.deepEqual(failure, original);
    } };
  const interrupted = await f.service.reconcile(lost.job.id, owner, handlers);
  assert.equal(interrupted.state, "unknown"); assert.equal(interrupted.provenance, "unconfirmed"); assert.equal(f.notices.unread(owner).length, 0);
  const restarted = new ShellExecutions(f.db, f.versions, f.notices);
  const failed = await restarted.reconcile(lost.job.id, owner, handlers);
  assert.equal(failed.state, "failed"); assert.equal(failed.error, "Admission denied"); assert.equal(failed.provenance, "committed");
  assert.equal(failed.evidence!.processTerminated, true); assert.equal(attempts, 2); assert.equal(lost.submissions(), 1);
});

test("authorization is rechecked during recovered result reads and revoked results are not published", async context => {
  const f = await fixture(context); const lost = await lostAck(f, async id => recoveredTerminal(id, f));
  let authorized = true; let catalogReads = 0;
  lost.runner.listEnvironments = async () => { catalogReads++; authorized = false; return []; };
  const record = await f.service.reconcile(lost.job.id, owner, {
    runner: () => { if (!authorized) throw Object.assign(new Error("revoked"), { statusCode: 403 }); return lost.runner; },
    finalize: async (_, result, runner) => { await runner.listEnvironments(); return result; },
  });
  assert.equal(catalogReads, 1); assert.equal(record.state, "unknown"); assert.equal(record.observation?.lastError?.code, "AUTHORIZATION_REVOKED");
  assert.equal(record.provenance, "unconfirmed"); assert.equal(record.result, undefined); assert.equal(f.notices.unread(owner).length, 0);
});

test("repeated background scans share one bounded batch rather than multiplying Runner queries", async context => {
  const f = await fixture(context); const release = deferred<void>(); const entered = deferred<void>();
  let queries = 0; let inFlight = 0; let maxInFlight = 0;
  const lookup = async (id: string) => {
    queries++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    if (queries === 4) entered.resolve();
    await release.promise; inFlight--;
    return recoveredTerminal(id, f);
  };
  let runner!: RunnerClient;
  for (let index = 0; index < 12; index++) runner = (await lostAck(f, lookup, `workspace-${index}`)).runner;
  f.service.configureRecovery({ runner: () => runner, finalize: async (_, result) => result });
  context.after(() => f.service.close());
  await entered.promise;
  const scans = Array.from({ length: 10 }, () => f.service.reconcilePending(identity.runnerId));
  await Promise.resolve();
  assert.equal(queries, 4, "overlapping ticks must not launch another batch");
  release.resolve(); await Promise.all(scans);
  assert.equal(queries, 12); assert.equal(maxInFlight, 4);
});

test("reconnection arriving during another scan is coalesced rather than losing blocked recovery", async context => {
  const f = await fixture(context); const release = deferred<void>(); const denied = deferred<void>();
  let revoked = true; let firstId = "";
  const lookup = async (id: string) => {
    if (id === firstId && revoked) { denied.resolve(); throw Object.assign(new Error("revoked"), { statusCode: 403 }); }
    if (id !== firstId) await release.promise;
    return recoveredTerminal(id, f);
  };
  const first = await lostAck(f, lookup, "first-workspace"); firstId = first.job.id;
  const second = await lostAck(f, lookup, "second-workspace");
  f.service.configureRecovery({ runner: () => first.runner, finalize: async (_, result) => result });
  context.after(() => f.service.close());
  await denied.promise;
  revoked = false;
  const reconnect = f.service.reconcilePending(identity.runnerId);
  release.resolve(); await reconnect;
  assert.equal((await f.service.get(first.job.id, owner)).state, "completed");
  assert.equal((await f.service.get(second.job.id, owner)).state, "completed");
});

test("a retried logical tool call keeps its original ID across API restart and rejects changed input", async context => {
  const f = await fixture(context); let submissions = 0;
  const runner = { health: async () => ({ runnerInstanceId: "original-ledger" }), startShellExecution: async () => { submissions++; throw new TypeError("fetch failed"); } } as unknown as RunnerClient;
  const contextFor = (id: string) => ({ ...recoveryContext(id), toolCallId: "logical-call" });
  const callback = (id: string, dispatch: RunnerClient["executeShell"]) => dispatch(request(id));
  const original = await f.service.start(owner, identity, () => runner, callback, contextFor);
  await f.service.wait(original.id, owner, 1000);
  const restarted = new ShellExecutions(f.db, f.versions, f.notices);
  const retry = await restarted.start(owner, identity, () => runner, callback, contextFor);
  assert.equal(retry.id, original.id); assert.equal(retry.state, "unknown"); assert.equal(submissions, 1);
  const renewed = await restarted.start(owner, identity, () => runner, callback, id => ({ ...contextFor(id), permissionEpoch: { ...contextFor(id).permissionEpoch, id: "renewed-epoch", createdAt: "2026-01-02T00:00:00.000Z" } }));
  assert.equal(renewed.id, original.id);
  await assert.rejects(restarted.start(owner, identity, () => runner, callback, id => ({ ...contextFor(id), toolCallId: "fresh-call" })), { code: "ORIGINAL_EXECUTION_UNCONFIRMED" });
  await assert.rejects(restarted.start(owner, identity, () => runner, callback, id => ({ ...contextFor(id), code: "different" })), { code: "EXECUTION_ID_CONFLICT" });
  assert.equal(submissions, 1);
});

test("Runner publication recovery pending stays transient until its completed receipt is available", async context => {
  const f = await fixture(context); let journalPending = true;
  const lost = await lostAck(f, async id => {
    if (journalPending) throw Object.assign(new Error("Runner is reconciling its journal"), { statusCode: 503, code: "EXECUTION_RECOVERY_PENDING" });
    return recoveredTerminal(id, f);
  });
  const handlers = { runner: () => lost.runner, finalize: async (_: unknown, result: ShellExecutionResult) => result };
  const pending = await f.service.reconcile(lost.job.id, owner, handlers);
  assert.equal(pending.observation?.lastError?.retryable, true); assert.ok(pending.observation?.nextRetryAt);
  journalPending = false;
  f.service.configureRecovery(handlers); context.after(() => f.service.close());
  assert.equal((await f.service.wait(lost.job.id, owner, 1000)).state, "completed"); assert.equal(lost.submissions(), 1);
});

test("a contender losing logical-intent insertion returns the winner instead of dispatching or failing", async context => {
  const f = await fixture(context); let submits = 0;
  const runner = { health: async () => ({ runnerInstanceId: "original-ledger" }),
    startShellExecution: async (input: ShellExecutionRequest) => { submits++; return recoveredTerminal(input.executionId, f); },
  } as unknown as RunnerClient;
  const contextFor = (id: string) => ({ ...recoveryContext(id), toolCallId: "shared-logical-call" });
  const callback = (id: string, dispatch: RunnerClient["executeShell"]) => dispatch(request(id));
  const winner = await f.service.start(owner, identity, () => runner, callback, contextFor);
  await f.service.wait(winner.id, owner, 1000);
  const contender = new ShellExecutions(f.db, f.versions, f.notices);
  const prepare = f.db.prepare.bind(f.db); let hidden = false;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!hidden && sql === "SELECT record FROM shell_executions WHERE id = ?") {
      hidden = true;
      Object.defineProperty(statement, "get", { value: () => undefined });
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const result = await contender.start(owner, identity, () => runner, callback, contextFor);
    assert.equal(hidden, true); assert.equal(result.id, winner.id); assert.equal(result.state, "completed"); assert.equal(submits, 1);
  } finally { f.db.prepare = prepare; }
});
