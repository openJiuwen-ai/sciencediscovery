// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { filterEnabledMcpSources } from "@sciencediscovery/mcp-sources";
import type { RuntimeSettingsOverrides } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { nativeToolFingerprint } from "./native-activation.js";
import { nativeRuntimeConnectorIds, recordNativeRunChoiceContext } from "./native-choices.js";
import type { ConfigurationApplyReceipt, ConfigurationRecord } from "./types.js";
import type { ConfigurationActivationEvidence } from "./runtime-bridge.js";

type Descriptor = Parameters<typeof nativeToolFingerprint>[0][number];

/** Admit exactly the approved connector to the existing governed recovery dispatcher. */
export function activateJiuwenConnector(input: {
  store: SessionStore; sessionId: string; runId: string; record: ConfigurationRecord; receipt: ConfigurationApplyReceipt;
  plugins?: RuntimeSettingsOverrides["plugins"]; initialTools: readonly Descriptor[]; activatedTools: Map<string, Descriptor>;
  activateSource(sourceId: string): readonly Descriptor[];
}): ConfigurationActivationEvidence {
  const { store, sessionId, runId, record, receipt } = input;
  if (record.view.capabilityId !== "connector.enable" || record.view.runId !== runId
    || record.stopGeneration !== store.notifications.generation(sessionId) || !store.notifications.canWake(sessionId))
    throw new Error("Configuration activation no longer belongs to this task");
  if (!receipt.result.resourceRevision) throw new Error("Configuration receipt has no resource revision");
  const connectorId = String(record.input.connectorId);
  const current = store.getSessionSettings(sessionId).effective;
  if (!current.enabledConnectorIds.includes(connectorId)
    || !filterEnabledMcpSources([connectorId], current.plugins).includes(connectorId)
    || !filterEnabledMcpSources([connectorId], input.plugins).includes(connectorId))
    throw new Error("Connector policy no longer permits this activation");
  // Frozen settings can contain unavailable sources. Preserve the actual live set,
  // not that wishlist; otherwise the post-activation dependency comparison changes.
  const runtimeSources = nativeRuntimeConnectorIds(store, sessionId, runId);
  if (!runtimeSources) throw new Error("Original runtime source set is unavailable");
  const descriptors = input.activateSource(connectorId);
  for (const tool of descriptors) input.activatedTools.set(tool.name, tool);
  const fingerprint = nativeToolFingerprint([...input.initialTools, ...input.activatedTools.values()]);
  recordNativeRunChoiceContext({ store, sessionId, runId,
    enabledConnectorIds: [...new Set([...runtimeSources, connectorId])],
    webSearchAvailable: runtimeSources.includes("web"), plugins: input.plugins, toolCatalogFingerprint: fingerprint });
  return { requestId: record.view.id, revision: receipt.revision, receiptId: receipt.id, runId,
    effectiveRevision: receipt.result.resourceRevision, toolCatalogFingerprint: fingerprint, activatedAt: new Date().toISOString() };
}
