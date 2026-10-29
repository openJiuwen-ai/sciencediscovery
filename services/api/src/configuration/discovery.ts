// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationCapabilityId } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { configurationConnectorDirectory } from "./connector-directory.js";
import { nativeRuntimeConnectorIds } from "./native-choices.js";
import { thinkingChoices } from "./p1-adapters.js";
import { configurationDiagnostic } from "./diagnostics.js";
import { CONFIGURATION_SETTINGS_INVENTORY } from "./settings-catalog.js";
import { SYSTEM_CONFIGURATION_CAPABILITIES } from "./agent-metadata.js";
import { ConfigurationError, digest, invalid, string } from "./validation.js";
import { CONFIGURATION_CONTEXT_LIMITS } from "./context-budget.js";
import { configurationDiscoveryMatches } from "./discovery-match.js";

const aliases: Record<ConfigurationCapabilityId, string> = {
  "model.select": "model select choose 模型 切换 选择",
  "model.connect": "model api connect provider 模型 接入 添加 接口 服务商",
  "model.repair_credential": "credential authentication key 凭据 认证 密钥 修复",
  "connector.enable": "connector source pubmed arxiv literature paper papers 数据源 连接器 启用 检索 文献 论文",
  "skill.select": "skill library skills 工作流 技能 技能库",
  "thinking.configure": "thinking reasoning effort 思考 推理 强度 深度",
  "review.configure": "review reviewer semantic 审阅 审查 自动审查",
  "timeouts.configure": "timeout timeouts 超时 等待 时限",
  "quotas.configure": "quota quotas 配额 并发 上传 容量",
  "idea_tree.configure": "idea tree 探索树 深度 轮次",
};
const domainAliases: Record<string, string> = { proxy: "代理", timeouts: "超时", quotas: "配额", memory: "记忆", web: "搜索服务", mcp: "安装MCP", environment: "环境", runner_registration: "注册Runner SSH", network_security: "权限 网络安全", plugins_and_specialists: "插件 专家", idea_tree: "探索树" };
type Row = Record<string, unknown>;
export interface ConfigurationDiscoveryInput {
  query?: string; capabilityId?: string; targetId?: string; cursor?: string; limit?: number; diagnosticCode?: string;
}
const text = (value: string, max = 180) => value.slice(0, max);
function matches(query: string, value: string): boolean {
  return configurationDiscoveryMatches(query, value);
}
function normalizedQuery(value: unknown, required: boolean): string {
  if (value === undefined && !required) return "";
  const query = string(value, "query", 200).trim().toLocaleLowerCase();
  if (!query) invalid("A discovery query is required");
  return query;
}
/** Build a valid UTF-8 JSON page. Identifiers and schema are never string-truncated. */
export function configurationPage(base: Row, rows: readonly Row[], input: ConfigurationDiscoveryInput, identity: unknown, maxBytes: number): Row {
  const limit = input.limit ?? CONFIGURATION_CONTEXT_LIMITS.page;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONFIGURATION_CONTEXT_LIMITS.maxPage) invalid("Invalid discovery limit");
  const key = digest(identity).slice(7, 23);
  let offset = 0;
  if (input.cursor !== undefined) {
    const cursor = string(input.cursor, "cursor", 100).match(/^([a-f0-9]{16}):([0-9]{1,9})$/);
    if (!cursor || cursor[1] !== key) invalid("Cursor does not match this discovery query");
    offset = Number(cursor[2]);
  }
  const items: Row[] = [];
  const result = (next: number): Row => ({ ...base, items: [...items], total: rows.length,
    ...(next < rows.length ? { nextCursor: `${key}:${next}` } : {}) });
  const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
  if (!fits(result(offset))) throw new ConfigurationError("CONFIGURATION_DISCOVERY_LIMIT", "The capability detail exceeds its context budget");
  for (const row of rows.slice(offset, offset + limit)) {
    items.push(row);
    if (!fits(result(offset + items.length))) { items.pop(); break; }
  }
  if (!items.length && offset < rows.length) throw new ConfigurationError("CONFIGURATION_DISCOVERY_LIMIT", "A resource cannot fit this discovery page");
  return result(offset + items.length);
}

/** Server-side catalog. Only a scoped page is projected to the model. No network, probes or mutations. */
export async function discoverConfiguration(store: SessionStore, sessionId: string, runId: string,
  action: "search" | "describe", input: ConfigurationDiscoveryInput): Promise<Row> {
  store.assertSessionWritable(sessionId);
  const framework = configurationFramework(store);
  const settings = store.getSessionSettings(sessionId);
  const native = framework.options.nativeExecutor;
  const query = normalizedQuery(input.query, action === "search" && !input.diagnosticCode);
  const diagnosis = input.diagnosticCode ? configurationDiagnostic(string(input.diagnosticCode, "diagnosticCode", 100)) : undefined;
  const capabilities = framework.service.registry.describe();
  let connectorCache: ReturnType<typeof configurationConnectorDirectory> | undefined;
  const connectors = async () => {
    if (connectorCache) return connectorCache;
    const run = await store.getSessionRun(sessionId, runId);
    return connectorCache = configurationConnectorDirectory({ registrations: framework.options.connectors?.(sessionId) ?? [],
      runtimeEnabledConnectorIds: run ? nativeRuntimeConnectorIds(store, sessionId, runId) : undefined,
      sessionEnabledConnectorIds: settings.effective.enabledConnectorIds, runtimePlugins: run?.settingsSnapshot.plugins,
      sessionPlugins: settings.effective.plugins, nativeExecutor: native || framework.options.jiuwenLiveWait === true, runBound: true });
  };
  let modelCache: Row[] | undefined;
  let skillCache: ReturnType<SessionStore["configurationSkillResources"]> | undefined;
  const skills = () => skillCache ??= store.configurationSkillResources();
  const models = () => modelCache ??= store.listModels().map(model => ({ id: model.id, name: text(model.name), model: model.model,
    credential: model.hasApiToken ? "provided" : store.modelAllowsMissingToken(model) ? "not_required" : "missing" }));
  const resources = async (id: ConfigurationCapabilityId): Promise<Row[]> => {
    if (id === "connector.enable") return (await connectors()).map(row => ({ ...row, name: text(row.name) }));
    if (["model.select", "model.repair_credential", "review.configure"].includes(id)) return models();
    if (id === "skill.select") {
      const catalog = skills();
      return [...catalog.ids.map(id => ({ id, kind: "skill", name: text(id), enabled: settings.effective.skillSelectionMode === "all" || settings.effective.enabledSkillIds.includes(id) })),
        ...catalog.libraries.map(item => ({ id: item.id, kind: "library", name: text(item.name), versionId: item.headVersionId ?? null, ready: Boolean(item.headVersionId) }))];
    }
    return [];
  };
  const availabilityCache = new Map<ConfigurationCapabilityId, Row>();
  const availability = async (id: ConfigurationCapabilityId): Promise<Row> => {
    const cached = availabilityCache.get(id);
    if (cached) return cached;
    const unsupportedReason = ["skill.select", "thinking.configure", "review.configure"].includes(id) && !native && !framework.options.jiuwenLiveWait ? "CONFIGURATION_BACKEND_UNSUPPORTED"
      : id === "connector.enable" && !(await connectors()).some(row => row.canPropose) ? "NO_READY_CONFIGURABLE_CONNECTOR"
      : id === "skill.select" && !skills().selectionAvailable ? "SHARED_SKILL_CATALOG"
      : id === "thinking.configure" && !thinkingChoices(store.getModel(settings.effective.modelId)).modes.length ? "MODEL_THINKING_UNSUPPORTED" : undefined;
    const output = { available: !unsupportedReason, ...(unsupportedReason ? { unsupportedReason } : {}) };
    availabilityCache.set(id, output);
    return output;
  };
  const brief = async (id: ConfigurationCapabilityId): Promise<Row> => {
    const item = capabilities.find(item => item.id === id)!;
    return { capabilityId: id, label: text(item.label), activation: item.activation, ...await availability(id) };
  };
  if (action === "search") {
    const rows: Row[] = [];
    const overview = /^(settings|configuration|设置|配置|可修改设置|可配置设置)$/u.test(query);
    // A structured unknown/network failure is not a reason to propose a repair.
    for (const item of capabilities) {
      if (diagnosis && !diagnosis.capabilityIds.includes(item.id)) continue;
      const relevant = overview || (query ? matches(query, `${item.id} ${item.label} ${aliases[item.id]}`) : Boolean(diagnosis));
      const found = query && !overview ? (await resources(item.id)).filter(row => matches(query, `${row.id} ${row.name} ${row.model ?? ""}`)) : [];
      if (found.length) for (const resource of found) rows.push({ ...await brief(item.id), resource });
      else if (relevant) rows.push(await brief(item.id));
    }
    if (!diagnosis && query) for (const domain of CONFIGURATION_SETTINGS_INVENTORY) {
      if (!domain.capabilities.length && matches(query, `${domain.id} ${domainAliases[domain.id] ?? ""} ${domain.fields.join(" ")}`)) rows.push({ domain: domain.id, available: false, unsupportedReason: text("reason" in domain ? domain.reason : "Not integrated") });
    }
    rows.sort((a, b) => JSON.stringify([a.capabilityId, (a.resource as Row | undefined)?.id, a.domain]).localeCompare(JSON.stringify([b.capabilityId, (b.resource as Row | undefined)?.id, b.domain])));
    return configurationPage({ action, query, ...(diagnosis ? { diagnosis } : {}), instruction: "Read a matching capability with describe if fields are needed, then propose only the actual requirement. No card or setting was changed." },
      rows, input, [sessionId, action, query, input.diagnosticCode ?? ""], CONFIGURATION_CONTEXT_LIMITS.search);
  }
  const id = framework.service.registry.get(string(input.capabilityId, "capabilityId", 100)).id;
  const descriptor = capabilities.find(item => item.id === id)!;
  const effective = settings.effective;
  const preview = (ids: readonly string[]) => ({ count: ids.length, ids: [...ids].slice(0, 5), hasMore: ids.length > 5 });
  let current: Row;
  if (id === "connector.enable") {
    const all = await connectors();
    current = { runtimeEnabled: preview(all.filter(row => row.runtimeEnabled).map(row => row.id)), sessionSaved: preview(effective.enabledConnectorIds), runtimeStateKnown: all.some(row => row.runtimeStateKnown) };
  } else if (id === "skill.select") current = { skillSelectionMode: effective.skillSelectionMode, enabledSkills: preview(effective.enabledSkillIds), enabledLibraries: preview(effective.enabledSkillLibraries.map(item => item.libraryId)) };
  else if (id === "thinking.configure") current = { thinkingMode: effective.thinkingMode ?? "model_default", thinkingEffort: effective.thinkingEffort ?? "model_default", supported: thinkingChoices(store.getModel(effective.modelId)) };
  else if (id === "review.configure") current = { reviewModelId: effective.reviewModelId ?? effective.modelId ?? null, semanticReviewEnabled: effective.semanticReviewEnabled,
    ...store.getSessionReviewerSpecialistSettings(sessionId), reviewerGloballyEnabled: store.getReviewerSpecialistSettings().enabled };
  else if (id === "timeouts.configure") current = { ...store.getTimeoutSettings() };
  else if (id === "quotas.configure") current = { ...store.getQuotaSettings() };
  else if (id === "idea_tree.configure") {
    const idea = store.getIdeaTreeSettings();
    current = { explorationIntensity: idea.explorationIntensity, scoreDirection: idea.scoreDirection,
      maxTokensPerCall: idea.maxTokensPerCall, maxDepth: idea.maxDepth, maxNodes: idea.maxNodes };
  } else current = { modelId: effective.modelId ?? null };
  const selected = (await resources(id)).filter(row => (!input.targetId || row.id === input.targetId) && (!query || matches(query, `${row.id} ${row.name} ${row.model ?? ""}`)));
  if (input.targetId && !selected.length) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "The requested installed resource was not found");
  const sourceFields = Object.keys(descriptor.fields).filter(field => !["name", "baseUrl", "model", "apiProtocol", "apiVariant", "tokenOptional"].includes(field));
  const sources = Object.fromEntries(sourceFields.filter(field => field in settings.sources).map(field => [field, settings.sources[field as keyof typeof settings.sources]]));
  return configurationPage({ action, ...await brief(id), ...(query ? { query } : {}), ...(input.targetId ? { targetId: input.targetId } : {}), whenNeeded: descriptor.whenNeeded, fields: framework.service.registry.fields(id),
    scopes: descriptor.scopes.filter(scope => (SYSTEM_CONFIGURATION_CAPABILITIES as readonly string[]).includes(id) || scope !== "global"), current, sources,
    instruction: (SYSTEM_CONFIGURATION_CAPABILITIES as readonly string[]).includes(id)
      ? "Only these registered fields may be proposed. This setting is deployment-wide: omit scope. 0 disables a timeout or byte quota. Do not set 0 unless the user asked to remove that limit. Prompts, secrets, install commands and permission switches are not fields here. Saved configuration does not rewrite a run that already read its settings."
      : "Only these registered fields may be proposed. Resources are a bounded page. Enter secrets through the user's secure card. Saved configuration is not approval to change an active frozen task." },
    selected, input, [sessionId, action, id, query, input.targetId ?? ""], CONFIGURATION_CONTEXT_LIMITS.describe);
}
