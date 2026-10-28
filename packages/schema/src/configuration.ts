// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** The first additional conversational-settings adapter: an installed connector. */
export interface ConnectorConfigurationRequest {
  id: string;
  sessionId: string;
  projectId: string;
  runId: string;
  connectorId: string;
  connectorName: string;
  reason: string;
  baselineConnectorIds: string[];
  state: "awaiting_confirmation" | "applied" | "dismissed" | "stale";
  createdAt: string;
  updatedAt: string;
  /** Set only for a task run; a standalone configuration instruction has no task to resume. */
  continuationRunId?: string;
  /** Present only when a separate Session authorization was active at proposal time. */
  autoApplyAt?: string;
  decisionSource?: "user" | "auto";
  /** Session stop generation at proposal time; a Stop invalidates this request. */
  stopGeneration?: number;
}

export type ConnectorConfigurationPreflightResult =
  | { status: "not_applicable" }
  | { status: "proposal"; request: ConnectorConfigurationRequest | ConfigurationRequestView }
  | { status: "already_enabled"; connectorName: string }
  | { status: "unavailable"; connectorName: string };

/** Public v2 contracts. Secrets and executable adapter plans never belong in these views. */
export type ConfigurationCapabilityId = "model.select" | "model.connect" | "model.repair_credential" | "connector.enable" | "skill.select" | "thinking.configure" | "review.configure" | "timeouts.configure" | "quotas.configure" | "idea_tree.configure";
export type ConfigurationScope = { kind: "session" | "project"; id: string } | { kind: "global" };
export type ConfigurationScalar = string | number | boolean;
export type ConfigurationValue = ConfigurationScalar | string[];
export type ConfigurationValues = Record<string, ConfigurationValue>;
export type ConfigurationRequestState = "collecting_input" | "awaiting_confirmation" | "validating" | "applying" | "applied" | "needs_fix" | "stale" | "failed" | "dismissed" | "cancelled" | "expired";
export type ConfigurationAction = "preview" | "apply" | "dismiss" | "continue" | "reversal" | "query" | "cancel";
export type ConfigurationChoiceKind = "persisted_apply" | "run_overlay" | "alternative" | "dismiss";
export interface ConfigurationChoiceOptionView {
  id: string;
  kind: ConfigurationChoiceKind;
  label: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
  /** Registered, finite path identifier; never executable instructions. */
  alternativeId?: string;
}
export interface ConfigurationChoiceReceipt {
  optionId: string;
  kind: ConfigurationChoiceKind;
  label: string;
  configurationWritten: boolean;
  scope: "run" | "session" | "project" | "global" | "none";
  runId?: string;
  alternativeId?: string;
}
export type ConfigurationFieldView = {
  id: string;
  label: string;
  required: boolean;
  description?: string;
  placeholder?: string;
  help?: { label: string; url: string };
} & (
  | { kind: "credential"; status: "missing" | "provided" | "expired" }
  | { kind: "multiselect"; value?: string[]; choices: Array<{ id: string; label: string }> }
  | { kind: "text" | "url" | "number" | "boolean" | "enum"; value?: ConfigurationScalar; choices?: Array<{ id: string; label: string }> }
);
export interface ConfigurationRequestView {
  endpointAuthorization?: ConfigurationEndpointAuthorization;
  /** Missing means the historical v2 apply/dismiss protocol. */
  protocolVersion?: 3;
  options?: ConfigurationChoiceOptionView[];
  selectedOptionId?: string;
  choiceReceipt?: ConfigurationChoiceReceipt;
  needKey?: string;
  id: string;
  sessionId: string;
  projectId: string;
  runId?: string;
  revision: number;
  stateVersion: number;
  capabilityId: ConfigurationCapabilityId;
  adapterVersion: number;
  schemaVersion: number;
  state: ConfigurationRequestState;
  reason: { code: string; message: string };
  scope: ConfigurationScope;
  fields: ConfigurationFieldView[];
  changes: Array<{ field: string; before?: string; after?: string }>;
  impact: { resourceLocation: string; effectiveScope: string; message: string };
  verificationPlan: { targets: string[]; actions: string[]; maxRequests: number; mayCharge: boolean };
  previewDigest?: string;
  activation: {
    mode: "before_first_run" | "same_run" | "next_run" | "requires_restart";
    state: "not_requested" | "pending" | "active" | "failed" | "suppressed" | "needs_user_action";
    effectiveRevision?: string;
  };
  resumption: { state: "not_requested" | "pending" | "queued" | "started" | "completed" | "failed" | "suppressed" | "needs_user_action"; runId?: string };
  error?: { code: string; message: string; field?: string; retryable: boolean };
  allowedActions: ConfigurationAction[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  /** Server-scheduled only under a separate, revocable low-risk Session authorization. */
  autoApplyAt?: string;
  decisionSource?: "user" | "auto";
}
export interface ConfigurationPreviewInput {
  expectedRevision: number;
  values: ConfigurationValues;
  scope?: ConfigurationScope;
  credentialHandle?: string;
  selectedOptionId?: string;
}
export interface ConfigurationDecisionInput {
  revision: number;
  previewDigest: string;
  decision: "apply" | "dismiss";
  selectedOptionId?: string;
}
export interface ConfigurationCredentialInput {
  expectedRevision: number;
  fieldId: string;
  secret: string;
}
export interface ConfigurationCredentialDraftView { handle: string; expiresAt: string; }
export interface ConfigurationEndpointAuthorization {
  endpointTarget: string;
  host: string;
  classification: "trusted_preset" | "public_https" | "loopback" | "private_network" | "public_http";
  status: "required" | "confirmed" | "trusted" | "blocked";
  revision: number;
}
export interface ConfigurationEndpointConsentInput { revision: number; endpointTarget: string; }
export interface ConfigurationCapabilityView {
  id: ConfigurationCapabilityId;
  adapterVersion: number;
  schemaVersion: number;
  scopes: Array<ConfigurationScope["kind"]>;
  persistence: "local_transaction" | "external_control";
  autoApplyEligible: boolean;
}
