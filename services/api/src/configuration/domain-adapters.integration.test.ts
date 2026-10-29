// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { ConversationalConfigurationFramework } from "./framework.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

type Context = { after(action: () => Promise<void>): void };
async function harness(context: Context) {
  const parent = resolve(process.cwd(), ".tmp");
  const root = resolve(parent, `configuration-domain-${randomUUID()}`);
  const stores: SessionStore[] = [];
  context.after(async () => {
    for (const store of stores) store.close();
    assert.ok(root.startsWith(`${parent}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const store = new SessionStore(root); stores.push(store); await store.load();
  const project = await store.createProject("Configuration adapter integration");
  const session = await store.createSession(project.id, "Target", {}, {}, { allowUnconfiguredModel: true });
  const other = await store.createSession(project.id, "Other", {}, {}, { allowUnconfiguredModel: true });
  const framework = new ConversationalConfigurationFramework(store, { nativeExecutor: true,
    connector: (_sessionId, id) => ["pubmed", "uniprot"].includes(id) ? { name: id, ready: true } : undefined });
  return { root, store, project, session, other, framework, async reopen() { const reopened = new SessionStore(root); stores.push(reopened); await reopened.load(); return reopened; } };
}
async function approve(framework: ConversationalConfigurationFramework, view: ConfigurationRequestView) {
  if (view.endpointAuthorization?.status === "required") await framework.confirmEndpoint(view.sessionId, view.id, { revision: view.revision, endpointTarget: view.endpointAuthorization.endpointTarget });
  return framework.decide(view.sessionId, view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply" });
}
async function secure(framework: ConversationalConfigurationFramework, view: ConfigurationRequestView, values: ConfigurationValues, secret: string) {
  if (view.endpointAuthorization?.status === "required") await framework.confirmEndpoint(view.sessionId, view.id, { revision: view.revision, endpointTarget: view.endpointAuthorization.endpointTarget });
  const draft = await framework.provideCredential(view.sessionId, view.id, { expectedRevision: view.revision, fieldId: "apiToken", secret }, `credential-${view.id}`);
  return framework.preview(view.sessionId, view.id, { expectedRevision: view.revision, values, credentialHandle: draft.handle });
}
async function provider<T>(handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void, run: (origin: string) => Promise<T>): Promise<T> {
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk.toString();
    handler(request, response, JSON.parse(raw || "{}") as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try { return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function completion(response: ServerResponse) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] })); }

test("CFG-R02: connection preview normalization identifies invalid baseUrl without echoing it", async context => {
  const h = await harness(context);
  for (const baseUrl of ["not a URL", "file:///private", "https://user:synthetic-secret@example.test/v1", "https://example.test/v1?key=synthetic-secret", "https://example.test/v1#synthetic-secret"]) {
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.connect", values: {} });
    await assert.rejects(h.framework.preview(h.session.id, proposal.id, {
      expectedRevision: proposal.revision, values: { name: "Invalid endpoint", model: "fixture", baseUrl },
    }), error => {
      assert.equal((error as { code: string }).code, "INVALID_CONFIGURATION_URL");
      assert.equal((error as { status: number }).status, 400);
      assert.equal((error as { field: string }).field, "baseUrl");
      assert.doesNotMatch((error as Error).message, /synthetic-secret|file:\/\/\/private|user:/);
      return true;
    });
  }
  assert.equal(h.store.listModels().length, 0);
});

test("CFG-R02: unconfirmed custom destinations cannot receive credentials or even token-optional probes", async context => {
  const h = await harness(context); let calls = 0;
  await provider((_request, response) => { calls++; completion(response); }, async origin => {
    const values = { name: "User gateway", model: "gateway", baseUrl: origin, tokenOptional: true };
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.connect", values });
    assert.equal(proposal.endpointAuthorization?.classification, "loopback");
    assert.equal(proposal.endpointAuthorization?.status, "required");
    await assert.rejects(h.framework.provideCredential(h.session.id, proposal.id, { expectedRevision: proposal.revision, fieldId: "apiToken", secret: "never-send-me" }), { code: "ENDPOINT_CONSENT_REQUIRED" });
    const rejected = await h.framework.decide(h.session.id, proposal.id, { revision: proposal.revision, previewDigest: proposal.previewDigest!, decision: "apply" });
    assert.notEqual(rejected.state, "applied"); assert.equal(calls, 0);
    assert.equal(h.store.listModels().length, 0);
    const refreshed = await h.framework.preview(h.session.id, proposal.id, { expectedRevision: rejected.revision, values });
    await assert.rejects(h.framework.confirmEndpoint(h.session.id, proposal.id, { revision: refreshed.revision - 1, endpointTarget: refreshed.endpointAuthorization!.endpointTarget }), { code: "STALE_ENDPOINT_CONSENT" });
    await h.framework.confirmEndpoint(h.session.id, proposal.id, { revision: refreshed.revision, endpointTarget: refreshed.endpointAuthorization!.endpointTarget });
    const accepted = await h.framework.decide(h.session.id, proposal.id, { revision: refreshed.revision, previewDigest: refreshed.previewDigest!, decision: "apply" });
    assert.equal(accepted.state, "applied"); assert.equal(calls, 1);
    assert.throws(() => h.framework.service.registry.agentValues("model.connect", { ...values, endpointConsent: true }));
  });
});

test("CFG-R02: destination consent survives same-target revision, but target edits require a new independent confirmation", async context => {
  const h = await harness(context); let calls = 0;
  await provider((request, response) => { calls++; assert.equal(request.headers.authorization, "Bearer approved-key"); completion(response); }, async origin => {
    const values = { name: "Gateway", model: "gateway", baseUrl: origin };
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.connect", values });
    await h.framework.confirmEndpoint(h.session.id, proposal.id, { revision: proposal.revision, endpointTarget: proposal.endpointAuthorization!.endpointTarget });
    const ready = await secure(h.framework, proposal, values, "approved-key");
    assert.equal(ready.endpointAuthorization?.status, "confirmed");
    const changed = await h.framework.preview(h.session.id, proposal.id, { expectedRevision: ready.revision, values: { ...values, baseUrl: `${origin}/other` } });
    assert.equal(changed.endpointAuthorization?.status, "required");
    await assert.rejects(h.framework.confirmEndpoint(h.session.id, proposal.id, { revision: changed.revision, endpointTarget: proposal.endpointAuthorization!.endpointTarget }), { code: "STALE_ENDPOINT_CONSENT" });
    await assert.rejects(h.framework.provideCredential(h.session.id, proposal.id, { expectedRevision: changed.revision, fieldId: "apiToken", secret: "never-send-to-new-target" }), { code: "ENDPOINT_CONSENT_REQUIRED" });
    assert.equal(calls, 0);
    const original = await h.framework.preview(h.session.id, proposal.id, { expectedRevision: changed.revision, values });
    const final = await secure(h.framework, original, values, "approved-key");
    assert.equal((await approve(h.framework, final)).state, "applied"); assert.equal(calls, 1);
  });
});

test("CFG-R02: public plaintext HTTP refuses keys and cannot be made trusted by an Agent-supplied provider name", async context => {
  const h = await harness(context);
  const incomplete = await h.framework.propose(h.session.id, { capabilityId: "model.connect", values: {} });
  await assert.rejects(h.framework.provideCredential(h.session.id, incomplete.id, { expectedRevision: incomplete.revision, fieldId: "apiToken", secret: "no-host-yet" }), { code: "ENDPOINT_CONSENT_REQUIRED" });
  await h.framework.decide(h.session.id, incomplete.id, { revision: incomplete.revision, previewDigest: incomplete.previewDigest!, decision: "dismiss" });
  const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.connect", values: { name: "OpenAI", baseUrl: "http://api.openai.com/v1", model: "custom" } });
  assert.equal(proposal.endpointAuthorization?.classification, "public_http"); assert.equal(proposal.endpointAuthorization?.status, "blocked");
  await assert.rejects(h.framework.confirmEndpoint(h.session.id, proposal.id, { revision: proposal.revision, endpointTarget: proposal.endpointAuthorization!.endpointTarget }), { code: "ENDPOINT_CREDENTIAL_INSECURE" });
  await assert.rejects(h.framework.provideCredential(h.session.id, proposal.id, { expectedRevision: proposal.revision, fieldId: "apiToken", secret: "not-on-cleartext" }), { code: "ENDPOINT_CREDENTIAL_INSECURE" });
  assert.equal(h.store.listProviders().length, 0);
});

test("CFG-R03: reversing an enable operation removes an offline connector without requiring readiness", async context => {
  const h = await harness(context);
  const enabled = await h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
  assert.equal((await approve(h.framework, enabled)).state, "applied");
  h.framework.options.connector = () => undefined;
  const inverse = await h.framework.service.reversal(h.session.id, enabled.id);
  assert.equal((await approve(h.framework, inverse)).state, "applied");
  assert.equal(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds.includes("pubmed"), false);
  assert.equal(Object.hasOwn(h.store.getSessionSettings(h.session.id).overrides, "enabledConnectorIds"), false);
});

test("CFG-R03: a long legitimate connector override is restored without JSON field or diff limits", async context => {
  const h = await harness(context);
  const previous = Array.from({ length: 120 }, (_, index) => `custom-${index.toString(16).padStart(12, "0")}`);
  h.store.setCustomConnectorIds(previous);
  await h.store.replaceSessionSettings(h.session.id, { enabledConnectorIds: previous });
  const enable = await h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
  assert.equal((await approve(h.framework, enable)).state, "applied");
  h.framework.options.connector = () => undefined;
  const inverse = await h.framework.service.reversal(h.session.id, enable.id);
  assert.ok(String(h.framework.service.getRecord(h.session.id, inverse.id).input.restoreConnectorIds).length > 2048);
  assert.equal((await approve(h.framework, inverse)).state, "applied");
  assert.deepEqual(h.store.getSessionSettings(h.session.id).overrides.enabledConnectorIds, previous);
});

test("CFG-R03: a removed installed source can be reversed without reintroducing it or requiring readiness", async context => {
  const h = await harness(context); const id = "custom-000000000abc";
  h.store.setCustomConnectorIds([id]); h.framework.options.connector = (_session, target) => target === id ? { name: "Custom source", ready: true } : undefined;
  const enable = await h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: id } });
  assert.equal((await approve(h.framework, enable)).state, "applied");
  h.store.setCustomConnectorIds([]); h.framework.options.connector = () => undefined;
  const inverse = await h.framework.service.reversal(h.session.id, enable.id);
  assert.equal((await approve(h.framework, inverse)).state, "applied");
  assert.equal(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds.includes(id), false);
});

test("CFG-R11: an actively leased credential stays busy rather than becoming expired", async context => {
  const h = await harness(context); let calls = 0;
  await provider((_request, response) => { calls++; completion(response); }, async origin => {
    const model = await h.store.createModel({ name: "Leased", model: "leased", baseUrl: origin, apiToken: "formal-original" });
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.repair_credential", values: { modelId: model.id } });
    const ready = await secure(h.framework, proposal, { modelId: model.id }, "busy-candidate");
    const handle = h.framework.service.getRecord(h.session.id, ready.id).credentialHandle!;
    h.store.getConfigurationDatabase().prepare("UPDATE configuration_credential_drafts SET lease_until=? WHERE handle=?").run(Date.now() + 20_000, handle);
    const busy = await approve(h.framework, ready);
    assert.equal(busy.state, "needs_fix"); assert.equal(busy.error?.code, "CREDENTIAL_DRAFT_BUSY");
    assert.equal(h.framework.service.getRecord(h.session.id, ready.id).credentialHandle, handle);
    assert.equal(h.store.getModelApiToken(model.id), "formal-original"); assert.equal(calls, 0);
  });
});

test("CFG-R11: adding a model reuses a legitimate endpoint provider without replacing its shared credential", async context => {
  const h = await harness(context); let calls = 0;
  await provider((request, response) => { calls++; assert.equal(request.headers.authorization, "Bearer new-model-key"); completion(response); }, async origin => {
    const existing = await h.store.createProvider({ name: "Existing provider", baseUrl: origin, apiProtocol: "openai-chat-completions", apiVariant: "openai", apiToken: "shared-original" });
    const old = await h.store.materializeProviderModel(existing.id, "existing-model");
    const values = { name: "Another display name", baseUrl: origin, model: "new-model", apiProtocol: "openai-chat-completions", apiVariant: "openai" };
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.connect", values });
    const ready = await secure(h.framework, proposal, values, "new-model-key");
    assert.equal((await approve(h.framework, ready)).state, "applied");
    assert.equal(h.store.listProviders().length, 1); assert.equal(h.store.getProviderApiToken(existing.id), "shared-original");
    assert.equal(h.store.getModelApiToken(old.id), "shared-original");
    const added = h.store.listModels().find(model => model.model === "new-model")!;
    assert.equal(added.providerId, existing.id); assert.equal(h.store.getModelApiToken(added.id), "new-model-key");
  });
  assert.equal(calls, 1);
});

test("CFG-R02: a repair target changed after approval cannot send the candidate to either destination", async context => {
  const h = await harness(context); let calls = 0;
  await provider((_request, response) => { calls++; completion(response); }, async original => {
    await provider((_request, response) => { calls++; completion(response); }, async changed => {
      const model = await h.store.createModel({ name: "Mutable endpoint", model: "mutable", baseUrl: original, apiToken: "formal-original" });
      const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.repair_credential", values: { modelId: model.id } });
      const ready = await secure(h.framework, proposal, { modelId: model.id }, "candidate-not-sent");
      const adapter = h.framework.service.registry.get("model.repair_credential"); const verify = adapter.verify!;
      adapter.verify = async context => { await h.store.updateModel(model.id, { name: model.name, model: model.model, baseUrl: changed }); return verify(context); };
      const result = await approve(h.framework, ready);
      assert.notEqual(result.state, "applied"); assert.equal(calls, 0);
      assert.equal(h.store.getModelApiToken(model.id), "formal-original"); assert.equal(h.framework.repository.getReceipt(ready.id), undefined);
    });
  });
});

test("CFG-T32: a dismissed need ignores unrelated edits, permits relevant re-evaluation and cannot resurrect a terminal task", async context => {
  const h = await harness(context);
  const run = await h.store.createSessionRun({ sessionId: h.session.id, prompt: "Find PubMed literature", settingsSnapshot: h.store.resolveRuntimeSettings(h.session.id).effective });
  await h.store.updateSessionRun(h.session.id, run.id, { status: "running" });
  const proposal = { protocolVersion: 3 as const, capabilityId: "connector.enable" as const, values: { connectorId: "pubmed" }, runId: run.id };
  const initial = await h.framework.propose(h.session.id, proposal);
  const dismissal = await h.framework.preview(h.session.id, initial.id, { expectedRevision: initial.revision, values: { connectorId: "pubmed" }, selectedOptionId: "dismiss" });
  await h.framework.decide(h.session.id, dismissal.id, { revision: dismissal.revision, previewDigest: dismissal.previewDigest!, selectedOptionId: "dismiss", decision: "dismiss" });
  await assert.rejects(h.framework.propose(h.session.id, proposal), { code: "CONFIGURATION_NEED_ALREADY_DECIDED" });
  await h.store.replaceSessionSettings(h.session.id, { thinkingMode: "enabled" });
  await assert.rejects(h.framework.propose(h.session.id, proposal), { code: "CONFIGURATION_NEED_ALREADY_DECIDED" });
  h.store.setConfigurationConnectorRevisionSource(() => "a-new-relevant-connector-catalog");
  const reEvaluated = await h.framework.propose(h.session.id, proposal);
  assert.notEqual(reEvaluated.id, initial.id); assert.notEqual(reEvaluated.needKey, initial.needKey);
  assert.equal(reEvaluated.state, "awaiting_confirmation");
  await h.store.updateSessionRun(h.session.id, run.id, { status: "cancelled" });
  await assert.rejects(h.framework.propose(h.session.id, proposal), { code: "CONFIGURATION_TASK_UNAVAILABLE" });
});

test("CFG-T28/31: a saved generic companion cannot bypass failed activation through the legacy continuation entry", async context => {
  const h = await harness(context);
  h.framework.options.activate = async () => { throw new Error("The target tool factory is temporarily unavailable"); };
  const run = await h.store.createSessionRun({ sessionId: h.session.id, prompt: "Research using PubMed", settingsSnapshot: h.store.resolveRuntimeSettings(h.session.id).effective });
  const view = await h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "connector.enable", values: { connectorId: "pubmed" }, runId: run.id });
  await h.store.updateSessionRun(h.session.id, run.id, { status: "blocked", configurationWait: true, configurationCheckpoint: {
    requestId: view.id, history: [{ role: "user", content: run.prompt }], stopGeneration: h.store.notifications.generation(h.session.id), committedAt: new Date().toISOString(),
  } });
  const saved = await h.framework.decide(h.session.id, view.id, { revision: view.revision, previewDigest: view.previewDigest!, selectedOptionId: view.selectedOptionId, decision: "apply" });
  assert.equal(saved.state, "applied"); assert.equal(saved.activation.state, "failed");
  assert.equal(h.store.getConnectorConfigurationRequest(h.session.id, view.id), undefined, "New requests use only the generic decision record");
  assert.equal(await h.store.ensureConnectorContinuationRun({ sessionId: h.session.id, requestId: view.id }), undefined);
  const stillPaused = await h.store.getSessionRun(h.session.id, run.id);
  assert.equal(stillPaused?.status, "blocked"); assert.equal(stillPaused?.configurationWait, true);
  assert.equal(stillPaused?.configurationResume, undefined);
  assert.deepEqual(stillPaused?.settingsSnapshot, run.settingsSnapshot);
});

test("CFG-T31: connector approval versions survive an unrelated legacy model-provider migration on reopen", async context => {
  const h = await harness(context);
  await h.store.createModel({ name: "Durable version fixture", model: "durable-fixture", baseUrl: "https://models.example.test/v1", apiToken: "fixture-token" });
  const before = h.store.configurationSnapshot(h.session.id, "connector.enable", "pubmed");
  const reopened = await h.reopen();
  const after = reopened.configurationSnapshot(h.session.id, "connector.enable", "pubmed");
  const oldModel = (before.data.models as Array<Record<string, unknown>>)[0]!;
  const migratedModel = (after.data.models as Array<Record<string, unknown>>)[0]!;
  assert.equal(oldModel.providerId, undefined); assert.equal(typeof migratedModel.providerId, "string", "Exercise the real startup migration");
  for (const field of ["id", "baseUrl", "model", "apiProtocol", "apiVariant", "hasApiToken"]) assert.equal(migratedModel[field], oldModel[field]);
  assert.equal(Object.hasOwn(before.resourceVersions, "models"), false);
  assert.deepEqual(after.resourceVersions, before.resourceVersions, "Equivalent settings must retain their approved versions across a crash");
});

async function dueAutomaticProposal(h: Awaited<ReturnType<typeof harness>>) {
  await h.store.updateSession(h.session.id, { autoApplyLowRiskConfiguration: true });
  const run = await h.store.createSessionRun({ sessionId: h.session.id, prompt: "Enable PubMed for this task", settingsSnapshot: h.store.resolveRuntimeSettings(h.session.id).effective });
  const view = await h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" }, runId: run.id });
  assert.ok(view.autoApplyAt, "the run-bound proposal must inherit its authorized cancellation window");
  await h.store.runConfigurationTransaction(h.session.id, () => {
    const record = h.framework.service.getRecord(h.session.id, view.id);
    const expected = record.view.stateVersion;
    record.view.autoApplyAt = new Date(Date.now() - 1).toISOString();
    record.view.stateVersion++;
    h.framework.repository.save(record, expected);
  });
  return h.framework.service.get(h.session.id, view.id);
}

test("CFG-R10: legacy due work is indexed and bounded, while deferred waits cannot starve later requests", async context => {
  const h = await harness(context);
  const view = await dueAutomaticProposal(h);
  const template = h.store.getConnectorConfigurationRequest(h.session.id, view.id)!;
  const database = h.store.getConfigurationDatabase();
  const dueAt = new Date(Date.now() - 60_000).toISOString(); const now = new Date().toISOString();
  const insert = database.prepare("INSERT INTO connector_configuration_requests(id,session_id,run_id,connector_id,state,record_json) VALUES(?,?,?,?,?,?)");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 2000; index++) {
      const record = { ...template, id: `history-${index}`, state: "applied" };
      insert.run(record.id, record.sessionId, record.runId, record.connectorId, record.state, JSON.stringify(record));
    }
    for (let index = 0; index < 125; index++) {
      const record = { ...template, id: `due-${String(index).padStart(3, "0")}`, autoApplyAt: dueAt };
      insert.run(record.id, record.sessionId, record.runId, record.connectorId, record.state, JSON.stringify(record));
    }
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
  const first = h.store.listDueConnectorConfigurationRequests(now, 500);
  assert.equal(first.length, 100); assert.ok(first.every(record => record.id.startsWith("due-")));
  const queryPlan = database.prepare("EXPLAIN QUERY PLAN SELECT record_json FROM connector_configuration_requests WHERE state='awaiting_confirmation' AND json_extract(record_json,'$.autoApplyAt') IS NOT NULL AND COALESCE(next_check_at,json_extract(record_json,'$.autoApplyAt'))<=? ORDER BY COALESCE(next_check_at,json_extract(record_json,'$.autoApplyAt')),id LIMIT 100").all(now);
  assert.match(JSON.stringify(queryPlan), /connector_configuration_requests_due/);
  for (const record of first) h.store.deferConnectorConfigurationAutoApply(record.id, new Date(Date.now() + 10_000).toISOString());
  const next = h.store.listDueConnectorConfigurationRequests(now, 100);
  assert.equal(next.length, 25); assert.ok(next.every(record => !first.some(previous => previous.id === record.id)));
  h.store.withdrawConnectorAutoApply(h.session.id, next[0]!.id);
  assert.equal(h.store.listDueConnectorConfigurationRequests(now, 100).length, 24);
});

function verificationGate(framework: ConversationalConfigurationFramework) {
  const adapter = framework.service.registry.get("connector.enable");
  const verify = adapter.verify!;
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  adapter.verify = async context => { entered(); await proceed; return verify(context); };
  return { started, release };
}

async function expireProposal(h: Awaited<ReturnType<typeof harness>>, id: string) {
  await h.store.runConfigurationTransaction(h.session.id, () => {
    const record = h.framework.service.getRecord(h.session.id, id); const version = record.view.stateVersion;
    record.view.expiresAt = new Date(Date.now() - 1).toISOString(); record.view.stateVersion++;
    h.framework.repository.save(record, version);
  });
}

test("CFG-T03/10: expiry and Stop are durable terminal facts and release independent proposal deduplication", async context => {
  const h = await harness(context);
  const old = await h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
  await expireProposal(h, old.id);
  await assert.rejects(approve(h.framework, old), { code: "CONFIGURATION_EXPIRED" });
  assert.equal(h.framework.service.get(h.session.id, old.id).state, "expired");
  assert.equal(h.framework.repository.getReceipt(old.id), undefined);
  const fresh = await h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
  assert.notEqual(fresh.id, old.id);
  h.store.notifications.stop(h.session.id);
  const afterStop = await h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
  assert.notEqual(afterStop.id, fresh.id);
  assert.equal(h.framework.service.get(h.session.id, fresh.id).state, "cancelled");
  assert.equal(h.framework.service.getRecord(h.session.id, afterStop.id).stopGeneration, h.store.notifications.generation(h.session.id));
  await assert.rejects(approve(h.framework, fresh), { code: "CONTINUATION_STOPPED" });
  const reopened = await h.reopen(); const restored = new ConversationalConfigurationFramework(reopened, { nativeExecutor: true, connector: () => ({ name: "PubMed", ready: true }) });
  assert.equal(restored.service.get(h.session.id, old.id).state, "expired");
  assert.equal(restored.service.get(h.session.id, fresh.id).state, "cancelled");
});

test("CFG-T03/12: an expired run-bound proposal preserves its paused checkpoint without applying, resuming or finishing", async context => {
  const h = await harness(context); let resumes = 0;
  h.framework.options.resume = async () => { resumes++; return undefined; };
  await h.store.updateSession(h.session.id, { autoApplyLowRiskConfiguration: true });
  const run = await h.store.createSessionRun({ sessionId: h.session.id, prompt: "Keep the original research task", settingsSnapshot: h.store.resolveRuntimeSettings(h.session.id).effective });
  const proposal = await h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" }, runId: run.id });
  const checkpoint = { requestId: proposal.id, history: [{ role: "user", content: run.prompt }], stopGeneration: h.store.notifications.generation(h.session.id), committedAt: new Date().toISOString() };
  await h.store.updateSessionRun(h.session.id, run.id, { status: "blocked", configurationWait: true, configurationCheckpoint: checkpoint });
  await expireProposal(h, proposal.id); await h.framework.tick();
  const expired = h.framework.service.get(h.session.id, proposal.id);
  assert.equal(expired.state, "expired"); assert.equal(expired.resumption.state, "needs_user_action"); assert.equal(expired.autoApplyAt, undefined);
  assert.match(expired.error?.message ?? "", /remains paused/);
  assert.equal(h.store.getConnectorConfigurationRequest(h.session.id, proposal.id)?.state, "stale");
  assert.equal(h.store.getConnectorConfigurationRequest(h.session.id, proposal.id)?.autoApplyAt, undefined);
  await assert.rejects(approve(h.framework, proposal), { code: "CONFIGURATION_EXPIRED" });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" }, runId: run.id }), { code: "CONFIGURATION_REPLAN_UNAVAILABLE" });
  const held = await h.store.getSessionRun(h.session.id, run.id);
  assert.equal(held?.status, "blocked"); assert.equal(held?.configurationWait, true); assert.equal(held?.finishedAt, undefined);
  assert.deepEqual(held?.configurationCheckpoint, checkpoint); assert.equal(resumes, 0);
  assert.equal(h.framework.repository.getReceipt(proposal.id), undefined);
  assert.equal((await h.store.listSessionRuns(h.session.id)).length, 1);
});

test("CFG-T03/06: expired or revoked implicit drafts become missing and allow the actual three-step credential refill", async context => {
  const h = await harness(context); let probes = 0;
  await provider((request, response) => { probes++; assert.equal(request.headers.authorization, "Bearer replacement-key"); completion(response); }, async origin => {
    const model = await h.store.createModel({ name: "Formal model", model: "formal", baseUrl: origin, apiToken: "formal-original" });
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.repair_credential", values: { modelId: model.id } });
    let ready = await secure(h.framework, proposal, { modelId: model.id }, "expired-candidate");
    const oldHandle = h.framework.service.getRecord(h.session.id, proposal.id).credentialHandle!;
    h.store.getConfigurationDatabase().prepare("UPDATE configuration_credential_drafts SET expires_at=? WHERE handle=?").run(Date.now() - 1, oldHandle);
    await assert.rejects(h.framework.preview(h.session.id, proposal.id, { expectedRevision: ready.revision, values: { modelId: model.id }, credentialHandle: oldHandle }), { code: "CREDENTIAL_DRAFT_EXPIRED" });
    assert.equal(h.framework.service.get(h.session.id, proposal.id).revision, ready.revision, "an explicit invalid handle cannot edit a revision");
    const missing = await h.framework.preview(h.session.id, proposal.id, { expectedRevision: ready.revision, values: { modelId: model.id } });
    assert.equal(missing.state, "collecting_input"); assert.equal(missing.revision, ready.revision + 1);
    assert.equal(missing.fields.find(field => field.kind === "credential")?.status, "missing");
    assert.equal(h.framework.service.getRecord(h.session.id, proposal.id).credentialHandle, undefined);
    assert.equal(h.store.getModelApiToken(model.id), "formal-original"); assert.equal(probes, 0);
    ready = await secure(h.framework, missing, { modelId: model.id }, "revoked-candidate");
    h.framework.credentials.clearRequest(proposal.id);
    const revoked = await h.framework.preview(h.session.id, proposal.id, { expectedRevision: ready.revision, values: { modelId: model.id } });
    assert.equal(revoked.state, "collecting_input");
    const uploaded = await h.framework.provideCredential(h.session.id, proposal.id, { expectedRevision: revoked.revision, fieldId: "apiToken", secret: "replacement-key" }, "fresh-credential");
    const final = await h.framework.preview(h.session.id, proposal.id, { expectedRevision: revoked.revision, values: { modelId: model.id }, credentialHandle: uploaded.handle });
    assert.equal(final.state, "awaiting_confirmation"); assert.equal(final.revision, revoked.revision + 1);
    assert.equal(JSON.stringify(final).includes(uploaded.handle), false); assert.equal(JSON.stringify(final).includes("replacement-key"), false);
    assert.equal((await approve(h.framework, final)).state, "applied"); assert.equal(h.store.getModelApiToken(model.id), "replacement-key");
  });
  assert.equal(probes, 1);
});

test("CFG-T20/21: an invalid concurrent user digest cannot overwrite an automatic decision source", async context => {
  const h = await harness(context);
  const view = await dueAutomaticProposal(h); const gate = verificationGate(h.framework);
  const automatic = h.framework.decide(h.session.id, view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply" }, "automatic-valid", "auto");
  await gate.started;
  const invalid = assert.rejects(h.framework.decide(h.session.id, view.id, { revision: view.revision, previewDigest: "invalid-user-digest", decision: "apply" }, "user-invalid"), { code: "STALE_CONFIGURATION_PREVIEW" });
  gate.release();
  assert.equal((await automatic).state, "applied"); await invalid;
  assert.equal(h.framework.service.get(h.session.id, view.id).decisionSource, "auto");
  assert.ok(h.framework.repository.getReceipt(view.id));
  assert.ok(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds.includes("pubmed"));
});

test("CFG-T20/21: revoking automatic authorization during verification prevents formal commit despite a concurrent invalid user decision", async context => {
  const h = await harness(context);
  const before = [...h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds];
  const view = await dueAutomaticProposal(h); const gate = verificationGate(h.framework);
  const automatic = h.framework.decide(h.session.id, view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply" }, "automatic-revoked", "auto");
  await gate.started;
  const invalid = assert.rejects(h.framework.decide(h.session.id, view.id, { revision: view.revision, previewDigest: "invalid-user-digest", decision: "apply" }, "user-invalid-revoked"), { code: "STALE_CONFIGURATION_PREVIEW" });
  await h.store.updateSession(h.session.id, { autoApplyLowRiskConfiguration: false });
  gate.release();
  assert.notEqual((await automatic).state, "applied"); await invalid;
  assert.equal(h.framework.service.get(h.session.id, view.id).decisionSource, "auto");
  assert.equal(h.framework.repository.getReceipt(view.id), undefined);
  assert.deepEqual(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds, before);
});

test("CFG-01/02/14: finite adapters preserve inherited connectors, unrelated fields, and reversal restores absence", async context => {
  const h = await harness(context);
  assert.deepEqual(h.framework.service.registry.list().map(adapter => adapter.id).sort(), ["connector.enable", "idea_tree.configure", "model.connect", "model.repair_credential", "model.select", "quotas.configure", "review.configure", "skill.select", "thinking.configure", "timeouts.configure"]);
  await h.store.replaceGlobalSettings({ enabledConnectorIds: ["uniprot"], semanticReviewEnabled: false });
  const view = await h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
  assert.deepEqual(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds, ["uniprot"]);
  assert.equal((await approve(h.framework, view)).state, "applied");
  assert.deepEqual(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds, ["uniprot", "pubmed"]);
  assert.equal(h.store.getSessionSettings(h.session.id).effective.semanticReviewEnabled, false);
  assert.deepEqual(h.store.getSessionSettings(h.other.id).effective.enabledConnectorIds, ["uniprot"]);
  const reversal = await h.framework.service.reversal(h.session.id, view.id);
  assert.notEqual(reversal.id, view.id); assert.equal((await approve(h.framework, reversal)).state, "applied");
  assert.equal(Object.hasOwn(h.store.getSessionSettings(h.session.id).overrides, "enabledConnectorIds"), false);
  assert.deepEqual(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds, ["uniprot"]);
});

test("CFG-T02/14: model selection is session-local and reversal returns to the inherited default", async context => {
  const h = await harness(context);
  const first = await h.store.createModel({ name: "First", model: "first", baseUrl: "https://models.example.test/v1", apiToken: "first-token" });
  const second = await h.store.createModel({ name: "Second", model: "second", baseUrl: "https://models.example.test/v1", apiToken: "second-token" });
  assert.equal(h.store.getSessionSettings(h.session.id).effective.modelId, first.id);
  const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.select", values: { modelId: second.id } });
  assert.equal((await approve(h.framework, proposal)).state, "applied");
  assert.equal(h.store.getSessionSettings(h.session.id).effective.modelId, second.id);
  assert.equal(h.store.getGlobalSettings().effective.modelId, first.id);
  assert.equal(h.store.getSessionSettings(h.other.id).effective.modelId, first.id);
  const reversal = await h.framework.service.reversal(h.session.id, proposal.id);
  assert.equal((await approve(h.framework, reversal)).state, "applied");
  assert.equal(Object.hasOwn(h.store.getSessionSettings(h.session.id).overrides, "modelId"), false);
  assert.equal(h.store.getSessionSettings(h.session.id).effective.modelId, first.id);
  const reopened = await h.reopen();
  assert.equal(Object.hasOwn(reopened.getSessionSettings(h.session.id).overrides, "modelId"), false);
});

test("CFG-T05/06: first model connection verifies once then writes the global default without an extra session override", async context => {
  const h = await harness(context); let probes = 0;
  await h.store.replaceGlobalSettings({ enabledConnectorIds: ["uniprot"], semanticReviewEnabled: false });
  await provider((request, response, body) => {
    probes++; assert.equal(request.url, "/v1/chat/completions"); assert.equal(request.headers.authorization, "Bearer first-key");
    assert.equal(body.model, "first-model"); completion(response);
  }, async origin => {
    const values = { name: "First provider", baseUrl: origin, model: "first-model", apiProtocol: "openai-chat-completions", apiVariant: "openai" };
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.connect", values });
    assert.equal(proposal.scope.kind, "global"); assert.equal(proposal.state, "collecting_input");
    const ready = await secure(h.framework, proposal, values, "first-key");
    assert.equal(h.store.listProviders().length, 0); assert.equal(h.store.listModels().length, 0); assert.equal(probes, 0);
    assert.equal(JSON.stringify(ready).includes("first-key"), false);
    assert.equal((await approve(h.framework, ready)).state, "applied");
    const saved = h.store.listModels()[0]!;
    assert.equal(h.store.getModelApiToken(saved.id), "first-key");
    assert.equal(h.store.getGlobalSettings().effective.modelId, saved.id);
    assert.equal(h.store.getSessionSettings(h.session.id).effective.modelId, saved.id);
    assert.equal(Object.hasOwn(h.store.getSessionSettings(h.session.id).overrides, "modelId"), false);
    assert.equal(h.store.getSessionSettings(h.other.id).effective.modelId, saved.id);
    assert.equal(h.store.getGlobalSettings().effective.semanticReviewEnabled, false);
    assert.deepEqual(h.store.getGlobalSettings().effective.enabledConnectorIds, ["uniprot"]);
    assert.equal(h.framework.credentials.hasDraft(proposal.id, ready.revision, String(h.framework.service.getRecord(h.session.id, proposal.id).plan.data?.credentialTarget)), false);
  });
  assert.equal(probes, 1);
});

test("CFG-T04: token-optional connection sends no fake API key and later connections bind only the current session", async context => {
  const h = await harness(context); let probes = 0;
  const initial = await h.store.createModel({ name: "Existing", model: "existing", baseUrl: "https://existing.example.test/v1", apiToken: "existing-key" });
  await provider((request, response) => { probes++; assert.equal(request.headers.authorization, undefined); completion(response); }, async origin => {
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.connect", values: { name: "Local", model: "local-model", baseUrl: origin, apiProtocol: "openai-chat-completions", apiVariant: "openai", tokenOptional: true } });
    assert.equal(proposal.scope.kind, "session"); assert.equal(proposal.state, "awaiting_confirmation");
    assert.equal((await approve(h.framework, proposal)).state, "applied");
    const saved = h.store.listModels().find(model => model.model === "local-model")!;
    assert.equal(h.store.getModelApiToken(saved.id), undefined); assert.equal(h.store.modelAllowsMissingToken(saved), true);
    assert.equal(h.store.getSessionSettings(h.session.id).effective.modelId, saved.id);
    assert.equal(h.store.getSessionSettings(h.other.id).effective.modelId, initial.id);
    assert.equal(h.store.getGlobalSettings().effective.modelId, initial.id);
  });
  assert.equal(probes, 1);
});

test("CFG-T04/06: repair validates an isolated candidate and only overrides the selected shared-provider profile", async context => {
  const h = await harness(context); let probes = 0;
  await provider((request, response, body) => {
    probes++; assert.equal(request.headers.authorization, "Bearer replacement-for-one"); assert.equal(body.model, "model-one"); completion(response);
  }, async origin => {
    const shared = await h.store.createProvider({ name: "Shared", baseUrl: origin, apiProtocol: "openai-chat-completions", apiVariant: "openai", apiToken: "shared-original" });
    const first = await h.store.materializeProviderModel(shared.id, "model-one");
    const second = await h.store.materializeProviderModel(shared.id, "model-two");
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.repair_credential", values: { modelId: first.id } });
    assert.equal(proposal.scope.kind, "global");
    const ready = await secure(h.framework, proposal, { modelId: first.id }, "replacement-for-one");
    assert.equal(probes, 0); assert.equal(h.store.getModelApiToken(first.id), "shared-original");
    const result = await approve(h.framework, ready); assert.equal(result.state, "applied");
    assert.equal(h.store.getProviderApiToken(shared.id), "shared-original");
    assert.equal(h.store.getModelApiToken(first.id), "replacement-for-one"); assert.equal(h.store.getModelApiToken(second.id), "shared-original");
    assert.equal(JSON.stringify(result).includes("replacement-for-one"), false);
    const reopened = await h.reopen();
    assert.equal(reopened.getModelApiToken(first.id), "replacement-for-one"); assert.equal(reopened.getModelApiToken(second.id), "shared-original");
  });
  assert.equal(probes, 1);
});

test("CFG-T04: rejected credential never replaces the original formal credential", async context => {
  const h = await harness(context); let probes = 0;
  await provider((_request, response) => { probes++; response.writeHead(401); response.end(JSON.stringify({ error: "candidate-credential" })); }, async origin => {
    const model = await h.store.createModel({ name: "Working", model: "working", baseUrl: origin, apiToken: "working-original" });
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.repair_credential", values: { modelId: model.id } });
    const ready = await secure(h.framework, proposal, { modelId: model.id }, "candidate-credential");
    const result = await approve(h.framework, ready);
    assert.equal(result.state, "needs_fix"); assert.equal(h.store.getModelApiToken(model.id), "working-original");
    assert.equal(h.framework.repository.getReceipt(proposal.id), undefined); assert.equal(JSON.stringify(result).includes("candidate-credential"), false);
  });
  assert.equal(probes, 1);
});

test("CFG-T10/13/23: Stop, independent settings changes, unknown and reserved fields block stale writes", async context => {
  const h = await harness(context);
  const baselineConnectors = [...h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds];
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed", arbitrary: "write" } }), /INVALID_CONFIGURATION_INPUT/);
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed", restoreInheritance: true } }), /Restoration fields/);
  const stale = await h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
  await h.store.updateSession(h.session.id, { semanticReviewEnabled: false });
  await assert.rejects(approve(h.framework, stale), { code: "RESOURCE_VERSION_CONFLICT" });
  const refreshed = await h.framework.preview(h.session.id, stale.id, { expectedRevision: 1, values: { connectorId: "pubmed" } });
  h.store.notifications.stop(h.session.id);
  await assert.rejects(approve(h.framework, refreshed), { code: "CONTINUATION_STOPPED" });
  assert.deepEqual(h.store.getSessionSettings(h.session.id).effective.enabledConnectorIds, baselineConnectors);
  assert.equal(h.framework.repository.getReceipt(stale.id), undefined);
});

test("CFG-T12/28: a receipt write failure atomically rolls back provider, model, credential and global binding", async context => {
  const h = await harness(context); let probes = 0;
  await provider((_request, response) => { probes++; completion(response); }, async origin => {
    const values = { name: "Rollback", baseUrl: origin, model: "rollback-model", apiProtocol: "openai-chat-completions", apiVariant: "openai" };
    const proposal = await h.framework.propose(h.session.id, { capabilityId: "model.connect", values });
    const ready = await secure(h.framework, proposal, values, "isolated-candidate");
    const database = h.store.getConfigurationDatabase();
    const baselineSecrets = database.prepare("SELECT model_id,encrypted_token FROM model_secrets ORDER BY model_id").all();
    database.exec("CREATE TRIGGER reject_configuration_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
    const result = await approve(h.framework, ready);
    assert.equal(result.state, "failed"); assert.equal(h.store.listModels().length, 0); assert.equal(h.store.listProviders().length, 0);
    assert.equal(h.store.getGlobalSettings().effective.modelId, undefined); assert.equal(h.store.getSessionSettings(h.session.id).effective.modelId, undefined);
    assert.deepEqual(database.prepare("SELECT model_id,encrypted_token FROM model_secrets ORDER BY model_id").all(), baselineSecrets);
    assert.equal(h.framework.repository.getReceipt(proposal.id), undefined); assert.equal(h.framework.repository.listOutbox().length, 0);
    database.exec("DROP TRIGGER reject_configuration_receipt");
    const retry = await h.framework.preview(h.session.id, ready.id, { expectedRevision: ready.revision, values });
    assert.equal((await approve(h.framework, retry)).state, "applied", "a failed atomic write must not poison the write queue");
  });
  assert.equal(probes, 2);
});

test("review connector JSON errors are domain input errors and no-op differs from restore removal or inheritance", async context => {
  const h = await harness(context), adapter = h.framework.service.registry.get("connector.enable");
  for (const value of ["{", "not-json"]) {
    assert.throws(() => adapter.normalize({ connectorId: "pubmed", restoreConnectorIds: value }), { code: "INVALID_CONFIGURATION_INPUT" });
  }
  for (const value of ['{}', '["pubmed","pubmed"]', '[null]']) {
    assert.throws(() => adapter.normalize({ connectorId: "pubmed", restoreConnectorIds: value }));
  }
  await h.store.replaceProjectSettings(h.project.id, { enabledConnectorIds: ["pubmed"] });
  await h.store.replaceSessionSettings(h.session.id, { enabledConnectorIds: ["pubmed"] });
  await assert.rejects(h.framework.propose(h.session.id, { capabilityId: "connector.enable", values: { connectorId: "pubmed" } }), { code: "CONFIGURATION_NO_CHANGE" });
  assert.equal(h.framework.service.list(h.session.id).length, 0);
  const snapshot = h.store.configurationSnapshot(h.session.id, "connector.enable", "pubmed"), scope = { kind: "session" as const, id: h.session.id };
  assert.equal(adapter.preview(adapter.normalize({ connectorId: "pubmed", restoreConnectorIds: "[]" }), snapshot, scope).ready, true);
  assert.equal(adapter.preview(adapter.normalize({ connectorId: "pubmed", restoreInheritance: true }), snapshot, scope).ready, true);
});
