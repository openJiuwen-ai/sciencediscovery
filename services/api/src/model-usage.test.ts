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
import { test } from "node:test";

import type { ModelInvocationUsage } from "@sciencediscovery/schema";

import {
  estimateInvocationCost,
  modelUsageAnalyticsToCsv,
  summarizeGlobalModelUsage,
  summarizeModelUsage,
  summarizeModelUsageAnalytics,
} from "./model-usage.js";

function usage(overrides: Partial<ModelInvocationUsage>): ModelInvocationUsage {
  return {
    attemptIndex: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    finishedAt: "2026-01-01T00:00:01.000Z",
    id: `usage-${overrides.invocationKind ?? "task"}-${overrides.attemptIndex ?? 0}`,
    inputTokens: 10,
    invocationId: `invocation-${overrides.invocationKind ?? "task"}`,
    invocationKind: "task",
    model: "test-model",
    modelProfileId: "model-a",
    modelProfileName: "Model A",
    outputTokens: 5,
    projectId: "project-a",
    runId: "run-a",
    sessionId: "session-a",
    startedAt: "2026-01-01T00:00:00.000Z",
    totalTokens: 15,
    usageStatus: "reported",
    ...overrides,
  };
}

test("USG-003 usage summary aggregates task, semantic review, and paper vision invocations", () => {
  const summary = summarizeModelUsage("session-a", [
    usage({ invocationKind: "task", startedAt: "2026-01-01T00:00:00.000Z", totalTokens: 15 }),
    usage({ invocationKind: "semantic-review", modelProfileId: "model-b", modelProfileName: "Model B", runId: "run-a", startedAt: "2026-01-01T00:00:01.000Z", totalTokens: 9 }),
    usage({ invocationKind: "paper-vision", runId: undefined, startedAt: "2026-01-01T00:00:02.000Z", totalTokens: 6 }),
  ]);

  assert.equal(summary.totals.invocationCount, 3);
  assert.equal(summary.totals.totalTokens, 30);
  assert.equal(summary.byInvocationKind.find((bucket) => bucket.key === "task")?.totalTokens, 15);
  assert.equal(summary.byInvocationKind.find((bucket) => bucket.key === "semantic-review")?.totalTokens, 9);
  assert.equal(summary.byInvocationKind.find((bucket) => bucket.key === "paper-vision")?.totalTokens, 6);
  assert.equal(summary.byModel.find((bucket) => bucket.key === "model-a")?.totalTokens, 21);
  assert.equal(summary.byModel.find((bucket) => bucket.key === "model-b")?.totalTokens, 9);
  assert.equal(summary.byRun.find((bucket) => bucket.key === "run-a")?.totalTokens, 24);
  assert.equal(summary.latestInvocation?.invocationKind, "paper-vision");
});

test("USG-004 reported token usage remains visible when model pricing is unavailable", () => {
  const summary = summarizeModelUsage("session-a", [usage({ costUsd: null, totalTokens: 15 })]);

  assert.equal(summary.totals.totalTokens, 15);
  assert.equal(summary.totals.costUsd, null);
  assert.equal(summary.byModel[0]?.costUsd, null);
});

test("USG-005 invocation attempts keep a stable invocationId and increment attemptIndex", () => {
  const summary = summarizeModelUsage("session-a", [
    usage({ attemptIndex: 0, invocationId: "logical-call", totalTokens: null, usageStatus: "provider-not-reported", inputTokens: null, outputTokens: null }),
    usage({ attemptIndex: 1, invocationId: "logical-call", totalTokens: 15 }),
  ]);

  assert.deepEqual(summary.invocations.map((record) => record.invocationId), ["logical-call", "logical-call"]);
  assert.deepEqual(summary.invocations.map((record) => record.attemptIndex), [0, 1]);
  assert.equal(summary.totals.reportedInvocationCount, 1);
  assert.equal(summary.totals.unreportedInvocationCount, 1);
});

test("USG-007 cache tokens aggregate without treating missing fields as zero", () => {
  const summary = summarizeModelUsage("session-a", [
    usage({ cacheReadTokens: 8, cacheWriteTokens: 2, totalTokens: 15 }),
    usage({ cacheReadTokens: null, cacheWriteTokens: null, inputTokens: 4, outputTokens: 1, totalTokens: 5 }),
  ]);

  assert.equal(summary.totals.cacheReadTokens, 8);
  assert.equal(summary.totals.cacheWriteTokens, 2);
  assert.equal(summary.totals.inputTokens, 14);
  assert.equal(summary.totals.totalTokens, 20);
});

test("USG-008 unreported invocations stay unreported instead of showing zero tokens", () => {
  const summary = summarizeModelUsage("session-a", [
    usage({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageStatus: "provider-not-reported",
    }),
  ]);

  assert.equal(summary.totals.totalTokens, null);
  assert.equal(summary.totals.inputTokens, null);
  assert.equal(summary.totals.outputTokens, null);
  assert.equal(summary.totals.unreportedInvocationCount, 1);
  assert.equal(summary.totals.reportedInvocationCount, 0);
});

test("USG-009 global usage drills down model -> project -> session -> run", () => {
  const summary = summarizeGlobalModelUsage([
    usage({ id: "u1", projectId: "project-a", sessionId: "session-a", runId: "run-a", totalTokens: 15 }),
    usage({
      id: "u2",
      invocationKind: "paper-vision",
      modelProfileId: "model-b",
      modelProfileName: "Model B",
      projectId: "project-b",
      sessionId: "session-b",
      runId: undefined,
      totalTokens: 9,
    }),
  ], {
    projectIdBySessionId: new Map([
      ["session-a", "project-a"],
      ["session-b", "project-b"],
    ]),
    projectNameById: new Map([
      ["project-a", "Alpha"],
      ["project-b", "Beta"],
    ]),
    sessionTitleById: new Map([
      ["session-a", "Session A"],
      ["session-b", "Session B"],
    ]),
  });

  assert.equal(summary.totals.totalTokens, 24);
  assert.equal(summary.byModel.length, 2);
  const modelA = summary.byModel.find((group) => group.modelProfileId === "model-a");
  assert.equal(modelA?.projects[0]?.projectName, "Alpha");
  assert.equal(modelA?.projects[0]?.sessions[0]?.sessionTitle, "Session A");
  assert.equal(modelA?.projects[0]?.sessions[0]?.runs[0]?.runId, "run-a");
  assert.equal(modelA?.projects[0]?.sessions[0]?.runs[0]?.invocations.length, 1);
});

test("USG-014 daily analytics aggregates tokens by date and model with filters", () => {
  const summary = summarizeModelUsageAnalytics([
    usage({
      id: "u1",
      inputTokens: 1_000,
      modelProfileId: "model-a",
      modelProfileName: "Model A",
      outputTokens: 200,
      projectId: "project-a",
      startedAt: "2026-09-01T12:59:00.000Z",
      totalTokens: 1_200,
    }),
    usage({
      cacheReadTokens: 50,
      id: "u2",
      inputTokens: 400,
      modelProfileId: "model-a",
      modelProfileName: "Model A",
      outputTokens: 100,
      projectId: "project-a",
      startedAt: "2026-09-01T12:59:30.000Z",
      totalTokens: 500,
    }),
    usage({
      id: "u3",
      inputTokens: 10,
      model: "other-model",
      modelProfileId: "model-b",
      modelProfileName: "Model B",
      outputTokens: 5,
      projectId: "project-a",
      startedAt: "2026-09-02T00:00:00.000Z",
      totalTokens: 15,
    }),
    usage({
      id: "u4",
      inputTokens: null,
      modelProfileId: "model-a",
      modelProfileName: "Model A",
      outputTokens: null,
      projectId: "project-a",
      startedAt: "2026-09-02T01:00:00.000Z",
      totalTokens: null,
      usageStatus: "provider-not-reported",
    }),
  ], {
    projectIdBySessionId: new Map([["session-a", "project-a"]]),
    projectNameById: new Map([["project-a", "Alpha"]]),
    sessionTitleById: new Map([["session-a", "Session A"]]),
  }, { from: "2026-09-01", modelProfileId: "model-a", to: "2026-09-01" });

  assert.equal(summary.dailyByModel.length, 1);
  assert.equal(summary.dailyByModel[0]?.date, "2026-09-01");
  assert.equal(summary.dailyByModel[0]?.inputTokens, 1_400);
  assert.equal(summary.dailyByModel[0]?.outputTokens, 300);
  assert.equal(summary.dailyByModel[0]?.cacheReadTokens, 50);
  assert.equal(summary.dailyByModel[0]?.totalTokens, 1_700);
  assert.equal(summary.overview.totalTokens, 1_700);
});

test("USG-015 analytics estimates costs from pricing and keeps unpriced models empty", () => {
  const priced = usage({
    cacheReadTokens: 100_000,
    cacheWriteTokens: 200_000,
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    totalTokens: 1_500_000,
  });
  assert.deepEqual(estimateInvocationCost(priced, {
    cachedInput: 0.5,
    cacheWriteInput: 3,
    currency: "CNY",
    input: 2,
    output: 8,
    unit: "per-1m-tokens",
  }), { amount: 6.65, currency: "CNY" });

  const summary = summarizeModelUsageAnalytics([
    priced,
    usage({
      id: "unpriced",
      costUsd: null,
      inputTokens: 1_000,
      modelProfileId: "model-b",
      modelProfileName: "Model B",
      outputTokens: 1_000,
      totalTokens: 2_000,
    }),
  ], {
    pricingByModelProfileId: new Map([[
      "model-a",
      { cacheWriteInput: 3, currency: "USD", input: 1, output: 2, unit: "per-1m-tokens" },
    ]]),
    projectIdBySessionId: new Map([["session-a", "project-a"]]),
    projectNameById: new Map([["project-a", "Alpha"]]),
    sessionTitleById: new Map([["session-a", "Session A"]]),
  });

  assert.equal(summary.overview.estimatedCosts[0]?.currency, "USD");
  assert.equal(summary.overview.estimatedCosts[0]?.amount, 2.7);
  assert.equal(summary.dailyByModel.find((row) => row.modelProfileId === "model-a")?.estimatedCost?.amount, 2.7);
  assert.equal(summary.dailyByModel.find((row) => row.modelProfileId === "model-a")?.estimatedCosts[0]?.amount, 2.7);
  assert.equal(summary.dailyByModel.find((row) => row.modelProfileId === "model-b")?.estimatedCost, undefined);
});

test("USG-016 analytics buckets and filters days in the configured time zone", () => {
  const summary = summarizeModelUsageAnalytics([
    usage({ startedAt: "2026-01-01T16:30:00.000Z" }),
  ], {
    pricingByModelProfileId: new Map(),
    projectIdBySessionId: new Map([["session-a", "project-a"]]),
    projectNameById: new Map([["project-a", "Alpha"]]),
    sessionTitleById: new Map([["session-a", "Session A"]]),
  }, { from: "2026-01-02", to: "2026-01-02" });

  assert.equal(summary.filters.timeZone, "Asia/Shanghai");
  assert.equal(summary.dailyByModel.length, 1);
  assert.equal(summary.dailyByModel[0]?.date, "2026-01-02");
  assert.equal(summary.overview.totalTokens, 15);
});

test("USG-017 analytics CSV export is stable and escapes spreadsheet formulas", () => {
  const csv = modelUsageAnalyticsToCsv({
    dailyByModel: [{
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      date: "2026-09-01",
      estimatedCost: { amount: 0.42, currency: "USD" },
      estimatedCosts: [
        { amount: 0.42, currency: "USD" },
        { amount: 3.1, currency: "CNY" },
      ],
      inputTokens: 10,
      model: "=cmd",
      modelProfileId: "model-a",
      modelProfileName: "+unsafe",
      outputTokens: 5,
      totalTokens: 15,
    }],
    exchangeRates: [{
      baseCurrency: "USD",
      effectiveDate: "2026-09-01",
      provider: "Frankfurter",
      quoteCurrency: "CNY",
      rate: 6.69,
      retrievedAt: "2026-09-01T00:00:00.000Z",
      sourceUrl: "https://api.frankfurter.dev/v2/rate/USD/CNY",
      stale: false,
    }],
    filters: {},
    generatedAt: "2026-09-01T00:00:00.000Z",
    overview: {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCosts: [{ amount: 0.42, currency: "USD" }],
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
  }, { displayCurrency: "CNY" });

  assert.match(csv, /"date","modelProfileName".*"estimatedCostOriginal","originalCurrency","displayCost","displayCurrency","displayExchangeRate"/);
  assert.match(csv, /"'\+unsafe"/);
  assert.match(csv, /"'=cmd"/);
  assert.match(csv, /"0.42 \/ 3.1","USD \/ CNY","5.9098","CNY","USD\/CNY 6.69","Frankfurter","2026-09-01T00:00:00.000Z"/);
});
