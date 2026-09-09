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

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GlobalModelUsageSummary, ModelInvocationUsage, ModelUsageAnalyticsSummary, ModelUsageBucket } from "@sciencediscovery/schema";

import { filterGlobalUsageSummary, InvocationTable, latestUsageChartScrollLeft, RunUsageInline, UsagePage } from "../src/UsagePage.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { formatCompactTokenValue, usageBreakdownLabel, usageInlineLabel, usageInOutLabel } from "../src/usageFormat.js";

function bucket(overrides: Partial<ModelUsageBucket> = {}): ModelUsageBucket {
  return {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    inputTokens: 10,
    invocationCount: 1,
    key: "bucket",
    label: "Bucket",
    outputTokens: 5,
    reportedInvocationCount: 1,
    totalTokens: 15,
    unreportedInvocationCount: 0,
    ...overrides,
  };
}

test("USG-011 usage formatting omits missing token fields instead of unreported", () => {
  assert.equal(formatCompactTokenValue(null), "—");
  assert.equal(formatCompactTokenValue(undefined), "—");
  assert.equal(
    usageInlineLabel(bucket({
      cacheReadTokens: 2_000,
      cacheWriteTokens: null,
      inputTokens: 6_600,
      outputTokens: 102,
    })),
    "input 6.6K / output 102 / cache read 2.0K",
  );
  assert.doesNotMatch(usageInlineLabel(bucket({ cacheWriteTokens: null })), /unreported|cache write/);
  assert.equal(usageInOutLabel(bucket({ cacheReadTokens: 19_000 })), "in 10 · out 5");
  assert.doesNotMatch(usageInOutLabel(bucket({ cacheReadTokens: 19_000 })), /cache/);
  assert.equal(usageBreakdownLabel(bucket({ inputTokens: null, unreportedInvocationCount: 1 })), "out 5");
});

test("USG-012 usage page renders model drilldown, chart and inline/table usage", () => {
  const invocation: ModelInvocationUsage = {
    attemptIndex: 0,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    costUsd: null,
    finishedAt: "2026-08-03T06:40:00.000Z",
    id: "usage-a",
    inputTokens: 10,
    invocationId: "invocation-a",
    invocationKind: "task",
    model: "model-a",
    modelProfileId: "model-a",
    modelProfileName: "Model A",
    outputTokens: 5,
    runId: "run-a",
    sessionId: "session-a",
    startedAt: "2026-08-03T06:39:00.000Z",
    totalTokens: 15,
    usageStatus: "reported",
  };
  const laterInvocation: ModelInvocationUsage = {
    ...invocation,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    finishedAt: "2026-08-04T06:41:00.000Z",
    id: "usage-b",
    inputTokens: 20,
    invocationId: "invocation-b",
    model: "model-b",
    modelProfileId: "model-b",
    modelProfileName: "Model B",
    outputTokens: 10,
    runId: undefined,
    sessionId: "session-b",
    startedAt: "2026-08-04T06:40:00.000Z",
    totalTokens: 30,
  };
  const summary: GlobalModelUsageSummary = {
    byModel: [{
      bucket: bucket({ key: "model-a", label: "Model A" }),
      model: "model-a",
      modelProfileId: "model-a",
      modelProfileName: "Model A",
      projects: [{
        bucket: bucket({ key: "project-a", label: "Alpha" }),
        projectId: "project-a",
        projectName: "Alpha",
        sessions: [{
          bucket: bucket({ key: "session-a", label: "Session A" }),
          runs: [{
            bucket: bucket({ key: "run-a", label: "run-a" }),
            invocations: [invocation],
            runId: "run-a",
          }],
          sessionId: "session-a",
          sessionTitle: "Session A",
        }],
      }],
    }, {
      bucket: bucket({ inputTokens: 20, key: "model-b", label: "Model B", outputTokens: 10, totalTokens: 30 }),
      model: "model-b",
      modelProfileId: "model-b",
      modelProfileName: "Model B",
      projects: [{
        bucket: bucket({ inputTokens: 20, key: "project-b", label: "Beta", outputTokens: 10, totalTokens: 30 }),
        projectId: "project-b",
        projectName: "Beta",
        sessions: [{
          bucket: bucket({ inputTokens: 20, key: "session-b", label: "Session B", outputTokens: 10, totalTokens: 30 }),
          runs: [{
            bucket: bucket({ inputTokens: 20, key: "invocation:usage-b", label: "invocation-b", outputTokens: 10, totalTokens: 30 }),
            invocations: [laterInvocation],
            runId: null,
          }],
          sessionId: "session-b",
          sessionTitle: "Session B",
        }],
      }],
    }, {
      bucket: bucket({ inputTokens: 30, key: "model-c", label: "DeepSeek V4 Pro", outputTokens: 10, totalTokens: 40 }),
      model: "deepseek-v4-pro",
      modelProfileId: "model-c",
      modelProfileName: "DeepSeek V4 Pro",
      projects: [],
    }],
    totals: bucket({ key: "global", label: "All models", invocationCount: 1 }),
  };
  const analytics: ModelUsageAnalyticsSummary = {
    dailyByModel: [{
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      date: "2026-08-03",
      estimatedCost: { amount: 0.0123, currency: "USD" },
      estimatedCosts: [{ amount: 0.0123, currency: "USD" }],
      inputTokens: 10,
      model: "model-a",
      modelProfileId: "model-a",
      modelProfileName: "Model A",
      outputTokens: 5,
      totalTokens: 15,
    }, {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      date: "2026-08-03",
      estimatedCost: { amount: 0.4, currency: "CNY" },
      estimatedCosts: [{ amount: 0.4, currency: "CNY" }],
      inputTokens: 30,
      model: "deepseek-v4-pro",
      modelProfileId: "model-c",
      modelProfileName: "DeepSeek V4 Pro",
      outputTokens: 10,
      totalTokens: 40,
    }, {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      date: "2026-08-04",
      estimatedCosts: [],
      inputTokens: 20,
      model: "model-b",
      modelProfileId: "model-b",
      modelProfileName: "Model B",
      outputTokens: 10,
      totalTokens: 30,
    }],
    filters: {},
    generatedAt: "2026-08-04T00:00:00.000Z",
    exchangeRates: [{
      baseCurrency: "USD",
      effectiveDate: "2026-09-08",
      provider: "Frankfurter",
      quoteCurrency: "CNY",
      rate: 6.69,
      retrievedAt: "2026-09-08T00:00:00.000Z",
      sourceUrl: "https://api.frankfurter.dev/v2/rate/USD/CNY",
      stale: false,
    }, {
      baseCurrency: "CNY",
      effectiveDate: "2026-09-08",
      provider: "Frankfurter",
      quoteCurrency: "USD",
      rate: 1 / 6.69,
      retrievedAt: "2026-09-08T00:00:00.000Z",
      sourceUrl: "https://api.frankfurter.dev/v2/rate/USD/CNY",
      stale: false,
    }],
    overview: {
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      estimatedCosts: [{ amount: 0.4, currency: "CNY" }, { amount: 0.0123, currency: "USD" }],
      inputTokens: 60,
      outputTokens: 25,
      totalTokens: 85,
    },
  };

  const page = renderToStaticMarkup(React.createElement(UsagePage, {
    analytics,
    filters: {},
    onExport: () => undefined,
    onFiltersChange: () => undefined,
    onOpenSession: () => undefined,
    summary,
  }));
  assert.match(page, /Model usage/);
  assert.match(page, /Model A/);
  assert.match(page, /Alpha/);
  assert.match(page, /DeepSeek V4 Pro/);
  assert.match(page, /Daily usage chart/);
  assert.match(page, /Usage chart legend/);
  assert.match(page, /Usage filters/);
  assert.match(page, /All models/);
  assert.match(page, /Last 30 days/);
  assert.match(page, /Cache write/);
  assert.match(page, /Estimated cost \(CNY, approx\.\)/);
  assert.match(page, /Displayed costs use approximate cached conversion \(1 USD = 6\.69 CNY \(2026-09-08\)\); exports keep original currencies, and CSV adds display conversion columns\./);
  assert.match(page, /<option value="CNY" selected="">CNY<\/option>/);
  assert.match(page, /<option value="USD">USD<\/option>/);
  assert.match(page, /Tokens/);
  assert.match(page, /7\/6/);
  assert.match(page, /8\/4/);
  assert.match(page, /2026-08-03/);
  assert.match(page, /usage-chart-scroll/);
  assert.match(page, /CN¥0\.482287/);
  assert.match(page, /usage-chart-bars fit/);
  assert.match(page, /usage-chart-bar-stack/);
  assert.match(page, /usage-chart-segment/);
  assert.match(page, /tooltip-top/);
  assert.match(page, /Not configured/);
  assert.doesNotMatch(page, /Daily call/);

  const chinesePage = renderToStaticMarkup(React.createElement(
    LocaleProvider,
    { initialLocale: "zh-CN" },
    React.createElement(UsagePage, {
      analytics,
      filters: {},
      onExport: () => undefined,
      onFiltersChange: () => undefined,
      onOpenSession: () => undefined,
      summary,
    }),
  ));
  assert.match(chinesePage, /每日用量图表/);
  assert.match(chinesePage, /用量图表图例/);
  assert.match(chinesePage, /预估费用 \(CNY，约\)/);
  assert.match(chinesePage, /页面金额按缓存汇率近似换算（1 USD = 6\.69 CNY \(2026-09-08\)）；导出保留原币种，CSV 会追加展示换算列。/);
  assert.match(chinesePage, /Token/);
  assert.match(chinesePage, /¥0\.482287/);
  assert.match(chinesePage, /未配置/);
  assert.doesNotMatch(chinesePage, /Daily token usage|Estimated cost|Run a Session/);

  const stalePage = renderToStaticMarkup(React.createElement(UsagePage, {
    analytics: { ...analytics, exchangeRates: analytics.exchangeRates?.map((rate) => ({ ...rate, stale: true })) },
    filters: {},
    onExport: () => undefined,
    onFiltersChange: () => undefined,
    onOpenSession: () => undefined,
    summary,
  }));
  assert.match(stalePage, /Displayed costs use stale cached conversion \(1 USD = 6\.69 CNY \(2026-09-08\)\)/);
  assert.match(stalePage, /Using stale cached display conversion: 1 USD = 6\.69 CNY \(2026-09-08\)/);

  const noRatePage = renderToStaticMarkup(React.createElement(UsagePage, {
    analytics: { ...analytics, exchangeRates: [] },
    filters: {},
    onExport: () => undefined,
    onFiltersChange: () => undefined,
    onOpenSession: () => undefined,
    summary,
  }));
  assert.match(noRatePage, /Estimated cost \(original\)/);
  assert.match(noRatePage, /No display exchange rate is available; costs stay in their original currencies\./);
  assert.match(noRatePage, /CN¥0\.40 \/ \$0\.0123/);
  assert.match(noRatePage, /disabled="">Cost/);

  const unpricedAnalytics: ModelUsageAnalyticsSummary = {
    ...analytics,
    dailyByModel: analytics.dailyByModel.map(({ estimatedCost: _estimatedCost, ...row }) => ({ ...row, estimatedCosts: [] })),
    overview: { ...analytics.overview, estimatedCosts: [] },
  };
  const unpricedPage = renderToStaticMarkup(React.createElement(UsagePage, {
    analytics: unpricedAnalytics,
    filters: {},
    onExport: () => undefined,
    onFiltersChange: () => undefined,
    onOpenSession: () => undefined,
    summary,
  }));
  assert.match(unpricedPage, /Daily token usage/);
  assert.match(unpricedPage, /disabled="">Cost/);
  assert.match(unpricedPage, /usage-chart-column/);
  assert.doesNotMatch(unpricedPage, /usage-chart-dates/);

  const loading = renderToStaticMarkup(React.createElement(UsagePage, {
    analytics: undefined,
    filters: {},
    onExport: () => undefined,
    onFiltersChange: () => undefined,
    onOpenSession: () => undefined,
    summary: undefined,
  }));
  assert.match(loading, /Loading usage/);
  assert.doesNotMatch(loading, /No usage yet/);

  const empty = renderToStaticMarkup(React.createElement(UsagePage, {
    analytics: { ...analytics, dailyByModel: [], overview: { ...analytics.overview, estimatedCosts: [], totalTokens: 0 } },
    filters: {},
    onExport: () => undefined,
    onFiltersChange: () => undefined,
    onOpenSession: () => undefined,
    summary: { byModel: [], totals: bucket({ key: "global", label: "All models", invocationCount: 0 }) },
  }));
  assert.match(empty, /No usage yet/);

  const filteredPage = renderToStaticMarkup(React.createElement(UsagePage, {
    analytics: {
      ...analytics,
      dailyByModel: analytics.dailyByModel.filter((row) => row.modelProfileId === "model-c"),
      filters: { from: "2026-08-01", modelProfileId: "model-c", to: "2026-08-04" },
      overview: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCosts: [{ amount: 0.4, currency: "CNY" }],
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40,
      },
    },
    filters: { from: "2026-08-01", modelProfileId: "model-c", to: "2026-08-04" },
    onExport: () => undefined,
    onFiltersChange: () => undefined,
    onOpenSession: () => undefined,
    summary,
  }));
  assert.match(filteredPage, /<option value="model-c" selected="">DeepSeek V4 Pro<\/option>/);
  assert.match(filteredPage, /value="2026-08-01"/);
  assert.match(filteredPage, /value="2026-08-04"/);
  assert.match(filteredPage, /8\/1/);
  assert.match(filteredPage, /8\/2/);
  assert.match(filteredPage, /8\/3/);
  assert.match(filteredPage, /8\/4/);
  assert.match(filteredPage, /usage-chart-bars fit/);
  assert.doesNotMatch(filteredPage, /Session A/);

  const dateFilteredAnalytics: ModelUsageAnalyticsSummary = {
    ...analytics,
    dailyByModel: analytics.dailyByModel.filter((row) => row.date === "2026-08-04"),
    filters: { from: "2026-08-04", to: "2026-08-04", timeZone: "UTC" },
    overview: {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCosts: [],
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    },
  };
  const dateFilteredPage = renderToStaticMarkup(React.createElement(UsagePage, {
    analytics: dateFilteredAnalytics,
    filters: { from: "2026-08-04", to: "2026-08-04" },
    onExport: () => undefined,
    onFiltersChange: () => undefined,
    onOpenSession: () => undefined,
    summary,
  }));
  assert.match(dateFilteredPage, /Model B/);
  assert.match(dateFilteredPage, /Beta/);
  assert.doesNotMatch(dateFilteredPage, /Session A/);
  const filteredSummary = filterGlobalUsageSummary(summary, { from: "2026-08-04", to: "2026-08-04" }, "UTC");
  assert.equal(filteredSummary.totals.totalTokens, 30);
  assert.equal(filteredSummary.byModel[0]?.projects[0]?.sessions[0]?.sessionTitle, "Session B");

  const longRangePage = renderToStaticMarkup(React.createElement(UsagePage, {
    analytics: {
      ...analytics,
      filters: { from: "2026-06-01", to: "2026-08-04" },
    },
    filters: { from: "2026-06-01", to: "2026-08-04" },
    onExport: () => undefined,
    onFiltersChange: () => undefined,
    onOpenSession: () => undefined,
    summary,
  }));
  assert.match(longRangePage, /usage-chart-bars scroll/);
  assert.equal(latestUsageChartScrollLeft(1384, 640), 744);
  assert.equal(latestUsageChartScrollLeft(500, 640), 0);

  const inline = renderToStaticMarkup(React.createElement(RunUsageInline, {
    run: { bucket: bucket({ unreportedInvocationCount: 1, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null }), runId: "run-abcdef01" },
  }));
  assert.match(inline, /Usage:/);
  assert.match(inline, /input 10/);
  assert.match(inline, /output 5/);
  assert.doesNotMatch(inline, /cache read/);
  assert.doesNotMatch(inline, /cache write/);
  assert.doesNotMatch(inline, /unreported/);
  assert.doesNotMatch(inline, /Latest run usage/);
  assert.equal(renderToStaticMarkup(React.createElement(RunUsageInline, {})), "");

  const table = renderToStaticMarkup(React.createElement(InvocationTable, { invocations: [invocation] }));
  assert.match(table, /<table/);
  assert.match(table, /Cache read/);
  assert.match(table, /Cache write/);
  assert.match(table, /task/);
});
