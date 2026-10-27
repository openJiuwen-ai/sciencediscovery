// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });
import { DatabaseSync } from "node:sqlite";
import { ConfigurationActivationCoordinator } from "./activation-coordinator.js";
import { parseBackendCapabilities, probeBackendCapabilities, requireSameRun, unsupportedBackendCapabilities, type BackendConfigurationCapabilities } from "./backend-capabilities.js";
import { HttpBackendControl, type BackendControl, type BackendWriteOperation, type BackendWriteReceipt } from "./backend-control.js";
import { ConfigurationOperationWorker, SqliteExternalOperationJournal } from "./operation-worker.js";
import { JiuwenConfigurationRuntimeBridge, persistNativeConfigurationWait, type JiuwenConfigurationWaitBinding, type ConfigurationActivationEvidence } from "./runtime-bridge.js";
import type { ConfigurationApplyReceipt, ConfigurationRecord } from "./types.js";

const capabilities = (): BackendConfigurationCapabilities => ({
  protocolVersion: 1, backendId: "jiuwenswarm", baseline: { workswarmCommit: null, coreCommit: null, patches: [] },
  control: { conditionalWrite: true, idempotentOperations: true, queryOperation: true },
  runtime: { durableInterrupt: true, exactResume: true, targetToolRefresh: true, durableWaitBinding: true },
  settings: [{ id: "connector.enable", schemaVersion: 1, scopes: ["session"], activationModes: ["same_run"] }], unavailableReasons: [],
});
const operation = (): BackendWriteOperation => ({ backendId: "jiuwenswarm", operationId: "op-1", requestId: "request-1", revision: 2,
  previewDigest: "approved-digest", settingId: "connector.enable", scope: "session", expectedBackendRevision: "backend-4",
  approvedPlan: { connectorId: "pubmed" }, stopGeneration: 7 });
const backendReceipt = (): BackendWriteReceipt => ({ backendId: "jiuwenswarm", operationId: "op-1", requestId: "request-1", revision: 2,
  previewDigest: "approved-digest", previousBackendRevision: "backend-4", backendRevision: "backend-5" });
const binding = (): JiuwenConfigurationWaitBinding => ({ sessionId: "session-1", runId: "run-1", requestId: "request-1", revision: 2,
  stopGeneration: 7, checkpointRef: "local-checkpoint", committedAt: "2026-10-19T00:00:00.000Z",
  upstreamSessionId: "upstream-session-1", interruptId: "configuration-interrupt", toolCallId: "tool-1", upstreamCheckpointRef: "core-checkpoint" });
const evidence = (): ConfigurationActivationEvidence => ({ requestId: "request-1", revision: 2, receiptId: "receipt-1", runId: "run-1",
  effectiveRevision: "backend-5", toolCatalogFingerprint: "toolset-5", activatedAt: "2026-10-19T00:00:01.000Z" });

test("CFG-T26 missing or malformed handshake fails closed and never calls config.set", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response("{}", { status: 404 }); }) as typeof fetch;
  const caps = await probeBackendCapabilities({ adapterUrl: "http://adapter", fetch: fakeFetch });
  assert.equal(caps.runtime.exactResume, false);
  assert.throws(() => requireSameRun(caps, "connector.enable"));
  await assert.rejects(new HttpBackendControl({ baseUrl: "http://adapter", fetch: fakeFetch }).submit(operation(), { beforeDispatch: async () => true }));
  assert.ok(calls.every((url) => url.endsWith("/agent/configuration/capabilities")));
  assert.throws(() => parseBackendCapabilities({ ...capabilities(), protocolVersion: 2 }));
  assert.throws(() => parseBackendCapabilities({ ...capabilities(), runtime: { durableInterrupt: "true" } }));
});

test("CFG-T27 native checkpoint commits before wait, failure never exposes a wait receipt", async () => {
  const order: string[] = [];
  const result = await persistNativeConfigurationWait({ sessionId: "s", runId: "r", requestId: "q", generation: () => 3,
    commitCheckpoint: async () => { order.push("checkpoint"); return "checkpoint-ref"; },
    commitWait: async (wait) => { order.push("wait"); assert.equal(wait.checkpointRef, "checkpoint-ref"); } });
  assert.deepEqual(order, ["checkpoint", "wait"]);
  assert.equal(result.stopGeneration, 3);
  await assert.rejects(persistNativeConfigurationWait({ sessionId: "s", runId: "r", requestId: "q", generation: () => 3,
    commitCheckpoint: async () => { throw new Error("disk full"); }, commitWait: async () => { assert.fail("must not expose wait"); } }), /disk full/);
});

test("CFG-T27 Stop during native checkpoint prevents an actionable configuration wait", async () => {
  let generation = 3;
  await assert.rejects(persistNativeConfigurationWait({ sessionId: "s", runId: "r", requestId: "q", generation: () => generation,
    commitCheckpoint: async () => { generation++; return "ref"; }, commitWait: async () => { assert.fail("no wait after Stop"); } }), /invalidated/);
});

test("CFG-T25 resumes only the bound configuration interrupt and preserves unrelated permission questions", async () => {
  let sent: Parameters<import("./runtime-bridge.js").JiuwenInterruptHost["resume"]>[0] | undefined;
  const bridge = new JiuwenConfigurationRuntimeBridge(capabilities(), {
    inspectWait: async () => ({ binding: binding(), checkpointDurable: true, pendingInterruptIds: ["configuration-interrupt", "unrelated-shell-permission"] }),
    resume: async (input) => { sent = input; return { state: "queued", resumeKey: input.resumeKey }; }, cancel: async () => {},
  });
  const result = await bridge.resume({ binding: binding(), capabilityId: "connector.enable", decision: "apply", generation: () => 7, activation: evidence() });
  assert.equal(result.state, "queued");
  assert.deepEqual(Object.keys(sent!.answers), ["configuration-interrupt"]);
  assert.equal(sent!.binding.runId, "run-1");
});

test("CFG-T25 mismatched upstream Session or expired generation never resumes", async () => {
  let resumes = 0;
  const bridge = new JiuwenConfigurationRuntimeBridge(capabilities(), {
    inspectWait: async () => ({ binding: { ...binding(), upstreamSessionId: "other-session" }, checkpointDurable: true, pendingInterruptIds: ["configuration-interrupt"] }),
    resume: async (input) => { resumes++; return { state: "queued", resumeKey: input.resumeKey }; }, cancel: async () => {},
  });
  await assert.rejects(bridge.resume({ binding: binding(), capabilityId: "connector.enable", decision: "dismiss", generation: () => 7 }), /binding mismatch/);
  await assert.rejects(bridge.resume({ binding: binding(), capabilityId: "connector.enable", decision: "dismiss", generation: () => 8 }), /stopped/);
  assert.equal(resumes, 0);
});

test("CFG-T25 Stop while reconciling core interrupt suppresses continuation", async () => {
  let generation = 7;
  const bridge = new JiuwenConfigurationRuntimeBridge(capabilities(), {
    inspectWait: async () => { generation++; return { binding: binding(), checkpointDurable: true, pendingInterruptIds: ["configuration-interrupt"] }; },
    resume: async () => { assert.fail("Stop must win"); }, cancel: async () => {},
  });
  await assert.rejects(bridge.resume({ binding: binding(), capabilityId: "connector.enable", decision: "dismiss", generation: () => generation }), /stopped/);
});

test("CFG-T26 an installed core version cannot substitute for durable adapter capability", async () => {
  const unsupported = unsupportedBackendCapabilities("jiuwenswarm", "no durable adapter");
  const bridge = new JiuwenConfigurationRuntimeBridge(unsupported, {
    inspectWait: async () => { assert.fail("must fail before upstream invocation"); },
    resume: async () => { assert.fail("must not resume"); }, cancel: async () => {},
  });
  await assert.rejects(bridge.resume({ binding: binding(), capabilityId: "connector.enable", decision: "dismiss", generation: () => 7 }), /cannot durably resume/);
});

test("CFG-T24 timeout produces unknown; restart only queries and records saved fact after Stop", async () => {
  const database = new DatabaseSync(":memory:");
  let authorized = true, submits = 0, queries = 0, committed = 0;
  const options = { database, isAuthorized: async () => authorized, commitApplied: () => { committed++; } };
  const journal = new SqliteExternalOperationJournal(options); journal.prepare(operation());
  const backend: BackendControl = { inspect: async () => capabilities(),
    submit: async () => { submits++; throw new Error("reply lost after remote commit"); },
    queryOperation: async () => { queries++; return { state: "applied", receipt: backendReceipt() }; } };
  assert.equal((await new ConfigurationOperationWorker(backend, journal).process("op-1"))!.state, "external_unknown");
  authorized = false;
  const restarted = new SqliteExternalOperationJournal(options);
  assert.equal((await new ConfigurationOperationWorker(backend, restarted).process("op-1"))!.state, "applied");
  assert.equal(committed, 1); assert.equal(submits, 1); assert.equal(queries, 1);
  await new ConfigurationOperationWorker(backend, restarted).process("op-1");
  assert.equal(committed, 1); assert.equal(submits, 1); database.close();
});

test("CFG-T24 crash after sending is reconciled from durable lease without resubmission", async () => {
  const database = new DatabaseSync(":memory:"); let now = 100, submits = 0;
  const options = { database, now: () => now, leaseMs: 10, isAuthorized: async () => true, commitApplied: () => {} };
  const first = new SqliteExternalOperationJournal(options); first.prepare(operation());
  const claimed = (await first.claim("op-1"))!; claimed.state = "sending"; await first.save(claimed);
  const restarted = new SqliteExternalOperationJournal(options);
  assert.equal(await restarted.claim("op-1"), undefined);
  now = 111;
  const backend: BackendControl = { inspect: async () => capabilities(), submit: async () => { submits++; return { state: "unknown" }; }, queryOperation: async () => ({ state: "applied", receipt: backendReceipt() }) };
  assert.equal((await new ConfigurationOperationWorker(backend, restarted).process("op-1"))!.state, "applied");
  assert.equal(submits, 0); database.close();
});

test("CFG-T24 missing remote guarantees reject write before dispatch", async () => {
  const database = new DatabaseSync(":memory:"); let calls = 0;
  const journal = new SqliteExternalOperationJournal({ database, isAuthorized: async () => true, commitApplied: () => {} }); journal.prepare(operation());
  const backend: BackendControl = { inspect: async () => unsupportedBackendCapabilities("jiuwenswarm", "no CAS"), submit: async () => { calls++; return { state: "unknown" }; }, queryOperation: async () => { calls++; return { state: "unknown" }; } };
  await assert.rejects(new ConfigurationOperationWorker(backend, journal).process("op-1"), /lacks conditional writes/);
  assert.equal(calls, 0); assert.equal(journal.read("op-1")!.state, "prepared"); database.close();
});

test("CFG-T24 Stop before first submit suppresses operation; mismatched plan cannot reuse its ID", async () => {
  const database = new DatabaseSync(":memory:");
  const journal = new SqliteExternalOperationJournal({ database, isAuthorized: async () => false, commitApplied: () => { assert.fail("no saved receipt"); } }); journal.prepare(operation());
  assert.throws(() => journal.prepare({ ...operation(), previewDigest: "different" }), /another plan/);
  const backend: BackendControl = { inspect: async () => { assert.fail("no backend call after Stop"); }, submit: async () => ({ state: "unknown" }), queryOperation: async () => ({ state: "unknown" }) };
  assert.equal((await new ConfigurationOperationWorker(backend, journal).process("op-1"))!.state, "suppressed"); database.close();
});

test("CFG-T24 Stop during the control client's second handshake prevents the actual write dispatch", async () => {
  const database = new DatabaseSync(":memory:"); let authorized = true, inspections = 0, writes = 0;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const fakeFetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/capabilities")) {
      inspections++;
      if (inspections === 2) { enter(); await proceed; }
      return Response.json(capabilities());
    }
    if (String(url).endsWith("/operations/submit")) { writes++; return Response.json({ state: "applied", receipt: backendReceipt() }); }
    assert.fail(`Unexpected backend request: ${String(url)}`);
  }) as typeof fetch;
  const journal = new SqliteExternalOperationJournal({ database, isAuthorized: async () => authorized, commitApplied: () => { assert.fail("Stopped operation has no saved receipt"); } });
  journal.prepare(operation());
  const worker = new ConfigurationOperationWorker(new HttpBackendControl({ baseUrl: "http://adapter", fetch: fakeFetch }), journal);
  const processing = worker.process("op-1");
  await entered; authorized = false; release();
  assert.equal((await processing)!.state, "suppressed");
  assert.equal(writes, 0); assert.equal(inspections, 2);
  assert.equal(journal.read("op-1")!.errorCode, "dispatch_not_authorized"); database.close();
});

test("CFG-T24 final dispatch authorization runs after handshake and permits exactly one still-approved write", async () => {
  const order: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/capabilities")) { order.push("handshake"); return Response.json(capabilities()); }
    order.push("write"); return Response.json({ state: "applied", receipt: backendReceipt() });
  }) as typeof fetch;
  const result = await new HttpBackendControl({ baseUrl: "http://adapter", fetch: fakeFetch }).submit(operation(), {
    beforeDispatch: async () => { order.push("authorize"); return true; },
  });
  assert.equal(result.state, "applied"); assert.deepEqual(order, ["handshake", "authorize", "write"]);
});

test("CFG-T24 authoritative unknown result remains query-only across repeated recovery attempts", async () => {
  const database = new DatabaseSync(":memory:"); let submits = 0, queries = 0;
  const journal = new SqliteExternalOperationJournal({ database, isAuthorized: async () => true, commitApplied: () => {} }); journal.prepare(operation());
  const backend: BackendControl = { inspect: async () => capabilities(),
    submit: async () => { submits++; return { state: "unknown" }; },
    queryOperation: async () => { queries++; return { state: "not_executed", safeToRetry: false }; } };
  const worker = new ConfigurationOperationWorker(backend, journal);
  await worker.process("op-1"); await worker.process("op-1"); await worker.process("op-1");
  assert.equal(submits, 1); assert.equal(queries, 2); assert.equal(journal.read("op-1")!.state, "external_unknown"); database.close();
});

test("CFG-T24 safe retry requires authoritative not-executed and rechecks Stop before same operation submit", async () => {
  const database = new DatabaseSync(":memory:"); let authorized = true, submits = 0;
  const journal = new SqliteExternalOperationJournal({ database, isAuthorized: async () => authorized, commitApplied: () => {} }); journal.prepare(operation());
  const backend: BackendControl = { inspect: async () => capabilities(),
    submit: async () => { submits++; return { state: "unknown" }; }, queryOperation: async () => ({ state: "not_executed", safeToRetry: true }) };
  const worker = new ConfigurationOperationWorker(backend, journal);
  await worker.process("op-1"); await worker.process("op-1");
  assert.equal(journal.read("op-1")!.state, "prepared"); authorized = false;
  await worker.process("op-1"); assert.equal(submits, 1); assert.equal(journal.read("op-1")!.state, "suppressed"); database.close();
});

test("CFG-T24 receipt transaction failure rolls back local completion and retries authority query only", async () => {
  const database = new DatabaseSync(":memory:"); let submits = 0, failCommit = true;
  const journal = new SqliteExternalOperationJournal({ database, isAuthorized: async () => true,
    commitApplied: () => { if (failCommit) throw new Error("local receipt disk failure"); } }); journal.prepare(operation());
  const backend: BackendControl = { inspect: async () => capabilities(),
    submit: async () => { submits++; return { state: "applied", receipt: backendReceipt() }; }, queryOperation: async () => ({ state: "applied", receipt: backendReceipt() }) };
  const worker = new ConfigurationOperationWorker(backend, journal);
  await assert.rejects(worker.process("op-1"), /local receipt disk failure/);
  assert.equal(journal.read("op-1")!.state, "sending"); failCommit = false;
  assert.equal((await worker.process("op-1"))!.state, "applied"); assert.equal(submits, 1); database.close();
});

test("CFG-T24 worker cannot mutate an approved operation after claiming its lease", async () => {
  const database = new DatabaseSync(":memory:");
  const journal = new SqliteExternalOperationJournal({ database, isAuthorized: async () => true, commitApplied: () => {} }); journal.prepare(operation());
  const claimed = (await journal.claim("op-1"))!; claimed.operation.approvedPlan = { connectorId: "other" };
  await assert.rejects(journal.save(claimed), /immutable/);
  assert.deepEqual(journal.read("op-1")!.operation.approvedPlan, { connectorId: "pubmed" }); database.close();
});

function approved(): { record: ConfigurationRecord; receipt: ConfigurationApplyReceipt } {
  const record = { view: { id: "request-1", revision: 2, runId: "run-1", sessionId: "session-1" }, plan: { activationMode: "same_run" },
    approvedRevision: 2, approvedDigest: "approved-digest", stopGeneration: 7 } as ConfigurationRecord;
  const receipt = { id: "receipt-1", requestId: "request-1", revision: 2, previewDigest: "approved-digest", stopGeneration: 7 } as ConfigurationApplyReceipt;
  return { record, receipt };
}

test("CFG-T28 activation failure preserves saved configuration and never enqueues continuation", async () => {
  const { record, receipt } = approved(); let state = "";
  const coordinator = new ConfigurationActivationCoordinator({ isCurrent: async () => true,
    activate: async () => { throw new Error("tool registry failed"); }, saveActivation: async (_, result) => { state = result.state; },
    enqueueResume: async () => { assert.fail("cannot resume without activation"); } });
  assert.equal(await coordinator.activate(record, receipt), "failed"); assert.equal(state, "failed");
  assert.equal(receipt.id, "receipt-1"); assert.equal(record.approvedDigest, "approved-digest");
});

test("CFG-T28 independent active receipt precedes queued resume; failed queue does not rewrite configuration", async () => {
  const { record, receipt } = approved(); const stages: string[] = [];
  const coordinator = new ConfigurationActivationCoordinator({ isCurrent: async () => true, activate: async () => evidence(),
    saveActivation: async (_, result) => { stages.push(result.state); }, enqueueResume: async () => { stages.push("queue"); throw new Error("queue persistence failed"); } });
  await assert.rejects(coordinator.activate(record, receipt), /queue persistence failed/);
  assert.deepEqual(stages, ["active", "queue"]);
});

test("CFG-T28 next_run and restart are explicit and do not claim target runtime is active", async () => {
  const { record, receipt } = approved(); record.plan.activationMode = "next_run";
  const coordinator = new ConfigurationActivationCoordinator({ isCurrent: async () => true,
    activate: async () => { assert.fail("no unsupported hot activation"); }, saveActivation: async (_, result) => { assert.equal(result.code, "next_run"); },
    enqueueResume: async () => { assert.fail("no same-run resume"); } });
  assert.equal(await coordinator.activate(record, receipt), "needs_user_action");
});

test("CFG-T28 Stop during activation preserves saved fact but suppresses resumption", async () => {
  const { record, receipt } = approved(); let current = true, savedState = "";
  const coordinator = new ConfigurationActivationCoordinator({ isCurrent: async () => current,
    activate: async () => { current = false; return evidence(); }, saveActivation: async (_, result) => { savedState = result.state; },
    enqueueResume: async () => { assert.fail("Stop must suppress resumption"); } });
  assert.equal(await coordinator.activate(record, receipt), "suppressed"); assert.equal(savedState, "suppressed");
});

test("CFG-T28 activation evidence for another target run cannot resume this run", async () => {
  const { record, receipt } = approved();
  const coordinator = new ConfigurationActivationCoordinator({ isCurrent: async () => true,
    activate: async () => ({ ...evidence(), runId: "other-run" }), saveActivation: async (_, result) => { assert.equal(result.state, "failed"); },
    enqueueResume: async () => { assert.fail("wrong target runtime"); } });
  assert.equal(await coordinator.activate(record, receipt), "failed");
});
