// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });
import type { SessionRun } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapterContext, ConfigurationPlan, ConfigurationRecord } from "./types.js";
import { applyNativeRunOverlay, nativeApprovedRunConnectorIds, nativeConnectorChoiceOptions, nativeRunOverlay,
  recordNativeChoiceCheckpoint, recordNativeRunChoiceContext, validateNativeChoice, validatePersistedNativeChoice } from "./native-choices.js";

function fixture(path = ":memory:") {
  const database = new DatabaseSync(path); let generation = 4, companionResolutions = 0;
  let webSettings = { freeSearchEngines: { bing: true }, paidSearchProviders: [], providers: [] };
  const store = { getConfigurationDatabase: () => database,
    notifications: { generation: () => generation, canWake: () => generation === 4 }, getWebSettings: () => webSettings,
    resolveConnectorConfigurationCompanionSync: () => { companionResolutions++; },
  } as unknown as SessionStore;
  const selectedOption = { id: "run-only", kind: "run_overlay" as const, label: "This task", description: "Only this task", available: true };
  const plan: ConfigurationPlan = { ready: true, fields: [], changes: [],
    impact: { resourceLocation: "Installed connectors", effectiveScope: "This task", message: "Enable PubMed for this task" },
    verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "same_run" };
  const record: ConfigurationRecord = { view: { id: "request", sessionId: "session", projectId: "project", runId: "run",
    capabilityId: "connector.enable", protocolVersion: 3, revision: 2, stateVersion: 1, adapterVersion: 1, schemaVersion: 1,
    state: "awaiting_confirmation", reason: { code: "connector_required", message: "PubMed is needed" },
    scope: { kind: "session", id: "session" }, options: [selectedOption], fields: plan.fields, changes: plan.changes,
    impact: plan.impact, verificationPlan: plan.verificationPlan,
    activation: { mode: "same_run", state: "not_requested" }, resumption: { state: "not_requested" },
    allowedActions: ["preview", "apply", "dismiss"], createdAt: "now", updatedAt: "now",
    previewDigest: "digest", selectedOptionId: "run-only" }, adapterVersion: 1, schemaVersion: 1,
    input: { connectorId: "pubmed" }, target: "pubmed", plan, resourceVersions: { settings: "baseline" },
    stopGeneration: 4, fingerprint: "request-fingerprint", createdBy: "test" };
  const context: ConfigurationAdapterContext = { selectedOption, sessionId: "session", requestId: "request", revision: 2,
    runId: "run", previewDigest: "digest", input: record.input, plan, scope: record.view.scope,
    snapshot: { projectId: "project", stopGeneration: 4, writable: true, data: {}, resourceVersions: { settings: "baseline" } } };
  const capture = (web = false) => recordNativeRunChoiceContext({ store, sessionId: "session", runId: "run", enabledConnectorIds: web ? ["web"] : [],
    webSearchAvailable: web, toolCatalogFingerprint: "actual-factory" });
  const checkpoint = () => recordNativeChoiceCheckpoint({ store, sessionId: "session", runId: "run", requestId: "request", stopGeneration: 4, historyRef: "history", committedAt: "now" });
  return { database, store, record, context, capture, checkpoint, resolutions: () => companionResolutions,
    stop: () => { generation++; }, changeWeb: () => { webSettings = { ...webSettings, freeSearchEngines: { bing: false } }; } };
}

for (const missing of ["selected option", "preview digest"]) {
  test(`CFG-T31 Native overlay rejects a missing ${missing} before writes`, () => {
    const f = fixture(); f.capture(); f.checkpoint();
    if (missing === "selected option") f.context.selectedOption = undefined;
    else delete f.record.view.previewDigest;
    f.database.exec("BEGIN");
    try {
      assert.throws(() => applyNativeRunOverlay(f.store, f.record, f.context), {
        code: "CONFIGURATION_CHOICE_APPROVAL_REQUIRED",
      });
      assert.equal(nativeRunOverlay(f.store, "session", "run", "request"), undefined);
      assert.equal(f.resolutions(), 0);
    } finally {
      f.database.exec("ROLLBACK");
      f.database.close();
    }
  });
}

for (const kind of ["persisted_apply", "dismiss", "alternative"] as const) {
  test(`CFG-T31 Native overlay rejects an explicit ${kind} selection before writes`, () => {
    const f = fixture(); f.capture(true); f.checkpoint();
    f.context.selectedOption = { id: kind, kind, label: kind, description: kind, available: true,
      ...(kind === "alternative" ? { alternativeId: "web-search" } : {}) };
    f.database.exec("BEGIN");
    try {
      assert.throws(() => applyNativeRunOverlay(f.store, f.record, f.context), {
        code: "CONFIGURATION_CHOICE_APPROVAL_REQUIRED",
      });
      assert.equal(nativeRunOverlay(f.store, "session", "run", "request"), undefined);
      assert.equal(f.resolutions(), 0);
    } finally {
      f.database.exec("ROLLBACK");
      f.database.close();
    }
  });
}

test("CFG-T31 Native overlay rejects an unavailable explicit selection before writes", () => {
  const f = fixture(); f.capture(); f.checkpoint();
  assert.ok(f.context.selectedOption);
  f.context.selectedOption = { ...f.context.selectedOption, available: false };
  f.database.exec("BEGIN");
  try {
    assert.throws(() => applyNativeRunOverlay(f.store, f.record, f.context), {
      code: "CONFIGURATION_CHOICE_APPROVAL_REQUIRED",
    });
    assert.equal(nativeRunOverlay(f.store, "session", "run", "request"), undefined);
    assert.equal(f.resolutions(), 0);
  } finally {
    f.database.exec("ROLLBACK");
    f.database.close();
  }
});

test("CFG-T31 persisted Native choices remain verifiable after recovery without authorizing an implicit apply", () => {
  const f = fixture(); f.capture(); f.checkpoint();
  assert.doesNotThrow(() => validatePersistedNativeChoice(f.store, f.record));
  f.context.selectedOption = undefined;
  f.database.exec("BEGIN");
  try {
    assert.throws(() => applyNativeRunOverlay(f.store, f.record, f.context), { code: "CONFIGURATION_CHOICE_APPROVAL_REQUIRED" });
    assert.equal(nativeRunOverlay(f.store, "session", "run", "request"), undefined);
    assert.equal(f.resolutions(), 0);
    f.stop();
    assert.throws(() => validatePersistedNativeChoice(f.store, f.record), { code: "CONFIGURATION_CHOICE_UNAVAILABLE" });
  } finally {
    f.database.exec("ROLLBACK");
    f.database.close();
  }
});

test("CFG-T31 Native overlay requires the exact durable checkpoint and an atomic transaction", () => {
  const f = fixture(); f.capture();
  assert.throws(() => applyNativeRunOverlay(f.store, f.record, f.context), /transaction/);
  f.database.exec("BEGIN");
  assert.throws(() => applyNativeRunOverlay(f.store, f.record, f.context), /checkpoint/);
  f.checkpoint(); applyNativeRunOverlay(f.store, f.record, f.context);
  applyNativeRunOverlay(f.store, f.record, f.context);
  f.database.exec("COMMIT");
  const saved = nativeRunOverlay(f.store, "session", "run", "request")!;
  assert.equal(saved.runId, "run"); assert.equal(saved.revision, 2); assert.equal(saved.previewDigest, "digest");
  assert.equal(saved.checkpoint.historyRef, "history"); assert.equal(saved.connectorId, "pubmed");
  assert.equal(nativeRunOverlay(f.store, "session", "other-run", "request"), undefined);
  const count = f.database.prepare("SELECT count(*) AS n FROM configuration_native_overlays_v3").get() as { n: number };
  assert.equal(count.n, 1);
  f.stop(); assert.equal(nativeRunOverlay(f.store, "session", "run", "request"), undefined);
  assert.throws(() => validateNativeChoice(f.store, f.record, f.context.selectedOption), /no longer available/);
  f.database.close();
});

test("CFG-T32 alternatives require actual frozen Web tool evidence and unchanged configured availability", () => {
  const f = fixture();
  const choices = () => nativeConnectorChoiceOptions({ store: f.store, sessionId: "session", runId: "run", ready: true });
  assert.equal(choices().some(option => option.kind === "run_overlay" || option.kind === "alternative"), false);
  f.capture(false); assert.equal(choices().some(option => option.kind === "alternative"), false);
  f.capture(true); const web = choices().find(option => option.kind === "alternative")!; assert.ok(web);
  assert.doesNotThrow(() => validateNativeChoice(f.store, f.record, web));
  f.changeWeb(); assert.equal(choices().some(option => option.kind === "alternative"), false);
  assert.throws(() => validateNativeChoice(f.store, f.record, web), /no verified/);
  f.database.close();
});

test("CFG-T31 terminal tasks cannot reuse formerly approved activation increments", () => {
  const f = fixture();
  f.database.exec("CREATE TABLE configuration_native_activation_v2(run_id TEXT,record_json TEXT)");
  f.database.prepare("INSERT INTO configuration_native_activation_v2 VALUES(?,?)").run("run", "not parsed for a terminal task");
  const run = { id: "run", sessionId: "session", status: "completed", settingsSnapshot: { enabledConnectorIds: ["arxiv"] } } as SessionRun;
  assert.deepEqual(nativeApprovedRunConnectorIds(f.store, run), ["arxiv"]);
  assert.deepEqual(run.settingsSnapshot.enabledConnectorIds, ["arxiv"]);
  f.database.close();
});

test("CFG-T31 a committed overlay survives SQLite reopen and remains bound to its original checkpoint and Stop generation", () => {
  const directory = mkdtempSync(join(tmpdir(), "configuration-overlay-"));
  try {
    const file = join(directory, "overlay.sqlite");
    const first = fixture(file); first.capture(); first.checkpoint(); first.database.exec("BEGIN");
    applyNativeRunOverlay(first.store, first.record, first.context); first.database.exec("COMMIT");
    const before = nativeRunOverlay(first.store, "session", "run", "request")!; first.database.close();
    const restarted = fixture(file);
    assert.deepEqual(nativeRunOverlay(restarted.store, "session", "run", "request"), before);
    assert.equal(nativeRunOverlay(restarted.store, "session", "queued-task", "request"), undefined);
    restarted.stop(); assert.equal(nativeRunOverlay(restarted.store, "session", "run", "request"), undefined);
    restarted.database.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
