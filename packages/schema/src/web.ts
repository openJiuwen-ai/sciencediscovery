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

import type { ProxyPolicy } from "./proxy.js";

/**
 * Search is one aggregated capability, not a provider the user picks.
 *
 * `web_search` tries the configured paid providers first, then the free
 * engines the user left enabled, and returns the first engine that answers.
 * The provider identifiers below therefore name *engines inside* that
 * aggregation, which is why paid Brave (keyed API) and free Brave (public
 * result page) are distinct entries.
 */
export type PaidSearchProvider = "tavily" | "exa" | "brave";
export type FreeSearchEngine = "duckduckgo" | "bing" | "brave-html";
export type WebSearchProvider = PaidSearchProvider | FreeSearchEngine;
export type WebFetchProvider = "jina" | "tavily" | "exa";

/** Fixed attempt order for the paid tier; a provider joins once it has a key. */
export const PAID_SEARCH_ORDER: readonly PaidSearchProvider[] = ["tavily", "exa", "brave"];
/** Fixed attempt order for the free tier; a disabled engine is never requested. */
export const FREE_SEARCH_ORDER: readonly FreeSearchEngine[] = ["duckduckgo", "bing", "brave-html"];
/** Resolved wire mode sent to the gateway; configuration uses ProxyPolicy. */
export type WebProxyMode = "environment" | "custom" | "direct";

export interface WebProviderState {
  hasApiKey: boolean;
  provider: WebSearchProvider | WebFetchProvider;
}

export interface WebSettings {
  fetchCacheTtlSeconds: number;
  fetchProvider: WebFetchProvider;
  /** Per-engine switches for the free tier. A disabled engine is not requested. */
  freeSearchEngines: Record<FreeSearchEngine, boolean>;
  /** Paid providers allowed to join the aggregation, in attempt order. */
  paidSearchProviders: PaidSearchProvider[];
  proxyPolicy: ProxyPolicy;
  searchCacheTtlSeconds: number;
}

export const DEFAULT_WEB_SETTINGS: WebSettings = {
  fetchCacheTtlSeconds: 24 * 60 * 60,
  fetchProvider: "jina",
  // Free engines default on so search works with no credential at all; the
  // paid tier only participates once the operator supplies a key.
  freeSearchEngines: { bing: true, "brave-html": true, duckduckgo: true },
  paidSearchProviders: [...PAID_SEARCH_ORDER],
  proxyPolicy: "inherit",
  searchCacheTtlSeconds: 60 * 60,
};

/**
 * Bring a persisted pre-aggregation settings record forward.
 *
 * Older installs stored a single `searchProvider` (plus `ddgsBackend` and an
 * optional `searchFallbackProvider`). Dropping those silently would change what
 * the install spends money on, so they are translated to the equivalent tier
 * selection instead — the attempt order itself is fixed by `PAID_SEARCH_ORDER`
 * and `FREE_SEARCH_ORDER`, so only the selection has to be carried over:
 *
 * - a paid `searchProvider` becomes the only enabled paid provider, so an
 *   install that deliberately paid for one vendor does not start calling the
 *   others just because their keys happen to be stored;
 * - the free engines are enabled only where the old route could reach the free
 *   tier — `searchProvider: "ddgs"` or `searchFallbackProvider: "ddgs"`. A paid
 *   route with no fallback stays paid-only;
 * - `ddgsBackend` has no successor: the aggregation tries every enabled engine,
 *   so there is nothing left to pick between.
 */
export function migrateLegacyWebSettings(stored: Record<string, unknown>): Record<string, unknown> {
  const hasLegacy = "searchProvider" in stored || "ddgsBackend" in stored
    || "searchFallbackProvider" in stored;
  if (!hasLegacy) return stored;

  const { ddgsBackend: _ddgsBackend, searchFallbackProvider, searchProvider, ...rest } = stored;
  const paid = typeof searchProvider === "string"
    && (PAID_SEARCH_ORDER as readonly string[]).includes(searchProvider)
    ? [searchProvider as PaidSearchProvider]
    : [];
  const freeReachable = searchProvider === "ddgs" || searchFallbackProvider === "ddgs";
  const free = Object.fromEntries(
    FREE_SEARCH_ORDER.map((engine) => [engine, freeReachable]),
  ) as Record<FreeSearchEngine, boolean>;
  return {
    ...rest,
    freeSearchEngines: rest.freeSearchEngines ?? free,
    paidSearchProviders: rest.paidSearchProviders ?? paid,
  };
}

export interface UpdateWebSettingsRequest extends Partial<WebSettings> {
  /** API keys are write-only. null removes the saved key. */
  providerApiKeys?: Partial<Record<"brave" | "exa" | "jina" | "tavily", string | null>>;
}

export interface WebSettingsDetails extends WebSettings {
  providers: WebProviderState[];
}

export type WebOperation = "search" | "fetch";
export type WebAttemptStatus =
  | "succeeded"
  | "cache-hit"
  | "unauthorized"
  | "rate-limited"
  | "timeout"
  | "server-error"
  | "transport-error"
  | "semantic-error";

export type WebErrorCode =
  | "CANCELLED"
  | "GATEWAY_CONTRACT_ERROR"
  | "INVALID_INPUT"
  | "NO_RESULTS"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "UPSTREAM_UNAVAILABLE";

export interface WebError {
  code: WebErrorCode;
  message: string;
  retryable: boolean;
  upstreamCode?: string;
}

export interface WebInvocationAttempt {
  durationMs: number;
  endpoint?: string;
  errorCode?: string;
  errorMessage?: string;
  provider: WebSearchProvider | WebFetchProvider;
  proxyMode?: WebProxyMode;
  proxyUsed?: boolean;
  status: WebAttemptStatus;
  /** Which half of the aggregation this attempt came from. */
  tier?: "free" | "paid";
}

export interface WebInvocation {
  attempts: WebInvocationAttempt[];
  cacheHit: boolean;
  casObjectId?: string;
  createdAt: string;
  error?: WebError;
  forceRefresh: boolean;
  id: string;
  operation: WebOperation;
  projectId: string;
  request: { query: string } | { url: string };
  sessionId: string;
  status: "failed" | "succeeded";
  toolCallId: string;
  turnId: string;
}

export interface WebUsageSummary {
  cacheHits: number;
  failures: number;
  fallbacks: number;
  fetches: number;
  searches: number;
}
