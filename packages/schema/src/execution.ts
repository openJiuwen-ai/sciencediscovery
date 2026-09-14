// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ShellExecutionResult } from "./environment.js";

export interface ExecutionOwner { sessionId: string; agentId: string }
export interface ManagedExecution extends ExecutionOwner {
  id: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  queuedAt: string;
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
  id: string;
  runnerId: string;
  workspaceId: string;
  turnId: string;
  state: ManagedExecution["state"];
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  accepted: boolean;
  provenance: "pending" | "committed" | "unconfirmed";
  runnerVersionId?: string;
  result?: AgentShellExecutionResult;
  error?: string;
}
