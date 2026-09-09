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

import type {
  DailyModelUsageSummary,
  GlobalModelUsageSummary,
  GlobalUsageModelGroup,
  GlobalUsageProjectGroup,
  GlobalUsageRunGroup,
  GlobalUsageSessionGroup,
  ModelUsageAnalyticsFilters,
  ModelUsageAnalyticsSummary,
  ModelUsageCost,
  ModelUsageExchangeRate,
  ModelInvocationUsage,
  ModelUsageBucket,
  ResolvedModelPricing,
  SessionUsageSummary,
} from "@sciencediscovery/schema";

export function createUsageBucket(key: string, label: string): ModelUsageBucket {
  return {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    inputTokens: null,
    invocationCount: 0,
    key,
    label,
    outputTokens: null,
    reportedInvocationCount: 0,
    totalTokens: null,
    unreportedInvocationCount: 0,
  };
}

function addNullable(current: number | null, addition: number | null | undefined): number | null {
  if (addition === null || addition === undefined) return current;
  return (current ?? 0) + addition;
}

export function addUsageToBucket(bucket: ModelUsageBucket, usage: ModelInvocationUsage): void {
  bucket.invocationCount += 1;
  if (usage.usageStatus === "reported") {
    bucket.reportedInvocationCount += 1;
    bucket.inputTokens = addNullable(bucket.inputTokens, usage.inputTokens);
    bucket.outputTokens = addNullable(bucket.outputTokens, usage.outputTokens);
    bucket.totalTokens = addNullable(bucket.totalTokens, usage.totalTokens);
    bucket.cacheReadTokens = addNullable(bucket.cacheReadTokens, usage.cacheReadTokens);
    bucket.cacheWriteTokens = addNullable(bucket.cacheWriteTokens, usage.cacheWriteTokens);
    bucket.costUsd = addNullable(bucket.costUsd, usage.costUsd);
  } else {
    bucket.unreportedInvocationCount += 1;
  }
}

function addToMap(
  buckets: Map<string, ModelUsageBucket>,
  key: string,
  label: string,
  usage: ModelInvocationUsage,
): void {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = createUsageBucket(key, label);
    buckets.set(key, bucket);
  }
  addUsageToBucket(bucket, usage);
}

function sortBuckets(buckets: Iterable<ModelUsageBucket>): ModelUsageBucket[] {
  return [...buckets].toSorted((left, right) =>
    right.invocationCount - left.invocationCount
    || left.label.localeCompare(right.label)
    || left.key.localeCompare(right.key));
}

function normalizeInvocation(usage: ModelInvocationUsage): ModelInvocationUsage {
  return {
    ...usage,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    outcome: usage.outcome ?? "completed",
  };
}

export function summarizeModelUsage(
  sessionId: string,
  records: ModelInvocationUsage[],
): SessionUsageSummary {
  const invocations = records
    .filter((usage) => usage.sessionId === sessionId)
    .map(normalizeInvocation)
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  const totals = createUsageBucket(sessionId, "Session");
  const byModel = new Map<string, ModelUsageBucket>();
  const byInvocationKind = new Map<string, ModelUsageBucket>();
  const byRun = new Map<string, ModelUsageBucket>();

  for (const usage of invocations) {
    addUsageToBucket(totals, usage);
    addToMap(byModel, usage.modelProfileId, usage.modelProfileName, usage);
    addToMap(byInvocationKind, usage.invocationKind, usage.invocationKind, usage);
    if (usage.runId) addToMap(byRun, usage.runId, usage.runId, usage);
  }

  return {
    byInvocationKind: sortBuckets(byInvocationKind.values()),
    byModel: sortBuckets(byModel.values()),
    byRun: sortBuckets(byRun.values()),
    invocations: structuredClone(invocations),
    ...(invocations.at(-1) ? { latestInvocation: structuredClone(invocations.at(-1)!) } : {}),
    sessionId,
    totals,
  };
}

export interface GlobalUsageContext {
  projectNameById: Map<string, string>;
  projectIdBySessionId: Map<string, string>;
  sessionTitleById: Map<string, string>;
}

function resolveProjectId(usage: ModelInvocationUsage, context: GlobalUsageContext): string {
  return usage.projectId
    ?? context.projectIdBySessionId.get(usage.sessionId)
    ?? "unknown-project";
}

function buildRunGroups(records: ModelInvocationUsage[]): GlobalUsageRunGroup[] {
  const groups = new Map<string, GlobalUsageRunGroup>();
  for (const usage of records) {
    const runId = usage.runId ?? null;
    const key = runId ?? `invocation:${usage.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        bucket: createUsageBucket(key, runId ?? usage.invocationId),
        invocations: [],
        runId,
      };
      groups.set(key, group);
    }
    addUsageToBucket(group.bucket, usage);
    group.invocations.push(structuredClone(usage));
  }
  return [...groups.values()].toSorted((left, right) =>
    right.bucket.invocationCount - left.bucket.invocationCount
    || (left.runId ?? "").localeCompare(right.runId ?? ""));
}

function buildSessionGroups(
  records: ModelInvocationUsage[],
  context: GlobalUsageContext,
): GlobalUsageSessionGroup[] {
  const groups = new Map<string, { records: ModelInvocationUsage[]; sessionId: string }>();
  for (const usage of records) {
    let group = groups.get(usage.sessionId);
    if (!group) {
      group = { records: [], sessionId: usage.sessionId };
      groups.set(usage.sessionId, group);
    }
    group.records.push(usage);
  }
  return [...groups.values()].map((group) => {
    const bucket = createUsageBucket(group.sessionId, context.sessionTitleById.get(group.sessionId) ?? group.sessionId);
    for (const usage of group.records) addUsageToBucket(bucket, usage);
    return {
      bucket,
      runs: buildRunGroups(group.records),
      sessionId: group.sessionId,
      sessionTitle: context.sessionTitleById.get(group.sessionId) ?? group.sessionId,
    };
  }).toSorted((left, right) =>
    right.bucket.invocationCount - left.bucket.invocationCount
    || left.sessionTitle.localeCompare(right.sessionTitle));
}

function buildProjectGroups(
  records: ModelInvocationUsage[],
  context: GlobalUsageContext,
): GlobalUsageProjectGroup[] {
  const groups = new Map<string, { projectId: string; records: ModelInvocationUsage[] }>();
  for (const usage of records) {
    const projectId = resolveProjectId(usage, context);
    let group = groups.get(projectId);
    if (!group) {
      group = { projectId, records: [] };
      groups.set(projectId, group);
    }
    group.records.push(usage);
  }
  return [...groups.values()].map((group) => {
    const projectName = context.projectNameById.get(group.projectId) ?? group.projectId;
    const bucket = createUsageBucket(group.projectId, projectName);
    for (const usage of group.records) addUsageToBucket(bucket, usage);
    return {
      bucket,
      projectId: group.projectId,
      projectName,
      sessions: buildSessionGroups(group.records, context),
    };
  }).toSorted((left, right) =>
    right.bucket.invocationCount - left.bucket.invocationCount
    || left.projectName.localeCompare(right.projectName));
}

export function summarizeGlobalModelUsage(
  records: ModelInvocationUsage[],
  context: GlobalUsageContext,
): GlobalModelUsageSummary {
  const normalized = records.map(normalizeInvocation)
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  const totals = createUsageBucket("global", "All models");
  const byModel = new Map<string, { modelProfileId: string; modelProfileName: string; model: string; records: ModelInvocationUsage[] }>();

  for (const usage of normalized) {
    addUsageToBucket(totals, usage);
    let group = byModel.get(usage.modelProfileId);
    if (!group) {
      group = {
        model: usage.model,
        modelProfileId: usage.modelProfileId,
        modelProfileName: usage.modelProfileName,
        records: [],
      };
      byModel.set(usage.modelProfileId, group);
    }
    group.records.push(usage);
  }

  const modelGroups: GlobalUsageModelGroup[] = [...byModel.values()].map((group) => {
    const bucket = createUsageBucket(group.modelProfileId, group.modelProfileName);
    for (const usage of group.records) addUsageToBucket(bucket, usage);
    return {
      bucket,
      model: group.model,
      modelProfileId: group.modelProfileId,
      modelProfileName: group.modelProfileName,
      projects: buildProjectGroups(group.records, context),
    };
  }).toSorted((left, right) =>
    right.bucket.invocationCount - left.bucket.invocationCount
    || left.modelProfileName.localeCompare(right.modelProfileName));

  return { byModel: modelGroups, totals };
}

export interface ModelUsageAnalyticsContext extends GlobalUsageContext {
  pricingByModelProfileId?: Map<string, ResolvedModelPricing>;
}

const DEFAULT_USAGE_ANALYTICS_TIME_ZONE = "Asia/Shanghai";

function usageDateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  });
}

function usageAnalyticsDateContext(requestedTimeZone: string | undefined): {
  formatter: Intl.DateTimeFormat;
  timeZone: string;
} {
  const timeZone = requestedTimeZone?.trim() || DEFAULT_USAGE_ANALYTICS_TIME_ZONE;
  try {
    return { formatter: usageDateFormatter(timeZone), timeZone };
  } catch {
    return {
      formatter: usageDateFormatter(DEFAULT_USAGE_ANALYTICS_TIME_ZONE),
      timeZone: DEFAULT_USAGE_ANALYTICS_TIME_ZONE,
    };
  }
}

function dateBucket(usage: ModelInvocationUsage, formatter: Intl.DateTimeFormat): string {
  const date = new Date(usage.startedAt);
  if (Number.isNaN(date.getTime())) return usage.startedAt.slice(0, 10);
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function matchesFilters(
  usage: ModelInvocationUsage,
  filters: ModelUsageAnalyticsFilters,
  context: Pick<ModelUsageAnalyticsContext, "projectIdBySessionId">,
  formatter: Intl.DateTimeFormat,
): boolean {
  const date = dateBucket(usage, formatter);
  if (filters.from && date < filters.from) return false;
  if (filters.to && date > filters.to) return false;
  if (filters.modelProfileId && usage.modelProfileId !== filters.modelProfileId) return false;
  if (filters.projectId && resolveProjectId(usage, context as GlobalUsageContext) !== filters.projectId) return false;
  return true;
}

function addCost(costs: Map<ModelUsageCost["currency"], number>, cost: ModelUsageCost | undefined): void {
  if (!cost) return;
  costs.set(cost.currency, (costs.get(cost.currency) ?? 0) + cost.amount);
}

function sortedCosts(costs: Map<ModelUsageCost["currency"], number>): ModelUsageCost[] {
  return [...costs.entries()]
    .filter(([, amount]) => amount > 0)
    .map(([currency, amount]) => ({ amount, currency }))
    .toSorted((left, right) => left.currency.localeCompare(right.currency));
}

function findExchangeRate(
  exchangeRates: ModelUsageExchangeRate[] | undefined,
  baseCurrency: ModelUsageCost["currency"],
  quoteCurrency: ModelUsageCost["currency"],
): ModelUsageExchangeRate | undefined {
  if (baseCurrency === quoteCurrency) return undefined;
  return exchangeRates?.find((rate) =>
    rate.baseCurrency === baseCurrency
    && rate.quoteCurrency === quoteCurrency
    && Number.isFinite(rate.rate)
    && rate.rate > 0);
}

function convertUsageCostForDisplay(
  cost: ModelUsageCost,
  displayCurrency: ModelUsageCost["currency"],
  exchangeRates: ModelUsageExchangeRate[] | undefined,
): { cost: ModelUsageCost; exchangeRate?: ModelUsageExchangeRate } | undefined {
  if (cost.currency === displayCurrency) return { cost };
  const exchangeRate = findExchangeRate(exchangeRates, cost.currency, displayCurrency);
  if (!exchangeRate) return undefined;
  return {
    cost: { amount: cost.amount * exchangeRate.rate, currency: displayCurrency },
    exchangeRate,
  };
}

function convertUsageCostsForDisplay(
  costs: ModelUsageCost[],
  displayCurrency: ModelUsageCost["currency"] | undefined,
  exchangeRates: ModelUsageExchangeRate[] | undefined,
): { cost: ModelUsageCost; exchangeRate?: ModelUsageExchangeRate } | undefined {
  if (!displayCurrency || !costs.length) return undefined;
  let exchangeRate: ModelUsageExchangeRate | undefined;
  let amount = 0;
  for (const cost of costs) {
    const converted = convertUsageCostForDisplay(cost, displayCurrency, exchangeRates);
    if (!converted) return undefined;
    amount += converted.cost.amount;
    exchangeRate ??= converted.exchangeRate;
  }
  return { cost: { amount: Number(amount.toFixed(12)), currency: displayCurrency }, ...(exchangeRate ? { exchangeRate } : {}) };
}

export function estimateInvocationCost(
  usage: ModelInvocationUsage,
  pricing: ResolvedModelPricing | undefined,
): ModelUsageCost | undefined {
  if (usage.usageStatus !== "reported") return undefined;
  if (pricing) {
    const amount = ((usage.inputTokens ?? 0) * pricing.input
      + (usage.outputTokens ?? 0) * pricing.output
      + (usage.cacheReadTokens ?? 0) * (pricing.cachedInput ?? pricing.input)
      + (usage.cacheWriteTokens ?? 0) * (pricing.cacheWriteInput ?? pricing.input)) / 1_000_000;
    return amount > 0 ? { amount, currency: pricing.currency } : undefined;
  }
  return usage.costUsd !== null && usage.costUsd !== undefined && usage.costUsd > 0
    ? { amount: usage.costUsd, currency: "USD" }
    : undefined;
}

export function summarizeModelUsageAnalytics(
  records: ModelInvocationUsage[],
  context: ModelUsageAnalyticsContext,
  filters: ModelUsageAnalyticsFilters = {},
): ModelUsageAnalyticsSummary {
  const { formatter, timeZone } = usageAnalyticsDateContext(filters.timeZone);
  const normalized = records
    .map(normalizeInvocation)
    .filter((usage) => matchesFilters(usage, filters, context, formatter))
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  const overviewCosts = new Map<ModelUsageCost["currency"], number>();
  const daily = new Map<string, DailyModelUsageSummary & { costs: Map<ModelUsageCost["currency"], number> }>();
  const overview = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCosts: [] as ModelUsageCost[],
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  for (const usage of normalized) {
    const cost = estimateInvocationCost(usage, context.pricingByModelProfileId?.get(usage.modelProfileId));
    addCost(overviewCosts, cost);
    if (usage.usageStatus === "reported") {
      overview.inputTokens += usage.inputTokens ?? 0;
      overview.outputTokens += usage.outputTokens ?? 0;
      overview.cacheReadTokens += usage.cacheReadTokens ?? 0;
      overview.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      overview.totalTokens += usage.totalTokens ?? 0;
    }

    const date = dateBucket(usage, formatter);
    const key = `${date}:${usage.modelProfileId}`;
    let row = daily.get(key);
    if (!row) {
      row = {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costs: new Map<ModelUsageCost["currency"], number>(),
        date,
        estimatedCosts: [],
        inputTokens: 0,
        model: usage.model,
        modelProfileId: usage.modelProfileId,
        modelProfileName: usage.modelProfileName,
        outputTokens: 0,
        totalTokens: 0,
      };
      daily.set(key, row);
    }
    addCost(row.costs, cost);
    if (usage.usageStatus === "reported") {
      row.inputTokens += usage.inputTokens ?? 0;
      row.outputTokens += usage.outputTokens ?? 0;
      row.cacheReadTokens += usage.cacheReadTokens ?? 0;
      row.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      row.totalTokens += usage.totalTokens ?? 0;
    }
  }

  overview.estimatedCosts = sortedCosts(overviewCosts);
  const dailyByModel = [...daily.values()].map(({ costs, ...row }) => {
    const estimatedCosts = sortedCosts(costs);
    const [estimatedCost] = estimatedCosts;
    return {
      ...row,
      estimatedCosts,
      ...(estimatedCost ? { estimatedCost } : {}),
    };
  }).toSorted((left, right) =>
    right.date.localeCompare(left.date)
    || left.modelProfileName.localeCompare(right.modelProfileName)
    || left.modelProfileId.localeCompare(right.modelProfileId));

  return {
    dailyByModel,
    filters: { ...filters, timeZone },
    generatedAt: new Date().toISOString(),
    overview,
  };
}

function csvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw;
  return `"${safe.replaceAll("\"", "\"\"")}"`;
}

export function modelUsageAnalyticsToCsv(
  summary: ModelUsageAnalyticsSummary,
  options: { displayCurrency?: ModelUsageCost["currency"] } = {},
): string {
  const lines = [
    [
      "date",
      "modelProfileName",
      "modelProfileId",
      "model",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "totalTokens",
      "estimatedCostOriginal",
      "originalCurrency",
      "displayCost",
      "displayCurrency",
      "displayExchangeRate",
      "displayExchangeRateSource",
      "displayExchangeRateRetrievedAt",
    ].map(csvCell).join(","),
  ];
  for (const row of summary.dailyByModel) {
    const displayCost = convertUsageCostsForDisplay(row.estimatedCosts, options.displayCurrency, summary.exchangeRates);
    lines.push([
      row.date,
      row.modelProfileName,
      row.modelProfileId,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.totalTokens,
      row.estimatedCosts.map((cost) => cost.amount).join(" / "),
      row.estimatedCosts.map((cost) => cost.currency).join(" / "),
      displayCost?.cost.amount,
      displayCost?.cost.currency,
      displayCost?.exchangeRate ? `${displayCost.exchangeRate.baseCurrency}/${displayCost.exchangeRate.quoteCurrency} ${displayCost.exchangeRate.rate}` : undefined,
      displayCost?.exchangeRate?.provider,
      displayCost?.exchangeRate?.retrievedAt,
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
