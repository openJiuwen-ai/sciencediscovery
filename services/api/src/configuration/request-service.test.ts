// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
import { DatabaseSync } from "node:sqlite";
import { ConfigurationRequestService } from "./request-service.js";
import { ConfigurationRepository } from "./repository.js";
import { ConfigurationRegistry } from "./registry.js";
import type { ConfigurationAdapter, ConfigurationSnapshot, ConfigurationHost } from "./types.js";
import { ConfigurationError, object, string } from "./validation.js";
import { normalizeConfigurationFields, normalizeTokenSchema } from "./schema-normalizer.js";
import { normalizeChoices } from "./choices.js";
import { configurationNeedKey } from "./need-key.js";

function harness(options: { verify?: ConfigurationAdapter["verify"]; applyFails?: boolean; credential?: boolean; choiceOptions?: ConfigurationHost["choiceOptions"]; applyRunOverlay?: ConfigurationHost["applyRunOverlay"] } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE domain_settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO domain_settings VALUES (1, '[]')");
  const repo = new ConfigurationRepository(db);
  let generation = 0; let version = 0; let writes = 0; let writable = true;
  const snapshot = (): ConfigurationSnapshot => ({ projectId: "project", stopGeneration: generation, writable, resourceVersions: { settings: String(version), parent: "v1", credential: "generation-1" }, data: {} });
  const adapter: ConfigurationAdapter = {
    id: "connector.enable", version: 1, schemaVersion: 1, scopes: ["session"], persistence: "local_transaction",
    normalize(input) { const value = object(input, ["connectorId"], "values"); return { connectorId: string(value.connectorId, "connectorId") }; },
    target(input) { return String(input.connectorId); },
    preview(input, context) { return { ready: true, fields: [{ id: "connectorId", label: "Connector", required: true, kind: "text", value: string(input.connectorId, "connectorId") }, ...(options.credential ? [{ id: "apiKey", label: "API key", required: true, kind: "credential" as const, status: "missing" as const }] : [])], changes: [{ field: "connectors", after: String(input.connectorId) }], impact: { resourceLocation: "Catalog", effectiveScope: "Session", message: "Keep other connectors" }, verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: context.runId ? "same_run" : "next_run", data: { privateRef: "do-not-project" } }; },
    verify: options.verify,
    apply(context) {
      db.prepare("UPDATE domain_settings SET value = ? WHERE id = 1").run(JSON.stringify(["existing", context.input.connectorId]));
      if (options.applyFails) throw new Error("provider SECRET must never escape");
      writes++; version++; return { resourceRevision: String(version), summary: "Enabled" };
    },
    previewReversal() { return { connectorId: "previous" }; },
  };
  let queue: Promise<unknown> = Promise.resolve();
  const host = { snapshot, choiceOptions: options.choiceOptions, applyRunOverlay: options.applyRunOverlay, runInTransaction<T>(_sessionId: string, action: () => T): Promise<T> {
    const operation = queue.then(() => { const oldVersion = version; const oldWrites = writes; try { return repo.transaction(action); } catch (error) { version = oldVersion; writes = oldWrites; throw error; } });
    queue = operation.then(() => undefined, () => undefined); return operation;
  } };
  const registry = new ConfigurationRegistry().register(adapter);
  const service = new ConfigurationRequestService({ repository: repo, registry, host });
  return { db, repo, service, registry, host, adapter, get writes() { return writes; }, stop() { generation++; }, changeVersion() { version++; }, archive() { writable = false; } };
}
const proposal = { capabilityId: "connector.enable" as const, values: { connectorId: "pubmed" }, runId: "run-1" };

test("CFG-R10 due lifecycle and phase queries are bounded, indexed and do not revisit historical receipts", async () => {
  const h = harness();
  const view = await h.service.propose("session", proposal);
  const source = h.service.getRecord("session", view.id);
  h.repo.transaction(() => {
    for (let i = 0; i < 325; i++) {
      const record = structuredClone(source); record.view.id = `work-${i}`; record.fingerprint = `fingerprint-${i}`;
      if (i < 200) { record.view.state = "applied"; record.view.resumption.state = "completed"; }
      h.repo.save(record);
      if (i >= 200) h.repo.scheduleWork(record, 0);
      h.repo.enqueueOutbox({ id: `phase-${i}`, requestId: record.view.id, revision: 1, sessionId: "session", kind: "activate",
        state: i < 200 ? "done" : "pending", payload: {}, createdAt: "now", updatedAt: "now" });
    }
  });
  const first = h.repo.dueRequests(Date.now(), 1000);
  assert.equal(first.length, 100); assert.ok(first.every(record => record.view.state === "awaiting_confirmation"));
  for (const record of first) h.repo.scheduleWork(record, Date.now() + 60_000);
  const next = h.repo.dueRequests();
  assert.equal(next.length, 26); // remaining 25 plus the initial request
  assert.ok(next.every(record => !first.some(item => item.view.id === record.view.id)));
  const plan = h.db.prepare("EXPLAIN QUERY PLAN SELECT request_id FROM configuration_work_v3 WHERE due_at<=? ORDER BY due_at,request_id LIMIT ?").all(Date.now(), 100) as Array<{ detail: string }>;
  assert.ok(plan.some(row => row.detail.includes("configuration_work_v3_due")));
  const firstPhases = h.repo.pendingOutbox(Date.now(), 1000);
  assert.equal(firstPhases.length, 100);
  for (const phase of firstPhases) h.repo.updateOutbox({ ...phase, state: "done" }, "pending");
  const nextPhases = h.repo.pendingOutbox(); assert.equal(nextPhases.length, 25);
  assert.ok(nextPhases.every(phase => !firstPhases.some(previous => previous.id === phase.id)));
  assert.equal(h.repo.pendingNotices(1000).length, 100);
  const notification = h.repo.pendingNotices(1)[0]!;
  h.repo.acknowledgeNotice(notification.request_id, notification.state_version - 1);
  assert.equal(h.repo.pendingNotices(1)[0]!.request_id, notification.request_id, "An old writer cannot acknowledge a newer notice");
  h.db.close();
});

const choiceOptions = () => [
  { id: "save", kind: "persisted_apply" as const, label: "Save for session", description: "Enable the installed connector for the session.", available: true },
  { id: "run-only", kind: "run_overlay" as const, label: "Use for this task", description: "Leave all saved settings unchanged.", available: true },
  { id: "use-web", kind: "alternative" as const, label: "Use Web search", description: "Use the available Web search source; results may differ from PubMed.", available: true, alternativeId: "web_search" },
  { id: "dismiss", kind: "dismiss" as const, label: "Do not configure", description: "Continue without changing settings.", available: true },
];

test("CFG-T30: finite option metadata rejects duplicate IDs, executable extensions and missing alternative identity", () => {
  assert.throws(() => normalizeChoices([...choiceOptions(), choiceOptions()[0]!]), { code: "INVALID_CONFIGURATION_INPUT" });
  assert.throws(() => normalizeChoices(choiceOptions().map(option => ({ ...option, command: "untrusted executable" }))), { code: "INVALID_CONFIGURATION_INPUT" });
  assert.throws(() => normalizeChoices(choiceOptions().map(option => option.kind === "alternative" ? { ...option, alternativeId: undefined } : option)), { code: "INVALID_CONFIGURATION_INPUT" });
  assert.throws(() => normalizeChoices(choiceOptions().map(option => option.kind === "dismiss" ? { ...option, available: false } : option)), { code: "INVALID_CONFIGURATION_INPUT" });
});

test("CFG-T30/36: new P1 capabilities require the v3 choice protocol while historical connector requests retain v2", async () => {
  const h = harness();
  for (const capabilityId of ["skill.select", "thinking.configure", "review.configure", "timeouts.configure", "quotas.configure", "idea_tree.configure"] as const)
    await assert.rejects(h.service.propose("session", { capabilityId, values: {} }), { code: "CONFIGURATION_PROTOCOL_REQUIRED" });
  assert.equal(h.service.list("session").length, 0);
  const legacy = await h.service.propose("session", proposal);
  assert.equal(legacy.protocolVersion, undefined);
  assert.equal((await h.service.decide("session", legacy.id, { revision: 1, previewDigest: legacy.previewDigest!, decision: "apply" })).state, "applied");
});

test("CFG-T32: connector refusal identity survives unrelated settings edits but changes with relevant capability availability", () => {
  const snapshot = { projectId: "project", stopGeneration: 1, writable: true,
    resourceVersions: { settings: "before", models: "before", credentials: "before", skills: "before", reviewer: "before", autoConfigurationPolicy: "before", connectorCatalog: "catalog", policies: "policy" },
    data: { effective: { enabledConnectorIds: [], plugins: {} }, installedConnectorIds: ["pubmed"] } } as unknown as ConfigurationSnapshot;
  const key = configurationNeedKey({ runId: "run", capabilityId: "connector.enable", target: "pubmed", snapshot });
  const unrelated = structuredClone(snapshot);
  for (const field of ["settings", "models", "credentials", "skills", "reviewer", "autoConfigurationPolicy"]) unrelated.resourceVersions[field] = "after";
  assert.equal(configurationNeedKey({ runId: "run", capabilityId: "connector.enable", target: "pubmed", snapshot: unrelated }), key);
  assert.notEqual(configurationNeedKey({ runId: "another-run", capabilityId: "connector.enable", target: "pubmed", snapshot }), key);
  unrelated.data.installedConnectorIds = [];
  assert.notEqual(configurationNeedKey({ runId: "run", capabilityId: "connector.enable", target: "pubmed", snapshot: unrelated }), key);
  unrelated.data.installedConnectorIds = ["pubmed"];
  (unrelated.data.effective as { enabledConnectorIds: string[] }).enabledConnectorIds = ["pubmed"];
  assert.notEqual(configurationNeedKey({ runId: "run", capabilityId: "connector.enable", target: "pubmed", snapshot: unrelated }), key);
});

test("CFG-T30/36: v3 selection is revision-bound, durable and cannot use the legacy decision shape", async () => {
  const h = harness({ choiceOptions });
  const initial = await h.service.propose("session", { ...proposal, protocolVersion: 3 });
  assert.equal(initial.protocolVersion, 3); assert.equal(initial.selectedOptionId, "save");
  await assert.rejects(h.service.decide("session", initial.id, { revision: 1, previewDigest: initial.previewDigest!, decision: "apply" }), { code: "CONFIGURATION_OPTION_REQUIRED" });
  await assert.rejects(h.service.preview("session", initial.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "arbitrary-command" }), { code: "CONFIGURATION_OPTION_UNAVAILABLE" });
  const selected = await h.service.preview("session", initial.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "dismiss" }, "choose-dismiss");
  await assert.rejects(h.service.preview("session", initial.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "save" }, "choose-dismiss"), { code: "IDEMPOTENCY_MISMATCH" });
  assert.equal(selected.revision, 2); assert.notEqual(selected.previewDigest, initial.previewDigest);
  await assert.rejects(h.service.decide("session", initial.id, { revision: 1, previewDigest: initial.previewDigest!, selectedOptionId: "save", decision: "apply" }), { code: "CONFIGURATION_OPTION_REQUIRED" });
  const input = { revision: selected.revision, previewDigest: selected.previewDigest!, selectedOptionId: "dismiss", decision: "dismiss" as const };
  const result = await h.service.decide("session", initial.id, input, "dismiss-once");
  assert.equal(result.state, "dismissed"); assert.equal(h.writes, 0);
  assert.deepEqual(result.choiceReceipt, { optionId: "dismiss", kind: "dismiss", label: "Do not configure", configurationWritten: false, scope: "none", runId: "run-1" });
  const restarted = new ConfigurationRequestService({ repository: new ConfigurationRepository(h.db), registry: h.registry, host: h.host });
  assert.deepEqual(await restarted.decide("session", initial.id, input, "dismiss-once"), result);
  assert.equal(h.repo.listOutbox().length, 1);
  assert.equal(h.repo.listOutbox()[0]?.payload.choiceKind, "dismiss");
  const row = h.service.getRecord("session", initial.id); row.view.selectedOptionId = "save";
  assert.throws(() => h.repo.save(row, row.view.stateVersion), { code: "STALE_CONFIGURATION_PREVIEW" });
});

test("CFG-T31: task overlay uses its isolated writer and never the persistent domain adapter", async () => {
  let overlays = 0;
  const h = harness({ choiceOptions, applyRunOverlay: context => {
    assert.equal(context.runId, "run-1"); assert.equal(context.selectedOption?.kind, "run_overlay");
    assert.ok(context.previewDigest); overlays++; return { resourceRevision: "overlay-1" };
  } });
  const initial = await h.service.propose("session", { ...proposal, protocolVersion: 3 });
  const selected = await h.service.preview("session", initial.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "run-only" });
  assert.equal(selected.impact.effectiveScope, "This task only");
  const result = await h.service.decide("session", initial.id, { revision: 2, previewDigest: selected.previewDigest!, decision: "apply", selectedOptionId: "run-only" });
  assert.equal(result.state, "applied"); assert.equal(overlays, 1); assert.equal(h.writes, 0);
  assert.equal(result.choiceReceipt?.configurationWritten, false); assert.equal(result.choiceReceipt?.scope, "run");
  assert.equal(result.allowedActions.includes("reversal"), false);
  assert.equal((h.db.prepare("SELECT value FROM domain_settings").get() as { value: string }).value, "[]");
});

test("CFG-T32: alternatives are revalidated, do not probe or save, and carry a finite path to the original run", async () => {
  let ready = true; let probes = 0;
  const h = harness({ choiceOptions: () => choiceOptions().map(option => option.kind === "alternative" ? { ...option, available: ready } : option), verify: async () => { probes++; return { ok: true }; } });
  const initial = await h.service.propose("session", { ...proposal, protocolVersion: 3 });
  const selected = await h.service.preview("session", initial.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "use-web" });
  const input = { revision: 2, previewDigest: selected.previewDigest!, selectedOptionId: "use-web", decision: "apply" as const };
  ready = false;
  await assert.rejects(h.service.decide("session", initial.id, input), { code: "CONFIGURATION_OPTION_UNAVAILABLE" });
  assert.equal(h.repo.listOutbox().length, 0);
  ready = true;
  const result = await h.service.decide("session", initial.id, input);
  assert.equal(result.state, "dismissed"); assert.equal(result.choiceReceipt?.kind, "alternative");
  assert.equal(probes, 0); assert.equal(h.writes, 0);
  assert.equal(h.repo.listOutbox()[0]?.payload.alternativeId, "web_search");
  assert.equal(h.repo.listOutbox()[0]?.payload.runId, "run-1");
});

test("CFG-T30/32: dismissal needs no credential and Stop still invalidates all choices", async () => {
  const h = harness({ credential: true, choiceOptions });
  const initial = await h.service.propose("session", { ...proposal, protocolVersion: 3 });
  assert.equal(initial.state, "collecting_input");
  const selected = await h.service.preview("session", initial.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "dismiss" });
  assert.equal(selected.state, "awaiting_confirmation"); assert.deepEqual(selected.fields, []);
  h.stop();
  await assert.rejects(h.service.decide("session", initial.id, { revision: 2, previewDigest: selected.previewDigest!, selectedOptionId: "dismiss", decision: "dismiss" }), { code: "CONTINUATION_STOPPED" });
  assert.equal(h.writes, 0); assert.equal(h.repo.listOutbox().length, 0);
});

test("CFG-T30: switching back from an alternative after refresh retains the server candidate", async () => {
  const h = harness({ choiceOptions });
  const initial = await h.service.propose("session", { ...proposal, protocolVersion: 3 });
  const alternative = await h.service.preview("session", initial.id, { expectedRevision: 1, values: proposal.values, selectedOptionId: "use-web" });
  assert.deepEqual(alternative.fields, []);
  const refreshed = h.service.get("session", initial.id);
  const persistent = await h.service.preview("session", initial.id, { expectedRevision: refreshed.revision, values: {}, selectedOptionId: "save" });
  assert.equal(persistent.fields[0]?.kind === "text" ? persistent.fields[0].value : undefined, "pubmed");
  assert.equal(persistent.revision, 3);
});

test("CFG-T23: finite schema rejects unknown keys, unsupported types, duplicate keys and mismatched credentials", () => {
  assert.throws(() => normalizeTokenSchema([{ key: "token", label: "Token", type: "text", evil: true }]));
  assert.throws(() => normalizeTokenSchema([{ key: "token", label: "Token", type: "file" }]));
  assert.throws(() => normalizeTokenSchema([{ key: "a", label: "A", type: "text" }, { key: "a", label: "B", type: "text" }]));
  assert.throws(() => normalizeTokenSchema([{ key: "token", label: "Token", type: "text" }], { credentialFields: ["token"] }));
  assert.throws(() => normalizeConfigurationFields([{ id: "token", label: "Token", required: true, kind: "credential", status: "provided", value: "SECRET" }]));
  const fields = normalizeTokenSchema([{ key: "token", label: "Token", type: "password", default: "SECRET", placeholder: "SECRET" }], { credentialFields: ["token"] });
  assert.equal(JSON.stringify(fields).includes("SECRET"), false);
  assert.throws(() => normalizeTokenSchema([{ key: "token", label: "Token", type: "text", help: { label: "Docs", url: "https://trusted.example/?secret=abc" } }], { helpHosts: ["trusted.example"] }));
});

test("CFG-01/02: finite registry, strict domain inputs, run-aware preview, DTO projection and immutable revision", async () => {
  const h = harness();
  assert.throws(() => h.registry.get("arbitrary.config"));
  await assert.rejects(h.service.propose("session", { ...proposal, values: { connectorId: "pubmed", secret: "SECRET" } }));
  const view = await h.service.propose("session", proposal);
  assert.equal(view.activation.mode, "same_run");
  assert.equal(JSON.stringify(view).includes("do-not-project"), false);
  const updated = await h.service.preview("session", view.id, { expectedRevision: 1, values: { connectorId: "pubmed" } });
  assert.equal(updated.revision, 2); assert.notEqual(updated.previewDigest, view.previewDigest);
  assert.equal(h.repo.getRevision(view.id, 1)?.view.previewDigest, view.previewDigest);
  await assert.rejects(h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" }), { code: "STALE_CONFIGURATION_PREVIEW" });
  const record = h.service.getRecord("session", view.id); record.input.connectorId = "other";
  assert.throws(() => h.repo.transaction(() => h.repo.save(record, record.view.stateVersion)), { code: "STALE_CONFIGURATION_PREVIEW" });
});

test("CFG-T09/10/28: durable idempotency, one apply per revision, atomic receipt and activation outbox", async () => {
  const h = harness();
  const view = await h.service.propose("session", proposal, "proposal-key");
  assert.deepEqual(await h.service.propose("session", proposal, "proposal-key"), view);
  await assert.rejects(h.service.propose("session", { ...proposal, values: { connectorId: "other" } }, "proposal-key"), { code: "IDEMPOTENCY_MISMATCH" });
  const decision = { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply" as const };
  const results = await Promise.all([h.service.decide("session", view.id, decision, "decision-key"), h.service.decide("session", view.id, decision, "decision-key")]);
  assert.equal(results.some((result) => result.state === "applied"), true); assert.equal(h.writes, 1);
  assert.equal((await h.service.decide("session", view.id, decision)).state, "applied"); assert.equal(h.writes, 1);
  assert.ok(h.repo.getReceipt(view.id, 1)); assert.equal(h.repo.listOutbox().length, 1);
  assert.equal(h.repo.listOutbox()[0]?.payload.runId, "run-1");
  assert.deepEqual(JSON.parse((h.db.prepare("SELECT value FROM domain_settings").get() as { value: string }).value), ["existing", "pubmed"]);
  const restarted = new ConfigurationRequestService({ repository: new ConfigurationRepository(h.db), registry: h.registry, host: { snapshot: () => { throw new Error("No writes on replay"); }, runInTransaction: async (_id, action) => action() } });
  assert.equal((await restarted.decide("session", view.id, decision, "decision-key")).state, "applied");
  assert.equal(h.writes, 1);
});

test("CFG-T10: a stale resource vector cannot overwrite settings, and re-preview invalidates approval", async () => {
  const h = harness(); const view = await h.service.propose("session", proposal); h.changeVersion();
  await assert.rejects(h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" }), { code: "RESOURCE_VERSION_CONFLICT" });
  assert.equal(h.writes, 0);
  const updated = await h.service.preview("session", view.id, { expectedRevision: 1, values: proposal.values });
  assert.equal(updated.revision, 2);
  assert.equal((await h.service.decide("session", view.id, { revision: 2, previewDigest: updated.previewDigest!, decision: "apply" })).state, "applied");
});

test("CFG-T12/13: Stop during verification suppresses apply and persists cancellation", async () => {
  let finish!: () => void; let begin!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const verified = new Promise<void>((resolve) => { finish = resolve; });
  const h = harness({ verify: async () => { begin(); await verified; return { ok: true }; } });
  const view = await h.service.propose("session", proposal);
  const pending = h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
  await started; h.stop(); finish(); const result = await pending;
  assert.equal(result.state, "cancelled"); assert.equal(h.writes, 0); assert.equal(h.repo.listOutbox().length, 0);
});

test("CFG-T08: rejection does not write settings and carries original run resume intent", async () => {
  const h = harness(); const view = await h.service.propose("session", proposal);
  const result = await h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "dismiss" });
  assert.equal(result.state, "dismissed"); assert.equal(h.writes, 0); assert.equal(h.repo.listOutbox()[0]?.kind, "resume");
  assert.equal(h.repo.listOutbox()[0]?.payload.decision, "dismiss");
});

test("CFG-T06/23: credential availability changes the approved revision without exposing handle", async () => {
  const h = harness({ credential: true }); const view = await h.service.propose("session", proposal);
  assert.equal(view.state, "collecting_input");
  const updated = await h.service.preview("session", view.id, { expectedRevision: 1, values: proposal.values, credentialHandle: "private-handle" });
  assert.equal(updated.state, "awaiting_confirmation"); assert.equal(JSON.stringify(updated).includes("private-handle"), false);
  assert.equal(updated.fields.find((field) => field.kind === "credential")?.status, "provided");
  await assert.rejects(h.service.preview("session", view.id, { expectedRevision: 2, values: { connectorId: "different-target" }, credentialHandle: "private-handle" }), { code: "INVALID_CONFIGURATION_INPUT" });
  const changed = await h.service.preview("session", view.id, { expectedRevision: 2, values: { connectorId: "different-target" } });
  assert.equal(changed.state, "collecting_input");
  assert.equal(h.service.getRecord("session", view.id).credentialHandle, undefined);
});

test("CFG-T14: reversal is a new proposal and refuses resource changes after original receipt", async () => {
  const h = harness(); const view = await h.service.propose("session", proposal);
  await h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
  const reversal = await h.service.reversal("session", view.id); assert.notEqual(reversal.id, view.id); assert.equal(reversal.state, "awaiting_confirmation");
  h.changeVersion(); await assert.rejects(h.service.reversal("session", view.id), { code: "RESOURCE_VERSION_CONFLICT" });
});

test("CFG-02: synchronous transaction guard rolls back domain settings on failure", async () => {
  const h = harness({ applyFails: true }); const view = await h.service.propose("session", proposal);
  const failed = await h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
  assert.equal(failed.state, "failed"); assert.equal(JSON.stringify(failed).includes("SECRET"), false);
  assert.equal((h.db.prepare("SELECT value FROM domain_settings").get() as { value: string }).value, "[]");
  assert.equal(h.repo.getReceipt(view.id), undefined); assert.equal(h.repo.listOutbox().length, 0);
  const second = await h.service.propose("session", { ...proposal, values: { connectorId: "other" } }); assert.equal(second.state, "awaiting_confirmation");
  assert.throws(() => h.repo.transaction(() => Promise.resolve()), /synchronous/);
});

test("CFG-T08/10: dismissal remains available after another settings entry changes the baseline", async () => {
  const h = harness(); const view = await h.service.propose("session", proposal); h.changeVersion();
  const result = await h.service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "dismiss" });
  assert.equal(result.state, "dismissed"); assert.equal(h.writes, 0);
});

test("CFG-T06: nested DTO extensions cannot leak private server references", async () => {
  const h = harness(); const view = await h.service.propose("session", proposal);
  const record = h.service.getRecord("session", view.id);
  Object.assign(record.view.reason, { credentialHandle: "SECRET" });
  Object.assign(record.view.resumption, { secretRef: "SECRET" });
  Object.assign(record.view.activation, { backendReceipt: "SECRET" });
  record.view.autoApplyAt = new Date(Date.now() + 30_000).toISOString();
  record.view.decisionSource = "auto";
  record.view.stateVersion++;
  h.repo.transaction(() => h.repo.save(record, view.stateVersion));
  const projected = h.service.get("session", view.id);
  assert.equal(JSON.stringify(projected).includes("SECRET"), false);
  assert.equal(projected.autoApplyAt, record.view.autoApplyAt);
  assert.equal(projected.decisionSource, "auto");
  const version = record.view.stateVersion;
  delete record.view.autoApplyAt; record.view.stateVersion++;
  h.repo.transaction(() => h.repo.save(record, version));
  assert.equal(h.service.get("session", view.id).autoApplyAt, undefined);
  assert.equal(h.service.get("session", view.id).previewDigest, view.previewDigest);
});

test("CFG-T24/27: startup classifies an abandoned verification as unknown without sending another probe", async () => {
  let probes = 0;
  const h = harness({ verify: async () => { probes++; return { ok: true }; } });
  const view = await h.service.propose("session", proposal);
  h.repo.transaction(() => {
    const record = h.service.getRecord("session", view.id); record.view.state = "validating";
    record.approvedRevision = 1; record.approvedDigest = view.previewDigest; record.view.stateVersion++;
    h.repo.save(record, view.stateVersion);
    h.repo.saveVerificationAttempt({ id: `${view.id}:1:verify`, requestId: view.id, sessionId: "session", revision: 1, ownerId: "exited-process", state: "started", startedAt: new Date().toISOString() });
    h.repo.reserveIdempotency("session:pending", "pending-key", { approved: true }, view.id);
  });
  const restarted = new ConfigurationRequestService({ repository: h.repo, registry: h.registry, host: h.host });
  assert.equal(await restarted.recoverPendingVerifications(), 1);
  assert.equal(await restarted.recoverPendingVerifications(), 0);
  const recovered = restarted.get("session", view.id);
  assert.equal(recovered.state, "needs_fix"); assert.equal(recovered.error?.code, "VERIFICATION_RESULT_UNKNOWN");
  assert.equal(h.repo.getVerificationAttempt(`${view.id}:1:verify`)?.state, "unknown");
  assert.equal(probes, 0); assert.equal(h.writes, 0); assert.equal(h.repo.listOutbox().length, 0);
  await assert.rejects(restarted.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" }), { code: "INVALID_CONFIGURATION_INPUT" });
  const fresh = await restarted.preview("session", view.id, { expectedRevision: 1, values: proposal.values });
  assert.equal((await restarted.decide("session", view.id, { revision: fresh.revision, previewDigest: fresh.previewDigest!, decision: "apply" })).state, "applied");
  assert.equal(probes, 1);
});

test("CFG-T24: external writes enqueue approved operations and never claim a local application receipt", async () => {
  const h = harness();
  const registry = new ConfigurationRegistry().register({ ...h.adapter, persistence: "external_control", apply: undefined });
  const service = new ConfigurationRequestService({ repository: h.repo, registry, host: h.host });
  const view = await service.propose("session", proposal);
  const result = await service.decide("session", view.id, { revision: 1, previewDigest: view.previewDigest!, decision: "apply" });
  assert.equal(result.state, "applying"); assert.equal(h.writes, 0); assert.equal(h.repo.getReceipt(view.id), undefined);
  assert.equal(h.repo.listOutbox()[0]?.kind, "external_submit");
  assert.equal(result.activation.state, "not_requested");
});

test("CFG-T06/23: credential rebind callback shares the revision transaction", async () => {
  const h = harness({ credential: true }); const view = await h.service.propose("session", proposal);
  const service = new ConfigurationRequestService({ repository: h.repo, registry: h.registry, host: { ...h.host,
    onPreviewRevision(input) {
      assert.equal(h.db.isTransaction, true); assert.equal(input.fromRevision, 1); assert.equal(input.toRevision, 2);
      h.db.prepare("UPDATE domain_settings SET value='temporary'").run();
      throw new ConfigurationError("CREDENTIAL_DRAFT_EXPIRED", "Re-enter the credential", 410);
    },
  } });
  await assert.rejects(service.preview("session", view.id, { expectedRevision: 1, values: proposal.values, credentialHandle: "opaque-handle" }), { code: "CREDENTIAL_DRAFT_EXPIRED" });
  assert.equal(service.get("session", view.id).revision, 1);
  assert.equal(h.repo.getRevision(view.id, 2), undefined);
  assert.equal((h.db.prepare("SELECT value FROM domain_settings").get() as { value: string }).value, "[]");
});

for (const retryable of [false, true]) {
  test(`review typed verification failures preserve public code, field and retryability: ${retryable}`, async () => {
    const privateBody = "synthetic-private-provider-response";
    const h = harness({ verify: async () => { throw new ConfigurationError("ADAPTER_CHECK_UNAVAILABLE", privateBody, 503, "connectorId", retryable); } });
    try {
      const view = await h.service.propose("session", proposal);
      const result = await h.service.decide("session", view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply" });
      assert.equal(result.state, "needs_fix");
      assert.equal(result.error?.code, "ADAPTER_CHECK_UNAVAILABLE");
      assert.equal(result.error?.retryable, retryable);
      assert.equal(result.error?.field, "connectorId");
      assert.deepEqual(h.service.get("session", view.id).error, result.error);
      assert.equal(h.repo.getVerificationAttempt(`${view.id}:${view.revision}:verify`)?.code, "ADAPTER_CHECK_UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private-provider-response/);
      assert.equal(h.writes, 0);
    } finally { h.db.close(); }
  });
}

test("review unexpected verification errors stay generic and never disclose provider data", async () => {
  const h = harness({ verify: async () => { throw new Error("synthetic-private-provider-response"); } });
  try {
    assert.equal(new ConfigurationError("DEFAULT_TERMINAL", "safe").retryable, false);
    const view = await h.service.propose("session", proposal);
    const result = await h.service.decide("session", view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply" });
    assert.equal(result.error?.code, "CONFIGURATION_VERIFICATION_FAILED"); assert.equal(result.error?.retryable, false);
    assert.equal(result.error?.field, undefined); assert.equal(h.writes, 0);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-provider-response/);
  } finally { h.db.close(); }
});

test("review typed verification fields must belong to the approved form", async () => {
  const h = harness({ verify: async () => { throw new ConfigurationError("ADAPTER_CHECK_UNAVAILABLE", "private provider text", 503, "synthetic-private-field", true); } });
  try {
    const view = await h.service.propose("session", proposal);
    const result = await h.service.decide("session", view.id, { revision: view.revision, previewDigest: view.previewDigest!, decision: "apply" });
    assert.equal(result.error?.code, "ADAPTER_CHECK_UNAVAILABLE"); assert.equal(result.error?.retryable, true);
    assert.equal(result.error?.field, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private provider text|synthetic-private-field/);
  } finally { h.db.close(); }
});
