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

/**
 * Reader for the repository's `extensions_config.json` MCP server registry.
 *
 * The file format is unchanged from previous releases (`mcpServers` maps a
 * server id to transport/config/routing). Values starting with `$` resolve as
 * environment variables; unresolved placeholders become empty strings so
 * subprocesses never receive a literal `$VAR` token.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface McpRoutingConfig {
  keywords: string[];
  mode: "off" | "prefer";
  priority: number;
}

export interface McpServerEntry {
  args: string[];
  command?: string;
  cwd?: string;
  description: string;
  enabled: boolean;
  env: Record<string, string>;
  headers: Record<string, string>;
  routing: McpRoutingConfig;
  toolCallTimeoutSeconds?: number;
  toolOverrides: Record<string, { routing?: McpRoutingConfig }>;
  transport: "http" | "sse" | "stdio";
  url?: string;
}

export interface ExtensionsConfigFile {
  path: string | undefined;
  servers: Record<string, McpServerEntry>;
  /** Content signature for cache invalidation; changes when the file changes. */
  signature: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveEnvValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (!value.startsWith("$")) return value;
    return process.env[value.slice(1)] ?? "";
  }
  if (Array.isArray(value)) return value.map(resolveEnvValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveEnvValue(entry)]));
  }
  return value;
}

function clampPriority(value: unknown): number {
  const priority = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.min(100, Math.max(0, priority));
}

function parseRouting(value: unknown): McpRoutingConfig {
  if (!isRecord(value)) return { keywords: [], mode: "off", priority: 0 };
  return {
    keywords: Array.isArray(value.keywords) ? value.keywords.map(String).filter(Boolean) : [],
    mode: value.mode === "prefer" ? "prefer" : "off",
    priority: clampPriority(value.priority),
  };
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => typeof entry === "string")
      .map(([key, entry]) => [key, entry as string]),
  );
}

function parseServer(value: unknown): McpServerEntry | undefined {
  if (!isRecord(value)) return undefined;
  // The MCP-spec `transport` field is an accepted alias for `type`.
  const rawTransport = typeof value.type === "string" && value.type
    ? value.type
    : typeof value.transport === "string" && value.transport
      ? value.transport
      : "stdio";
  const transport = rawTransport === "sse"
    ? "sse"
    : ["http", "streamable_http", "streamable-http"].includes(rawTransport)
      ? "http"
      : "stdio";
  const toolOverrides: McpServerEntry["toolOverrides"] = {};
  if (isRecord(value.tools)) {
    for (const [name, override] of Object.entries(value.tools)) {
      if (isRecord(override) && "routing" in override) {
        toolOverrides[name] = { routing: parseRouting(override.routing) };
      }
    }
  }
  return {
    args: Array.isArray(value.args) ? value.args.map(String) : [],
    ...(typeof value.command === "string" && value.command ? { command: value.command } : {}),
    ...(typeof value.cwd === "string" && value.cwd ? { cwd: value.cwd } : {}),
    description: typeof value.description === "string" ? value.description : "",
    enabled: value.enabled !== false,
    env: stringMap(value.env),
    headers: stringMap(value.headers),
    routing: parseRouting(value.routing),
    ...(typeof value.tool_call_timeout === "number" && Number.isFinite(value.tool_call_timeout)
      ? { toolCallTimeoutSeconds: value.tool_call_timeout }
      : {}),
    toolOverrides,
    transport,
    ...(typeof value.url === "string" && value.url ? { url: value.url } : {}),
  };
}

/** Server-level routing merged with a per-tool override, `off` filtered out. */
export function effectiveRouting(server: McpServerEntry, toolName: string): McpRoutingConfig | undefined {
  const override = server.toolOverrides[toolName]?.routing;
  const routing = override ?? server.routing;
  return routing.mode === "off" ? undefined : routing;
}

export function resolveExtensionsConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ["SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH"]) {
    const raw = env[name]?.trim();
    if (raw) {
      if (!existsSync(raw)) throw new Error(`Extensions config file from $${name} not found at ${raw}`);
      return raw;
    }
  }
  const candidate = resolve(process.cwd(), "extensions_config.json");
  return existsSync(candidate) ? candidate : undefined;
}

export function loadExtensionsConfig(configPath = resolveExtensionsConfigPath()): ExtensionsConfigFile {
  if (!configPath) return { path: undefined, servers: {}, signature: "absent" };
  const raw = readFileSync(configPath, "utf8");
  const stat = statSync(configPath);
  const signature = createHash("sha256")
    .update(`${configPath}\n${stat.mtimeMs}\n${stat.size}\n`)
    .update(raw)
    .digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Extensions config at ${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const resolved = resolveEnvValue(parsed);
  const servers: Record<string, McpServerEntry> = {};
  if (isRecord(resolved) && isRecord(resolved.mcpServers)) {
    for (const [name, entry] of Object.entries(resolved.mcpServers)) {
      const server = parseServer(entry);
      if (server) servers[name] = server;
    }
  }
  return { path: configPath, servers, signature };
}
