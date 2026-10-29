// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { SessionStore } from "../store.js";
import type { ConfigurationRecord } from "./types.js";

export const CONFIGURATION_PENDING_STATES = new Set([
  "collecting_input", "awaiting_confirmation", "needs_fix", "validating", "applying", "failed",
]);

/** All capabilities share this interaction lifecycle; activation timing is independent. */
export function configurationDecisionReady(record: ConfigurationRecord): boolean {
  return record.view.state === "dismissed" || record.view.state === "applied"
    && (record.plan.activationMode === "next_run" || record.plan.activationMode === "requires_restart"
      ? record.view.activation.state === "needs_user_action"
      : record.view.activation.state === "active");
}

/** Compatibility projection, not a second request store or connector-specific wait. */
export function listConfigurationInteractions(store: SessionStore, sessionId: string) {
  const db = store.getConfigurationDatabase();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='configuration_requests_v2'").get();
  const records = exists ? (db.prepare("SELECT record_json FROM configuration_requests_v2 WHERE session_id=? ORDER BY rowid DESC")
    .all(sessionId) as Array<{ record_json: string }>).map(row => JSON.parse(row.record_json) as ConfigurationRecord) : [];
  const ids = new Set(records.map(record => record.view.id));
  return [...records.map(record => ({ id: record.view.id, runId: record.view.runId ?? "", state: record.view.state,
    connectorId: record.view.capabilityId === "connector.enable" ? String(record.input.connectorId) : "",
    connectorName: record.view.capabilityId, stopGeneration: record.stopGeneration })),
    ...store.listConnectorConfigurationRequests(sessionId).filter(record => !ids.has(record.id))];
}

export function getConfigurationInteraction(store: SessionStore, sessionId: string, requestId: string) {
  const db = store.getConfigurationDatabase();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='configuration_requests_v2'").get();
  const row = exists ? db.prepare("SELECT record_json FROM configuration_requests_v2 WHERE id=? AND session_id=?")
    .get(requestId, sessionId) as { record_json: string } | undefined : undefined;
  if (!row) return store.getConnectorConfigurationRequest(sessionId, requestId);
  const record = JSON.parse(row.record_json) as ConfigurationRecord;
  return { id: record.view.id, runId: record.view.runId ?? "", state: record.view.state,
    connectorId: record.view.capabilityId === "connector.enable" ? String(record.input.connectorId) : "",
    connectorName: record.view.capabilityId, stopGeneration: record.stopGeneration };
}
