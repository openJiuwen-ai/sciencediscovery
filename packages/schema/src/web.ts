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

export type WebSearchProvider = "ddgs" | "tavily" | "exa" | "brave";
export type DdgsBackend = "bing" | "auto" | "duckduckgo";
export type WebFetchProvider = "jina" | "tavily" | "exa";
/** Resolved wire mode sent to the gateway; configuration uses ProxyPolicy. */
export type WebProxyMode = "environment" | "custom" | "direct";

export interface WebProviderState {
  hasApiKey: boolean;
  provider: WebSearchProvider | WebFetchProvider;
}

export interface WebSettings {
  ddgsBackend: DdgsBackend;
  fetchCacheTtlSeconds: number;
  fetchProvider: WebFetchProvider;
  proxyPolicy: ProxyPolicy;
  searchCacheTtlSeconds: number;
  searchFallbackProvider: "ddgs" | null;
  searchProvider: WebSearchProvider;
}

export const DEFAULT_WEB_SETTINGS: WebSettings = {
  ddgsBackend: "bing",
  fetchCacheTtlSeconds: 24 * 60 * 60,
  fetchProvider: "jina",
  proxyPolicy: "inherit",
  searchCacheTtlSeconds: 60 * 60,
  searchFallbackProvider: null,
  searchProvider: "ddgs",
};

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
  backend?: DdgsBackend;
  durationMs: number;
  endpoint?: string;
  errorCode?: string;
  errorMessage?: string;
  provider: WebSearchProvider | WebFetchProvider;
  proxyMode?: WebProxyMode;
  proxyUsed?: boolean;
  status: WebAttemptStatus;
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
