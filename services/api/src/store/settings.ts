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

import {
  DEFAULT_MEMORY_GRAPH_SETTINGS,
  isSkillSelectionMode,
  SKILL_SELECTION_FIELDS,
  type ConnectorId,
  type DdgsBackend,
  type McpProxyPolicies,
  type MemoryGraphSettings,
  type ProxyDefaultPolicy,
  type ProxyPolicy,
  type ProxyServerKind,
  type RuntimeSettingsField,
  type RuntimeSettingsOverrides,
  type SystemQuotaSettings,
  type SystemTimeoutSettings,
  type WebFetchProvider,
  type WebSearchProvider,
  type WebSettings,
} from "@science-agent/schema";

import { hasOwn, isRecord } from "./catalog.js";

export function knownConnectorIdSet(): ReadonlySet<string> {
  return new Set([
    "arxiv",
    "europe-pmc",
    "pubmed",
    "uniprot",
    "biorxiv",
    "medrxiv",
    "pdb",
    "ensembl",
    "reactome",
    "clinvar",
    "chembl",
    "geo",
  ]);
}

export const RUNTIME_SETTINGS_FIELDS = [
  "enabledConnectorIds",
  "enabledSkillIds",
  "modelId",
  "reviewModelId",
  "semanticReviewEnabled",
  "skillSelectionMode",
] as const satisfies readonly RuntimeSettingsField[];

/** Global defaults no longer configure skills; strip the fields instead of merging them. */
export function withoutSkillSelection(overrides: RuntimeSettingsOverrides): RuntimeSettingsOverrides {
  const stripped = { ...overrides };
  for (const field of SKILL_SELECTION_FIELDS) delete stripped[field];
  return stripped;
}

function normalizeStringArray(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
  strict: boolean,
): string[] | undefined {
  if (!Array.isArray(value)) {
    if (strict) throw new Error(`${field} must be an array`);
    return undefined;
  }
  if (strict && value.some((item) => typeof item !== "string" || !allowed.has(item))) {
    throw new Error(`${field} contains an unknown value`);
  }
  return [...new Set(value.filter((item): item is string => typeof item === "string" && allowed.has(item)))];
}

export function normalizeRuntimeSettings(
  value: unknown,
  modelIds: ReadonlySet<string>,
  skillIds: ReadonlySet<string>,
  strict: boolean,
): RuntimeSettingsOverrides {
  if (!isRecord(value)) {
    if (strict) throw new Error("Runtime settings must be an object");
    return {};
  }
  if (strict) {
    const unknown = Object.keys(value).find((key) => !RUNTIME_SETTINGS_FIELDS.includes(key as RuntimeSettingsField));
    if (unknown) throw new Error(`Unknown runtime setting: ${unknown}`);
  }

  const normalized: RuntimeSettingsOverrides = {};
  if (hasOwn(value, "enabledConnectorIds")) {
    const connectors = normalizeStringArray(
      value.enabledConnectorIds,
      "enabledConnectorIds",
      knownConnectorIdSet(),
      strict,
    );
    if (connectors) normalized.enabledConnectorIds = connectors as ConnectorId[];
  }
  if (hasOwn(value, "enabledSkillIds")) {
    const skills = normalizeStringArray(
      value.enabledSkillIds,
      "enabledSkillIds",
      skillIds,
      strict,
    );
    if (skills) normalized.enabledSkillIds = skills;
  }
  for (const field of ["modelId", "reviewModelId"] as const) {
    if (!hasOwn(value, field)) continue;
    const modelId = value[field];
    if (typeof modelId !== "string" || !modelIds.has(modelId)) {
      if (strict) throw new Error(`${field} must reference an existing model profile`);
      continue;
    }
    normalized[field] = modelId;
  }
  if (hasOwn(value, "semanticReviewEnabled")) {
    if (typeof value.semanticReviewEnabled !== "boolean") {
      if (strict) throw new Error("semanticReviewEnabled must be a boolean");
    } else {
      normalized.semanticReviewEnabled = value.semanticReviewEnabled;
    }
  }
  if (hasOwn(value, "skillSelectionMode")) {
    if (!isSkillSelectionMode(value.skillSelectionMode)) {
      if (strict) throw new Error("skillSelectionMode must be all or selected");
    } else {
      normalized.skillSelectionMode = value.skillSelectionMode;
    }
  }
  return normalized;
}

const TIMEOUT_SETTING_FIELDS = [
  "gatewayIdleTimeoutMs",
  "gatewayTurnTimeoutMs",
  "kernelIdleTimeoutMs",
  "permissionWaitTimeoutMs",
  "runnerExecTimeoutMs",
] as const satisfies readonly (keyof SystemTimeoutSettings)[];

export function normalizeTimeoutSettings(value: unknown): SystemTimeoutSettings {
  if (!isRecord(value)) throw new Error("Timeout settings must be an object");
  const unknown = Object.keys(value).find((key) => !TIMEOUT_SETTING_FIELDS.includes(key as keyof SystemTimeoutSettings));
  if (unknown) throw new Error(`Unknown timeout setting: ${unknown}`);
  const result = {} as SystemTimeoutSettings;
  for (const field of TIMEOUT_SETTING_FIELDS) {
    const setting = value[field];
    if (!Number.isSafeInteger(setting) || (setting as number) < 0) {
      throw new Error(`${field} must be a non-negative integer number of milliseconds`);
    }
    result[field] = setting as number;
  }
  if (result.gatewayIdleTimeoutMs > 0
    && result.gatewayTurnTimeoutMs > 0
    && result.gatewayTurnTimeoutMs < result.gatewayIdleTimeoutMs) {
    throw new Error(
      "gatewayTurnTimeoutMs must be greater than or equal to gatewayIdleTimeoutMs when both timeouts are finite",
    );
  }
  return result;
}

const QUOTA_SETTING_FIELDS = [
  "runnerMaxOutputBytes",
  "runnerMaxWorkspaceBytes",
  "uploadMaxFileBytes",
  "uploadMaxRequestBytes",
] as const satisfies readonly (keyof SystemQuotaSettings)[];

export function normalizeQuotaSettings(value: unknown): SystemQuotaSettings {
  if (!isRecord(value)) throw new Error("Quota settings must be an object");
  const unknown = Object.keys(value).find((key) => !QUOTA_SETTING_FIELDS.includes(key as keyof SystemQuotaSettings));
  if (unknown) throw new Error(`Unknown quota setting: ${unknown}`);
  const result = {} as SystemQuotaSettings;
  for (const field of QUOTA_SETTING_FIELDS) {
    const setting = value[field];
    if (!Number.isSafeInteger(setting) || (setting as number) < 0) {
      throw new Error(`${field} must be a non-negative integer number of bytes`);
    }
    result[field] = setting as number;
  }
  return result;
}

/** Fill missing quota fields from fallback (catalog migration / partial PUT). */
export function resolveQuotaSettings(value: unknown, fallback: SystemQuotaSettings): SystemQuotaSettings {
  if (value === undefined || value === null) return structuredClone(fallback);
  if (!isRecord(value)) throw new Error("Quota settings must be an object");
  return normalizeQuotaSettings({
    runnerMaxOutputBytes: value.runnerMaxOutputBytes ?? fallback.runnerMaxOutputBytes,
    runnerMaxWorkspaceBytes: value.runnerMaxWorkspaceBytes ?? fallback.runnerMaxWorkspaceBytes,
    uploadMaxFileBytes: value.uploadMaxFileBytes ?? fallback.uploadMaxFileBytes,
    uploadMaxRequestBytes: value.uploadMaxRequestBytes ?? fallback.uploadMaxRequestBytes,
  });
}

const MEMORY_GRAPH_SETTING_FIELDS = ["enabled", "neo4jHttp", "neo4jUser"] as const satisfies readonly (keyof MemoryGraphSettings)[];

/** Normalize persisted/partial memory-graph settings, filling gaps from the
 *  product defaults. Unknown keys are dropped silently (not rejected) so an
 *  older catalog row carrying a renamed field — e.g. the pre-HTTP `neo4jBolt`
 *  key left over from when the sidecar spoke Bolt — does not wedge boot; the
 *  stale value is simply ignored and the current field falls back to its
 *  default until the user re-configures it in System Settings. Malformed
 *  known values still throw. A missing field falls back to the default so a
 *  partial PUT or an older catalog row still yields a valid settings object. */
export function normalizeMemoryGraphSettings(value: unknown): MemoryGraphSettings {
  if (value === undefined || value === null) return structuredClone(DEFAULT_MEMORY_GRAPH_SETTINGS);
  if (!isRecord(value)) throw new Error("Memory-graph settings must be an object");
  // Unknown keys (e.g. a leftover pre-HTTP `neo4jBolt`) are silently dropped
  // here — we only read the known fields below, so anything else is ignored
  // and the current field falls back to its default. See the doc above.
  const enabled = typeof value.enabled === "boolean" ? value.enabled : DEFAULT_MEMORY_GRAPH_SETTINGS.enabled;
  const rawHttp = typeof value.neo4jHttp === "string" ? value.neo4jHttp.trim() : "";
  const neo4jHttp = rawHttp || DEFAULT_MEMORY_GRAPH_SETTINGS.neo4jHttp;
  if (neo4jHttp.length > 8_192) throw new Error("neo4jHttp is too long");
  const rawUser = typeof value.neo4jUser === "string" ? value.neo4jUser.trim() : "";
  const neo4jUser = rawUser || DEFAULT_MEMORY_GRAPH_SETTINGS.neo4jUser;
  if (neo4jUser.length > 512) throw new Error("neo4jUser is too long");
  return { enabled, neo4jHttp, neo4jUser };
}

const WEB_SEARCH_PROVIDERS = new Set<WebSearchProvider>(["ddgs", "tavily", "exa", "brave"]);
const WEB_FETCH_PROVIDERS = new Set<WebFetchProvider>(["jina", "tavily", "exa"]);
const DDGS_BACKENDS = new Set<DdgsBackend>(["bing", "auto", "duckduckgo"]);
const WEB_SETTING_FIELDS = new Set([
  "ddgsBackend",
  "fetchCacheTtlSeconds",
  "fetchProvider",
  "proxyPolicy",
  "searchCacheTtlSeconds",
  "searchFallbackProvider",
  "searchProvider",
]);

export function normalizeWebSettings(value: unknown): WebSettings {
  if (!isRecord(value)) throw new Error("Web settings must be an object");
  const unknown = Object.keys(value).find((key) => !WEB_SETTING_FIELDS.has(key));
  if (unknown) throw new Error(`Unknown web setting: ${unknown}`);
  const searchProvider = value.searchProvider;
  const fetchProvider = value.fetchProvider;
  const searchFallbackProvider = value.searchFallbackProvider;
  const ddgsBackend = value.ddgsBackend ?? "bing";
  const proxyPolicy = normalizeProxyPolicy(value.proxyPolicy ?? "inherit", "proxyPolicy");
  if (!WEB_SEARCH_PROVIDERS.has(searchProvider as WebSearchProvider)) {
    throw new Error("Unsupported web search provider");
  }
  if (!WEB_FETCH_PROVIDERS.has(fetchProvider as WebFetchProvider)) {
    throw new Error("Unsupported web fetch provider");
  }
  if (!DDGS_BACKENDS.has(ddgsBackend as DdgsBackend)) {
    throw new Error("Unsupported DDGS backend");
  }
  if (searchFallbackProvider !== null && searchFallbackProvider !== "ddgs") {
    throw new Error("searchFallbackProvider must be ddgs or null");
  }
  for (const field of ["searchCacheTtlSeconds", "fetchCacheTtlSeconds"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0 || (value[field] as number) > 30 * 24 * 60 * 60) {
      throw new Error(`${field} must be an integer between 0 and 2592000 seconds`);
    }
  }
  return {
    ddgsBackend: ddgsBackend as DdgsBackend,
    fetchCacheTtlSeconds: value.fetchCacheTtlSeconds as number,
    fetchProvider: fetchProvider as WebFetchProvider,
    proxyPolicy,
    searchCacheTtlSeconds: value.searchCacheTtlSeconds as number,
    searchFallbackProvider,
    searchProvider: searchProvider as WebSearchProvider,
  };
}

export function normalizeProxyUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("The proxy URL cannot be empty");
  if (raw.length > 8_192) throw new Error("The proxy URL is too long");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The proxy URL is invalid");
  }
  if (!["http:", "https:", "socks5:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("The proxy URL must use http, https, or socks5");
  }
  if (parsed.hash) throw new Error("The proxy URL cannot contain a fragment");
  return parsed.toString();
}

export const PROXY_SERVER_KINDS = new Set<ProxyServerKind>(["custom_url", "environment", "system"]);

export function normalizeProxyPolicy(value: unknown, field: string): ProxyPolicy {
  if (typeof value !== "string") throw new Error(`${field} must be a string proxy policy`);
  if (value === "inherit" || value === "none") return value;
  if (value.startsWith("proxy:")) {
    const serverId = value.slice("proxy:".length);
    if (serverId && serverId.length <= 200) return `proxy:${serverId}`;
  }
  throw new Error(`${field} must be inherit, none, or proxy:<server-id>`);
}

export function normalizeProxyDefaultPolicy(value: unknown): ProxyDefaultPolicy {
  const policy = normalizeProxyPolicy(value, "defaultPolicy");
  if (policy === "inherit") throw new Error("defaultPolicy must be none or proxy:<server-id>");
  return policy;
}

/** Normalize the per-MCP-server proxy policy map. Explicit "inherit" entries
 *  are dropped — inherit is the implicit default for unlisted servers. */
export function normalizeMcpProxyPolicies(value: unknown): McpProxyPolicies {
  if (!isRecord(value)) throw new Error("MCP proxy policies must be an object");
  const policies: McpProxyPolicies = {};
  for (const [serverId, policy] of Object.entries(value)) {
    const id = serverId.trim();
    if (!id || id.length > 200) throw new Error("MCP server ids must be 1-200 characters");
    const normalized = normalizeProxyPolicy(policy, `policies.${id}`);
    if (normalized !== "inherit") policies[id] = normalized;
  }
  return policies;
}
