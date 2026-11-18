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
 * The settings surfaces behind 设置, one function per route.
 *
 * These are thin on purpose: the routes already carry the contract, and every
 * value here is read back from the server rather than cached in the browser, so
 * a second window on the same data directory cannot drift.
 */

import type { ApiClient } from "./client.js";
import type { ModelUsageAnalyticsFilters, ModelUsageAnalyticsSummary, SessionUsageSummary } from "./types.js";

export function getSessionUsage(client: ApiClient, sessionId: string): Promise<SessionUsageSummary> {
  return client.request(`/api/sessions/${encodeURIComponent(sessionId)}/usage`);
}

/** Deployment-wide token statistics. No exchange-rate request is needed for this view. */
export function getModelUsage(client: ApiClient, filters: Pick<ModelUsageAnalyticsFilters, "from" | "to" | "timeZone">): Promise<ModelUsageAnalyticsSummary> {
  const query = new URLSearchParams({ includeExchangeRates: "false" });
  for (const field of ["from", "to", "timeZone"] as const) {
    const value = filters[field];
    if (value) query.set(field, value);
  }
  return client.request(`/api/usage/analytics?${query}`);
}
