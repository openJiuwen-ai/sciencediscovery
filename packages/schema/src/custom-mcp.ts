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

import type { McpCatalogTool } from "./mcp-source.js";
import type { JsonValue, McpToolResult } from "./mcp-result.js";

export interface CustomMcpServerConfig {
  name: string;
  description: string;
  transport: "stdio" | "http" | "sse";
  enabled: boolean;
  command: string;
  args: string[];
  cwd: string;
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  timeoutSeconds: number;
  authMode?: "headers" | "oauth";
  oauth?: { clientId: string; clientSecret: string; scope: string; clientMetadataUrl: string };
}

/** Null values retain a saved secret; absent map keys remove it. */
export interface CustomMcpServerInput extends Omit<CustomMcpServerConfig, "env" | "headers" | "oauth"> {
  env: Record<string, string | null>;
  headers: Record<string, string | null>;
  oauth?: Omit<NonNullable<CustomMcpServerConfig["oauth"]>, "clientSecret"> & { clientSecret: string | null };
}

export interface CustomMcpServerDetails extends Omit<CustomMcpServerInput, "env" | "headers"> {
  id: string;
  sourceId: string;
  env: Record<string, null>;
  headers: Record<string, null>;
  status: "untested" | "ready" | "error" | "disabled";
  error?: string;
  checkedAt?: string;
  durationMs?: number;
  tools: McpCatalogTool[];
  authorization?: McpAuthorizationStatus;
}

export interface McpAuthorizationStatus {
  state: "required" | "authorizing" | "authorized" | "expired";
  expiresAt?: string;
  scope?: string;
  error?: string;
}

export interface McpAuthorizationStart {
  authorizationUrl: string;
  expiresAt: string;
}

export interface McpInspectorRequest {
  sessionId: string;
  toolName: string;
  input: JsonValue;
}

export interface McpInspectorResult {
  ok: boolean;
  durationMs: number;
  invocationId: string;
  raw?: JsonValue;
  result?: McpToolResult;
  error?: string;
}
