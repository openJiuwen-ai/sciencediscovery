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

/**
 * The settings pages' value translations, kept pure.
 *
 * What is left here is text-shaped and testable without a DOM: the proxy
 * policy vocabulary, the Runner state label, and the sandbox allowlist box
 * read as entries. Anything that only the components can decide stays in
 * them.
 */

import type { DailyModelUsageSummary, ModelUsageAnalyticsFilters, ModelUsageReporting } from "../api/types.js";

export type UsageRange = "today" | "week" | "month" | "all";
export type TokenField = "inputTokens" | "outputTokens" | "totalTokens";

export function usageFilters(range: UsageRange, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Pick<ModelUsageAnalyticsFilters, "from" | "to" | "timeZone"> {
  if (range === "all") return { timeZone };
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? "";
  const to = `${part("year")}-${part("month")}-${part("day")}`;
  const days = range === "today" ? 1 : range === "week" ? 7 : 30;
  // Subtract calendar days, independent of daylight-saving changes in the selected zone.
  const from = new Date(Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day")) - days + 1)).toISOString().slice(0, 10);
  return { from, to, timeZone };
}

export interface ModelUsageRow {
  id: string;
  name: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reporting?: ModelUsageReporting;
}

/** Keep separate model profiles separate, even when they use the same underlying model. */
export function modelUsageRows(daily: DailyModelUsageSummary[]): ModelUsageRow[] {
  const rows = new Map<string, ModelUsageRow>();
  for (const day of [...daily].sort((left, right) => right.date.localeCompare(left.date))) {
    const current = rows.get(day.modelProfileId);
    if (!current) {
      rows.set(day.modelProfileId, { id: day.modelProfileId, name: day.modelProfileName, model: day.model,
        inputTokens: day.inputTokens, outputTokens: day.outputTokens, totalTokens: day.totalTokens,
        reporting: day.reporting ? { ...day.reporting } : undefined });
      continue;
    }
    current.inputTokens += day.inputTokens;
    current.outputTokens += day.outputTokens;
    current.totalTokens += day.totalTokens;
    if (current.reporting && day.reporting) {
      current.reporting.invocationCount += day.reporting.invocationCount;
      current.reporting.reportedInputCount += day.reporting.reportedInputCount;
      current.reporting.reportedOutputCount += day.reporting.reportedOutputCount;
      current.reporting.reportedTotalCount += day.reporting.reportedTotalCount;
    } else current.reporting = undefined;
  }
  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

const REPORTED_FIELD = {
  inputTokens: "reportedInputCount", outputTokens: "reportedOutputCount", totalTokens: "reportedTotalCount",
} as const;

/** Unknown is distinct from a reported zero. Older responses cannot prove that a zero was reported. */
export function knownTokenValue(value: number, field: TokenField, reporting: ModelUsageReporting | undefined, hasActivity: boolean): number | null {
  if (reporting) return reporting.invocationCount > 0 && reporting[REPORTED_FIELD[field]] === 0 ? null : value;
  return hasActivity && value === 0 ? null : value;
}

export function usageIncomplete(reporting: ModelUsageReporting | undefined, hasActivity: boolean): boolean {
  if (!reporting) return hasActivity;
  return Object.values(REPORTED_FIELD).some(field => reporting[field] < reporting.invocationCount);
}
