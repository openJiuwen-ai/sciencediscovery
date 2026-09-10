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
  DEFAULT_IDEA_TREE_SETTINGS,
  DEFAULT_MEMORY_GRAPH_SETTINGS,
  DEFAULT_WEB_SETTINGS,
  type EnabledSkillLibrary,
  FREE_SEARCH_ORDER,
  isSkillSelectionMode,
  migrateLegacyWebSettings,
  PAID_SEARCH_ORDER,
  SKILL_SELECTION_FIELDS,
  type ConnectorId,
  type FreeSearchEngine,
  type IdeaTreeAssessorConfig,
  type IdeaTreeSettings,
  type PaidSearchProvider,
  type McpProxyPolicies,
  type MemoryGraphSettings,
  type ProxyDefaultPolicy,
  type ProxyPolicy,
  type ProxyServerKind,
  type RuntimeSettingsField,
  type RuntimeSettingsOverrides,
  type SystemQuotaSettings,
  type SystemTimeoutSettings,
  type UpdateIdeaTreeSettingsRequest,
  type WebFetchProvider,
  type WebSettings,
} from "@sciencediscovery/schema";

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
    "llm-wiki",
  ]);
}

export const RUNTIME_SETTINGS_FIELDS = [
  "enabledConnectorIds",
  "enabledSkillLibraries",
  "enabledSkillIds",
  "modelId",
  "reviewModelId",
  "semanticReviewEnabled",
  "skillSelectionMode",
  "thinkingEffort",
  "thinkingMode",
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

function normalizeEnabledSkillLibraries(value: unknown, strict: boolean): EnabledSkillLibrary[] | undefined {
  if (!Array.isArray(value)) {
    if (strict) throw new Error("enabledSkillLibraries must be an array");
    return undefined;
  }
  const normalized: EnabledSkillLibrary[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.libraryId !== "string") {
      if (strict) throw new Error("enabledSkillLibraries entries require libraryId");
      continue;
    }
    const libraryId = item.libraryId.trim();
    const versionId = typeof item.versionId === "string" ? item.versionId.trim() : undefined;
    if (!libraryId || (versionId !== undefined && !versionId)) {
      if (strict) throw new Error("enabledSkillLibraries entries require non-empty ids");
      continue;
    }
    const priority = typeof item.priority === "number" ? item.priority : undefined;
    if (item.priority !== undefined && typeof item.priority !== "number") {
      if (strict) throw new Error("enabledSkillLibraries priority must be an integer");
      continue;
    }
    if (priority !== undefined && (!Number.isSafeInteger(priority) || Math.abs(priority) > 1_000_000)) {
      if (strict) throw new Error("enabledSkillLibraries priority must be an integer");
      continue;
    }
    const limit = typeof item.limit === "number" ? item.limit : undefined;
    if (item.limit !== undefined && typeof item.limit !== "number") {
      if (strict) throw new Error("enabledSkillLibraries limit must be between 1 and 100");
      continue;
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      if (strict) throw new Error("enabledSkillLibraries limit must be between 1 and 100");
      continue;
    }
    const key = `${libraryId}\0${versionId ?? "head"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      libraryId,
      ...(limit === undefined ? {} : { limit }),
      ...(priority === undefined ? {} : { priority }),
      ...(versionId === undefined ? {} : { versionId }),
    });
  }
  return normalized;
}

export function normalizeRuntimeSettings(
  value: unknown,
  modelIds: ReadonlySet<string>,
  skillIds: ReadonlySet<string>,
  strict: boolean,
  connectorIds: ReadonlySet<string> = knownConnectorIdSet(),
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
      connectorIds,
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
  if (hasOwn(value, "enabledSkillLibraries")) {
    const libraries = normalizeEnabledSkillLibraries(value.enabledSkillLibraries, strict);
    if (libraries) normalized.enabledSkillLibraries = libraries;
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
  if (hasOwn(value, "thinkingMode")) {
    if (!(["auto", "disabled", "enabled"] as const).includes(value.thinkingMode as never)) {
      if (strict) throw new Error("thinkingMode must be auto, enabled, or disabled");
    } else {
      normalized.thinkingMode = value.thinkingMode as RuntimeSettingsOverrides["thinkingMode"];
    }
  }
  if (hasOwn(value, "thinkingEffort")) {
    if (!(["low", "medium", "high", "xhigh", "max"] as const).includes(value.thinkingEffort as never)) {
      if (strict) throw new Error("thinkingEffort must be low, medium, high, xhigh, or max");
    } else {
      normalized.thinkingEffort = value.thinkingEffort as RuntimeSettingsOverrides["thinkingEffort"];
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

const WEB_FETCH_PROVIDERS = new Set<WebFetchProvider>(["jina", "tavily", "exa"]);
const WEB_SETTING_FIELDS = new Set([
  "fetchCacheTtlSeconds",
  "fetchProvider",
  "freeSearchEngines",
  "paidSearchProviders",
  "proxyPolicy",
  "searchCacheTtlSeconds",
]);

export function normalizeWebSettings(value: unknown): WebSettings {
  if (!isRecord(value)) throw new Error("Web settings must be an object");
  // Records written before search became an aggregation still carry the old
  // single-provider fields; translate them instead of rejecting the record.
  const migrated = migrateLegacyWebSettings(value);
  const unknown = Object.keys(migrated).find((key) => !WEB_SETTING_FIELDS.has(key));
  if (unknown) throw new Error(`Unknown web setting: ${unknown}`);
  const fetchProvider = migrated.fetchProvider;
  const proxyPolicy = normalizeProxyPolicy(migrated.proxyPolicy ?? "inherit", "proxyPolicy");
  if (!WEB_FETCH_PROVIDERS.has(fetchProvider as WebFetchProvider)) {
    throw new Error("Unsupported web fetch provider");
  }

  const paidInput = migrated.paidSearchProviders ?? [...PAID_SEARCH_ORDER];
  if (!Array.isArray(paidInput) || paidInput.some((entry) => !PAID_SEARCH_ORDER.includes(entry as PaidSearchProvider))) {
    throw new Error("paidSearchProviders must list supported paid search providers");
  }
  // Store in the canonical attempt order so persistence cannot reorder the tier.
  const paidSearchProviders = PAID_SEARCH_ORDER.filter((provider) => paidInput.includes(provider));

  const freeInput = migrated.freeSearchEngines ?? { ...DEFAULT_WEB_SETTINGS.freeSearchEngines };
  if (!isRecord(freeInput)) throw new Error("freeSearchEngines must be an object");
  const unknownEngine = Object.keys(freeInput).find((key) => !FREE_SEARCH_ORDER.includes(key as FreeSearchEngine));
  if (unknownEngine) throw new Error(`Unknown free search engine: ${unknownEngine}`);
  const freeSearchEngines = Object.fromEntries(FREE_SEARCH_ORDER.map((engine) => {
    const enabled = freeInput[engine];
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new Error(`freeSearchEngines.${engine} must be a boolean`);
    }
    return [engine, enabled ?? DEFAULT_WEB_SETTINGS.freeSearchEngines[engine]];
  })) as Record<FreeSearchEngine, boolean>;

  for (const field of ["searchCacheTtlSeconds", "fetchCacheTtlSeconds"] as const) {
    const seconds = migrated[field];
    if (!Number.isSafeInteger(seconds) || (seconds as number) < 0 || (seconds as number) > 30 * 24 * 60 * 60) {
      throw new Error(`${field} must be an integer between 0 and 2592000 seconds`);
    }
  }
  return {
    fetchCacheTtlSeconds: migrated.fetchCacheTtlSeconds as number,
    fetchProvider: fetchProvider as WebFetchProvider,
    freeSearchEngines,
    paidSearchProviders,
    proxyPolicy,
    searchCacheTtlSeconds: migrated.searchCacheTtlSeconds as number,
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

/** Coerce a possibly-empty string to undefined so the caller can fall back to
 *  the product default. The Idea Tree contract treats empty strings as
 *  "use default" — this helper centralizes that rule. */
function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Expected a string");
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Coerce a maybe-provided numeric field, validating its range. When omitted,
 *  falls back to the current stored value. */
function boundedInteger(
  value: unknown,
  field: keyof IdeaTreeSettings,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  const numeric = value as number;
  if (numeric < min || numeric > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return numeric;
}

/** Normalize one Assessor config overlay. Empty strings become undefined so
 *  the workflow skill's built-in defaults are used. The scoringCriteria, when
 *  provided, is a free-form text describing the scoring rubric. */
function normalizeAssessor(
  input: unknown,
  fallback: IdeaTreeAssessorConfig,
): IdeaTreeAssessorConfig {
  if (input === undefined || input === null) return structuredClone(fallback);
  if (!isRecord(input)) throw new Error("Assessor config must be an object");
  const systemPrompt = hasOwn(input, "systemPrompt")
    ? optionalString(input.systemPrompt)
    : fallback.systemPrompt;
  const scoringCriteria = hasOwn(input, "scoringCriteria")
    ? optionalString(input.scoringCriteria)
    : fallback.scoringCriteria;
  const weight = hasOwn(input, "weight")
    ? (typeof input.weight === "number" && Number.isFinite(input.weight)
      ? input.weight
      : (() => { throw new Error("Assessor weight must be a finite number"); })())
    : fallback.weight;
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(scoringCriteria ? { scoringCriteria } : {}),
    ...(weight !== undefined ? { weight } : {}),
  };
}

/**
 * Normalize an Idea Tree settings update against the current stored value.
 *
 * - Empty strings become undefined so the product defaults (or the workflow
 *   skill's built-in values) are used.
 * - Numeric fields are range-validated: maxDepth [1,20], maxNodes [1,10000],
 *   maxSearchRounds [1,10000]. Omitted fields retain the current value.
 * - Weight validation: if all three assessor weights are provided, they must
 *   sum to 1.0 within a 0.001 tolerance. Partial weights are kept as-is so
 *   the caller can update one without re-specifying the others; the sum is
 *   only enforced when all three are present.
 */
export function normalizeIdeaTreeSettings(
  input: UpdateIdeaTreeSettingsRequest,
  current: IdeaTreeSettings,
): IdeaTreeSettings {
  const maxRounds = boundedInteger(input.maxRounds, "maxRounds", 1, 100, current.maxRounds ?? 3);
  const candidatesPerRound = boundedInteger(input.candidatesPerRound, "candidatesPerRound", 1, 20, current.candidatesPerRound ?? 3);
  const maxTokensPerCall = boundedInteger(input.maxTokensPerCall, "maxTokensPerCall", 256, 32000, current.maxTokensPerCall ?? 4000);
  const maxTokens = input.maxTokens === null ? null : input.maxTokens === undefined ? current.maxTokens ?? null
    : boundedInteger(input.maxTokens, "maxTokens", 1, Number.MAX_SAFE_INTEGER, 1);
  const maxDepth = boundedInteger(input.maxDepth, "maxDepth", 1, 20, current.maxDepth);
  const maxNodes = boundedInteger(input.maxNodes, "maxNodes", 2, 10_000, current.maxNodes);
  const maxSearchRounds = boundedInteger(
    input.maxSearchRounds,
    "maxSearchRounds",
    1,
    10_000,
    current.maxSearchRounds,
  );
  const scoreDirection = input.scoreDirection === "maximize" || input.scoreDirection === "minimize"
    ? input.scoreDirection
    : current.scoreDirection;
  const designSystemPrompt = hasOwn(input, "designSystemPrompt")
    ? optionalString(input.designSystemPrompt)
    : current.designSystemPrompt;
  const assessorActivity = normalizeAssessor(input.assessorActivity, current.assessorActivity);
  const assessorStability = normalizeAssessor(input.assessorStability, current.assessorStability);
  const assessorSustainability = normalizeAssessor(input.assessorSustainability, current.assessorSustainability);
  const aggregatorSystemPrompt = hasOwn(input, "aggregatorSystemPrompt")
    ? optionalString(input.aggregatorSystemPrompt)
    : current.aggregatorSystemPrompt;
  const propagateInsightSystemPrompt = hasOwn(input, "propagateInsightSystemPrompt")
    ? optionalString(input.propagateInsightSystemPrompt)
    : current.propagateInsightSystemPrompt;
  // Weight validation: enforce the 1.0 sum only when all three weights are
  // explicitly provided in this update. Partial updates keep the current
  // values for the un-touched assessors, so the sum is only meaningful when
  // the caller is re-balancing the whole tier at once.
  const providedWeights = [
    input.assessorActivity?.weight,
    input.assessorStability?.weight,
    input.assessorSustainability?.weight,
  ].filter((value) => typeof value === "number");
  if (providedWeights.length === 3) {
    const sum = (input.assessorActivity!.weight as number)
      + (input.assessorStability!.weight as number)
      + (input.assessorSustainability!.weight as number);
    if (Math.abs(sum - 1) > 0.001) {
      throw new Error(`Assessor weights must sum to 1.0 (got ${sum})`);
    }
  }
  return {
    maxRounds, candidatesPerRound, maxTokens, maxTokensPerCall,
    maxDepth,
    maxNodes,
    maxSearchRounds,
    scoreDirection,
    ...(designSystemPrompt ? { designSystemPrompt } : {}),
    assessorActivity,
    assessorStability,
    assessorSustainability,
    ...(aggregatorSystemPrompt ? { aggregatorSystemPrompt } : {}),
    ...(propagateInsightSystemPrompt ? { propagateInsightSystemPrompt } : {}),
  };
}

/** Fill missing Idea Tree settings fields from the product defaults. Used on
 *  catalog load and on partial GETs so the runtime always sees a complete
 *  settings object. Unknown keys are dropped silently (same rule as the
 *  memory-graph normalizer) so a stale catalog row carrying a renamed field
 *  does not wedge boot. */
export function resolveIdeaTreeSettings(value: unknown): IdeaTreeSettings {
  if (value === undefined || value === null) return structuredClone(DEFAULT_IDEA_TREE_SETTINGS);
  if (!isRecord(value)) throw new Error("Idea Tree settings must be an object");
  const current: IdeaTreeSettings = {
    maxRounds: typeof value.maxRounds === "number" ? value.maxRounds : 3,
    candidatesPerRound: typeof value.candidatesPerRound === "number" ? value.candidatesPerRound : 3,
    maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : null,
    maxTokensPerCall: typeof value.maxTokensPerCall === "number" ? value.maxTokensPerCall : 4000,
    maxDepth: typeof value.maxDepth === "number" ? value.maxDepth : DEFAULT_IDEA_TREE_SETTINGS.maxDepth,
    maxNodes: typeof value.maxNodes === "number" ? value.maxNodes : DEFAULT_IDEA_TREE_SETTINGS.maxNodes,
    maxSearchRounds: typeof value.maxSearchRounds === "number"
      ? value.maxSearchRounds
      : DEFAULT_IDEA_TREE_SETTINGS.maxSearchRounds,
    scoreDirection: value.scoreDirection === "maximize" || value.scoreDirection === "minimize"
      ? value.scoreDirection
      : DEFAULT_IDEA_TREE_SETTINGS.scoreDirection,
    ...(typeof value.designSystemPrompt === "string" && value.designSystemPrompt.trim()
      ? { designSystemPrompt: value.designSystemPrompt.trim() }
      : {}),
    assessorActivity: normalizeAssessor(value.assessorActivity, DEFAULT_IDEA_TREE_SETTINGS.assessorActivity),
    assessorStability: normalizeAssessor(value.assessorStability, DEFAULT_IDEA_TREE_SETTINGS.assessorStability),
    assessorSustainability: normalizeAssessor(
      value.assessorSustainability,
      DEFAULT_IDEA_TREE_SETTINGS.assessorSustainability,
    ),
    ...(typeof value.aggregatorSystemPrompt === "string" && value.aggregatorSystemPrompt.trim()
      ? { aggregatorSystemPrompt: value.aggregatorSystemPrompt.trim() }
      : {}),
    ...(typeof value.propagateInsightSystemPrompt === "string" && value.propagateInsightSystemPrompt.trim()
      ? { propagateInsightSystemPrompt: value.propagateInsightSystemPrompt.trim() }
      : {}),
  };
  return current;
}
