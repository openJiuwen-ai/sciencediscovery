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

import { createHash } from "node:crypto";

import type {
  McpCatalog,
  McpCatalogServer,
  McpCatalogTool,
  McpConnectionError,
  McpSourceManifest,
  McpSourceStatus,
  ResolvedProxy,
} from "@sciencediscovery/schema";
import type { McpSourceRegistry } from "@sciencediscovery/mcp-sources";

import type { McpTransportClient } from "./transport.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function schemaHash(schema: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Conservative compatibility check: locally advertised calls must satisfy the remote tool contract. */
export function inputSchemasCompatible(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): boolean {
  if (local.type && remote.type && local.type !== remote.type) return false;
  const localProperties = local.properties;
  const remoteProperties = remote.properties;
  if (!localProperties || !remoteProperties || typeof localProperties !== "object" || typeof remoteProperties !== "object"
    || Array.isArray(localProperties) || Array.isArray(remoteProperties)) {
    return schemaHash(local) === schemaHash(remote);
  }
  const localNames = new Set(Object.keys(localProperties));
  const remoteNames = new Set(Object.keys(remoteProperties));
  const remoteAllowsExtra = remote.additionalProperties !== false;
  if (!remoteAllowsExtra && [...localNames].some((name) => !remoteNames.has(name))) return false;
  const localRequired = new Set(stringArray(local.required));
  if (stringArray(remote.required).some((name) => !localRequired.has(name))) return false;
  return true;
}

function catalogServer(manifest: McpSourceManifest, catalog: McpCatalog): McpCatalogServer | undefined {
  return catalog.servers.find((candidate) => candidate.id === manifest.transport.mcpServerId);
}

function statusFor(manifest: McpSourceManifest, catalog: McpCatalog): McpSourceStatus {
  const toolIds = Object.keys(manifest.tools);
  const server = catalogServer(manifest, catalog);
  // The client only lists enabled servers, so a server missing from an applied
  // catalog was switched off or never configured: the source is off, not broken.
  if (!server || !server.enabled) {
    return {
      availableTools: [],
      catalogRevision: catalog.revision,
      error: `MCP server is disabled or not configured: ${manifest.transport.mcpServerId ?? "(missing id)"}`,
      lastCheckedAt: catalog.loadedAt,
      missingTools: toolIds,
      sourceId: manifest.id,
      status: "disabled",
    };
  }
  if (server.error) {
    return {
      availableTools: [],
      catalogRevision: catalog.revision,
      error: server.error,
      lastCheckedAt: catalog.loadedAt,
      missingTools: toolIds,
      sourceId: manifest.id,
      status: "unavailable",
    };
  }
  const available: string[] = [];
  const missing: string[] = [];
  for (const [toolId, tool] of Object.entries(manifest.tools)) {
    const remote = server.tools.find((candidate: McpCatalogTool) => candidate.name === tool.mcpToolName);
    if (remote && inputSchemasCompatible(tool.inputSchema, remote.inputSchema)) available.push(toolId);
    else missing.push(toolId);
  }
  return {
    availableTools: available,
    catalogRevision: catalog.revision,
    ...(missing.length ? { error: `Missing or incompatible MCP tools: ${missing.join(", ")}` } : {}),
    lastCheckedAt: catalog.loadedAt,
    missingTools: missing,
    sourceId: manifest.id,
    status: missing.length ? "degraded" : "ready",
  };
}

export class McpSourceCatalog {
  private catalog?: McpCatalog;
  private readonly statuses = new Map<string, McpSourceStatus>();

  constructor(
    private readonly registry: McpSourceRegistry,
    private readonly gateway: McpTransportClient,
    /** Current per-server resolved proxies, sent with reloads so the gateway
     *  rebuilds MCP connections under the right outbound configuration. */
    private readonly proxyMapProvider?: () => Record<string, ResolvedProxy>,
    private readonly onCatalog?: (catalog: McpCatalog) => void,
  ) {}

  private apply(catalog: McpCatalog): McpCatalog {
    this.onCatalog?.(catalog);
    this.catalog = catalog;
    this.statuses.clear();
    for (const source of this.registry.list()) {
      this.statuses.set(source.manifest.id, statusFor(source.manifest, catalog));
    }
    return structuredClone(catalog);
  }

  async refresh(signal?: AbortSignal): Promise<McpCatalog> {
    return this.apply(await this.gateway.catalog(signal));
  }

  async reload(signal?: AbortSignal): Promise<McpCatalog> {
    return this.apply(await this.gateway.reload(this.proxyMapProvider?.(), signal));
  }

  getCatalog(): McpCatalog | undefined {
    return this.catalog ? structuredClone(this.catalog) : undefined;
  }

  getStatus(sourceId: string): McpSourceStatus {
    const status = this.statuses.get(sourceId);
    if (status) return structuredClone(status);
    const source = this.registry.get(sourceId);
    // A source registered after the last refresh (an imported custom server)
    // is judged against the catalog already applied.
    if (this.catalog) return statusFor(source.manifest, this.catalog);
    return {
      availableTools: [],
      error: "MCP catalog has not been refreshed",
      lastCheckedAt: new Date(0).toISOString(),
      missingTools: Object.keys(source.manifest.tools),
      sourceId,
      status: "unavailable",
    };
  }

  listStatuses(): McpSourceStatus[] {
    return this.registry.list().map((source) => this.getStatus(source.manifest.id));
  }

  /** Why the source's enabled MCP server could not be connected or could not list
   *  its tools in the last applied catalog. Off servers, partial tool mismatches and
   *  a catalog that was never refreshed are not connection failures. */
  connectionError(sourceId: string): McpConnectionError | undefined {
    if (!this.catalog) return undefined;
    const server = catalogServer(this.registry.get(sourceId).manifest, this.catalog);
    if (!server?.enabled || !server.error) return undefined;
    return { checkedAt: this.catalog.loadedAt, message: server.error };
  }
}
