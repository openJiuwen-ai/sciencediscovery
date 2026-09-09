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
  ModelInvocationUsage,
  ModelUsageAnalyticsSummary,
  ModelUsageCost,
  ModelUsageExchangeRate,
  ModelUsageBucket,
} from "@sciencediscovery/schema";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { ChevronDownIcon, ChevronRightIcon, DownloadIcon, ProjectIcon, SessionIcon, SparkleIcon } from "./icons.js";
import { formatCompactTokenValue, formatTokenField, invocationStatusLabel, usageBreakdownLabel, usageInlineLabel } from "./usageFormat.js";
import { useLocale } from "./i18n/index.js";

type UsageCostCurrency = ModelUsageCost["currency"];

const DISPLAY_CURRENCIES: UsageCostCurrency[] = ["CNY", "USD"];
const USAGE_CHART_COLORS = ["#ff5a0a", "#2563eb", "#10b981", "#a855f7", "#f59e0b", "#ef4444", "#14b8a6", "#64748b"];
const DAY_MS = 24 * 60 * 60 * 1000;

function formatUsageCost(cost: ModelUsageCost | undefined, locale: string): string {
  if (!cost) return "--";
  return new Intl.NumberFormat(locale, {
    currency: cost.currency,
    maximumFractionDigits: cost.amount < 1 ? 6 : 2,
    minimumFractionDigits: cost.amount < 1 ? 2 : 2,
    style: "currency",
  }).format(cost.amount);
}

function formatUsageCosts(costs: ModelUsageCost[], locale: string): string {
  return costs.length ? costs.map((cost) => formatUsageCost(cost, locale)).join(" / ") : "--";
}

function findExchangeRate(
  exchangeRates: ModelUsageExchangeRate[] | undefined,
  baseCurrency: UsageCostCurrency,
  quoteCurrency: UsageCostCurrency,
): ModelUsageExchangeRate | undefined {
  if (baseCurrency === quoteCurrency) return undefined;
  return exchangeRates?.find((rate) =>
    rate.baseCurrency === baseCurrency
    && rate.quoteCurrency === quoteCurrency
    && Number.isFinite(rate.rate)
    && rate.rate > 0);
}

function convertUsageCost(
  cost: ModelUsageCost,
  currency: UsageCostCurrency,
  exchangeRates: ModelUsageExchangeRate[] | undefined,
): { cost: ModelUsageCost; exchangeRate?: ModelUsageExchangeRate } | undefined {
  if (cost.currency === currency) return { cost };
  const exchangeRate = findExchangeRate(exchangeRates, cost.currency, currency);
  if (!exchangeRate) return undefined;
  return {
    cost: { amount: cost.amount * exchangeRate.rate, currency },
    exchangeRate,
  };
}

function convertUsageCosts(
  costs: ModelUsageCost[],
  currency: UsageCostCurrency,
  exchangeRates: ModelUsageExchangeRate[] | undefined,
): { cost: ModelUsageCost; exchangeRate?: ModelUsageExchangeRate } | undefined {
  if (!costs.length) return undefined;
  let amount = 0;
  let exchangeRate: ModelUsageExchangeRate | undefined;
  for (const cost of costs) {
    const converted = convertUsageCost(cost, currency, exchangeRates);
    if (!converted) return undefined;
    amount += converted.cost.amount;
    exchangeRate ??= converted.exchangeRate;
  }
  return { cost: { amount, currency }, ...(exchangeRate ? { exchangeRate } : {}) };
}

function hasDisplayCurrencyConversion(
  costs: ModelUsageCost[],
  currency: UsageCostCurrency,
  exchangeRates: ModelUsageExchangeRate[] | undefined,
): boolean {
  return Boolean(convertUsageCosts(costs, currency, exchangeRates))
    && costs.some((cost) => cost.currency !== currency);
}

function formatExchangeRateLabel(rate: ModelUsageExchangeRate, locale: string): string {
  const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(rate.rate);
  const date = rate.effectiveDate ? ` (${rate.effectiveDate})` : "";
  return `1 ${rate.baseCurrency} = ${value} ${rate.quoteCurrency}${date}`;
}

function displayExchangeRate(
  exchangeRates: ModelUsageExchangeRate[] | undefined,
  displayCurrency: UsageCostCurrency,
): ModelUsageExchangeRate | undefined {
  const preferred = displayCurrency === "CNY"
    ? findExchangeRate(exchangeRates, "USD", "CNY")
    : findExchangeRate(exchangeRates, "CNY", "USD");
  return preferred ?? exchangeRates?.find((item) => item.quoteCurrency === displayCurrency) ?? exchangeRates?.[0];
}

function displayExchangeRateLabel(
  exchangeRates: ModelUsageExchangeRate[] | undefined,
  displayCurrency: UsageCostCurrency,
  locale: string,
): string | undefined {
  const rate = displayExchangeRate(exchangeRates, displayCurrency);
  return rate ? formatExchangeRateLabel(rate, locale) : undefined;
}

function estimatedCostTitle(
  t: (key: "usage.estimatedCostTitle" | "usage.estimatedCostApproxSuffix", variables?: Record<string, string | number>) => string,
  currency: UsageCostCurrency,
  approximate: boolean,
): string {
  return t("usage.estimatedCostTitle", {
    approximate: approximate ? t("usage.estimatedCostApproxSuffix") : "",
    currency,
  });
}

function formatChartDate(date: string, locale: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function formatChartNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function niceAxisMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const rounded = normalized <= 1 ? 1
    : normalized <= 2 ? 2
      : normalized <= 5 ? 5 : 10;
  return rounded * magnitude;
}

function parseDateBucket(date: string | undefined): number | undefined {
  const match = date?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const [, yearText, monthText, dayText] = match;
  const [year, month, day] = [yearText, monthText, dayText].map(Number);
  if (!year || !month || !day) return undefined;
  return Date.UTC(year, month - 1, day);
}

function dateBucketFromTime(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function latestUsageChartScrollLeft(scrollWidth: number, clientWidth: number): number {
  return Math.max(0, scrollWidth - clientWidth);
}

function usageSummaryDateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  });
}

function usageSummaryDateBucket(startedAt: string, timeZone: string): string {
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return startedAt.slice(0, 10);
  const parts = Object.fromEntries(usageSummaryDateFormatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function invocationMatchesUsageFilters(
  invocation: ModelInvocationUsage,
  filters: UsageAnalyticsUiFilters,
  timeZone: string,
): boolean {
  const date = usageSummaryDateBucket(invocation.startedAt, timeZone);
  if (filters.from && date < filters.from) return false;
  if (filters.to && date > filters.to) return false;
  if (filters.modelProfileId && invocation.modelProfileId !== filters.modelProfileId) return false;
  return true;
}

function createUiUsageBucket(key: string, label: string): ModelUsageBucket {
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

function addUiNullable(current: number | null, addition: number | null | undefined): number | null {
  if (addition === null || addition === undefined) return current;
  return (current ?? 0) + addition;
}

function addInvocationToUiBucket(bucket: ModelUsageBucket, invocation: ModelInvocationUsage): void {
  bucket.invocationCount += 1;
  if (invocation.usageStatus === "reported") {
    bucket.reportedInvocationCount += 1;
    bucket.inputTokens = addUiNullable(bucket.inputTokens, invocation.inputTokens);
    bucket.outputTokens = addUiNullable(bucket.outputTokens, invocation.outputTokens);
    bucket.totalTokens = addUiNullable(bucket.totalTokens, invocation.totalTokens);
    bucket.cacheReadTokens = addUiNullable(bucket.cacheReadTokens, invocation.cacheReadTokens);
    bucket.cacheWriteTokens = addUiNullable(bucket.cacheWriteTokens, invocation.cacheWriteTokens);
    bucket.costUsd = addUiNullable(bucket.costUsd, invocation.costUsd);
  } else {
    bucket.unreportedInvocationCount += 1;
  }
}

function bucketFromInvocations(key: string, label: string, invocations: ModelInvocationUsage[]): ModelUsageBucket {
  const bucket = createUiUsageBucket(key, label);
  for (const invocation of invocations) addInvocationToUiBucket(bucket, invocation);
  return bucket;
}

export function filterGlobalUsageSummary(
  summary: GlobalModelUsageSummary,
  filters: UsageAnalyticsUiFilters,
  timeZone = "Asia/Shanghai",
): GlobalModelUsageSummary {
  const byModel: GlobalUsageModelGroup[] = [];
  const allInvocations: ModelInvocationUsage[] = [];

  for (const modelGroup of summary.byModel) {
    if (filters.modelProfileId && modelGroup.modelProfileId !== filters.modelProfileId) continue;
    const modelInvocations: ModelInvocationUsage[] = [];
    const projects: GlobalUsageProjectGroup[] = [];
    for (const project of modelGroup.projects) {
      const projectInvocations: ModelInvocationUsage[] = [];
      const sessions: GlobalUsageSessionGroup[] = [];
      for (const session of project.sessions) {
        const sessionInvocations: ModelInvocationUsage[] = [];
        const runs: GlobalUsageRunGroup[] = [];
        for (const run of session.runs) {
          const invocations = run.invocations.filter((invocation) => invocationMatchesUsageFilters(invocation, filters, timeZone));
          if (!invocations.length) continue;
          sessionInvocations.push(...invocations);
          runs.push({
            bucket: bucketFromInvocations(run.bucket.key, run.bucket.label, invocations),
            invocations,
            runId: run.runId,
          });
        }
        if (!sessionInvocations.length) continue;
        projectInvocations.push(...sessionInvocations);
        sessions.push({
          bucket: bucketFromInvocations(session.bucket.key, session.bucket.label, sessionInvocations),
          runs,
          sessionId: session.sessionId,
          sessionTitle: session.sessionTitle,
        });
      }
      if (!projectInvocations.length) continue;
      modelInvocations.push(...projectInvocations);
      projects.push({
        bucket: bucketFromInvocations(project.bucket.key, project.bucket.label, projectInvocations),
        projectId: project.projectId,
        projectName: project.projectName,
        sessions,
      });
    }
    if (!modelInvocations.length) continue;
    allInvocations.push(...modelInvocations);
    byModel.push({
      bucket: bucketFromInvocations(modelGroup.bucket.key, modelGroup.bucket.label, modelInvocations),
      model: modelGroup.model,
      modelProfileId: modelGroup.modelProfileId,
      modelProfileName: modelGroup.modelProfileName,
      projects,
    });
  }

  return {
    byModel,
    totals: bucketFromInvocations(summary.totals.key, summary.totals.label, allInvocations),
  };
}

function localDateBucket(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateBucketDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - Math.max(0, days - 1));
  return localDateBucket(date);
}

export interface UsageAnalyticsUiFilters {
  from?: string;
  modelProfileId?: string;
  to?: string;
}

interface DailyUsageChartPoint {
  costs: Map<ModelUsageCost["currency"], number>;
  date: string;
  rows: DailyModelUsageSummary[];
  totalTokens: number;
}

function buildDailyChartPoints(
  rows: DailyModelUsageSummary[],
  range: { fallbackEndDate?: string; from?: string; to?: string } = {},
): DailyUsageChartPoint[] {
  const byDate = new Map<string, DailyUsageChartPoint>();
  for (const row of rows) {
    let point = byDate.get(row.date);
    if (!point) {
      point = { costs: new Map(), date: row.date, rows: [], totalTokens: 0 };
      byDate.set(row.date, point);
    }
    point.rows.push(row);
    point.totalTokens += row.totalTokens;
    for (const cost of row.estimatedCosts) {
      point.costs.set(cost.currency, (point.costs.get(cost.currency) ?? 0) + cost.amount);
    }
  }
  const sortedDates = [...byDate.keys()].toSorted((left, right) => left.localeCompare(right));
  const firstDataDate = parseDateBucket(sortedDates[0]);
  const lastDataDate = parseDateBucket(sortedDates.at(-1));
  const requestedStartDate = parseDateBucket(range.from);
  const requestedEndDate = parseDateBucket(range.to);
  const generatedDate = parseDateBucket(range.fallbackEndDate);
  const fallbackLast = Math.max(lastDataDate ?? 0, generatedDate ?? 0);
  const last = requestedEndDate ?? fallbackLast;
  const thirtyDayStart = last - (29 * DAY_MS);
  const first = requestedStartDate ?? Math.min(firstDataDate ?? thirtyDayStart, thirtyDayStart);
  if (!last || first === undefined || last < first) {
    return [...byDate.values()].toSorted((left, right) => left.date.localeCompare(right.date));
  }
  const points: DailyUsageChartPoint[] = [];
  for (let time = first; time <= last; time += DAY_MS) {
    const date = dateBucketFromTime(time);
    points.push(byDate.get(date) ?? { costs: new Map(), date, rows: [], totalTokens: 0 });
  }
  return points;
}

function costsFromPoint(point: DailyUsageChartPoint): ModelUsageCost[] {
  return [...point.costs].map(([currency, amount]) => ({ amount, currency }));
}

function TokenMeter({ bucket }: { bucket: ModelUsageBucket }) {
  const { t } = useLocale();
  const hasReported = bucket.reportedInvocationCount > 0;
  return (
    <div className={hasReported ? "usage-token-meter" : "usage-token-meter muted"} aria-label={t("usage.aria")}>
      <span><em>{t("usage.total")}</em><strong>{formatCompactTokenValue(bucket.totalTokens)}</strong></span>
      <span><em>{t("usage.input")}</em><strong>{formatCompactTokenValue(bucket.inputTokens)}</strong></span>
      <span><em>{t("usage.output")}</em><strong>{formatCompactTokenValue(bucket.outputTokens)}</strong></span>
      <span><em>{t("usage.cacheRead")}</em><strong>{formatCompactTokenValue(bucket.cacheReadTokens)}</strong></span>
      <span><em>{t("usage.cacheWrite")}</em><strong>{formatCompactTokenValue(bucket.cacheWriteTokens)}</strong></span>
      <span><em>{t("usage.calls")}</em><strong>{bucket.invocationCount}</strong></span>
      {bucket.unreportedInvocationCount > 0 ? <span className="usage-unreported"><em>{t("usage.unreported")}</em><strong>{bucket.unreportedInvocationCount}</strong></span> : null}
    </div>
  );
}

function InvocationRow({ usage }: { usage: ModelInvocationUsage }) {
  return (
    <tr>
      <td><strong>{usage.invocationKind}</strong><small>{usage.modelProfileName}</small></td>
      <td>{invocationStatusLabel(usage)}</td>
      <td>{formatTokenField(usage.totalTokens)}</td>
      <td>{formatTokenField(usage.inputTokens)}</td>
      <td>{formatTokenField(usage.outputTokens)}</td>
      <td>{formatTokenField(usage.cacheReadTokens)}</td>
      <td>{formatTokenField(usage.cacheWriteTokens)}</td>
    </tr>
  );
}

export function InvocationTable({ invocations }: { invocations: ModelInvocationUsage[] }) {
  const { t } = useLocale();
  return (
    <div className="usage-invocation-table-wrap">
      <table className="usage-invocation-table">
        <thead>
          <tr>
            <th scope="col">{t("usage.kind")}</th>
            <th scope="col">{t("usage.status")}</th>
            <th scope="col">{t("usage.total")}</th>
            <th scope="col">{t("usage.input")}</th>
            <th scope="col">{t("usage.output")}</th>
            <th scope="col">{t("usage.cacheRead")}</th>
            <th scope="col">{t("usage.cacheWrite")}</th>
          </tr>
        </thead>
        <tbody>
          {invocations.map((usage) => <InvocationRow key={usage.id} usage={usage} />)}
        </tbody>
      </table>
    </div>
  );
}

function UsageOverview({
  analytics,
  displayCurrency,
}: {
  analytics: ModelUsageAnalyticsSummary;
  displayCurrency: UsageCostCurrency;
}) {
  const { locale, t } = useLocale();
  const estimatedCost = convertUsageCosts(analytics.overview.estimatedCosts, displayCurrency, analytics.exchangeRates);
  const canDisplayCurrency = Boolean(estimatedCost);
  const costTitle = canDisplayCurrency
    ? estimatedCostTitle(t, displayCurrency, hasDisplayCurrencyConversion(analytics.overview.estimatedCosts, displayCurrency, analytics.exchangeRates))
    : t("usage.estimatedCostOriginal");
  return (
    <div className="usage-overview">
      <span><em>{t("usage.total")}</em><strong>{formatCompactTokenValue(analytics.overview.totalTokens)}</strong></span>
      <span><em>{t("usage.input")}</em><strong>{formatCompactTokenValue(analytics.overview.inputTokens)}</strong></span>
      <span><em>{t("usage.output")}</em><strong>{formatCompactTokenValue(analytics.overview.outputTokens)}</strong></span>
      <span><em>{t("usage.cacheRead")}</em><strong>{formatCompactTokenValue(analytics.overview.cacheReadTokens)}</strong></span>
      <span><em>{t("usage.cacheWrite")}</em><strong>{formatCompactTokenValue(analytics.overview.cacheWriteTokens)}</strong></span>
      <span><em>{costTitle}</em><strong>{estimatedCost ? formatUsageCost(estimatedCost.cost, locale) : formatUsageCosts(analytics.overview.estimatedCosts, locale)}</strong></span>
    </div>
  );
}

function UsageFilters({
  filters,
  modelGroups,
  onChange,
}: {
  filters: UsageAnalyticsUiFilters;
  modelGroups: GlobalUsageModelGroup[];
  onChange: (filters: UsageAnalyticsUiFilters) => void;
}) {
  const { t } = useLocale();
  const modelOptions = useMemo(() => modelGroups.toSorted((left, right) =>
    left.modelProfileName.localeCompare(right.modelProfileName) || left.modelProfileId.localeCompare(right.modelProfileId)), [modelGroups]);
  const updateFilter = (key: keyof UsageAnalyticsUiFilters, value: string) => {
    const next = { ...filters, [key]: value || undefined };
    if (!next.from) delete next.from;
    if (!next.to) delete next.to;
    if (!next.modelProfileId) delete next.modelProfileId;
    onChange(next);
  };
  const applyPreset = (days: number) => {
    onChange({ ...filters, from: localDateBucketDaysAgo(days), to: localDateBucket() });
  };
  const clearFilters = () => onChange({});
  return (
    <div className="usage-filter-bar" aria-label={t("usage.filters")}>
      <label className="usage-filter-field model">
        <span>{t("usage.filterModel")}</span>
        <select value={filters.modelProfileId ?? ""} onChange={(event) => updateFilter("modelProfileId", event.currentTarget.value)}>
          <option value="">{t("usage.allModels")}</option>
          {modelOptions.map((group) => (
            <option key={group.modelProfileId} value={group.modelProfileId}>
              {group.modelProfileName}
            </option>
          ))}
        </select>
      </label>
      <label className="usage-filter-field">
        <span>{t("usage.filterFrom")}</span>
        <input
          type="date"
          value={filters.from ?? ""}
          max={filters.to}
          onChange={(event) => updateFilter("from", event.currentTarget.value)}
        />
      </label>
      <label className="usage-filter-field">
        <span>{t("usage.filterTo")}</span>
        <input
          type="date"
          value={filters.to ?? ""}
          min={filters.from}
          onChange={(event) => updateFilter("to", event.currentTarget.value)}
        />
      </label>
      <div className="usage-filter-presets">
        <button type="button" className="secondary-button" onClick={() => applyPreset(7)}>{t("usage.last7Days")}</button>
        <button type="button" className="secondary-button" onClick={() => applyPreset(30)}>{t("usage.last30Days")}</button>
        <button type="button" className="secondary-button" onClick={clearFilters}>{t("usage.clearFilters")}</button>
      </div>
    </div>
  );
}

function DailyUsageChart({
  analytics,
  displayCurrency,
  filters,
  onDisplayCurrencyChange,
}: {
  analytics: ModelUsageAnalyticsSummary;
  displayCurrency: UsageCostCurrency;
  filters: UsageAnalyticsUiFilters;
  onDisplayCurrencyChange: (currency: UsageCostCurrency) => void;
}) {
  const { locale, t } = useLocale();
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [activeIndex, setActiveIndex] = useState<number | undefined>();
  const [dragging, setDragging] = useState(false);
  const [plotWidth, setPlotWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; scrollLeft: number; startX: number } | undefined>(undefined);
  const points = useMemo(() => buildDailyChartPoints(analytics.dailyByModel, {
    fallbackEndDate: analytics.generatedAt,
    from: filters.from,
    to: filters.to,
  }), [analytics.dailyByModel, analytics.generatedAt, filters.from, filters.to]);
  const modelColorIndex = useMemo(() => new Map(
    [...new Set(analytics.dailyByModel.map((row) => row.modelProfileId))]
      .toSorted((left, right) => {
        const leftName = analytics.dailyByModel.find((row) => row.modelProfileId === left)?.modelProfileName ?? left;
        const rightName = analytics.dailyByModel.find((row) => row.modelProfileId === right)?.modelProfileName ?? right;
        return leftName.localeCompare(rightName) || left.localeCompare(right);
      })
      .map((id, index) => [id, index] as const),
  ), [analytics.dailyByModel]);
  const hasEstimatedCosts = analytics.overview.estimatedCosts.length > 0;
  const totalCost = convertUsageCosts(analytics.overview.estimatedCosts, displayCurrency, analytics.exchangeRates);
  const hasCostChart = Boolean(totalCost);
  const activeMetric = metric === "cost" && hasCostChart ? "cost" : "tokens";
  const totals = points.map((point) => activeMetric === "cost"
    ? convertUsageCosts(costsFromPoint(point), displayCurrency, analytics.exchangeRates)?.cost.amount ?? 0
    : point.totalTokens);
  const axisMax = niceAxisMax(Math.max(...totals, 0));
  const chartSlotWidth = points.length > 90 ? 34 : 38;
  const chartSlotGap = points.length > 31 ? 6 : 8;
  const chartPadding = 6;
  const chartContentWidth = (points.length * chartSlotWidth) + (Math.max(points.length - 1, 0) * chartSlotGap) + (chartPadding * 2);
  const chartFitsViewport = plotWidth > 0 ? chartContentWidth <= plotWidth : points.length <= 31;
  const renderedSlotWidth = chartFitsViewport && plotWidth > 0
    ? Math.max(1, (plotWidth - (chartPadding * 2) - (Math.max(points.length - 1, 0) * chartSlotGap)) / Math.max(points.length, 1))
    : chartSlotWidth;
  const hasApproximateCurrency = hasDisplayCurrencyConversion(analytics.overview.estimatedCosts, displayCurrency, analytics.exchangeRates);
  const exchangeRate = displayExchangeRate(analytics.exchangeRates, displayCurrency);
  const exchangeRateLabel = displayExchangeRateLabel(analytics.exchangeRates, displayCurrency, locale);
  const title = activeMetric === "cost"
    ? estimatedCostTitle(t, displayCurrency, hasApproximateCurrency)
    : t("usage.dailyTokens");
  const total = activeMetric === "cost"
    ? formatUsageCost(totalCost?.cost, locale)
    : formatCompactTokenValue(analytics.overview.totalTokens);
  const chartItems = points.map((point, index) => {
    const convertedCost = convertUsageCosts(costsFromPoint(point), displayCurrency, analytics.exchangeRates);
    const value = activeMetric === "cost" ? convertedCost?.cost.amount ?? 0 : point.totalTokens;
    const displayValue = activeMetric === "cost"
      ? convertedCost ? formatUsageCost(convertedCost.cost, locale) : t("usage.notConfigured")
      : formatTokenField(value);
    const rows = point.rows
      .toSorted((left, right) =>
        (modelColorIndex.get(left.modelProfileId) ?? 0) - (modelColorIndex.get(right.modelProfileId) ?? 0)
        || left.modelProfileName.localeCompare(right.modelProfileName))
      .map((row) => {
        const rowCost = convertUsageCosts(row.estimatedCosts, displayCurrency, analytics.exchangeRates);
        const rowValue = activeMetric === "cost" ? rowCost?.cost.amount ?? 0 : row.totalTokens;
        const rowHeight = Math.max(rowValue > 0 ? 4 : 0, Math.round((rowValue / axisMax) * 100));
        const unpricedCost = activeMetric === "cost" && !rowCost && row.totalTokens > 0;
        const colorIndex = modelColorIndex.get(row.modelProfileId) ?? 0;
        return {
          color: unpricedCost ? "#94a3b8" : USAGE_CHART_COLORS[colorIndex % USAGE_CHART_COLORS.length],
          displayValue: activeMetric === "cost"
            ? rowCost ? formatUsageCost(rowCost.cost, locale) : t("usage.notConfigured")
            : formatTokenField(rowValue),
          height: unpricedCost ? 4 : rowHeight,
          key: `${point.date}:${row.modelProfileId}`,
          modelProfileId: row.modelProfileId,
          modelProfileName: row.modelProfileName,
          unpriced: unpricedCost,
        };
      });
    const height = Math.max(value > 0 ? 4 : 0, Math.round((value / axisMax) * 100));
    return {
      date: point.date,
      displayValue,
      height,
      index,
      rows,
      tooltipPlacement: height >= 72 ? "top" : "above",
    };
  });
  const legendItems = [...modelColorIndex.entries()].map(([modelProfileId, colorIndex]) => {
    const rows = analytics.dailyByModel.filter((row) => row.modelProfileId === modelProfileId);
    const hasVisibleCost = rows.some((row) => convertUsageCosts(row.estimatedCosts, displayCurrency, analytics.exchangeRates));
    const unpriced = activeMetric === "cost" && rows.some((row) => row.totalTokens > 0) && !hasVisibleCost;
    return {
      color: unpriced ? "#94a3b8" : USAGE_CHART_COLORS[colorIndex % USAGE_CHART_COLORS.length],
      modelProfileId,
      name: rows[0]?.modelProfileName ?? modelProfileId,
    };
  });
  const activeTooltip = activeIndex === undefined ? undefined : chartItems[activeIndex];
  const tooltipLeft = activeTooltip
    ? chartPadding + activeTooltip.index * (renderedSlotWidth + chartSlotGap) + (renderedSlotWidth / 2) - scrollLeft
    : 0;
  const tooltipAlignment = plotWidth > 0 && tooltipLeft < 190
    ? "left"
    : plotWidth > 0 && tooltipLeft > plotWidth - 190 ? "right" : "center";
  const scrollKey = `${points[0]?.date ?? ""}:${points.at(-1)?.date ?? ""}:${points.length}:${filters.from ?? ""}:${filters.to ?? ""}`;
  const latestScrollKeyRef = useRef<string | undefined>(undefined);

  const syncScrollMetrics = () => {
    const node = scrollRef.current;
    if (!node) return;
    setScrollLeft(node.scrollLeft);
    setPlotWidth(node.clientWidth);
  };
  const showTooltip = (index: number) => {
    syncScrollMetrics();
    setActiveIndex(index);
  };
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    setScrollLeft(event.currentTarget.scrollLeft);
    setPlotWidth(event.currentTarget.clientWidth);
  };
  const handlePointerDown: React.PointerEventHandler<HTMLDivElement> = (event) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      scrollLeft: event.currentTarget.scrollLeft,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove: React.PointerEventHandler<HTMLDivElement> = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const distance = event.clientX - drag.startX;
    if (Math.abs(distance) > 3) {
      setDragging(true);
      setActiveIndex(undefined);
    }
    event.currentTarget.scrollLeft = drag.scrollLeft - distance;
    setScrollLeft(event.currentTarget.scrollLeft);
    setPlotWidth(event.currentTarget.clientWidth);
  };
  const endDrag: React.PointerEventHandler<HTMLDivElement> = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    dragRef.current = undefined;
    setDragging(false);
  };

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    setPlotWidth(node.clientWidth);
    if (plotWidth <= 0) return;
    if (latestScrollKeyRef.current === scrollKey) {
      setScrollLeft(node.scrollLeft);
      return;
    }
    const nextScrollLeft = chartFitsViewport ? 0 : latestUsageChartScrollLeft(node.scrollWidth, node.clientWidth);
    node.scrollLeft = nextScrollLeft;
    setScrollLeft(nextScrollLeft);
    latestScrollKeyRef.current = scrollKey;
  }, [chartContentWidth, chartFitsViewport, plotWidth, scrollKey]);

  return (
    <article className="usage-chart-panel" aria-label={t("usage.dailyChart")}>
      <header className="usage-chart-header">
        <div className="usage-chart-title">
          <strong>{title}</strong>
          <span>{total}</span>
        </div>
        <div className="usage-chart-controls">
          <select
            aria-label={t("usage.currency")}
            value={displayCurrency}
            onChange={(event) => onDisplayCurrencyChange(event.currentTarget.value as UsageCostCurrency)}
          >
            {DISPLAY_CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
          </select>
          <div className="usage-chart-segmented" role="group" aria-label={t("usage.chartMetric")}>
            <button type="button" className={activeMetric === "cost" ? "active" : ""} disabled={!hasCostChart} onClick={() => setMetric("cost")}>
              {t("usage.cost")}
            </button>
            <button type="button" className={activeMetric === "tokens" ? "active" : ""} onClick={() => setMetric("tokens")}>
              {t("usage.tokens")}
            </button>
          </div>
        </div>
      </header>
      {legendItems.length ? (
        <div className="usage-chart-legend" aria-label={t("usage.chartLegend")}>
          {legendItems.map((item) => (
            <span className="usage-chart-legend-item" key={item.modelProfileId}>
              <i aria-hidden="true" style={{ "--bar-color": item.color } as React.CSSProperties} />
              <span>{item.name}</span>
            </span>
          ))}
        </div>
      ) : null}
      {hasApproximateCurrency && exchangeRateLabel ? (
        <p className="usage-currency-note">
          {exchangeRate?.stale
            ? t("usage.currencyStaleNote", { rate: exchangeRateLabel })
            : t("usage.currencyApproxNote", { rate: exchangeRateLabel })}
        </p>
      ) : hasEstimatedCosts && !hasCostChart ? (
        <p className="usage-currency-note">{t("usage.currencyUnavailableNote")}</p>
      ) : null}
      <div className="usage-chart-body">
        <div className="usage-chart-axis" aria-hidden="true">
          <div className="usage-chart-axis-labels">
            <span>{activeMetric === "cost" ? formatChartNumber(axisMax) : formatCompactTokenValue(axisMax)}</span>
            <span>{activeMetric === "cost" ? formatChartNumber(axisMax / 2) : formatCompactTokenValue(axisMax / 2)}</span>
            <span>0</span>
          </div>
          <span className="usage-chart-axis-spacer" />
        </div>
        <div className="usage-chart-plot">
          <div className="usage-chart-gridline top" aria-hidden="true" />
          <div className="usage-chart-gridline middle" aria-hidden="true" />
          <div className="usage-chart-gridline bottom" aria-hidden="true" />
          {activeTooltip && activeTooltip.rows.length ? (
            <span
              className={`usage-chart-tooltip align-${tooltipAlignment}`}
              style={{ "--tooltip-left": `${Math.max(8, tooltipLeft)}px` } as React.CSSProperties}
            >
              <strong>
                {activeTooltip.date}
                <em>{activeTooltip.displayValue}</em>
              </strong>
              {activeTooltip.rows.map((row) => (
                <span
                  className={row.unpriced ? "usage-chart-tooltip-row muted" : "usage-chart-tooltip-row"}
                  key={row.key}
                  style={{ "--bar-color": row.color } as React.CSSProperties}
                >
                  <i aria-hidden="true" />
                  <span>{row.modelProfileName}</span>
                  <em>{row.displayValue}</em>
                </span>
              ))}
              {activeTooltip.rows.length > 1 ? (
                <span className="usage-chart-tooltip-row muted">
                  <i aria-hidden="true" />
                  <span>{t("usage.total")}</span>
                  <em>{activeTooltip.displayValue}</em>
                </span>
              ) : null}
            </span>
          ) : null}
          <div
            className={dragging ? "usage-chart-scroll dragging" : "usage-chart-scroll"}
            onPointerCancel={endDrag}
            onPointerDown={handlePointerDown}
            onPointerLeave={() => setActiveIndex(undefined)}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onScroll={handleScroll}
            ref={scrollRef}
          >
            <div
              className={chartFitsViewport ? "usage-chart-bars fit" : "usage-chart-bars scroll"}
              style={{
                "--chart-content-min": `${chartContentWidth}px`,
                "--day-slot-gap": `${chartSlotGap}px`,
                "--day-slot-width": `${chartSlotWidth}px`,
              } as React.CSSProperties}
            >
              {chartItems.map((item) => (
                <div className="usage-chart-column" key={item.date}>
                  {item.rows.length ? (
                    <button
                      type="button"
                      className={item.tooltipPlacement === "top" ? "usage-chart-bar tooltip-top" : "usage-chart-bar"}
                      onBlur={() => setActiveIndex(undefined)}
                      onFocus={() => showTooltip(item.index)}
                      onPointerEnter={() => showTooltip(item.index)}
                      style={{ "--bar-height": `${item.height}%` } as React.CSSProperties}
                      aria-label={`${item.date} ${item.displayValue}`}
                    >
                      <span className="usage-chart-bar-stack">
                        {item.rows.map((row) => (
                          <span
                            aria-hidden="true"
                            className={row.unpriced ? "usage-chart-segment unpriced" : "usage-chart-segment"}
                            key={row.key}
                            style={{
                              "--bar-color": row.color,
                              "--segment-height": `${row.height}%`,
                            } as React.CSSProperties}
                          />
                        ))}
                      </span>
                    </button>
                  ) : <span className="usage-chart-empty-day" aria-hidden="true" />}
                  <span className="usage-chart-date" aria-hidden="true">{formatChartDate(item.date, locale)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function SessionGroup({
  group,
  onOpenSession,
}: {
  group: GlobalUsageSessionGroup;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="usage-tree-node session">
      <button type="button" className="usage-tree-toggle" onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDownIcon size={15} /> : <ChevronRightIcon size={15} />}
        <SessionIcon size={15} />
        <span>
          <strong>{group.sessionTitle}</strong>
          <small>{usageBreakdownLabel(group.bucket)}</small>
        </span>
        <em>{formatCompactTokenValue(group.bucket.totalTokens)}</em>
      </button>
      <div className="usage-tree-actions">
        <button type="button" className="secondary-button usage-open-button" onClick={() => onOpenSession(group.sessionId)}>{t("usage.openSession")}</button>
      </div>
      {expanded ? (
        <div className="usage-tree-children">
          {group.runs.map((run) => (
            <div className="usage-tree-node run" key={`${group.sessionId}:${run.runId ?? run.bucket.key}`}>
              <div className="usage-run-header">
                <strong>{run.runId ? `Run ${run.runId.slice(0, 8)}` : "Standalone invocations"}</strong>
                <small>{usageBreakdownLabel(run.bucket)}</small>
              </div>
              <InvocationTable invocations={run.invocations} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProjectGroup({
  group,
  onOpenSession,
}: {
  group: GlobalUsageProjectGroup;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="usage-tree-node project">
      <button type="button" className="usage-tree-toggle" onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDownIcon size={15} /> : <ChevronRightIcon size={15} />}
        <ProjectIcon size={15} />
        <span>
          <strong>{group.projectName}</strong>
          <small>{usageBreakdownLabel(group.bucket)}</small>
        </span>
        <em>{formatCompactTokenValue(group.bucket.totalTokens)}</em>
      </button>
      {expanded ? (
        <div className="usage-tree-children">
          {group.sessions.map((session) => (
            <SessionGroup key={session.sessionId} group={session} onOpenSession={onOpenSession} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ModelGroup({
  group,
  onOpenSession,
}: {
  group: GlobalUsageModelGroup;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <article className="usage-model-card">
      <button type="button" className="usage-tree-toggle model" onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
        <SparkleIcon size={16} />
        <span>
          <strong>{group.modelProfileName}</strong>
          <small>{group.model} - {usageBreakdownLabel(group.bucket)}</small>
        </span>
        <em>{formatCompactTokenValue(group.bucket.totalTokens)}</em>
      </button>
      {expanded ? (
        <div className="usage-tree-children">
          <TokenMeter bucket={group.bucket} />
          {group.projects.map((project) => (
            <ProjectGroup key={`${group.modelProfileId}:${project.projectId}`} group={project} onOpenSession={onOpenSession} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function UsagePage({
  analytics,
  filters,
  onExport,
  onFiltersChange,
  onOpenSession,
  summary,
}: {
  analytics: ModelUsageAnalyticsSummary | undefined;
  filters: UsageAnalyticsUiFilters;
  onExport: (format: "csv" | "json", displayCurrency: UsageCostCurrency) => void;
  onFiltersChange: (filters: UsageAnalyticsUiFilters) => void;
  onOpenSession: (sessionId: string) => void;
  summary: GlobalModelUsageSummary | undefined;
}) {
  const { locale, t } = useLocale();
  const loading = summary === undefined || analytics === undefined;
  const filteredSummary = useMemo(() => summary
    ? filterGlobalUsageSummary(summary, filters, analytics?.filters.timeZone)
    : undefined, [analytics?.filters.timeZone, filters, summary]);
  const filteredModelGroups = useMemo(() => {
    if (!filteredSummary) return [];
    if (!filters.modelProfileId) return filteredSummary.byModel;
    return filteredSummary.byModel.filter((group) => group.modelProfileId === filters.modelProfileId);
  }, [filteredSummary, filters.modelProfileId]);
  const hasAnyStoredUsage = Boolean(summary && summary.byModel.length > 0);
  const empty = Boolean(summary && analytics && summary.byModel.length === 0 && analytics.dailyByModel.length === 0);
  const filteredEmpty = Boolean(summary && analytics && hasAnyStoredUsage && analytics.dailyByModel.length === 0 && analytics.overview.totalTokens === 0);
  const [displayCurrency, setDisplayCurrency] = useState<UsageCostCurrency>("CNY");
  const hasApproximateCurrency = analytics
    ? hasDisplayCurrencyConversion(analytics.overview.estimatedCosts, displayCurrency, analytics.exchangeRates)
    : false;
  const exchangeRate = analytics ? displayExchangeRate(analytics.exchangeRates, displayCurrency) : undefined;
  const exchangeRateLabel = analytics ? displayExchangeRateLabel(analytics.exchangeRates, displayCurrency, locale) : undefined;
  const subtitle = useMemo(() => {
    if (loading) return t("usage.loading");
    if (empty) return t("usage.empty");
    return t("usage.subtitle", {
      models: filters.modelProfileId ? filteredModelGroups.length : summary!.byModel.length,
      tokens: formatCompactTokenValue(analytics!.overview.totalTokens),
    });
  }, [analytics, empty, filteredModelGroups.length, filters.modelProfileId, loading, summary, t]);

  return (
    <section className="usage-page" aria-label={t("usage.aria")}>
      <header className="usage-page-header">
        <div>
          <span className="eyebrow">{t("usage.eyebrow")}</span>
          <h1>{t("usage.title")}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="usage-export-actions" aria-label={t("usage.export")}>
          <button type="button" className="secondary-button" disabled={loading} onClick={() => onExport("csv", displayCurrency)} title={t("usage.exportCsv")}>
            <DownloadIcon size={15} /> CSV
          </button>
          <button type="button" className="secondary-button" disabled={loading} onClick={() => onExport("json", displayCurrency)} title={t("usage.exportJson")}>
            <DownloadIcon size={15} /> JSON
          </button>
        </div>
        {analytics?.overview.estimatedCosts.length ? (
          <p className="usage-export-note">
            {hasApproximateCurrency && exchangeRateLabel
              ? exchangeRate?.stale
                ? t("usage.exportOriginalCurrencyWithStaleNote", { rate: exchangeRateLabel })
                : t("usage.exportOriginalCurrencyWithApproxNote", { rate: exchangeRateLabel })
              : t("usage.exportOriginalCurrencyNote")}
          </p>
        ) : null}
        {analytics ? <UsageOverview analytics={analytics} displayCurrency={displayCurrency} /> : null}
        {summary && hasAnyStoredUsage ? (
          <UsageFilters filters={filters} modelGroups={summary.byModel} onChange={onFiltersChange} />
        ) : null}
      </header>
      {loading ? (
        <div className="usage-empty">
          <SparkleIcon size={22} />
          <strong>{t("usage.loadingTitle")}</strong>
          <p>{t("usage.loadingHelp")}</p>
        </div>
      ) : empty ? (
        <div className="usage-empty">
          <SparkleIcon size={22} />
          <strong>{t("usage.emptyTitle")}</strong>
          <p>{t("usage.emptyHelp")}</p>
        </div>
      ) : filteredEmpty ? (
        <div className="usage-empty">
          <SparkleIcon size={22} />
          <strong>{t("usage.filteredEmptyTitle")}</strong>
          <p>{t("usage.filteredEmptyHelp")}</p>
        </div>
      ) : (
        <>
          <DailyUsageChart analytics={analytics!} displayCurrency={displayCurrency} filters={filters} onDisplayCurrencyChange={setDisplayCurrency} />
          <div className="usage-model-list">
            {filteredModelGroups.map((group) => (
              <ModelGroup key={group.modelProfileId} group={group} onOpenSession={onOpenSession} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function RunUsageInline({
  run,
}: {
  run?: { bucket: ModelUsageBucket; runId: string };
}) {
  const { t } = useLocale();
  if (!run) return null;
  return (
    <p className="message-usage-inline" aria-label={t("usage.run")}>
      {t("usage.eyebrow")}: {usageInlineLabel(run.bucket)}
    </p>
  );
}
