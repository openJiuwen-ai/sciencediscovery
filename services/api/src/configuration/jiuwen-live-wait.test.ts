// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { createConfigurationAgentTools } from "./agent-tools.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const root = resolve(tmpdir(), `jiuwen-configuration-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const project = await store.createProject("Jiuwen configuration");
  const session = await store.createSession(project.id, "Original task", {}, {}, { allowUnconfiguredModel: true });
  await store.replaceSessionSettings(session.id, { enabledConnectorIds: [] });
  const run = await store.createSessionRun({ sessionId: session.id, prompt: "Original research", settingsSnapshot: store.resolveRuntimeSettings(session.id).effective });
  await store.updateSessionRun(session.id, run.id, { status: "running" });
  const framework = configurationFramework(store, { nativeExecutor: false, jiuwenLiveWait: true,
    connector: () => ({ name: "PubMed", ready: true }),
    resume: async () => { throw new Error("Must never enqueue Native or another task"); } });
  return { store, session, run, framework };
}
async function proposal(f: Awaited<ReturnType<typeof fixture>>) {
  return f.framework.propose(f.session.id, { protocolVersion: 3, runId: f.run.id, capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
}
function apply(view: ConfigurationRequestView) {
  return { revision: view.revision, previewDigest: view.previewDigest!, selectedOptionId: view.selectedOptionId, decision: "apply" as const };
}

test("Jiuwen live configuration applies once, activates the actual host, and releases only the original tool", async context => {
  const f = await fixture(context); const view = await proposal(f); let activated = 0;
  const waiting = f.framework.waitForDecision(f.session.id, view.id, undefined, async (record, receipt) => {
    activated++;
    assert.equal(record.view.runId, f.run.id);
    assert.ok(receipt.result.resourceRevision);
    return { requestId: view.id, revision: receipt.revision, receiptId: receipt.id, runId: f.run.id,
      effectiveRevision: receipt.result.resourceRevision, toolCatalogFingerprint: "actual-host-fingerprint", activatedAt: new Date().toISOString() };
  });
  assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), f.run.id);
  const decisions = await Promise.all([f.framework.decide(f.session.id, view.id, apply(view)), f.framework.decide(f.session.id, view.id, apply(view))]);
  assert.ok(decisions.every(item => item.state === "applied"));
  assert.equal((await waiting).activation.state, "active"); assert.equal(activated, 1);
  assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), undefined);
  assert.equal((await f.store.listSessionRuns(f.session.id)).length, 1);
  assert.equal((await f.store.getSessionRun(f.session.id, f.run.id))!.status, "running");
  assert.ok(f.store.getSessionSettings(f.session.id).effective.enabledConnectorIds.includes("pubmed"));
  assert.equal(f.store.listPermissionGrants().length, 0, "Configuration consent is not execution permission");
});

test("Jiuwen refusal returns to original task without configuration or permission grants and cannot re-propose the same need", async context => {
  const f = await fixture(context); const view = await proposal(f);
  const waiting = f.framework.waitForDecision(f.session.id, view.id);
  const preview = await f.framework.preview(f.session.id, view.id, { expectedRevision: view.revision, values: {}, selectedOptionId: "dismiss" });
  await f.framework.decide(f.session.id, view.id, { ...apply(preview), decision: "dismiss" });
  assert.equal((await waiting).state, "dismissed");
  assert.deepEqual(f.store.getSessionSettings(f.session.id).effective.enabledConnectorIds, []);
  assert.equal(f.store.listPermissionGrants().length, 0);
  await assert.rejects(proposal(f), { code: "CONFIGURATION_NEED_ALREADY_DECIDED" });
});

for (const kind of ["connector", "model"] as const) {
  test(`Jiuwen can refuse a deleted ${kind} without applying or starting another task`, async context => {
    const f = await fixture(context);
    let capabilityId: "connector.enable" | "model.select", values: Record<string, string>, removeTarget: () => Promise<void>;
    if (kind === "connector") {
      const connectorId = "custom-0123456789ab";
      f.store.setCustomConnectorIds([connectorId]);
      capabilityId = "connector.enable"; values = { connectorId };
      removeTarget = async () => { f.store.setCustomConnectorIds([]); };
    } else {
      await f.store.createModel({ name: "Current", model: "current", baseUrl: "https://example.test/v1", apiToken: "fixture-current" });
      const target = await f.store.createModel({ name: "Deleted", model: "deleted", baseUrl: "https://example.test/v1", apiToken: "fixture-deleted" });
      capabilityId = "model.select"; values = { modelId: target.id };
      removeTarget = () => f.store.deleteModel(target.id);
    }
    const view = await f.framework.propose(f.session.id, { protocolVersion: 3, runId: f.run.id, capabilityId, values });
    const controller = new AbortController();
    const waiting = f.framework.waitForDecision(f.session.id, view.id, controller.signal);
    // Cleanup must also release the waiter if an assertion fails before dismissal.
    const settled = waiting.catch(() => undefined);
    context.after(async () => { controller.abort(); await settled; });
    await removeTarget();
    const settings = f.store.getSessionSettings(f.session.id);
    await assert.rejects(f.framework.decide(f.session.id, view.id, apply(view)), { code: "RESOURCE_VERSION_CONFLICT" });
    const current = f.framework.service.get(f.session.id, view.id);
    const dismissed = await f.framework.preview(f.session.id, view.id, { expectedRevision: current.revision, values: {}, selectedOptionId: "dismiss" });
    assert.deepEqual(dismissed.fields, []); assert.deepEqual(dismissed.changes, []);
    assert.equal(dismissed.verificationPlan.maxRequests, 0);
    await f.framework.decide(f.session.id, view.id, { ...apply(dismissed), decision: "dismiss" });
    assert.equal((await waiting).state, "dismissed");
    assert.deepEqual(f.store.getSessionSettings(f.session.id), settings);
    assert.equal(f.store.listPermissionGrants().length, 0);
    assert.equal((await f.store.listSessionRuns(f.session.id)).length, 1);
    assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), undefined);
  });
}

test("Jiuwen disconnected/aborted tool releases live binding and fences a late apply", async context => {
  const f = await fixture(context); const view = await proposal(f); const controller = new AbortController();
  const waiting = f.framework.waitForDecision(f.session.id, view.id, controller.signal);
  const rejected = assert.rejects(waiting, /cancelled/); controller.abort(); await rejected;
  assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), undefined);
  await assert.rejects(f.framework.decide(f.session.id, view.id, apply(view)));
  assert.equal(f.framework.service.get(f.session.id, view.id).state, "cancelled");
  assert.deepEqual(f.store.getSessionSettings(f.session.id).effective.enabledConnectorIds, []);
});

test("Jiuwen next-run settings are saved while the current run stays frozen; tool output excludes credentials", async context => {
  const f = await fixture(context);
  await f.store.createModel({ name: "Current model", model: "current-fixture", baseUrl: "https://example.test/v1", apiToken: "OTHER-PRIVATE-KEY" });
  const model = await f.store.createModel({ name: "Future model", model: "fixture", baseUrl: "https://example.test/v1", apiToken: "NEVER-IN-TOOL-RESULT" });
  let waits = 0, announced = 0;
  const tool = createConfigurationAgentTools({ store: f.store, sessionId: f.session.id, runId: f.run.id,
    beginExternalWait: () => { waits++; return () => { waits--; }; },
    onWaitReady: async () => {
      const card = f.framework.service.list(f.session.id)[0]!;
      assert.equal(f.framework.liveWaitRunId(f.session.id, card.id), f.run.id); announced++;
    } })[0]!;
  const result = tool.execute("configuration-call", { action: "propose", capabilityId: "model.select", values: { modelId: model.id } } as never);
  let view: ConfigurationRequestView | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    view = f.framework.service.list(f.session.id)[0];
    if (view && f.framework.liveWaitRunId(f.session.id, view.id)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(view); assert.equal(waits, 1); assert.equal(announced, 1); assert.equal(view.activation.mode, "next_run");
  await f.framework.decide(f.session.id, view.id, apply(view));
  const output = JSON.stringify(await result);
  assert.ok(!output.includes("NEVER-IN-TOOL-RESULT")); assert.match(output, /next_run/);
  assert.equal(waits, 0); assert.equal((await f.store.listSessionRuns(f.session.id)).length, 1);
  assert.deepEqual((await f.store.getSessionRun(f.session.id, f.run.id))!.settingsSnapshot, f.run.settingsSnapshot);
});

test("Jiuwen activation preserves actual mounted sources when frozen settings include unavailable sources", async context => {
  const f = await fixture(context);
  const { recordNativeRunChoiceContext, nativeRuntimeConnectorIds } = await import("./native-choices.js");
  const { activateJiuwenConnector } = await import("./jiuwen-activation.js");
  await f.store.updateSessionRun(f.session.id, f.run.id, { settingsSnapshot: { ...f.run.settingsSnapshot, enabledConnectorIds: ["arxiv", "web"] } });
  recordNativeRunChoiceContext({ store: f.store, sessionId: f.session.id, runId: f.run.id,
    enabledConnectorIds: [], webSearchAvailable: false, toolCatalogFingerprint: "empty-runtime" });
  const view = await proposal(f); let invoked = 0;
  const waiting = f.framework.waitForDecision(f.session.id, view.id, undefined, async (record, receipt) =>
    activateJiuwenConnector({ store: f.store, sessionId: f.session.id, runId: f.run.id, record, receipt,
      initialTools: [], activatedTools: new Map(), activateSource: sourceId => {
        invoked++; assert.equal(sourceId, "pubmed");
        return [{ name: "mcp__pubmed__search", sourceId, toolId: "search", description: "Fixture", displayName: "Search", routing: { mode: "prefer", keywords: [], priority: 1 }, inputSchema: {} }];
      } }));
  const decision = await f.framework.decide(f.session.id, view.id, apply(view));
  assert.equal(decision.activation.state, "active", JSON.stringify(decision)); assert.equal((await waiting).resumption.state, "started");
  assert.deepEqual(nativeRuntimeConnectorIds(f.store, f.session.id, f.run.id), ["pubmed"]);
  assert.equal(invoked, 1);
});

test("Jiuwen expiry and Stop release the pending tool without applying configuration", async context => {
  for (const reason of ["expired", "stopped"] as const) {
    const f = await fixture(context); const view = await proposal(f);
    const waiting = f.framework.waitForDecision(f.session.id, view.id);
    const cancelled = reason === "stopped" ? assert.rejects(waiting, /cancelled/) : undefined;
    if (reason === "stopped") f.store.notifications.stop(f.session.id);
    else {
      const record = f.framework.service.getRecord(f.session.id, view.id);
      record.view.expiresAt = "2000-01-01T00:00:00.000Z"; record.view.stateVersion++;
      f.framework.repository.save(record, record.view.stateVersion - 1);
    }
    // Production's existing configuration scheduler observes lifecycle changes;
    // changing a stored expiry does not reschedule the original absolute timer.
    await f.framework.tick();
    if (cancelled) await cancelled;
    else assert.equal((await waiting).state, "expired");
    assert.equal(f.framework.service.get(f.session.id, view.id).state, reason === "expired" ? "expired" : "cancelled");
    await assert.rejects(f.framework.decide(f.session.id, view.id, apply(view)));
    assert.deepEqual(f.store.getSessionSettings(f.session.id).effective.enabledConnectorIds, []);
    assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), undefined);
  }
});

test("Jiuwen activation failure releases the original tool with inactive receipt and never retries after return", async context => {
  const f = await fixture(context); const view = await proposal(f); let attempts = 0;
  const waiting = f.framework.waitForDecision(f.session.id, view.id, undefined, async () => {
    attempts++; throw new Error("No available executable tool descriptors");
  });
  await f.framework.decide(f.session.id, view.id, apply(view));
  const result = await waiting;
  assert.equal(result.state, "applied"); assert.equal(result.activation.state, "failed");
  assert.equal(result.error?.retryable, false); assert.ok(!result.allowedActions.includes("continue"));
  await f.framework.tick(); await f.framework.settle(f.session.id, view.id);
  assert.equal(attempts, 1); assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), undefined);
  assert.equal((await f.store.listSessionRuns(f.session.id)).length, 1);
});

test("Jiuwen HTTP live-wait hint survives preview and disappears after cancellation; it is not stored authority", async context => {
  const f = await fixture(context); const view = await proposal(f);
  const { createServer } = await import("node:http");
  const { handleConfigurationHttp } = await import("./http.js");
  const server = createServer((request, response) => {
    void handleConfigurationHttp({ request, response, url: new URL(request.url!, "http://localhost"),
      store: f.store, framework: f.framework, hasActiveRun: async () => false });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessions/${f.session.id}/configuration-requests`;
  const controller = new AbortController();
  const waiting = f.framework.waitForDecision(f.session.id, view.id, controller.signal);
  const rejected = assert.rejects(waiting, /cancelled/);
  try {
    const listed = await (await fetch(base)).json() as { items: ConfigurationRequestView[] };
    assert.equal(listed.items[0]!.liveWait, true);
    const preview = await (await fetch(`${base}/${view.id}/preview`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: view.revision, values: { connectorId: "pubmed" }, selectedOptionId: "persist" }) })).json() as ConfigurationRequestView;
    assert.equal(preview.liveWait, true);
    assert.equal(f.framework.service.getRecord(f.session.id, view.id).view.liveWait, undefined);
    f.store.notifications.stop(f.session.id);
    assert.equal(f.framework.liveWaitRunId(f.session.id, view.id), undefined, "Stop fences the hint even before transport abort");
    controller.abort(); await rejected;
    const cancelled = await (await fetch(`${base}/${view.id}`)).json() as ConfigurationRequestView;
    assert.equal(cancelled.liveWait, false); assert.equal(cancelled.state, "cancelled");
  } finally {
    controller.abort(); await rejected;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
