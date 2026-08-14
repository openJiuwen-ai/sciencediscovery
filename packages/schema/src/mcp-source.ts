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

import type { JsonValue, McpToolResult } from "./mcp-result.js";

export type McpSourceId = string;
export type McpToolId = string;

export type McpSourceKind =
  | "literature"
  | "protein"
  | "structure"
  | "genomics"
  | "variation"
  | "pathway"
  | "chemistry"
  | "dataset";

export type McpToolKind =
  | "search"
  | "lookup"
  | "analysis"
  | "artifact-plan";

export interface ResultCachePolicy {
  enabled: boolean;
  scope: "global-public" | "project" | "session";
  ttlSeconds: number;
}

export interface RoutingPromptPolicy {
  caveats: string[];
  citationPolicy: string;
  summary: string;
}

export type McpRetryCondition =
  | "transport-error"
  | "timeout"
  | "rate-limited"
  | "server-error";

export interface McpRetryPolicy {
  initialDelayMs: number;
  jitterRatio: number;
  maxAttempts: number;
  maxDelayMs: number;
  multiplier: number;
  respectRetryAfter: boolean;
  retryOn: McpRetryCondition[];
}

export const DEFAULT_MCP_READ_RETRY_POLICY: Readonly<McpRetryPolicy> = {
  initialDelayMs: 500,
  jitterRatio: 0.2,
  maxAttempts: 3,
  maxDelayMs: 10_000,
  multiplier: 2,
  respectRetryAfter: true,
  retryOn: ["transport-error", "rate-limited", "server-error"],
};

/** Recommended queue guards that built-in source manifests opt into explicitly. */
export const DEFAULT_MCP_RATE_LIMIT_QUEUE: Readonly<{
  maxQueueDepth: number;
  queueTimeoutMs: number;
}> = {
  maxQueueDepth: 8,
  queueTimeoutMs: 20_000,
};

export interface McpToolManifest {
  cachePolicy?: Partial<ResultCachePolicy>;
  description: string;
  displayName: string;
  id: McpToolId;
  idempotent: boolean;
  inputSchema: Record<string, unknown>;
  kind: McpToolKind;
  mcpToolName?: string;
  permission: {
    action: "artifact_download" | "connector";
    resourceTemplate: string;
    summaryTemplate: string;
  };
  promptFragment?: string;
  resultType: "analysis-result" | "artifact-plan" | "evidence-records" | "structured-data";
  retryPolicy: McpRetryPolicy;
  routing: {
    keywords: string[];
    mode: "off" | "prefer";
    priority: number;
  };
  timeoutMs: number;
}

export interface McpSourceManifest {
  cache: ResultCachePolicy;
  description: string;
  displayName: string;
  enabledByDefault: boolean;
  governance: {
    attribution: string;
    commercialUseConstraints?: string;
    dataClassification: "controlled" | "private" | "public";
    license: string;
    /** Maximum in-flight requests; omitted means unlimited. */
    maxConcurrentRequests?: number;
    /** Waiting requests allowed per rate-limit group; omitted means unlimited. */
    maxQueueDepth?: number;
    maxResponseBytes: number;
    /** Minimum spacing between requests; omitted with no rateLimitPerSecond means no pacing. */
    minIntervalMs?: number;
    networkHosts: string[];
    /** Longest a request may wait for a slot; omitted disables the queue timeout. */
    queueTimeoutMs?: number;
    rateLimitGroup: string;
    /** Requests per second used to derive pacing; omitted with no minIntervalMs means no pacing. */
    rateLimitPerSecond?: number;
    termsUrl: string;
  };
  id: McpSourceId;
  kinds: McpSourceKind[];
  prompt: RoutingPromptPolicy;
  publisher: string;
  schemaVersion: string;
  tools: Record<McpToolId, McpToolManifest>;
  transport: {
    mcpServerId: string;
    type: "mcp";
  };
  version: string;
}

export interface ValidationIssue {
  message: string;
  path: string;
}

export type ValidationResult =
  | { input: JsonValue; valid: true }
  | { issues: ValidationIssue[]; valid: false };

export interface McpRawResult {
  content: Array<
    | { text: string; type: "text" }
    | { type: "json"; value: JsonValue }
    | { mimeType?: string; type: "resource"; uri: string }
  >;
  isError: boolean;
  structuredContent?: JsonValue;
}

export interface NormalizationContext {
  retrievedAt: string;
  source: McpSourceManifest;
  tool: McpToolManifest;
}

export interface McpSourceAdapter {
  readonly manifest: McpSourceManifest;
  normalizeResult(context: NormalizationContext, raw: McpRawResult): Promise<McpToolResult>;
  validateInput(toolId: McpToolId, input: unknown): ValidationResult;
}

export interface McpSourceStatus {
  availableTools: McpToolId[];
  catalogRevision?: string;
  error?: string;
  lastCheckedAt: string;
  missingTools: McpToolId[];
  sourceId: McpSourceId;
  status: "degraded" | "disabled" | "misconfigured" | "ready" | "unavailable";
}

export interface McpCatalogTool {
  annotations?: Record<string, unknown>;
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  schemaHash: string;
}

export interface McpCatalogServer {
  description?: string;
  enabled: boolean;
  id: string;
  tools: McpCatalogTool[];
  transport: "http" | "sse" | "stdio";
}

export interface McpCatalog {
  loadedAt: string;
  revision: string;
  servers: McpCatalogServer[];
}
