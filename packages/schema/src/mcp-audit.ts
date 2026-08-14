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

import type { CasObjectRef } from "./provenance.js";
import type { JsonValue } from "./mcp-result.js";
import type { McpRetryPolicy, McpSourceId, McpToolId } from "./mcp-source.js";
import type { ResolvedProxy } from "./proxy.js";

export type McpAttemptStatus =
  | "rate-limited"
  | "semantic-error"
  | "server-error"
  | "succeeded"
  | "timeout"
  | "transport-error";

export interface McpAttempt {
  attempt: number;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  finishedAt: string;
  retryAfterMs?: number;
  startedAt: string;
  status: McpAttemptStatus;
}

export type McpErrorCode =
  | "CANCELLED"
  | "INVALID_INPUT"
  | "LICENSE_BLOCKED"
  | "NORMALIZATION_FAILED"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "RATE_LIMIT_QUEUE_FULL"
  | "RATE_LIMIT_QUEUE_TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "SOURCE_DISABLED"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "UPSTREAM_UNAVAILABLE";

export interface McpError {
  code: McpErrorCode;
  message: string;
  retryAfterMs?: number;
  retryable: boolean;
  upstreamCode?: string;
}

export interface McpInvocation {
  adapterVersion: string;
  attempts: McpAttempt[];
  attribution: string;
  cache: {
    hit: boolean;
    key: string;
    scope: string;
  };
  error?: McpError;
  finishedAt: string;
  id: string;
  license: string;
  mcpCatalogRevision?: string;
  mcpServerId?: string;
  mcpToolName?: string;
  normalizedResult?: CasObjectRef;
  permissionAuthorizationId?: string;
  /** @deprecated Legacy audit reference retained for persisted invocations. */
  permissionGrantId?: string;
  projectId: string;
  /** Time spent waiting for a rate-limit slot before the upstream call started. */
  queueWaitMs?: number;
  rawResponse?: CasObjectRef;
  request: CasObjectRef;
  resultCount: number;
  sessionId: string;
  sourceId: McpSourceId;
  sourceVersion?: string;
  startedAt: string;
  status: "cancelled" | "failed" | "succeeded";
  toolCallId: string;
  toolId: McpToolId;
  transport: "mcp";
  turnId: string;
}

export interface McpInvokeRequest {
  arguments: JsonValue;
  context: {
    projectId: string;
    sessionId: string;
    toolCallId: string;
    turnId: string;
  };
  execution: {
    maxResponseBytes?: number;
    retryPolicy: McpRetryPolicy;
    timeoutMs: number;
  };
  /** Resolved outbound proxy for the target server (per-server policy). */
  proxy?: ResolvedProxy;
  requestId: string;
  serverId: string;
  toolName: string;
}

export interface McpInvokeResponse {
  attempts: McpAttempt[];
  content: Array<
    | { text: string; type: "text" }
    | { type: "json"; value: JsonValue }
    | { mimeType?: string; type: "resource"; uri: string }
  >;
  durationMs: number;
  isError: boolean;
  requestId: string;
  serverId: string;
  structuredContent?: JsonValue;
  toolName: string;
}
