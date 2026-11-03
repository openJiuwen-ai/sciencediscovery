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

import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CustomMcpServerConfig, CustomMcpServerDetails, McpCatalog, McpCatalogTool } from "@sciencediscovery/schema";
import type { ConfigurationExternalOperation, ConfigurationExternalOutcome } from "../configuration/types.js";
import type { McpSourceRegistry } from "@sciencediscovery/mcp-sources";

import { decryptSecretValue, encryptSecretValue, loadOrCreateModelSecretKey } from "../store/secrets.js";
import { canonicalMcpEnvironmentName, mcpEnvironmentRemovalEffect } from "./runtime-environment.js";
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
  private configurationOperations: Record<string, ConfigurationExternalOutcome> = {};
  private pendingConfigurationDeletions: Record<string, string> = {};
  private deletionJournal = false;
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
      const envelope = ["sciencediscovery-custom-mcp-v2", "sciencediscovery-custom-mcp-v3"].includes(String(saved.format)) ? saved : undefined;
      this.deletionJournal = saved.format === "sciencediscovery-custom-mcp-v3";
      const servers = envelope ? envelope.servers : saved;
      if (!object(servers) || envelope && !object(envelope.operations)) throw new Error("Invalid saved MCP configuration envelope");
      if (envelope) for (const [operationId, value] of Object.entries(envelope.operations as Record<string, unknown>)) {
        if (!object(value)) throw new Error("Invalid saved MCP operation");
        this.validateConfigurationOperation({ operationId, bindingDigest: String(value.bindingDigest) });
        if (value.operationId !== operationId || !(value.status === "rejected" && typeof value.code === "string" && /^[A-Z][A-Z0-9_]{2,99}$/.test(value.code)
          || value.status === "applied" && object(value.resourceVersions) && Object.keys(value.resourceVersions).length === 1 && typeof value.resourceVersions.mcpMetadata === "string" && /^[a-f0-9]{64}$/.test(value.resourceVersions.mcpMetadata))) throw new Error("Invalid saved MCP operation outcome");
        this.configurationOperations[operationId] = value.status === "rejected"
          ? { operationId, bindingDigest: String(value.bindingDigest), status: "rejected", code: String(value.code) }
          : { operationId, bindingDigest: String(value.bindingDigest), status: "applied", resourceVersions: { mcpMetadata: String((value.resourceVersions as Record<string, unknown>).mcpMetadata) } };
      }
      if (Object.keys(this.configurationOperations).length > 10_000) throw new Error("MCP configuration operation journal exceeds capacity");
      for (const [id, value] of Object.entries(servers)) {
        if (!/^custom-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid saved MCP server id");
        this.configs[id] = normalizeCustomMcpConfig(value);
      }
      if (this.deletionJournal) {
        if (!object(envelope?.pendingDeletions)) throw new Error("Invalid pending MCP deletions");
        for (const [operationId, id] of Object.entries(envelope.pendingDeletions)) {
          if (typeof id !== "string" || !/^custom-[a-f0-9]{12}$/u.test(id) || this.configs[id] || this.configurationOperations[operationId]?.status !== "applied") throw new Error("Invalid pending MCP deletion binding");
          this.pendingConfigurationDeletions[operationId] = id;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.oauth.load(this.key);
    this.sync();
    for (const operationId of Object.keys(this.pendingConfigurationDeletions)) { await this.finishConfigurationDeletion(operationId); }
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

  /** Opaque server-only transport/auth binding. A key prevents offline guessing
   * of header/environment secrets; OAuth uses its encrypted vault generation. */
  configurationRevision(sourceIds?: readonly string[]): string {
    if (!this.key) return "not_loaded";
    return createHmac("sha256", this.key).update(JSON.stringify([
      sourceIds ? sourceIds.slice().sort().map(id => [id, this.transportConfig().servers[id] ?? null]) : this.transportConfig().signature,
      this.oauth.configurationRevision(sourceIds),
    ])).digest("hex");
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

  private async persist(next: Record<string, CustomMcpServerConfig>, operations = this.configurationOperations, invalidateChecks: readonly string[] = [], pendingDeletions = this.pendingConfigurationDeletions): Promise<void> {
    if (!this.key) throw new Error("MCP storage is not initialized");
    const temporary = `${this.path}.tmp`;
    const deletionJournal = this.deletionJournal || Object.keys(pendingDeletions).length > 0;
    const payload = Object.keys(operations).length ? { format: deletionJournal ? "sciencediscovery-custom-mcp-v3" : "sciencediscovery-custom-mcp-v2", servers: next, operations, ...(deletionJournal ? { pendingDeletions } : {}) } : next;
    await writeFile(temporary, encryptSecretValue(this.key, "custom-mcp-servers", JSON.stringify(payload)), { mode: 0o600 });
    await rename(temporary, this.path);
    this.configs = next;
    for (const id of invalidateChecks) { this.checks.delete(id); }
    this.configurationOperations = operations;
    this.pendingConfigurationDeletions = pendingDeletions;
    this.deletionJournal = deletionJournal;
    this.sync();
  }

  configurationDeletion(serverId = "") {
    const source = this.configurationMetadata(serverId);
    return { ...source, version: serverId && !source.current ? this.deletedConfigurationRevision(serverId) : source.version };
  }

  private deletedConfigurationRevision(id: string): string {
    if (!this.key) throw new Error("MCP storage is not initialized");
    return createHmac("sha256", this.key).update(JSON.stringify(["mcp-deleted-v1", id])).digest("hex");
  }

  /** Only local, convergent cleanup. Never refresh/probe or replay an invocation. */
  private async finishConfigurationDeletion(operationId: string): Promise<void> {
    const id = this.pendingConfigurationDeletions[operationId];
    if (!id) return;
    if (this.configs[id]) throw new Error("Deleted MCP identity was replaced before cleanup");
    this.registry.remove(id); this.checks.delete(id);
    await this.oauth.clear(id);
    await this.onRemoved(id);
    const pending = { ...this.pendingConfigurationDeletions }; delete pending[operationId];
    await this.persist(this.configs, this.configurationOperations, [], pending);
  }

  submitConfigurationDeletion(operation: ConfigurationExternalOperation, serverId: string, expectedVersion: string): Promise<ConfigurationExternalOutcome> {
    return this.mutate(async () => {
      const prior = this.operationOutcome(operation);
      if (prior) { await this.finishConfigurationDeletion(operation.operationId); if (prior.status === "applied") this.sync(); return prior; }
      if (!/^custom-[a-f0-9]{12}$/u.test(serverId) || !this.configs[serverId]) return this.recordConfigurationOutcome({ ...operation, status: "rejected", code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
      if (this.configurationMetadataRevision(serverId) !== expectedVersion) return this.recordConfigurationOutcome({ ...operation, status: "rejected", code: "RESOURCE_VERSION_CONFLICT" });
      if (Object.keys(this.configurationOperations).length >= 10_000) throw new Error("MCP configuration operation capacity reached; no automatic receipt deletion is allowed");
      const outcome: ConfigurationExternalOutcome = { ...operation, status: "applied", resourceVersions: { mcpMetadata: this.deletedConfigurationRevision(serverId) } };
      const next = { ...this.configs }; delete next[serverId];
      await this.persist(next, { ...this.configurationOperations, [operation.operationId]: outcome }, [serverId], { ...this.pendingConfigurationDeletions, [operation.operationId]: serverId });
      await this.finishConfigurationDeletion(operation.operationId);
      return structuredClone(outcome);
    });
  }


  /** Finite safe catalog; transport values and credentials never leave this service. */
  configurationMetadata(serverId?: string) {
    const items = Object.entries(this.configs).map(([id, config]) => ({ id, name: config.name, description: config.description, transport: config.transport, enabled: config.enabled }));
    return { items, current: items.find(item => item.id === serverId), version: serverId ? this.configurationMetadataRevision(serverId) : undefined };
  }

  configurationTimeout(serverId?: string) {
    const source = this.configurationMetadata(serverId);
    const items = source.items.map(item => ({ ...item, timeoutSeconds: this.configs[item.id]?.timeoutSeconds ?? 60 }));
    return { items, current: items.find(item => item.id === serverId), version: source.version };
  }

  /** Header names/counts only. Values and endpoint/execution details never leave the authority. */
  configurationHeaderRemoval(target = "") {
    let serverId = "", headerName = "";
    if (target) {
      try { const parsed: unknown = JSON.parse(target); if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(value => typeof value === "string")) { serverId = String(parsed[0]); headerName = String(parsed[1]).toLowerCase(); } } catch { /* Unbound discovery has no selected header. */ }
    }
    const items = Object.entries(this.configs).filter(([, config]) => config.transport !== "stdio").map(([id, config]) => {
      const counts = new Map<string, number>(); for (const name of Object.keys(config.headers)) { counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1); }
      return { id, name: config.name, transport: config.transport, enabled: config.enabled, headers: [...counts].filter(([name]) => name.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(name)).map(([name, aliases]) => ({ name, aliases })).sort((a, b) => a.name.localeCompare(b.name)) };
    });
    const current = items.find(item => item.id === serverId);
    return { items, current, header: current?.headers.find(item => item.name === headerName), version: serverId ? this.configurationMetadataRevision(serverId) : undefined };
  }

  submitConfigurationHeaderRemoval(operation: ConfigurationExternalOperation, target: string, expectedVersion: string): Promise<ConfigurationExternalOutcome> {
    return this.mutate(async () => {
      const prior = this.operationOutcome(operation); if (prior) { if (prior.status === "applied") this.sync(); return prior; }
      const reject = (code: string) => this.recordConfigurationOutcome({ ...operation, status: "rejected", code });
      const source = this.configurationHeaderRemoval(target), selected = source.current;
      if (!selected || !source.header) return reject("CONFIGURATION_RESOURCE_UNAVAILABLE");
      if (source.version !== expectedVersion) return reject("RESOURCE_VERSION_CONFLICT");
      const previous = this.configs[selected.id]; if (!previous) return reject("CONFIGURATION_RESOURCE_UNAVAILABLE");
      const selectedName = source.header.name;
      const candidate = normalizeCustomMcpConfig({ ...previous, headers: Object.fromEntries(Object.entries(previous.headers).filter(([name]) => name.toLowerCase() !== selectedName)) }, previous);
      return this.recordConfigurationOutcome({ ...operation, status: "applied", resourceVersions: { mcpMetadata: this.configurationMetadataRevision(selected.id, candidate) } }, { ...this.configs, [selected.id]: candidate }, [selected.id]);
    });
  }

  configurationEnvironmentRemoval(target = "") {
    let serverId = "", envName = "";
    if (target) {
      try { const parsed: unknown = JSON.parse(target); if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(value => typeof value === "string")) { serverId = String(parsed[0]); envName = canonicalMcpEnvironmentName(String(parsed[1])); } } catch { /* No selected stored variable. */ }
    }
    const items = Object.entries(this.configs).filter(([, config]) => config.transport === "stdio").map(([id, config]) => {
      const counts = new Map<string, number>(); for (const key of Object.keys(config.env)) { if (/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(key)) { const name = canonicalMcpEnvironmentName(key); counts.set(name, (counts.get(name) ?? 0) + 1); } }
      return { id, name: config.name, transport: config.transport, enabled: config.enabled, variables: [...counts].map(([name, aliases]) => ({ name, aliases, effect: mcpEnvironmentRemovalEffect(name) })).sort((a, b) => a.name.localeCompare(b.name)) };
    });
    const current = items.find(item => item.id === serverId);
    return { items, current, variable: current?.variables.find(item => item.name === envName), caseSensitive: process.platform !== "win32", version: serverId ? this.configurationEnvironmentRevision(serverId) : undefined };
  }

  private configurationEnvironmentRevision(serverId: string, config = this.configs[serverId]): string {
    if (!this.key) throw new Error("MCP storage is not initialized");
    return createHmac("sha256", this.key).update(JSON.stringify(["mcp-env-removal-v1", process.platform, this.configurationMetadataRevision(serverId, config)])).digest("hex");
  }

  submitConfigurationEnvironmentRemoval(operation: ConfigurationExternalOperation, target: string, expectedVersion: string): Promise<ConfigurationExternalOutcome> {
    return this.mutate(async () => {
      const prior = this.operationOutcome(operation); if (prior) { if (prior.status === "applied") this.sync(); return prior; }
      const reject = (code: string) => this.recordConfigurationOutcome({ ...operation, status: "rejected", code }), source = this.configurationEnvironmentRemoval(target), selected = source.current;
      if (!selected || !source.variable) return reject("CONFIGURATION_RESOURCE_UNAVAILABLE");
      if (source.version !== expectedVersion) return reject("RESOURCE_VERSION_CONFLICT");
      const previous = this.configs[selected.id]; if (!previous) return reject("CONFIGURATION_RESOURCE_UNAVAILABLE");
      const selectedName = source.variable.name;
      const candidate = normalizeCustomMcpConfig({ ...previous, env: Object.fromEntries(Object.entries(previous.env).filter(([name]) => canonicalMcpEnvironmentName(name) !== selectedName)) }, previous);
      return this.recordConfigurationOutcome({ ...operation, status: "applied", resourceVersions: { mcpMetadata: this.configurationEnvironmentRevision(selected.id, candidate) } }, { ...this.configs, [selected.id]: candidate }, [selected.id]);
    });
  }

  private configurationMetadataRevision(serverId: string, config = this.configs[serverId]): string {
    if (!this.key) throw new Error("MCP storage is not initialized");
    return createHmac("sha256", this.key).update(JSON.stringify([serverId, config ?? null, this.oauth.configurationRevision([serverId])])).digest("hex");
  }

  private validateConfigurationOperation(operation: ConfigurationExternalOperation): void {
    if (!/^[a-f0-9-]{36}:[1-9][0-9]{0,15}:external_submit$/.test(operation.operationId) || !/^sha256:[a-f0-9]{64}$/.test(operation.bindingDigest)) throw new Error("Invalid MCP configuration operation identity");
  }

  private operationOutcome(operation: ConfigurationExternalOperation): ConfigurationExternalOutcome | undefined {
    this.validateConfigurationOperation(operation);
    const prior = this.configurationOperations[operation.operationId];
    if (prior && prior.bindingDigest !== operation.bindingDigest) throw new Error("MCP configuration operation binding mismatch");
    return prior ? structuredClone(prior) : undefined;
  }

  private async recordConfigurationOutcome(outcome: ConfigurationExternalOutcome, configs = this.configs, invalidateChecks: readonly string[] = []): Promise<ConfigurationExternalOutcome> {
    if (Object.keys(this.configurationOperations).length >= 10_000) throw new Error("MCP configuration operation capacity reached; no automatic receipt deletion is allowed");
    await this.persist(configs, { ...this.configurationOperations, [outcome.operationId]: outcome }, invalidateChecks);
    return structuredClone(outcome);
  }

  submitConfigurationMetadata(operation: ConfigurationExternalOperation, serverId: string, expectedVersion: string, values: unknown): Promise<ConfigurationExternalOutcome> {
    return this.submitConfigurationFields(operation, serverId, expectedVersion, values, ["name", "description"]);
  }

  submitConfigurationTimeout(operation: ConfigurationExternalOperation, serverId: string, expectedVersion: string, values: unknown): Promise<ConfigurationExternalOutcome> {
    return this.submitConfigurationFields(operation, serverId, expectedVersion, values, ["timeoutSeconds"]);
  }

  private submitConfigurationFields(operation: ConfigurationExternalOperation, serverId: string, expectedVersion: string, values: unknown, fields: readonly string[]): Promise<ConfigurationExternalOutcome> {
    return this.mutate(async () => {
      const prior = this.operationOutcome(operation); if (prior) { if (prior.status === "applied") this.sync(); return prior; }
      const reject = (code: string) => this.recordConfigurationOutcome({ ...operation, status: "rejected", code });
      const previous = /^custom-[a-f0-9]{12}$/.test(serverId) && Object.hasOwn(this.configs, serverId) ? this.configs[serverId] : undefined;
      if (!previous) return reject("CONFIGURATION_RESOURCE_UNAVAILABLE");
      if (this.configurationMetadataRevision(serverId) !== expectedVersion) return reject("RESOURCE_VERSION_CONFLICT");
      if (!object(values) || !Object.keys(values).length || Object.keys(values).some(key => !fields.includes(key))) return reject("INVALID_CONFIGURATION_INPUT");
      if (fields.includes("timeoutSeconds") && (typeof values.timeoutSeconds !== "number" || !Number.isInteger(values.timeoutSeconds) || values.timeoutSeconds < 1 || values.timeoutSeconds > 600)) return reject("INVALID_CONFIGURATION_INPUT");
      let candidate: CustomMcpServerConfig;
      try { candidate = normalizeCustomMcpConfig({ ...previous, ...values }, previous); } catch { return reject("INVALID_CONFIGURATION_INPUT"); }
      if (Object.entries(this.configs).some(([id, item]) => id !== serverId && item.name.toLowerCase() === candidate.name.toLowerCase())) return reject("MCP_METADATA_NAME_CONFLICT");
      const next = { ...this.configs, [serverId]: candidate };
      return this.recordConfigurationOutcome({ ...operation, status: "applied", resourceVersions: { mcpMetadata: this.configurationMetadataRevision(serverId, candidate) } }, next);
    });
  }

  /** Absence becomes a durable tombstone, fencing a delayed old submit. */
  resolveConfigurationMetadata(operation: ConfigurationExternalOperation): Promise<ConfigurationExternalOutcome> {
    return this.mutate(async () => {
      const prior = this.operationOutcome(operation);
      if (prior) { await this.finishConfigurationDeletion(operation.operationId); if (prior.status === "applied") this.sync(); return prior; }
      return this.recordConfigurationOutcome({ ...operation, status: "rejected", code: "EXTERNAL_OPERATION_NOT_SAVED" });
    });
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
