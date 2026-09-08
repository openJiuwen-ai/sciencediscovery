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

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CustomMcpServerConfig, CustomMcpServerDetails, McpCatalog, McpCatalogTool } from "@sciencediscovery/schema";
import type { McpSourceRegistry } from "@sciencediscovery/mcp-sources";

import { decryptSecretValue, encryptSecretValue, loadOrCreateModelSecretKey } from "../store/secrets.js";
import { customMcpAdapter } from "./custom-adapter.js";
import { loadExtensionsConfig, type ExtensionsConfigFile, type McpServerEntry } from "./extensions-config.js";
import { McpOAuthManager, validateOAuthUrl } from "./oauth.js";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function secretMap(value: unknown, previous: Record<string, string>, label: string): Record<string, string> {
  if (!object(value)) throw new Error(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error(`${label} has too many entries`);
  return Object.fromEntries(entries.map(([key, item]) => {
    if (!key || /[\s=\0]/.test(key)) throw new Error(`Invalid ${label} key`);
    if (item === null && Object.hasOwn(previous, key)) return [key, previous[key]!];
    if (typeof item !== "string" || item.length > 16_384 || item.includes("\0")) throw new Error(`Invalid ${label} value`);
    if (label === "headers" && /[\r\n]/.test(item)) throw new Error("Header values cannot contain line breaks");
    return [key, item];
  }));
}

export function normalizeCustomMcpConfig(value: unknown, previous?: CustomMcpServerConfig): CustomMcpServerConfig {
  if (!object(value)) throw new Error("MCP configuration must be an object");
  const text = (key: string, max: number, fallback = ""): string => {
    const raw = value[key] ?? fallback;
    if (typeof raw !== "string" || raw.length > max || raw.includes("\0")) throw new Error(`Invalid ${key}`);
    return raw.trim();
  };
  const name = text("name", 100);
  if (!name) throw new Error("Server name is required");
  const rawTransport = value.transport ?? value.type ?? (value.url ? "http" : "stdio");
  const transport = rawTransport === "streamable_http" || rawTransport === "streamable-http" ? "http" : rawTransport;
  if (transport !== "http" && transport !== "sse" && transport !== "stdio") throw new Error("Unsupported MCP transport");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("enabled must be a boolean");
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.length > 100 || args.some((arg) => typeof arg !== "string" || arg.length > 8_192 || arg.includes("\0"))) {
    throw new Error("args must be an array of strings");
  }
  const timeoutSeconds = value.timeoutSeconds ?? value.tool_call_timeout ?? 60;
  if (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > 600) throw new Error("Timeout must be between 1 and 600 seconds");
  const command = text("command", 4_096);
  const url = text("url", 8_192);
  if (transport === "stdio" && !command) throw new Error("Command is required for stdio");
  if (transport !== "stdio") {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("A valid HTTP(S) URL is required"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error("Use an HTTP(S) URL without user credentials or a fragment");
  }
  const authMode = transport === "stdio" ? "headers" : value.authMode ?? "headers";
  if (authMode !== "headers" && authMode !== "oauth") throw new Error("Unsupported MCP authorization mode");
  let oauth: CustomMcpServerConfig["oauth"];
  if (authMode === "oauth") {
    validateOAuthUrl(url);
    const raw = value.oauth ?? {};
    if (!object(raw)) throw new Error("Invalid OAuth configuration");
    const field = (key: string): string => {
      const value = raw[key] ?? "";
      if (typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error(`Invalid OAuth ${key}`);
      return value.trim();
    };
    oauth = { clientId: field("clientId"), clientSecret: raw.clientSecret === null ? previous?.oauth?.clientSecret ?? "" : field("clientSecret"), scope: field("scope"), clientMetadataUrl: field("clientMetadataUrl") };
    if (oauth.clientSecret && !oauth.clientId) throw new Error("OAuth Client ID is required with a client secret");
    if (oauth.clientMetadataUrl) {
      const metadata = validateOAuthUrl(oauth.clientMetadataUrl);
      if (metadata.protocol !== "https:" || metadata.pathname === "/") throw new Error("Client metadata URL must be an HTTPS document URL");
    }
    if (object(value.headers) && Object.keys(value.headers).some((key) => key.toLowerCase() === "authorization")) throw new Error("Remove the Authorization header before enabling OAuth");
  }
  return {
    name, transport,
    description: text("description", 2_000),
    enabled: value.enabled === true,
    command: transport === "stdio" ? command : "",
    args: transport === "stdio" ? args as string[] : [],
    cwd: transport === "stdio" ? text("cwd", 4_096) : "",
    url: transport === "stdio" ? "" : url,
    env: transport === "stdio" ? secretMap(value.env ?? {}, previous?.env ?? {}, "env") : {},
    headers: transport !== "stdio" ? secretMap(value.headers ?? {}, previous?.headers ?? {}, "headers") : {},
    timeoutSeconds: Number(timeoutSeconds),
    authMode, ...(oauth ? { oauth } : {}),
  };
}

function entry(config: CustomMcpServerConfig): McpServerEntry {
  const resolveValues = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([key, value]) => [key, value.startsWith("$") ? process.env[value.slice(1)] ?? "" : value]));
  return {
    ...config,
    env: resolveValues(config.env),
    headers: resolveValues(config.headers),
    routing: { keywords: [], mode: "off", priority: 0 },
    toolOverrides: {},
    toolCallTimeoutSeconds: config.timeoutSeconds,
  };
}

export class CustomMcpServers {
  readonly oauth: McpOAuthManager;
  private configs: Record<string, CustomMcpServerConfig> = {};
  private readonly checks = new Map<string, { checkedAt: string; tools: McpCatalogTool[]; error?: string; durationMs?: number }>();
  private key?: Buffer;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;

  constructor(
    private readonly dataDir: string,
    private readonly registry: McpSourceRegistry,
    private readonly onIdsChanged: (ids: string[]) => void,
    private readonly refresh: () => Promise<unknown>,
    private readonly onRemoved: (id: string) => Promise<void> = async () => undefined,
  ) {
    this.path = resolve(dataDir, "custom-mcp-servers.enc");
    this.oauth = new McpOAuthManager(dataDir, (id) => this.configs[id]);
  }

  async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    this.key = await loadOrCreateModelSecretKey(resolve(this.dataDir, "model-secrets.key"));
    try {
      const encrypted = await readFile(this.path, "utf8");
      const saved: unknown = JSON.parse(decryptSecretValue(this.key, "custom-mcp-servers", encrypted));
      if (!object(saved)) throw new Error("Invalid saved MCP configuration");
      for (const [id, value] of Object.entries(saved)) {
        if (!/^custom-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid saved MCP server id");
        this.configs[id] = normalizeCustomMcpConfig(value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.oauth.load(this.key);
    this.sync();
  }

  private sync(): void {
    for (const [id, config] of Object.entries(this.configs)) {
      this.registry.upsert(customMcpAdapter(id, config, config.enabled ? this.checks.get(id)?.tools ?? [] : []));
    }
    this.onIdsChanged(Object.keys(this.configs));
  }

  transportConfig(): ExtensionsConfigFile {
    const base = loadExtensionsConfig();
    const servers = { ...base.servers };
    for (const [id, config] of Object.entries(this.configs)) servers[id] = entry(config);
    return { ...base, servers, signature: createHash("sha256").update(JSON.stringify(servers)).digest("hex") };
  }

  applyCatalog(catalog: McpCatalog): void {
    for (const [id, config] of Object.entries(this.configs)) {
      if (!config.enabled) continue;
      const server = catalog.servers.find((item) => item.id === id);
      if (!server) continue;
      let error = server.error ? this.cleanError(config, server.error) : undefined;
      let tools = error ? [] : server.tools;
      try { customMcpAdapter(id, config, tools); } catch {
        error = "The server returned an unsupported tool input schema";
        tools = [];
      }
      if (error) server.error = error;
      this.checks.set(id, { checkedAt: catalog.loadedAt, tools, ...(error ? { error } : {}) });
    }
    this.sync();
  }

  private cleanError(config: CustomMcpServerConfig, message: string): string {
    let safe = message;
    for (const secret of [...Object.values(entry(config).env), ...Object.values(entry(config).headers), config.url, config.oauth?.clientSecret ?? ""].filter(Boolean)) {
      safe = safe.split(secret).join("[redacted]");
    }
    return safe.slice(0, 1_000);
  }

  list(): CustomMcpServerDetails[] {
    return Object.entries(this.configs).map(([id, config]) => {
      const check = this.checks.get(id);
      const authorization = this.oauth.status(id);
      const needsLogin = authorization?.state === "required";
      return {
        ...config, id, sourceId: id,
        ...(config.oauth ? { oauth: { ...config.oauth, clientSecret: config.oauth.clientSecret ? null : "" } } : {}),
        ...(authorization ? { authorization } : {}),
        env: Object.fromEntries(Object.keys(config.env).map((key) => [key, null])),
        headers: Object.fromEntries(Object.keys(config.headers).map((key) => [key, null])),
        ...check,
        status: !config.enabled ? "disabled" : needsLogin || check?.error ? "error" : check ? "ready" : "untested",
        tools: needsLogin ? [] : check?.tools ?? [],
      };
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async persist(next: Record<string, CustomMcpServerConfig>): Promise<void> {
    if (!this.key) throw new Error("MCP storage is not initialized");
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, encryptSecretValue(this.key, "custom-mcp-servers", JSON.stringify(next)), { mode: 0o600 });
    await rename(temporary, this.path);
    this.configs = next;
    this.sync();
  }

  save(value: unknown, id?: string): Promise<CustomMcpServerDetails> {
    return this.mutate(async () => {
      if (id && !this.configs[id]) throw new Error("MCP server not found");
      const config = normalizeCustomMcpConfig(value, id ? this.configs[id] : undefined);
      if (Object.entries(this.configs).some(([otherId, other]) => otherId !== id && other.name.toLowerCase() === config.name.toLowerCase())) throw new Error("A server with this name already exists");
      if (!id && Object.keys(this.configs).length >= 50) throw new Error("At most 50 custom MCP servers are supported");
      const serverId = id ?? `custom-${randomBytes(6).toString("hex")}`;
      const previous = this.configs[serverId];
      this.checks.delete(serverId);
      await this.persist({ ...this.configs, [serverId]: config });
      if (previous && JSON.stringify([previous.url, previous.transport, previous.authMode, previous.oauth]) !== JSON.stringify([config.url, config.transport, config.authMode, config.oauth])) await this.oauth.clear(serverId);
      await this.refresh();
      return this.list().find((item) => item.id === serverId)!;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.configs[id]) throw new Error("MCP server not found");
      const next = { ...this.configs };
      delete next[id];
      await this.persist(next);
      await this.oauth.clear(id);
      this.registry.remove(id);
      this.checks.delete(id);
      await this.onRemoved(id);
      await this.refresh();
    });
  }

  import(value: unknown): Promise<CustomMcpServerDetails[]> {
    return this.mutate(async () => {
      if (!object(value) || !object(value.mcpServers) || !Object.keys(value.mcpServers).length) throw new Error("JSON must contain a non-empty mcpServers object");
      const next = { ...this.configs };
      const names = new Set(Object.values(next).map((config) => config.name.toLowerCase()));
      for (const [name, raw] of Object.entries(value.mcpServers)) {
        if (!object(raw)) throw new Error("Each MCP server must be an object");
        const config = normalizeCustomMcpConfig({ ...raw, name, enabled: false });
        if (names.has(config.name.toLowerCase())) throw new Error(`A server named ${config.name} already exists`);
        names.add(config.name.toLowerCase());
        next[`custom-${randomBytes(6).toString("hex")}`] = config;
      }
      if (Object.keys(next).length > 50) throw new Error("At most 50 custom MCP servers are supported");
      await this.persist(next);
      return this.list();
    });
  }

  test(id: string): Promise<CustomMcpServerDetails> {
    return this.mutate(async () => {
      const config = this.configs[id];
      if (!config) throw new Error("MCP server not found");
      // A separate client can probe a disabled server without enabling it for any Agent.
      const { McpNodeClient } = await import("./node-client.js");
      const probe = new McpNodeClient(() => ({ path: undefined, signature: id, servers: { [id]: { ...entry(config), enabled: true } } }), this.oauth);
      const started = Date.now();
      try {
        const catalog = await probe.catalog();
        const server = catalog.servers[0]!;
        let error = server.error ? this.cleanError(config, server.error) : undefined;
        let tools = error ? [] : server.tools;
        try { customMcpAdapter(id, config, tools); } catch { error = "The server returned an unsupported tool input schema"; tools = []; }
        this.checks.set(id, { checkedAt: catalog.loadedAt, durationMs: Date.now() - started, tools, ...(error ? { error } : {}) });
        this.sync();
        if (config.enabled) await this.refresh();
        const check = this.checks.get(id);
        if (check) check.durationMs = Date.now() - started;
        return this.list().find((item) => item.id === id)!;
      } finally { await probe.close(); }
    });
  }
}
