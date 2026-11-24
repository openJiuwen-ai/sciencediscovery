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

import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ApiClient } from "../src/api/client.js";
import { writeSettingsCache } from "../src/app/settings-cache.js";
import { getModelUsage } from "../src/api/usage.js";
import type { DailyModelUsageSummary, ModelUsageAnalyticsSummary, ModelUsageReporting } from "../src/api/types.js";
import { knownTokenValue, modelUsageRows, usageFilters, usageIncomplete } from "../src/app/usage-format.js";
import { TEXT } from "../src/text.js";
import { ModelUsageSettings } from "../src/views/settings/ModelUsageSettings.js";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
const reported = (): ModelUsageReporting => ({ invocationCount: 1, reportedInputCount: 1, reportedOutputCount: 1, reportedTotalCount: 1 });
function daily(over: Partial<DailyModelUsageSummary> = {}): DailyModelUsageSummary {
  return { date: "2026-11-18", modelProfileId: "profile-a", modelProfileName: "Model A", model: "shared-model",
    inputTokens: 80, outputTokens: 20, totalTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 0,
    estimatedCosts: [], reporting: reported(), ...over };
}
function summary(rows = [daily()]): ModelUsageAnalyticsSummary {
  return { dailyByModel: rows, filters: { timeZone: "Asia/Shanghai" }, generatedAt: "2026-11-18T04:05:00Z",
    overview: { inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0), totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
      cacheReadTokens: 60, cacheWriteTokens: 0, estimatedCosts: [], reporting: {
        invocationCount: rows.length,
        reportedInputCount: rows.reduce((sum, row) => sum + (row.reporting?.reportedInputCount ?? 0), 0),
        reportedOutputCount: rows.reduce((sum, row) => sum + (row.reporting?.reportedOutputCount ?? 0), 0),
        reportedTotalCount: rows.reduce((sum, row) => sum + (row.reporting?.reportedTotalCount ?? 0), 0),
      } } };
}
class Client extends ApiClient {
  calls: string[] = [];
  constructor(readonly handle: (path: string) => ModelUsageAnalyticsSummary | Promise<ModelUsageAnalyticsSummary>) { super(""); }
  override async request<T>(path: string): Promise<T> { this.calls.push(path); return await this.handle(path) as T; }
}
function invoke(node: ReactTestInstance, name: string, ...args: unknown[]) {
  const fn = node.props[name]; assert.ok(typeof fn === "function"); return fn(...args);
}
function button(view: ReactTestRenderer, label: string) {
  const node = view.root.findAllByType("button").find(item => item.children.includes(label)); assert.ok(node, label); return node;
}
async function mount(client: ApiClient) {
  let view: ReactTestRenderer | undefined;
  await act(async () => { view = create(<ModelUsageSettings client={client} />); }); assert.ok(view); return view;
}
const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());
const close = (view: ReactTestRenderer) => act(async () => view.unmount());

test("usage date ranges use local calendar days across time zones, DST and month boundaries", () => {
  const now = new Date("2026-11-18T00:30:00Z");
  assert.deepEqual(usageFilters("week", now, "Asia/Shanghai"), { from: "2026-11-12", to: "2026-11-18", timeZone: "Asia/Shanghai" });
  assert.deepEqual(usageFilters("today", now, "America/Los_Angeles"), { from: "2026-11-17", to: "2026-11-17", timeZone: "America/Los_Angeles" });
  assert.deepEqual(usageFilters("month", new Date("2026-03-01T00:00:00Z"), "UTC"), { from: "2026-01-31", to: "2026-03-01", timeZone: "UTC" });
  assert.deepEqual(usageFilters("week", new Date("2026-03-09T06:30:00Z"), "America/New_York"), { from: "2026-03-03", to: "2026-03-09", timeZone: "America/New_York" });
  assert.deepEqual(usageFilters("all", now, "UTC"), { timeZone: "UTC" });
});

test("daily model aggregation preserves profiles, reported totals and source data", () => {
  const data = [daily(), daily({ date: "2026-11-17", modelProfileName: "Older name" }),
    daily({ modelProfileId: "profile-b", modelProfileName: "Model B", totalTokens: 999 })];
  const before = structuredClone(data);
  const rows = modelUsageRows(data);
  assert.deepEqual(rows.map(row => row.id), ["profile-b", "profile-a"]);
  assert.equal(rows[1]?.name, "Model A");
  assert.equal(rows[1]?.totalTokens, 200, "cache tokens must not be added again");
  assert.equal(rows[1]?.reporting?.invocationCount, 2);
  assert.equal(rows[0]?.model, rows[1]?.model, "same underlying models still have separate profiles");
  assert.deepEqual(data, before);
});

test("unknown token fields differ from true zeros, including old server responses", () => {
  const missing = { ...reported(), reportedInputCount: 0 };
  assert.equal(knownTokenValue(0, "inputTokens", missing, true), null);
  assert.equal(knownTokenValue(0, "inputTokens", reported(), true), 0);
  assert.equal(knownTokenValue(0, "inputTokens", undefined, true), null);
  assert.equal(knownTokenValue(0, "inputTokens", undefined, false), 0);
  assert.equal(knownTokenValue(50, "inputTokens", undefined, true), 50);
  assert.equal(usageIncomplete(missing, true), true);
  assert.equal(usageIncomplete(reported(), true), false);
});

test("the usage API requests deployment statistics without project filtering or exchange rates", async () => {
  const client = new Client(() => summary());
  await getModelUsage(client, { from: "2026-11-12", to: "2026-11-18", timeZone: "Asia/Shanghai" });
  const call = client.calls[0]; assert.ok(call);
  const url = new URL(call, "https://local.test");
  assert.equal(url.pathname, "/api/usage/analytics");
  assert.equal(url.searchParams.get("includeExchangeRates"), "false");
  assert.equal(url.searchParams.get("projectId"), null);
  assert.equal(url.searchParams.get("timeZone"), "Asia/Shanghai");
  assert.equal(url.searchParams.get("from"), "2026-11-12");
});

test("usage settings show three metrics and a flat model table without cost or hierarchy controls", async () => {
  const client = new Client(() => summary([daily(), daily({ modelProfileId: "profile-b", modelProfileName: "Model B", totalTokens: 999 })]));
  const view = await mount(client);
  try {
    assert.equal(view.root.findAllByType("dd").length, 3);
    assert.equal(view.root.findAllByType("table").length, 1);
    assert.equal(view.root.findAllByType("details").length, 0);
    assert.equal(view.root.findAllByType("select").length, 0);
    const modelRows = view.root.findByType("tbody").findAllByType("tr");
    assert.equal(modelRows.length, 2);
    const first = modelRows[0]; assert.ok(first);
    assert.ok(first.findByType("strong").children.includes("Model B"));
    assert.ok(!text(view).includes(TEXT.settings.system.usage.incomplete));
    assert.ok(text(view).includes(TEXT.settings.system.usage.updated));
  } finally { await close(view); }
});

test("unreported usage shows dashes and a completeness note, not zero consumption", async () => {
  const response = summary([daily({ inputTokens: 0, outputTokens: 0, totalTokens: 0,
    reporting: { invocationCount: 1, reportedInputCount: 0, reportedOutputCount: 0, reportedTotalCount: 0 } })]);
  const view = await mount(new Client(() => response));
  try {
    assert.equal(view.root.findAllByType("dd").every(node => node.children.includes("—")), true);
    assert.equal(view.root.findAllByType("td").every(node => node.children.includes("—")), true);
    assert.ok(text(view).includes(TEXT.settings.system.usage.incomplete));
  } finally { await close(view); }
});

test("an empty period shows zeros and an empty state", async () => {
  const view = await mount(new Client(() => summary([])));
  try {
    assert.equal(view.root.findAllByType("dd").every(node => node.children.includes("0")), true);
    assert.ok(text(view).includes(TEXT.settings.system.usage.empty));
    assert.equal(view.root.findAllByType("table").length, 0);
    assert.ok(!text(view).includes(TEXT.settings.system.usage.incomplete));
  } finally { await close(view); }
});

test("switching periods ignores late responses for the previous period", async () => {
  let finish: ((value: ModelUsageAnalyticsSummary) => void) | undefined;
  const old = new Promise<ModelUsageAnalyticsSummary>(resolve => { finish = resolve; });
  const client = new Client(path => {
    const query = new URL(path, "https://local.test").searchParams;
    return query.get("from") === query.get("to") ? summary([daily({ modelProfileName: "today-model" })]) : old;
  });
  const view = await mount(client);
  try {
    await act(async () => { invoke(button(view, TEXT.settings.system.usage.today), "onClick"); });
    assert.ok(text(view).includes("today-model"));
    await act(async () => { finish?.(summary([daily({ modelProfileName: "late-model" })])); });
    assert.ok(text(view).includes("today-model")); assert.ok(!text(view).includes("late-model"));
  } finally { await close(view); }
});

test("a range with a remembered summary paints it before the refresh answers", async () => {
  const client = new Client(() => new Promise<ModelUsageAnalyticsSummary>(() => {}));
  writeSettingsCache(client, "model-usage:week", { client, summary: summary() });
  const markup = renderToStaticMarkup(<ModelUsageSettings client={client} />);

  assert.ok(markup.includes("Model A"), "the remembered summary is not on screen");
  assert.ok(!markup.includes('aria-busy="true"'), "the skeleton is still drawn over a remembered summary");
  assert.ok(!markup.includes(TEXT.settings.system.usage.skeleton), "the usage pane fell back to its first-paint skeleton");
  assert.ok(!markup.includes(TEXT.settings.loading), "the single loading line is back");
});

test("a range that was never visited paints the usage skeleton, and another client's summary does not leak", async () => {
  const visited = new Client(() => new Promise<ModelUsageAnalyticsSummary>(() => {}));
  writeSettingsCache(visited, "model-usage:week", { client: visited, summary: summary() });
  const fresh = new Client(() => new Promise<ModelUsageAnalyticsSummary>(() => {}));
  const markup = renderToStaticMarkup(<ModelUsageSettings client={fresh} />);

  assert.ok(markup.includes(TEXT.settings.system.usage.skeleton), "the usage skeleton is not on the first frame");
  assert.ok(markup.includes('aria-busy="true"'), "the skeleton is not marked busy");
  assert.ok(!markup.includes("Model A"), "another client's summary leaked into this one");
  assert.ok(!markup.includes(TEXT.settings.loading), "the single loading line is still drawn");
});

test("read failures are retryable and refresh failures keep the last confirmed statistics", async () => {
  let fail = true;
  const client = new Client(() => { if (fail) throw new Error("usage read failed"); return summary(); });
  const view = await mount(client);
  try {
    assert.match(text(view), /usage read failed/);
    fail = false;
    await act(async () => { invoke(button(view, TEXT.settings.retry), "onClick"); });
    assert.match(text(view), /Model A/);
    fail = true;
    await act(async () => { invoke(button(view, TEXT.settings.system.usage.refresh), "onClick"); });
    assert.match(text(view), /usage read failed/); assert.match(text(view), /Model A/);
  } finally { await close(view); }
});
