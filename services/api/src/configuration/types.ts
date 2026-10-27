// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationCapabilityId, ConfigurationFieldView, ConfigurationScope, ConfigurationRequestView, ConfigurationValues, ConfigurationChoiceOptionView } from "@sciencediscovery/schema";
import type { DatabaseSync } from "node:sqlite";

export interface ConfigurationSnapshot {
  projectId: string;
  stopGeneration: number;
  writable: boolean;
  resourceVersions: Record<string, string>;
  /** Server-only domain state; never projected to an Agent or HTTP response. */
  data: Record<string, unknown>;
  runId?: string;
}
export interface ConfigurationPlan {
  endpointAuthorization?: Omit<NonNullable<ConfigurationRequestView["endpointAuthorization"]>, "revision" | "status">;
  fields: ConfigurationFieldView[];
  changes: ConfigurationRequestView["changes"];
  impact: ConfigurationRequestView["impact"];
  verificationPlan: ConfigurationRequestView["verificationPlan"];
  activationMode: ConfigurationRequestView["activation"]["mode"];
  ready: boolean;
  /** Explicit adapter verdict; empty required input is not an unchanged request. */
  disposition?: "change" | "no_change" | "missing_input";
  /** Adapter-owned, non-executable server state. Never included in the public view. */
  data?: Record<string, unknown>;
}
export interface ConfigurationAdapterContext {
  selectedOption?: ConfigurationChoiceOptionView;
  runId?: string;
  previewDigest?: string;
  sessionId: string;
  requestId: string;
  revision: number;
  input: ConfigurationValues;
  plan: ConfigurationPlan;
  snapshot: ConfigurationSnapshot;
  scope: ConfigurationScope;
  /** Only the credential bridge resolves this opaque ref, never the Agent. */
  credentialHandle?: string;
}
export interface ConfigurationVerificationResult {
  ok: boolean;
  code?: string;
  message?: string;
  field?: string;
  retryable?: boolean;
}
export interface ConfigurationApplyResult {
  resourceRevision?: string;
  summary?: string;
  /** Exact inverse input, including absence markers encoded by the registered domain adapter. */
  reversal?: ConfigurationValues;
}
export interface ConfigurationAdapter {
  readonly id: ConfigurationCapabilityId;
  readonly version: number;
  readonly schemaVersion: number;
  readonly scopes: ReadonlyArray<ConfigurationScope["kind"]>;
  readonly persistence: "local_transaction" | "external_control";
  readonly autoApplyEligible?: boolean;
  readonly fieldPolicy?: { helpHosts?: readonly string[]; credentialFields?: readonly string[] };
  normalize(input: unknown): ConfigurationValues;
  target(input: ConfigurationValues): string;
  preview(input: ConfigurationValues, snapshot: ConfigurationSnapshot, scope: ConfigurationScope): ConfigurationPlan;
  verify?(context: ConfigurationAdapterContext): Promise<ConfigurationVerificationResult>;
  /** Synchronous, called within the host's existing domain + repository transaction. */
  apply?(context: ConfigurationAdapterContext): ConfigurationApplyResult;
  previewReversal?(receipt: ConfigurationApplyReceipt, snapshot: ConfigurationSnapshot): ConfigurationValues;
}
export interface ConfigurationHost {
  afterCommit?(sessionId: string): Promise<void>;
  executionDependencies?(record: ConfigurationRecord): Record<string, string> | undefined;
  projectEndpointAuthorization?(record: ConfigurationRecord): ConfigurationRequestView["endpointAuthorization"];
  choiceOptions?(input: { sessionId: string; capabilityId: ConfigurationCapabilityId; input: ConfigurationValues; snapshot: ConfigurationSnapshot; scope: ConfigurationScope; runId?: string }): ConfigurationChoiceOptionView[];
  validateChoice?(context: ConfigurationAdapterContext): void;
  /** Run overlay writes only its isolated durable record, never shared settings. */
  applyRunOverlay?(context: ConfigurationAdapterContext): ConfigurationApplyResult;
  runInTransaction<T>(sessionId: string, action: () => T): Promise<T>;
  snapshot(sessionId: string, capabilityId: ConfigurationCapabilityId, target: string): ConfigurationSnapshot;
  /** Validate the exact isolated draft while preparing a revision. An expired
   * implicit draft may be discarded; explicitly supplied stale handles reject. */
  resolvePreviewCredential?(input: { sessionId: string; requestId: string; revision: number; target: string; credentialHandle: string; explicit: boolean }): string | undefined;
  /** Rebinds an encrypted draft on the same SQLite connection, before revision commit. */
  onPreviewRevision?(input: { sessionId: string; requestId: string; fromRevision: number; toRevision: number; oldTarget: string; newTarget: string; credentialHandle?: string }): void;
}
export interface ConfigurationRecord {
  view: ConfigurationRequestView;
  adapterVersion: number;
  schemaVersion: number;
  input: ConfigurationValues;
  target: string;
  plan: ConfigurationPlan;
  resourceVersions: Record<string, string>;
  stopGeneration: number;
  credentialHandle?: string;
  fingerprint: string;
  approvedRevision?: number;
  approvedDigest?: string;
  createdBy: string;
}
export interface ConfigurationApplyReceipt {
  /** Frozen execution dependencies, separate from the formal write CAS vector. */
  executionDependencies?: Record<string, string>;
  id: string;
  requestId: string;
  revision: number;
  previewDigest: string;
  capabilityId: ConfigurationCapabilityId;
  sessionId: string;
  stopGeneration: number;
  result: ConfigurationApplyResult;
  resourceVersions: Record<string, string>;
  createdAt: string;
}
export interface ConfigurationOutboxRecord {
  id: string;
  requestId: string;
  revision: number;
  sessionId: string;
  kind: "activate" | "resume" | "external_submit";
  state: "pending" | "claimed" | "done" | "suppressed";
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface ConfigurationProposalInput {
  protocolVersion?: 3;
  capabilityId: ConfigurationCapabilityId;
  values: ConfigurationValues;
  scope?: ConfigurationScope;
  runId?: string;
  reason?: string;
  /** Trusted host binding for legacy/native checkpoint companions. Never accepted from Agent input. */
  requestId?: string;
}
export interface ConfigurationRepositoryOptions { database: DatabaseSync; }
export interface ConfigurationVerificationAttempt {
  id: string;
  requestId: string;
  sessionId: string;
  revision: number;
  ownerId: string;
  state: "started" | "succeeded" | "failed" | "unknown";
  startedAt: string;
  finishedAt?: string;
  code?: string;
}
