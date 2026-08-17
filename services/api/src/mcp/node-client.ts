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
 * In-process MCP client for the Node control plane.
 *
 * Replaces the Python-gateway HTTP hop with the official MCP TypeScript SDK:
 * servers from `extensions_config.json` are connected directly (stdio
 * subprocesses; SSE / streamable-HTTP for remote servers), the catalog is
 * built from live `listTools`, and invocations run under the same retry /
 * timeout / response-size policy contract the governance broker already
 * speaks (`McpInvokeRequest` / `McpInvokeResponse`).
 *
 * Sessions are cached per server and rebuilt when the config file content or
 * the server's resolved proxy changes. The bundled biomed/uniprot servers are
 * Python modules from the gateway environment, so a bare `python` command is
 * resolved to that interpreter.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type {
  JsonValue,
  McpAttempt,
  McpAttemptStatus,
  McpCatalog,
  McpCatalogServer,
  McpCatalogTool,
  McpInvokeRequest,
  McpInvokeResponse,
  ResolvedProxy,
} from "@science-agent/schema";

import { effectiveRouting, loadExtensionsConfig, type ExtensionsConfigFile, type McpServerEntry } from "./extensions-config.js";

const PROXY_ENV_VARS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
] as const;
const URL_PROXY_ENV_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;

/** Environment variables that make a stdio subprocess honour a resolved proxy. */
export function proxyEnvOverlay(proxy: ResolvedProxy | undefined): Record<string, string> {
  if (!proxy || proxy.mode === "direct") return {};
  if (proxy.mode === "environment") {
    const overlay: Record<string, string> = {};
    for (const name of PROXY_ENV_VARS) {
      const value = process.env[name];
      if (value) overlay[name] = value;
    }
    return overlay;
  }
  if (!proxy.url) throw new Error("Proxy mode 'url' requires a proxy URL");
  const overlay: Record<string, string> = {};
  for (const name of URL_PROXY_ENV_VARS) overlay[name] = proxy.url;
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const value = process.env[name];
    if (value) overlay[name] = value;
  }
  return overlay;
}

/** Resolve the interpreter for the bundled Python MCP servers. */
export function resolveMcpPython(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SCIENCE_AGENT_GATEWAY_PYTHON_PATH?.trim();
  if (configured) return configured;
  const dataDir = env.SCIENCE_AGENT_DATA_DIR?.trim();
  for (const candidate of [
    ...(dataDir ? [resolve(process.cwd(), dataDir, "envs/gateway/bin/python")] : []),
    resolve(process.cwd(), "data/envs/gateway/bin/python"),
    resolve(process.cwd(), "services/gateway/.venv/bin/python"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "python";
}

function classifyError(message: string): { retryAfterMs?: number; status: McpAttemptStatus } {
  const lowered = message.toLowerCase();
  let retryAfterMs: number | undefined;
  const tokens = lowered.replaceAll("=", " ").replaceAll(":", " ").split(/\s+/);
  for (const [index, token] of tokens.entries()) {
    if (!token.includes("retry-after") && !token.includes("retry_after")) continue;
    for (const candidate of tokens.slice(index + 1, index + 3)) {
      const parsed = Number.parseFloat(candidate.replace(/[()[\]{},;'"]+/g, ""));
      if (Number.isFinite(parsed)) {
        retryAfterMs = Math.max(0, Math.round(parsed * 1_000));
        break;
      }
    }
    if (retryAfterMs !== undefined) break;
  }
  if (lowered.includes("timed out") || lowered.includes("timeout")) return { status: "timeout", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  if (lowered.includes("429") || lowered.includes("rate limit") || lowered.includes("too many requests")) {
    return { status: "rate-limited", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (["connection", "transport", "network", "broken pipe", "reset by peer", "closed", "spawn"].some((marker) => lowered.includes(marker))) {
    return { status: "transport-error", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if ([" 500", " 502", " 503", " 504", "server error", "service unavailable"].some((marker) => lowered.includes(marker))) {
    return { status: "server-error", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  return { status: "semantic-error", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

function errorCodeFor(status: McpAttemptStatus, message: string): string {
  const lowered = message.toLowerCase();
  if (message.startsWith("RESPONSE_TOO_LARGE:")) return "RESPONSE_TOO_LARGE";
  if (lowered.includes("401") || lowered.includes("unauthorized")) return "UNAUTHORIZED";
  if (lowered.includes("404") || lowered.includes("not found")) return "NOT_FOUND";
  return status.toUpperCase().replaceAll("-", "_");
}

function contentBlocks(result: Record<string, unknown>): { blocks: McpInvokeResponse["content"]; structured: JsonValue | undefined } {
  const blocks: McpInvokeResponse["content"] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      blocks.push({ text: record.text, type: "text" });
    } else if (record.type === "resource_link" && typeof record.uri === "string") {
      blocks.push({ type: "resource", uri: record.uri, ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}) });
    } else {
      blocks.push({ type: "json", value: record as JsonValue });
    }
  }
  const structured = result.structuredContent !== undefined && result.structuredContent !== null
    ? (result.structuredContent as JsonValue)
    : undefined;
  return { blocks, structured };
}

interface ServerSession {
  client: Client;
  proxySignature: string;
}

export class McpNodeClient {
  private readonly sessions = new Map<string, ServerSession>();
  private proxies: Record<string, ResolvedProxy> = {};
  private configSignature: string | undefined;

  constructor(private readonly loadConfig: () => ExtensionsConfigFile = loadExtensionsConfig) {}

  private currentConfig(): ExtensionsConfigFile {
    const config = this.loadConfig();
    if (this.configSignature !== undefined && config.signature !== this.configSignature) {
      // Config content changed: rebuild every session on next use.
      void this.closeAll();
    }
    this.configSignature = config.signature;
    return config;
  }

  private proxySignature(serverId: string): string {
    return JSON.stringify(this.proxies[serverId] ?? null);
  }

  private async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.client.close()));
  }

  private async closeSession(serverId: string): Promise<void> {
    const session = this.sessions.get(serverId);
    if (!session) return;
    this.sessions.delete(serverId);
    await session.client.close().catch(() => undefined);
  }

  private async session(serverId: string, server: McpServerEntry): Promise<Client> {
    const proxySignature = this.proxySignature(serverId);
    const existing = this.sessions.get(serverId);
    if (existing && existing.proxySignature === proxySignature) return existing.client;
    if (existing) await this.closeSession(serverId);

    const client = new Client({ name: "science-agent-api", version: "1.0.0" });
    if (server.transport === "stdio") {
      if (!server.command) throw new Error(`MCP server '${serverId}' with stdio transport requires 'command'`);
      const command = server.command === "python" || server.command === "python3"
        ? resolveMcpPython()
        : server.command;
      const overlay = proxyEnvOverlay(this.proxies[serverId]);
      const env: Record<string, string> = { ...getDefaultEnvironment() };
      for (const [key, value] of Object.entries(server.env)) {
        if (!PROXY_ENV_VARS.includes(key as (typeof PROXY_ENV_VARS)[number])) env[key] = value;
      }
      Object.assign(env, overlay);
      const transport = new StdioClientTransport({
        args: server.args,
        command,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        env,
        stderr: "ignore",
      });
      await client.connect(transport);
    } else if (server.transport === "sse") {
      if (!server.url) throw new Error(`MCP server '${serverId}' with sse transport requires 'url'`);
      await client.connect(new SSEClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers },
      }));
    } else {
      if (!server.url) throw new Error(`MCP server '${serverId}' with http transport requires 'url'`);
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers },
      }));
    }
    this.sessions.set(serverId, { client, proxySignature });
    return client;
  }

  private async serverTools(serverId: string, server: McpServerEntry): Promise<McpCatalogTool[]> {
    const client = await this.session(serverId, server);
    const tools: McpCatalogTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) {
        const inputSchema = (tool.inputSchema ?? { properties: {}, type: "object" }) as Record<string, unknown>;
        const routing = effectiveRouting(server, tool.name);
        tools.push({
          ...(routing ? { annotations: { routing } } : {}),
          description: tool.description ?? tool.name,
          inputSchema,
          name: tool.name,
          schemaHash: createHash("sha256").update(JSON.stringify(inputSchema)).digest("hex"),
        });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return tools;
  }

  async catalog(): Promise<McpCatalog> {
    const config = this.currentConfig();
    const servers: McpCatalogServer[] = [];
    for (const [serverId, server] of Object.entries(config.servers).sort(([a], [b]) => a.localeCompare(b))) {
      if (!server.enabled) continue;
      let tools: McpCatalogTool[] = [];
      try {
        tools = await this.serverTools(serverId, server);
      } catch {
        // One broken server must not prevent healthy servers from
        // contributing; drop its session so the next catalog reconnects.
        await this.closeSession(serverId);
      }
      servers.push({
        ...(server.description ? { description: server.description } : {}),
        enabled: true,
        id: serverId,
        tools,
        transport: server.transport,
      });
    }
    const revision = createHash("sha256").update(JSON.stringify(servers)).digest("hex");
    return { loadedAt: new Date().toISOString(), revision, servers };
  }

  async reload(proxies?: Record<string, ResolvedProxy>): Promise<McpCatalog> {
    if (proxies) this.proxies = { ...proxies };
    await this.closeAll();
    this.configSignature = undefined;
    return this.catalog();
  }

  async invoke(request: McpInvokeRequest, signal?: AbortSignal): Promise<McpInvokeResponse> {
    const started = Date.now();
    if (request.proxy) {
      // Self-healing: a proxy change (or restart that lost the overlays)
      // reconnects the server under the requested environment.
      const next = JSON.stringify(request.proxy);
      if (JSON.stringify(this.proxies[request.serverId] ?? null) !== next) {
        this.proxies = { ...this.proxies, [request.serverId]: request.proxy };
        await this.closeSession(request.serverId);
      }
    }
    const config = this.currentConfig();
    const server = config.servers[request.serverId];
    if (!server || !server.enabled) {
      throw Object.assign(new Error(`Unknown MCP server: ${request.serverId}`), { statusCode: 404 });
    }

    const policy = request.execution.retryPolicy;
    const maxResponseBytes = request.execution.maxResponseBytes ?? 5_000_000;
    const deadline = started + request.execution.timeoutMs;
    const attempts: McpAttempt[] = [];
    let finalError = "MCP tool failed";
    let finalStatus: McpAttemptStatus = "semantic-error";

    for (let attemptNumber = 1; attemptNumber <= policy.maxAttempts; attemptNumber += 1) {
      const attemptStartedAt = new Date().toISOString();
      const attemptStarted = Date.now();
      const remaining = deadline - attemptStarted;
      let retryAfterMs: number | undefined;
      if (remaining <= 0) {
        finalStatus = "timeout";
        finalError = "MCP invocation deadline exceeded (timeout)";
      } else {
        try {
          const client = await this.session(request.serverId, server);
          const timeout = server.toolCallTimeoutSeconds !== undefined
            ? Math.min(remaining, server.toolCallTimeoutSeconds * 1_000)
            : remaining;
          const result = await client.callTool(
            { arguments: request.arguments as Record<string, unknown>, name: request.toolName },
            undefined,
            { ...(signal ? { signal } : {}), timeout },
          ) as Record<string, unknown>;
          if (result.isError) {
            const { blocks } = contentBlocks(result);
            const text = blocks.map((block) => (block.type === "text" ? block.text : "")).filter(Boolean).join("\n");
            throw new Error(text || "MCP tool reported an error");
          }
          const { blocks, structured } = contentBlocks(result);
          const responseBytes = Buffer.byteLength(JSON.stringify({ content: blocks, structuredContent: structured ?? null }), "utf8");
          if (responseBytes > maxResponseBytes) {
            throw new Error(`RESPONSE_TOO_LARGE: MCP response used ${responseBytes} bytes; limit is ${maxResponseBytes}`);
          }
          attempts.push({
            attempt: attemptNumber,
            durationMs: Date.now() - attemptStarted,
            finishedAt: new Date().toISOString(),
            startedAt: attemptStartedAt,
            status: "succeeded",
          });
          return {
            attempts,
            content: blocks,
            durationMs: Date.now() - started,
            isError: false,
            requestId: request.requestId,
            serverId: request.serverId,
            ...(structured !== undefined ? { structuredContent: structured } : {}),
            toolName: request.toolName,
          };
        } catch (error) {
          finalError = error instanceof Error ? error.message : String(error);
          const classified = classifyError(finalError);
          finalStatus = classified.status;
          retryAfterMs = classified.retryAfterMs;
          if (finalStatus === "transport-error") {
            // A dead stdio subprocess or dropped connection: reconnect on retry.
            await this.closeSession(request.serverId);
          }
        }
      }

      attempts.push({
        attempt: attemptNumber,
        durationMs: Date.now() - attemptStarted,
        errorCode: errorCodeFor(finalStatus, finalError),
        errorMessage: finalError.slice(0, 1_000),
        finishedAt: new Date().toISOString(),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        startedAt: attemptStartedAt,
        status: finalStatus,
      });
      const retryable = policy.retryOn.includes(finalStatus as (typeof policy.retryOn)[number]) && attemptNumber < policy.maxAttempts;
      if (!retryable) break;
      const exponential = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.multiplier ** (attemptNumber - 1));
      let delayMs = policy.respectRetryAfter && retryAfterMs !== undefined ? retryAfterMs : exponential;
      delayMs *= 1 + (Math.random() * 2 - 1) * policy.jitterRatio;
      const remainingMs = Math.max(0, deadline - Date.now());
      if (delayMs <= 0 || delayMs >= remainingMs) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }

    return {
      attempts,
      content: [{ text: finalError.slice(0, 1_000), type: "text" }],
      durationMs: Date.now() - started,
      isError: true,
      requestId: request.requestId,
      serverId: request.serverId,
      toolName: request.toolName,
    };
  }

  /** Close every cached session (shutdown hook). */
  async close(): Promise<void> {
    await this.closeAll();
  }
}
