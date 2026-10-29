// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ExecutionRecovery, RecoveryContext } from "./recovery.js";
import type { ShellExecutionResult } from "./environment.js";

export interface ExecutionOwner { sessionId: string; agentId: string }

/** Stable acceptance identity, persisted with the Runner's execution ledger. */
export interface ExecutionReceipt {
  runnerInstanceId: string;
  runnerBootId: string;
  revision: number;
  requestDigest: string;
  acceptedAt: string;
}

/** Evidence is populated only by the process owner, never inferred from a lost connection. */
export interface ExecutionEvidence {
  runnerInstanceId: string;
  runnerBootId: string;
  revision: number;
  processTerminated: boolean;
  terminationReason?: string;
  resultDigest?: string;
  workspaceVersionDigest?: string;
}

export interface ExecutionObservation {
  status: "fresh" | "stale" | "reconciling" | "blocked";
  lastObservedAt?: string;
  lastRunnerState?: ManagedExecution["state"];
  failureCount: number;
  nextRetryAt?: string;
  lastError?: { code: string; message: string; retryable: boolean; httpStatus?: number };
}

export interface ManagedExecution extends ExecutionOwner {
  receipt?: ExecutionReceipt;
  evidence?: ExecutionEvidence;
  /** Canonical admission key, persisted to quarantine unconfirmed work after restart. */
  workspaceKey?: string;
  npuDevices?: number[];
  id: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  queuedAt: string;
  recovery?: ExecutionRecovery;
  recoveryContext?: RecoveryContext;
  startedAt?: string;
  finishedAt?: string;
  result?: ShellExecutionResult;
  error?: string;
  logTruncated?: boolean;
  /** CAS record containing the completed workspace tree and execution logs. */
  version?: { pool: "agent-state"; digest: `sha256:${string}`; size: number; mediaType: string };
}
export interface ExecutionLogPage {
  chunks: Array<{ cursor: number; stream: "stdout" | "stderr"; text: string }>;
  nextCursor: number;
  truncated: boolean;
  retentionTruncated: boolean;
  /** The control plane's record of how the execution ended, attached when the
   * page is read through an Agent tool after the execution reached a terminal
   * state. A Runner's own page never carries it. */
  state?: ManagedExecution["state"];
  finishedAt?: string;
}

/** Control-plane ownership; Runner refs remain namespaced, not local CAS refs. */
export interface RunnerWorkspaceReference {
  runnerId: string;
  pool: "agent-state";
  /** Address in the named Runner's store, not a dependency in the API's CAS. */
  objectId: `sha256:${string}`;
  size: number;
  mediaType: string;
}

export type AgentShellExecutionResult = Omit<ShellExecutionResult, "workspaceSnapshot" | "workspaceVersion"> & {
  workspaceSnapshot?: ShellExecutionResult["workspaceSnapshot"] | RunnerWorkspaceReference;
  workspaceVersion?: ShellExecutionResult["workspaceVersion"] | RunnerWorkspaceReference;
};

export interface AgentShellExecution extends ExecutionOwner {
  receipt?: ExecutionReceipt;
  evidence?: ExecutionEvidence;
  observation?: ExecutionObservation;
  dispatchPhase?: "prepared" | "dispatching" | "accepted" | "rejected";
  finalization?: "pending" | "committed" | "failed";
  id: string;
  runnerId: string;
  workspaceId: string;
  turnId: string;
  state: ManagedExecution["state"];
  queuedAt: string;
  recovery?: ExecutionRecovery;
  recoveryContext?: RecoveryContext;
  startedAt?: string;
  finishedAt?: string;
  accepted: boolean;
  provenance: "pending" | "committed" | "unconfirmed";
  runnerVersionId?: string;
  result?: AgentShellExecutionResult;
  error?: string;
}
