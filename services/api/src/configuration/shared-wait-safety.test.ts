// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { handleExecutionReadiness } from "../http/execution-readiness.js";
import { sessionHasActiveRunExceptConfigurationWait } from "../runs/index.js";
import { configurationFramework } from "./framework.js";
import { handleConfigurationHttp } from "./http.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
const apply = (view: ConfigurationRequestView) => ({ revision: view.revision, previewDigest: view.previewDigest!,
  selectedOptionId: view.selectedOptionId, decision: "apply" as const });
async function fixture(context: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "shared-configuration-safety-"));
  const store = new SessionStore(root); await store.load();
  const project = await store.createProject("Independent shared wait safety");
  const session = await store.createSession(project.id, "Original task", {}, {}, { allowUnconfiguredModel: true });
  const foreign = await store.createSession(project.id, "Other session", {}, {}, { allowUnconfiguredModel: true });
  await store.replaceSessionSettings(session.id, { enabledConnectorIds: [] });
  const run = await store.createSessionRun({ sessionId: session.id, prompt: "Original task", settingsSnapshot: store.resolveRuntimeSettings(session.id).effective });
  await store.updateSessionRun(session.id, run.id, { status: "running" });
  const framework = configurationFramework(store, { nativeExecutor: false, jiuwenLiveWait: true,
    connector: () => ({ name: "Offline connector", ready: true }),
    resume: async () => { throw new Error("Must not start another task"); } });
  const waits: Array<{ controller: AbortController; result: Promise<unknown> }> = [];
  context.after(async () => {
    for (const wait of waits) wait.controller.abort();
    await Promise.all(waits.map(wait => wait.result));
    store.close(); await rm(root, { recursive: true, force: true });
  });
  function arm(view: ConfigurationRequestView, activate?: Parameters<typeof framework.waitForDecision>[3]) {
    const controller = new AbortController();
    const promise = framework.waitForDecision(session.id, view.id, controller.signal, activate);
    waits.push({ controller, result: promise.catch(error => error) });
    return { controller, promise };
  }
  const propose = () => framework.propose(session.id, { protocolVersion: 3, runId: run.id,
    capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
  return { root, store, session, foreign, run, framework, propose, arm };
}

test("shared configuration binding is not an execution-repair HTTP decision; preview identities remain authoritative", { timeout: 20_000 }, async context => {
  const f = await fixture(context), view = await f.propose(), waiting = f.arm(view);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://localhost");
      if (await handleConfigurationHttp({ request, response, url, store: f.store, framework: f.framework,
        hasActiveRun: (sessionId, requestId) => requestId
          ? sessionHasActiveRunExceptConfigurationWait(f.store, sessionId, requestId) : Promise.resolve(true) })) return;
      const read = async () => { const chunks: Buffer[] = []; for await (const part of request) { chunks.push(Buffer.from(part)); } return JSON.parse(Buffer.concat(chunks).toString()); };
      // No Runner probe route is exercised; the actual decision handler and store are used.
      if (!await handleExecutionReadiness(request, response, url, f.store, {} as never, {} as never, read)) response.writeHead(404).end();
    })().catch(error => { response.writeHead(500).end(String(error)); });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  context.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function api(path: string, body?: unknown) {
    const reply = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: reply.status, body: await reply.json() };
  }
  const base = `/api/sessions/${f.session.id}/configuration-requests/${view.id}`;
  assert.deepEqual((await api(`/api/sessions/${f.session.id}/execution-blocks`)).body, []);
  for (const choice of [{ action: "retry" }, { action: "cancel" }, { action: "switch", runnerId: "local" }]) {
    assert.equal((await api(`/api/sessions/${f.session.id}/execution-blocks/${view.id}`, choice)).status, 409);
    assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), f.run.id);
    assert.equal(f.framework.service.get(f.session.id, view.id).state, "awaiting_confirmation");
  }
  assert.equal((await api(`/api/sessions/${f.foreign.id}/configuration-requests/${view.id}`)).status, 404);
  const previewReply = await api(base + "/preview", { expectedRevision: view.revision, values: {}, selectedOptionId: "dismiss" });
  assert.equal(previewReply.status, 200);
  const preview = previewReply.body as ConfigurationRequestView;
  assert.ok(preview.revision > view.revision); assert.equal(preview.liveWait, true);
  assert.equal((await api(base + "/decision", { ...apply(preview), revision: view.revision, decision: "dismiss" })).status, 409);
  assert.equal((await api(base + "/decision", { ...apply(preview), previewDigest: "forged", decision: "dismiss" })).status, 409);
  assert.equal((await api(base + "/decision", { ...apply(preview), sessionId: f.foreign.id, decision: "dismiss" })).status, 400);
  assert.equal((await api(base + "/decision", { ...apply(preview), decision: "dismiss" })).status, 200);
  assert.equal((await waiting.promise).state, "dismissed");
  assert.equal(((await api(base)).body as ConfigurationRequestView).liveWait, false);
  assert.deepEqual(f.store.getSessionSettings(f.session.id).effective.enabledConnectorIds, []);
  assert.deepEqual(f.store.listPermissionGrants(), []);
  assert.equal((await f.store.listSessionRuns(f.session.id)).length, 1);
});

test("Stop during configuration verification wins before apply and releases only the original shared waiter", { timeout: 10_000 }, async context => {
  const f = await fixture(context), view = await f.propose(), waiting = f.arm(view);
  const adapter = f.framework.service.registry.get("connector.enable");
  let enter!: () => void, release!: () => void, writes = 0;
  const entered = new Promise<void>(done => { enter = done; }), gate = new Promise<void>(done => { release = done; });
  adapter.verify = async () => { enter(); await gate; return { ok: true }; };
  const originalApply = adapter.apply;
  assert.ok(originalApply);
  adapter.apply = input => { writes++; return originalApply(input); };
  const repair = f.store.executionBlocks.wait({ sessionId: f.foreign.id, executionId: "other-run", runnerId: "local", alternatives: [], reason: "Independent repair" });
  const decision = f.framework.decide(f.session.id, view.id, apply(view));
  await entered; f.store.notifications.stop(f.session.id);
  assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), undefined);
  release(); await decision; await f.framework.tick();
  await assert.rejects(waiting.promise, /cancelled/);
  assert.equal(f.framework.service.get(f.session.id, view.id).state, "cancelled");
  assert.equal(writes, 0);
  await assert.rejects(f.framework.decide(f.session.id, view.id, apply(view)));
  assert.equal(f.store.executionBlocks.list(f.foreign.id).length, 1);
  const [block] = f.store.executionBlocks.list(f.foreign.id);
  assert.ok(block);
  f.store.executionBlocks.decide(f.foreign.id, block.id, { action: "cancel" });
  assert.deepEqual(await repair, { action: "cancel" });
  assert.deepEqual(f.store.getSessionSettings(f.session.id).effective.enabledConnectorIds, []);
  assert.deepEqual(f.store.listPermissionGrants(), []);
});

test("shared configuration deadline expires the domain record and clears credential drafts without a probe", { timeout: 10_000 }, async context => {
  const f = await fixture(context);
  const model = await f.store.createModel({ name: "Offline credential target", model: "fixture", baseUrl: "https://api.openai.com/v1", apiToken: "FORMAL_SYNTHETIC_SECRET" });
  const view = await f.framework.propose(f.session.id, { protocolVersion: 3, runId: f.run.id,
    capabilityId: "model.repair_credential", values: { modelId: model.id } });
  const draft = await f.framework.provideCredential(f.session.id, view.id, { expectedRevision: view.revision, fieldId: "apiToken", secret: "DRAFT_SYNTHETIC_SECRET" });
  let probes = 0;
  f.framework.service.registry.get("model.repair_credential").verify = async () => { probes++; throw new Error("Must not contact model provider"); };
  const record = f.framework.service.getRecord(f.session.id, view.id);
  record.view.expiresAt = new Date(Date.now() + 50).toISOString(); record.view.stateVersion++;
  f.framework.repository.save(record, record.view.stateVersion - 1);
  const waiting = f.arm(view), keepAlive = setTimeout(() => undefined, 1000);
  try {
    const expired = await waiting.promise;
    assert.equal(expired.state, "expired"); assert.equal(expired.resumption.state, "started");
    assert.doesNotMatch(JSON.stringify(expired), /SYNTHETIC_SECRET|ciphertext/);
    assert.equal(probes, 0); assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), undefined);
    assert.throws(() => f.framework.credentials.read(draft.handle, { sessionId: f.session.id, requestId: view.id,
      revision: view.revision, target: model.id, fieldId: "apiToken" }), /CREDENTIAL_DRAFT_EXPIRED/);
    await assert.rejects(f.framework.decide(f.session.id, view.id, apply(view)));
    assert.deepEqual(f.store.listPermissionGrants(), []);
  } finally { clearTimeout(keepAlive); }
});

test("normal store close releases shared configuration wait without accessing the closed database", async context => {
  const f = await fixture(context), view = await f.propose(), waiting = f.arm(view);
  const stopGeneration = f.store.notifications.generation(f.session.id);
  const rejected = assert.rejects(waiting.promise, /Configuration wait was closed/);
  f.store.close(); await rejected;
  assert.equal(f.store.executionBlocks.configurationWait({ sessionId: f.session.id, runId: f.run.id,
    requestId: view.id, stopGeneration }), undefined);
});

test("a committed configuration decision does not time out while its activation is still completing", { timeout: 10_000 }, async context => {
  const f = await fixture(context), view = await f.propose();
  // Advance the real waiter timer only after domain acceptance reaches activation.
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const record = f.framework.service.getRecord(f.session.id, view.id);
  record.view.expiresAt = new Date(Date.now() + 200).toISOString(); record.view.stateVersion++;
  f.framework.repository.save(record, record.view.stateVersion - 1);
  let enter!: () => void, release!: () => void, resolved = false;
  const entered = new Promise<void>(done => { enter = done; }), gate = new Promise<void>(done => { release = done; });
  let expiryObserved = () => {}, expiryCalls = 0;
  const expired = new Promise<void>(done => { expiryObserved = done; });
  const register = f.store.executionBlocks.waitForConfiguration.bind(f.store.executionBlocks);
  f.store.executionBlocks.waitForConfiguration = (binding, signal) => register({ ...binding, onExpire: async () => {
    assert.ok(binding.onExpire);
    const result = await binding.onExpire();
    assert.equal(result, undefined, "An accepted decision still waits for activation after proposal expiry");
    expiryCalls++; expiryObserved(); return result;
  } }, signal);
  const waiting = f.arm(view, async (_source, receipt) => {
    enter(); await gate;
    assert.ok(receipt.result.resourceRevision);
    return { requestId: view.id, revision: receipt.revision, receiptId: receipt.id, runId: f.run.id,
      effectiveRevision: receipt.result.resourceRevision, toolCatalogFingerprint: "approved-tools", activatedAt: new Date().toISOString() };
  });
  void waiting.promise.then(() => { resolved = true; }, () => { resolved = true; });
  const decision = f.framework.decide(f.session.id, view.id, apply(view));
  try {
    await entered; context.mock.timers.tick(200); await expired;
    assert.equal(expiryCalls, 1);
    assert.equal(resolved, false, "An accepted decision must not return a pending activation merely because its proposal deadline passed");
    assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), f.run.id);
  } finally { release(); await decision; await waiting.promise; }
  assert.equal(f.framework.service.get(f.session.id, view.id).activation.state, "active");
});

test("abort followed immediately by store close releases the wait without closed-database cleanup", async context => {
  const f = await fixture(context), view = await f.propose(), waiting = f.arm(view);
  const rejected = assert.rejects(waiting.promise, /Configuration wait was (?:closed|cancelled)/);
  waiting.controller.abort(); f.store.close();
  await rejected;
});

test("late activation evidence after an aborted shared wait cannot mark configuration active", { timeout: 10_000 }, async context => {
  const f = await fixture(context), view = await f.propose();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(done => { enter = done; }), gate = new Promise<void>(done => { release = done; });
  const waiting = f.arm(view, async (_source, receipt) => {
    enter(); await gate;
    assert.ok(receipt.result.resourceRevision);
    return { requestId: view.id, revision: receipt.revision, receiptId: receipt.id, runId: f.run.id,
      effectiveRevision: receipt.result.resourceRevision, toolCatalogFingerprint: "late-tools", activatedAt: new Date().toISOString() };
  });
  const rejected = assert.rejects(waiting.promise, /cancelled/);
  const decision = f.framework.decide(f.session.id, view.id, apply(view));
  await entered; waiting.controller.abort(); await rejected;
  release(); await decision;
  assert.equal(f.framework.service.get(f.session.id, view.id).activation.state, "suppressed");
  assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), undefined);
  assert.deepEqual(f.store.listPermissionGrants(), []);
});

for (const reason of ["Stop", "new generation"] as const) {
  test(`an expired proposal's completed activation cannot strand or continue its waiter after ${reason} at resume`, { timeout: 10_000 }, async context => {
    const f = await fixture(context), view = await f.propose();
    // Setup and acceptance must not race the wall clock on a busy worker.
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const record = f.framework.service.getRecord(f.session.id, view.id);
    record.view.expiresAt = new Date(Date.now() + 1000).toISOString(); record.view.stateVersion++;
    f.framework.repository.save(record, record.view.stateVersion - 1);
    const owner = { sessionId: f.session.id, requestId: view.id, runId: f.run.id, stopGeneration: record.stopGeneration };
    let entered = () => {}, release = () => {}, expiryObserved = () => {}, expiryCalls = 0, stopInjected = 0;
    const activationEntered = new Promise<void>(done => { entered = done; });
    const activationGate = new Promise<void>(done => { release = done; });
    const expired = new Promise<void>(done => { expiryObserved = done; });
    const register = f.store.executionBlocks.waitForConfiguration.bind(f.store.executionBlocks);
    f.store.executionBlocks.waitForConfiguration = (binding, signal) => register({ ...binding, onExpire: async () => {
      assert.ok(binding.onExpire);
      const result = await binding.onExpire();
      assert.equal(result, undefined, "Expiry of an accepted decision leaves its activation waiting");
      expiryCalls++; expiryObserved(); return result;
    } }, signal);
    const waiting = f.framework.waitForDecision(f.session.id, view.id, undefined, async (_source, receipt) => {
      entered(); await activationGate; assert.ok(receipt.result.resourceRevision);
      return { requestId: view.id, revision: receipt.revision, receiptId: receipt.id, runId: f.run.id,
        effectiveRevision: receipt.result.resourceRevision, toolCatalogFingerprint: "approved-tools", activatedAt: new Date().toISOString() };
    });
    let outcome: "pending" | "returned" | "rejected" = "pending";
    const observed = waiting.then(value => { outcome = "returned"; return { value }; }, error => { outcome = "rejected"; return { error }; });
    context.after(async () => { release(); f.store.executionBlocks.close(); await observed; });
    const getRun = f.store.getSessionRun.bind(f.store);
    f.store.getSessionRun = async (...args) => {
      const run = await getRun(...args);
      const current = f.framework.service.get(f.session.id, view.id);
      if (!stopInjected && current.activation.state === "active" && current.resumption.state === "pending") {
        stopInjected++; f.store.notifications.stop(f.session.id);
        if (reason === "new generation") f.store.notifications.resume(f.session.id);
      }
      return run;
    };
    const decision = f.framework.decide(f.session.id, view.id, apply(view));
    try {
      await activationEntered; context.mock.timers.tick(1000); await expired;
      assert.equal(expiryCalls, 1); assert.equal(outcome, "pending");
      release(); await decision; await f.framework.tick(); await new Promise<void>(done => { setImmediate(done); });
      assert.equal(stopInjected, 1);
      assert.equal(f.framework.service.get(f.session.id, view.id).resumption.state, "suppressed");
      assert.equal(f.store.executionBlocks.configurationWait(owner), undefined, "Suppressed resume releases its original shared binding");
      assert.equal(outcome, "rejected", "Stop/epoch change must not return a normal continue result even without an AbortSignal");
      const result = await observed; assert.ok("error" in result); assert.match(String(result.error), /cancelled/);
      assert.ok(f.store.getSessionSettings(f.session.id).effective.enabledConnectorIds.includes("pubmed"), "An already saved setting is not rolled back");
      assert.deepEqual(f.store.listPermissionGrants(), []);
    } finally { release(); }
  });
}
