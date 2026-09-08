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
