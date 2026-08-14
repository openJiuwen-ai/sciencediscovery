// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { McpError } from "./mcp-audit.js";
import type { McpSourceId, McpToolId } from "./mcp-source.js";

export type ArtifactKind =
  | "archive"
  | "dataset"
  | "expression-matrix"
  | "paper"
  | "sequence"
  | "structure";

export interface ArtifactChecksum {
  algorithm: "md5" | "sha256";
  value: string;
}

export interface ArtifactCandidate {
  attribution: string;
  checksum?: ArtifactChecksum;
  expectedBytes?: number;
  expiresAt?: string;
  format: string;
  id: string;
  kind: ArtifactKind;
  license: string;
  logicalName: string;
  mimeType?: string;
  sourceId: McpSourceId;
  sourceRecordId: string;
  sourceUrl: string;
}

export interface ArtifactDestination {
  path: string;
  type: "workspace";
}

export interface ArtifactPlan {
  candidates: ArtifactCandidate[];
  createdAt: string;
  destination: ArtifactDestination;
  estimatedBytes?: number;
  expiresAt?: string;
  id: string;
  mcpInvocationId: string;
  permissionAuthorizationId?: string;
  /** @deprecated Legacy audit reference retained for persisted plans. */
  permissionGrantId?: string;
  permissionRequestId: string;
  quotaAvailableBytes?: number;
  selectedCandidateId: string;
  sessionId: string;
  sourceId: McpSourceId;
  sourceRecordId: string;
  state: "approved" | "awaiting_approval" | "expired";
  toolId: McpToolId;
}

export interface ArtifactJob {
  actualChecksum?: string;
  attempts: number;
  createdAt: string;
  error?: McpError;
  expectedChecksum?: string;
  finalPath?: string;
  finishedAt?: string;
  id: string;
  maxAttempts: number;
  planId: string;
  permissionAuthorizationId: string;
  /** @deprecated Legacy audit reference retained for persisted jobs. */
  permissionGrantId?: string;
  progress: {
    bytesDownloaded: number;
    filesCompleted: number;
    filesTotal: number;
    percent?: number;
    totalBytes?: number;
  };
  projectId: string;
  sessionId: string;
  sourceId: McpSourceId;
  sourceRecordId: string;
  stagingPath?: string;
  startedAt?: string;
  state: "cancelled" | "completed" | "failed" | "queued" | "retrying" | "running" | "verifying";
  updatedAt: string;
}

export interface ArtifactDownloadResult {
  actualChecksum?: string;
  bytesDownloaded: number;
  candidateId: string;
  error?: McpError;
  finalPath?: string;
  jobId?: string;
  planId: string;
  sourceId: McpSourceId;
  sourceRecordId: string;
  status: "cancelled" | "completed" | "denied" | "failed";
}

export interface ArtifactExtractionJob {
  artifactJobId: string;
  createdAt: string;
  error?: McpError;
  finishedAt?: string;
  id: string;
  manifestPath?: string;
  paperAcquisitionId?: string;
  sessionId: string;
  startedAt?: string;
  state: "cancelled" | "completed" | "failed" | "queued" | "running";
  textPath?: string;
  updatedAt: string;
}

export interface CreateArtifactPlanRequest {
  candidateId: string;
  destination: ArtifactDestination;
  mcpInvocationId: string;
}

export interface PrepareArtifactRequest {
  destination: ArtifactDestination;
  input: import("./mcp-result.js").JsonValue;
  projectId: string;
  sessionId: string;
  sourceId: McpSourceId;
  sourceRecordId: string;
  toolId: McpToolId;
}
