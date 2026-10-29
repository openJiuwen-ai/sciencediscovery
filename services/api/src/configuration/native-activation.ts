// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { describeMcpWorkspaceTools } from "@sciencediscovery/artifact-manager";
import { filterEnabledMcpSources, type McpSourceRegistry } from "@sciencediscovery/mcp-sources";
import type { McpSourceCatalog } from "@sciencediscovery/data-source";
import type { WorkspaceAgentOptions } from "@sciencediscovery/workspace";
import type { SessionStore } from "../store.js";
import type { ConfigurationApplyReceipt, ConfigurationRecord } from "./types.js";
import type { ConfigurationActivationEvidence } from "./runtime-bridge.js";
import { configurationDecisionReady } from "./interaction-wait.js";
import { canonical, digest } from "./validation.js";
import { nativeApprovedRunConnectorIds, nativeRunOverlay, validatePersistedNativeChoice, nativeExecutionDependenciesCurrent } from "./native-choices.js";

type ToolDescriptor = Omit<NonNullable<WorkspaceAgentOptions["mcpTools"]>[number], "execute">;
interface NativeToolWitness { evidence: ConfigurationActivationEvidence; enabledConnectorIds: string[]; stopGeneration: number; }
export function nativeToolFingerprint(tools: readonly ToolDescriptor[]): string {
  return digest(tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    routing: tool.routing, sourceId: tool.sourceId, toolId: tool.toolId, displayName: tool.displayName })).sort((a, b) => a.name.localeCompare(b.name)));
}
function ensureTable(store: SessionStore): void {
  store.getConfigurationDatabase().exec(`CREATE TABLE IF NOT EXISTS configuration_native_activation_v2 (
    request_id TEXT NOT NULL, revision INTEGER NOT NULL, run_id TEXT NOT NULL, record_json TEXT NOT NULL,
    verified_at TEXT, PRIMARY KEY(request_id,revision)
  )`);
}

/** Assemble the actual workspace tool descriptors from the frozen run + approved delta, without invoking them. */
export async function prepareNativeConnectorActivation(input: { store: SessionStore; record: ConfigurationRecord;
  receipt: ConfigurationApplyReceipt; registry: McpSourceRegistry; catalog: McpSourceCatalog }): Promise<ConfigurationActivationEvidence> {
  const { store, record, receipt } = input;
  const snapshot = store.configurationSnapshot(record.view.sessionId, record.view.capabilityId, record.target);
  if (snapshot.stopGeneration !== record.stopGeneration || !nativeExecutionDependenciesCurrent(store, record, receipt))
    throw new Error("Configuration activation baseline changed");
  const evidence: ConfigurationActivationEvidence = { requestId: record.view.id, revision: record.view.revision,
    receiptId: receipt.id, runId: record.view.runId, effectiveRevision: digest(receipt.executionDependencies ?? snapshot.resourceVersions),
    toolCatalogFingerprint: "", activatedAt: new Date().toISOString() };
  if (!record.view.runId) {
    if (record.plan.activationMode !== "before_first_run") throw new Error("No current runtime activation is supported for this setting");
    const modelId = store.getSessionSettings(record.view.sessionId).effective.modelId;
    const model = modelId ? store.getModel(modelId) : undefined;
    if (!model || (!store.getModelApiToken(model.id) && !store.modelAllowsMissingToken(model))) throw new Error("The effective task model is not usable");
    evidence.toolCatalogFingerprint = digest({ beforeFirstRun: true, modelId: model.id, model, tools: [] });
    return evidence;
  }
  if (record.view.capabilityId !== "connector.enable" || record.plan.activationMode !== "same_run") throw new Error("Native same-run activation only supports installed connectors");
  const run = await store.getSessionRun(record.view.sessionId, record.view.runId);
  if (!run || !run.configurationWait || run.status !== "blocked" || run.configurationCheckpoint?.requestId !== record.view.id
    || run.configurationCheckpoint.stopGeneration !== record.stopGeneration) throw new Error("The matching Native configuration checkpoint is not waiting");
  const connectorId = String(record.input.connectorId);
  if (record.view.choiceReceipt?.kind === "run_overlay") {
    const overlay = nativeRunOverlay(store, record.view.sessionId, run.id, record.view.id);
    if (!overlay || overlay.revision !== record.view.revision || overlay.previewDigest !== record.approvedDigest
      || overlay.optionId !== record.view.selectedOptionId || overlay.connectorId !== connectorId
      || overlay.checkpoint.requestId !== run.configurationCheckpoint.requestId
      || overlay.checkpoint.committedAt !== run.configurationCheckpoint.committedAt
      || canonical(overlay.checkpoint.historyRef) !== canonical(run.configurationCheckpoint.historyRef))
      throw new Error("The approved Native run overlay does not match the original checkpoint");
  }
  const enabledConnectorIds = [...new Set([...nativeApprovedRunConnectorIds(store, run), connectorId])];
  if (!filterEnabledMcpSources(enabledConnectorIds, run.settingsSnapshot.plugins).includes(connectorId)) throw new Error("The frozen run policy does not allow this connector");
  const descriptors = describeMcpWorkspaceTools({ registry: input.registry, catalog: input.catalog, enabledSourceIds: enabledConnectorIds });
  if (!descriptors.some(tool => tool.sourceId === connectorId)) throw new Error("The approved connector has no executable tool descriptors");
  evidence.toolCatalogFingerprint = nativeToolFingerprint(descriptors);
  const witness: NativeToolWitness = { evidence, enabledConnectorIds, stopGeneration: record.stopGeneration };
  ensureTable(store);
  await store.runConfigurationTransaction(record.view.sessionId, () => {
    if (store.notifications.generation(record.view.sessionId) !== record.stopGeneration) throw new Error("Configuration activation was stopped");
    const db = store.getConfigurationDatabase();
    const previous = db.prepare("SELECT record_json FROM configuration_native_activation_v2 WHERE request_id=? AND revision=?").get(record.view.id, record.view.revision) as { record_json: string } | undefined;
    if (previous) {
      const saved = JSON.parse(previous.record_json) as NativeToolWitness;
      if (saved.evidence.toolCatalogFingerprint !== evidence.toolCatalogFingerprint || saved.evidence.receiptId !== receipt.id)
        throw new Error("The prepared Native tool catalog changed");
      evidence.activatedAt = saved.evidence.activatedAt;
      return;
    }
    db.prepare("INSERT INTO configuration_native_activation_v2 (request_id,revision,run_id,record_json) VALUES (?,?,?,?)")
      .run(record.view.id, record.view.revision, run.id, JSON.stringify(witness));
  });
  return evidence;
}

/** Called after real executable tools are rebuilt, before the resumed model can run. Legacy requests have no V2 witness. */
export function verifyNativeConfigurationToolAssembly(input: { store: SessionStore; sessionId: string; runId: string;
  requestId: string; enabledConnectorIds: readonly string[]; tools: NonNullable<WorkspaceAgentOptions["mcpTools"]>; webSearchAvailable?: boolean }): void {
  const db = input.store.getConfigurationDatabase();
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='configuration_native_activation_v2'").get();
  const row = hasTable ? db.prepare("SELECT record_json,revision FROM configuration_native_activation_v2 WHERE request_id=? AND run_id=? ORDER BY revision DESC LIMIT 1")
    .get(input.requestId, input.runId) as { record_json: string; revision: number } | undefined : undefined;
  const hasRequests = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='configuration_requests_v2'").get();
  const v2 = hasRequests ? db.prepare("SELECT record_json FROM configuration_requests_v2 WHERE id=? AND session_id=?").get(input.requestId, input.sessionId) as { record_json: string } | undefined : undefined;
  if (!v2) return;
  const record = JSON.parse(v2.record_json) as ConfigurationRecord;
  if (record.view.state === "dismissed") {
    if (record.view.choiceReceipt?.kind === "alternative") {
      validatePersistedNativeChoice(input.store, record);
      if (!input.webSearchAvailable || !input.enabledConnectorIds.includes("web")) throw new Error("The selected Native alternative has no executable Web search tool");
    }
    return;
  }
  if (record.plan.activationMode === "next_run" || record.plan.activationMode === "requires_restart") {
    const saved = db.prepare("SELECT record_json FROM configuration_receipts_v2 WHERE request_id=? AND revision=?")
      .get(record.view.id, record.view.revision) as { record_json: string } | undefined;
    const receipt = saved ? JSON.parse(saved.record_json) as ConfigurationApplyReceipt : undefined;
    if (!configurationDecisionReady(record) || !receipt || receipt.revision !== record.approvedRevision
      || receipt.previewDigest !== record.approvedDigest || receipt.stopGeneration !== input.store.notifications.generation(input.sessionId))
      throw new Error("The deferred configuration decision does not match its approved receipt");
    return;
  }
  if (!row) throw new Error("The V2 configuration has no prepared Native activation witness");
  const witness = JSON.parse(row.record_json) as NativeToolWitness;
  const receiptRow = db.prepare("SELECT record_json FROM configuration_receipts_v2 WHERE request_id=? AND revision=?").get(input.requestId, row.revision) as { record_json: string } | undefined;
  const receipt = receiptRow ? JSON.parse(receiptRow.record_json) as ConfigurationApplyReceipt : undefined;
  const snapshot = input.store.configurationSnapshot(input.sessionId, record.view.capabilityId, record.target);
  if (record.view.state !== "applied" || record.view.revision !== row.revision || witness.evidence.requestId !== record.view.id
    || !receipt || receipt.id !== witness.evidence.receiptId || !nativeExecutionDependenciesCurrent(input.store, record, receipt)
    || canonical([...input.enabledConnectorIds].sort()) !== canonical([...witness.enabledConnectorIds].sort())
    || witness.stopGeneration !== input.store.notifications.generation(input.sessionId)
    || nativeToolFingerprint(input.tools) !== witness.evidence.toolCatalogFingerprint) throw new Error("The resumed Native tool assembly does not match the approved activation witness");
  if (record.view.choiceReceipt?.kind === "run_overlay") {
    const overlay = nativeRunOverlay(input.store, input.sessionId, input.runId, input.requestId);
    if (!overlay || overlay.revision !== record.view.revision || overlay.previewDigest !== record.approvedDigest)
      throw new Error("The resumed Native overlay no longer matches its approval");
  }
  db.prepare("UPDATE configuration_native_activation_v2 SET verified_at=? WHERE request_id=? AND revision=?")
    .run(new Date().toISOString(), input.requestId, row.revision);
}
