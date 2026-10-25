// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";

import { RefStore, VersionStore } from "@sciencediscovery/cas";
import { RunnerClient as HttpRunnerClient, type RunnerClient } from "@sciencediscovery/executor";
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

type Fixture = Awaited<ReturnType<typeof fixture>>;
type LogEvent = { level: "info" | "warn"; event: string; fields: { [key: string]: unknown } };
function captureLog() {
  const events: LogEvent[] = [];
  const write = (level: LogEvent["level"]) => (event: string, fields: LogEvent["fields"] = {}) => { events.push({ level, event, fields }); };
  return { events, log: { info: write("info"), warn: write("warn") }, named: (event: string) => events.filter((entry) => entry.event === event) };
}

/** A real HTTP Runner whose status endpoint can drop connections: transport faults come from fetch itself, not a fake throw. */
async function droppingRunner(context: TestContext, f: Fixture) {
  const runner = { id: "", posts: 0, statusRequests: 0, drop: 0, down: false, state: "running" as ManagedExecution["state"] };
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? "/", "http://runner");
    if (request.method === "POST" && url.pathname === "/shell-executions") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        runner.posts++;
        runner.id = (JSON.parse(body) as ShellExecutionRequest).executionId;
        send(202, { ...owner, id: runner.id, state: "running", queuedAt: new Date().toISOString() });
      });
      return;
    }
    if (request.method === "GET" && url.pathname === `/shell-executions/${runner.id}`) {
      runner.statusRequests++;
      if (runner.down || runner.drop > 0) {
        runner.drop = Math.max(0, runner.drop - 1);
        request.socket.destroy(); // the job keeps running; only this status read is lost
        return;
      }
      const ended = runner.state !== "queued" && runner.state !== "running";
      send(200, { ...owner, id: runner.id, state: runner.state, queuedAt: new Date().toISOString(),
        ...(ended ? { startedAt: new Date().toISOString(), result: f.result, version: f.ref } : {}) });
      return;
    }
    send(404, { error: "Execution not found for this Agent" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { runner, client: new HttpRunnerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "token") as RunnerClient };
}

test("a dropped status connection is retried by the same Execution ID and logged with its cause and Runner connection", async (context) => {
  const f = await fixture(context);
  const logs = captureLog();
  const service = new ShellExecutions(f.db, f.versions, f.notices, 1, undefined, logs.log);
  service.describeRunnerConnections(() => "ready");
  const { runner, client } = await droppingRunner(context, f);
  runner.drop = 1;
  runner.state = "completed";
  const job = await service.start(owner, identity, () => client, (executionId, dispatch) => dispatch(request(executionId)));
  const result = await service.wait(job.id, owner, 5_000);
  assert.equal(result.state, "completed");
  assert.equal(result.provenance, "committed");
  assert.equal(runner.posts, 1, "the accepted command is never submitted again");
  assert.equal(runner.statusRequests, 2);
  const [failure] = logs.named("shell_execution_observation_failed");
  assert.equal(logs.named("shell_execution_observation_failed").length, 1);
  assert.equal(failure!.level, "warn");
  assert.equal(failure!.fields.executionId, job.id);
  assert.equal(failure!.fields.runnerId, identity.runnerId);
  assert.equal(failure!.fields.consecutiveFailures, 1);
  assert.equal(failure!.fields.retryable, true);
  assert.equal(failure!.fields.errorMessage, "fetch failed");
  assert.match(String(failure!.fields.errorCode), /^(?:UND_ERR_|ECONN)/, "the socket-level code behind `fetch failed` is kept");
  assert.equal(failure!.fields.runnerConnection, "ready");
  assert.deepEqual(logs.named("shell_execution_observation_recovered").map((entry) => entry.fields.consecutiveFailures), [1]);
  assert.deepEqual(logs.named("shell_execution_unconfirmed"), []);
});

test("an outage past the threshold stays unconfirmed, then execution_status adopts the Runner's committed outcome without replay", async (context) => {
  const f = await fixture(context);
  const logs = captureLog();
  const service = new ShellExecutions(f.db, f.versions, f.notices, 1, undefined, logs.log);
  let connection = "connecting";
  service.describeRunnerConnections(() => connection);
  const { runner, client } = await droppingRunner(context, f);
  runner.down = true;
  const job = await service.start(owner, identity, () => client, (executionId, dispatch) => dispatch(request(executionId)));
  const lost = await service.wait(job.id, owner, 5_000);
  assert.equal(lost.state, "unknown", "a lost observation is neither success nor job failure");
  assert.equal(lost.provenance, "unconfirmed");
  assert.match(lost.error!, /after 5 consecutive attempts: fetch failed \((?:UND_ERR_|ECONN)/);
  const failures = logs.named("shell_execution_observation_failed");
  assert.deepEqual(failures.map((entry) => entry.fields.consecutiveFailures), [1, 2, 3, 4, 5]);
  assert.deepEqual(failures.map((entry) => "retryInMs" in entry.fields), [true, true, true, true, false]);
  assert.ok(failures.every((entry) => entry.fields.executionId === job.id && entry.fields.runnerConnection === "connecting"));
  const [unconfirmed] = logs.named("shell_execution_unconfirmed");
  assert.equal(unconfirmed!.fields.stage, "observation");
  assert.equal(unconfirmed!.fields.accepted, true);

  assert.equal((await service.wait(job.id, owner, 0)).state, "unknown", "without a Runner resolver nothing is queried");
  connection = "ready"; runner.down = false; runner.state = "completed";
  const reconciled = await service.wait(job.id, owner, 0, undefined, () => client);
  assert.equal(reconciled.state, "completed");
  assert.equal(reconciled.provenance, "committed");
  assert.equal(reconciled.error, undefined);
  assert.equal(reconciled.result?.stdout, "done");
  assert.equal(reconciled.runnerVersionId, f.ref.digest);
  assert.equal(runner.posts, 1, "reconciliation reads the same Execution ID; it never submits the command");
  assert.deepEqual(logs.named("shell_execution_reconciled").map((entry) => entry.fields),
    [{ executionId: job.id, runnerId: identity.runnerId, sessionId: owner.sessionId, agentId: owner.agentId,
      runnerState: "completed", state: "completed", provenance: "committed" }]);
  const statusReads = runner.statusRequests;
  assert.equal((await service.wait(job.id, owner, 0, undefined, () => client)).state, "completed");
  assert.equal(runner.statusRequests, statusReads, "a confirmed outcome is not queried again");
});

test("an execution orphaned by an API restart is followed again while its Runner still runs it, and its real end notifies again", async (context) => {
  const f = await fixture(context);
  const logs = captureLog();
  const finish = deferred<void>();
  let observations = 0; let ended = false;
  const runner = {
    getShellExecution: async (id: string) => {
      observations++;
      if (observations > 1) { await finish.promise; ended = true; }
      return { ...owner, id, state: ended ? "completed" : "running", queuedAt: "now", startedAt: "now",
        ...(ended ? { result: f.result, version: f.ref } : {}) };
    },
  } as unknown as RunnerClient;
  const orphan = { ...owner, ...identity, id: "orphan", state: "running", queuedAt: "now", accepted: true, provenance: "pending" };
  f.db.prepare("INSERT INTO shell_executions VALUES (?, ?, ?, ?)").run("orphan", owner.sessionId, owner.agentId, JSON.stringify(orphan));
  const restarted = new ShellExecutions(f.db, f.versions, f.notices, 1, undefined, logs.log);
  assert.equal(logs.named("shell_execution_orphaned")[0]!.fields.executionId, "orphan");
  assert.equal((await restarted.get("orphan", owner)).state, "unknown");
  assert.equal(f.notices.unread(owner).length, 1, "the restart reports the lost outcome");
  f.notices.markRead(owner, "execution", "orphan");

  const resumed = await restarted.wait("orphan", owner, 0, undefined, () => runner);
  assert.equal(resumed.state, "running", "the Runner's live record replaces the restart's unknown");
  assert.equal(resumed.provenance, "pending");
  assert.equal(resumed.finishedAt, undefined);
  assert.equal(resumed.error, undefined);
  assert.doesNotThrow(() => f.notices.createTimer(owner, { dueAt: Date.now() + 60_000, message: "check", executionId: "orphan" }),
    "a running execution accepts reminders again");
  finish.resolve();
  const completed = await restarted.wait("orphan", owner, 2_000, undefined, () => runner);
  assert.equal(completed.state, "completed");
  assert.equal(completed.provenance, "committed");
  assert.equal(completed.result?.stdout, "done");
  const [notice] = f.notices.unread(owner);
  assert.match(notice!.message, /orphan on Runner remote: completed; provenance committed/);
  assert.equal(f.notices.timers(owner)[0]!.state, "cancelled", "the real completion supersedes the reminder");
});

test("a resumed observation that loses the Runner again returns to unknown with a fresh notice", async (context) => {
  const f = await fixture(context);
  let observations = 0;
  const runner = {
    getShellExecution: async (id: string) => {
      observations++;
      if (observations > 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
      return { ...owner, id, state: "running", queuedAt: "now" };
    },
  } as unknown as RunnerClient;
  const orphan = { ...owner, ...identity, id: "orphan", state: "running", queuedAt: "now", accepted: true, provenance: "pending" };
  f.db.prepare("INSERT INTO shell_executions VALUES (?, ?, ?, ?)").run("orphan", owner.sessionId, owner.agentId, JSON.stringify(orphan));
  const restarted = new ShellExecutions(f.db, f.versions, f.notices, 1);
  f.notices.markRead(owner, "execution", "orphan");
  assert.equal((await restarted.wait("orphan", owner, 0, undefined, () => runner)).state, "running");
  const lost = await restarted.wait("orphan", owner, 2_000);
  assert.equal(lost.state, "unknown");
  assert.equal(lost.provenance, "unconfirmed");
  assert.match(lost.error!, /after 5 consecutive attempts: fetch failed \(ECONNRESET\)/);
  assert.equal(observations, 6);
  assert.match(f.notices.unread(owner)[0]!.message, /orphan on Runner remote: unknown; provenance unconfirmed/);
});

test("a lost submission response is reconciled once the Runner shows it accepted the Execution ID", async (context) => {
  const f = await fixture(context);
  const logs = captureLog();
  const service = new ShellExecutions(f.db, f.versions, f.notices, 1, undefined, logs.log);
  let submitted = 0;
  const runner = {
    startShellExecution: async () => { submitted++; throw new Error("lost response"); },
    getShellExecution: async (id: string) => ({ ...owner, id, state: "completed", queuedAt: "now", startedAt: "now", result: f.result, version: f.ref }),
  } as unknown as RunnerClient;
  const job = await service.start(owner, identity, () => runner, (id, dispatch) => dispatch(request(id)));
  assert.equal(job.state, "unknown"); assert.equal(job.accepted, false);
  assert.equal(logs.named("shell_execution_unconfirmed")[0]!.fields.stage, "submission");
  const reconciled = await service.wait(job.id, owner, 0, undefined, () => runner);
  assert.equal(reconciled.state, "completed");
  assert.equal(reconciled.provenance, "committed");
  assert.equal(reconciled.accepted, true);
  assert.equal(submitted, 1);
});

test("reconciliation adopts only Runner-committed outcomes and otherwise keeps the uncertainty explicit", async (context) => {
  const cases: Array<[string, (id: string) => Promise<Partial<ManagedExecution>>, { state: string; provenance: string; error?: RegExp }]> = [
    ["Runner still unreachable", async () => { throw new Error("Remote runner is not connected"); },
      { state: "unknown", provenance: "unconfirmed", error: /^Runner status remained unavailable/ }],
    ["Runner never received the ID", async () => { throw Object.assign(new Error("Execution not found for this Agent"), { statusCode: 400 }); },
      { state: "unknown", provenance: "unconfirmed", error: /^Runner status remained unavailable/ }],
    ["Runner restarted mid-run", async (id) => ({ id, state: "unknown", error: "Runner restarted before completion was recorded; the command was not replayed" }),
      { state: "unknown", provenance: "unconfirmed", error: /^Runner could not confirm the outcome: Runner restarted before completion/ }],
    ["completed without a committed version", async (id) => ({ id, state: "completed", startedAt: "now" }),
      { state: "unknown", provenance: "unconfirmed", error: /without a committed result/ }],
    ["recorded failure before a result", async (id) => ({ id, state: "failed", startedAt: "now", error: "sandbox setup failed",
      version: { pool: "agent-state", digest: "sha256:abc", size: 1, mediaType: "application/json" } }),
      { state: "failed", provenance: "committed", error: /^sandbox setup failed$/ }],
    ["foreign identity", async () => ({ id: "other", state: "completed" }),
      { state: "unknown", provenance: "unconfirmed", error: /^Runner status remained unavailable/ }],
  ];
  for (const [label, answer, expected] of cases) {
    const f = await fixture(context);
    const logs = captureLog();
    const service = new ShellExecutions(f.db, f.versions, f.notices, 1, undefined, logs.log);
    service.describeRunnerConnections(() => "disconnected");
    let observations = 0; let submitted = 0;
    const lost = {
      startShellExecution: async (r: ShellExecutionRequest) => { submitted++; return { ...owner, id: r.executionId, state: "running", queuedAt: "now" }; },
      getShellExecution: async () => { throw new TypeError("fetch failed"); },
    } as unknown as RunnerClient;
    const job = await service.start(owner, identity, () => lost, (id, dispatch) => dispatch(request(id)));
    assert.equal((await service.wait(job.id, owner, 2_000)).state, "unknown", label);
    const answering = {
      getShellExecution: async (id: string) => { observations++; return { ...owner, queuedAt: "now", ...await answer(id) }; },
    } as unknown as RunnerClient;
    const [first, second] = await Promise.all([
      service.wait(job.id, owner, 0, undefined, () => answering), service.wait(job.id, owner, 0, undefined, () => answering),
    ]);
    assert.equal(observations, 1, `${label}: concurrent inspections share one Runner query`);
    for (const result of [first!, second!]) {
      assert.equal(result.state, expected.state, label);
      assert.equal(result.provenance, expected.provenance, label);
      assert.match(result.error ?? "", expected.error!, label);
    }
    assert.equal(submitted, 1, `${label}: never replayed`);
    if (expected.state === "unknown" && !logs.named("shell_execution_reconciled").length) {
      const [failure] = logs.named("shell_execution_reconcile_failed");
      assert.equal(failure!.fields.executionId, job.id, label);
      assert.equal(failure!.fields.runnerConnection, "disconnected", label);
    }
  }
});
