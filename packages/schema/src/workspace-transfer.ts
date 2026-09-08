// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
export interface WorkspaceTransferInput {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  files: Array<{ sourcePath: string; targetPath: string }>;
  conflict?: "reject" | "overwrite";
}
export interface WorkspaceTransfer extends WorkspaceTransferInput {
  id: string; sessionId: string; agentId: string;
  state: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled" | "unknown";
  createdAt: string; finishedAt?: string; error?: string; errorCode?: string;
  sourceSnapshotId?: string;
  progress: Array<{ sourcePath: string; targetPath: string; size: number; sha256: string; bytes: number;
    state: "pending" | "copying" | "completed" | "failed" | "cancelled" | "unknown"; error?: string }>;
}
