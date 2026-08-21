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
 * Paid search providers: keyed vendor APIs.
 *
 * These run before the free engines because an operator who configured a key
 * expects that quality, and because an API contract degrades far less often
 * than a scraped result page. Each returns the same row shape as the free
 * engines, so the aggregation renders one consistent document no matter which
 * tier answered.
 */

import { externalUrl } from "@sciencediscovery/schema";

import { ProviderRequestError, providerRequest, statusErrorCode } from "./http.js";
import { textOf } from "./html.js";
import type { ProviderCallOptions, SearchRow } from "./types.js";

/**
 * Tavily authenticates with a bearer header. tavily-python 0.7.26 — the SDK
 * this path replaced — sends `Authorization: Bearer <key>` and keeps no
 * `api_key` field in the body; sending the key in the body instead would fail
 * only against the live API, which no offline test can catch.
 */
export function buildTavilyAuthHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

/** Brave API `web.results[]` reduced to the shared row shape. */
export function normalizeBraveResults(body: string, maxResults: number): SearchRow[] {
  const payload = JSON.parse(body) as { web?: { results?: unknown[] } };
  const raw = Array.isArray(payload.web?.results) ? payload.web.results : [];
  return raw.slice(0, maxResults).map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    return {
      content: typeof record.description === "string" ? textOf(record.description) : "",
      title: typeof record.title === "string" ? textOf(record.title) : "",
      url: typeof record.url === "string" ? record.url : "",
    };
  });
}

/** Tavily `results[]` reduced to the shared row shape. */
export function normalizeTavilyResults(body: string, maxResults: number): SearchRow[] {
  const payload = JSON.parse(body) as { results?: unknown[] };
  const raw = Array.isArray(payload.results) ? payload.results : [];
  return raw.slice(0, maxResults).map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    return {
      content: typeof record.content === "string" ? record.content : "",
      title: typeof record.title === "string" ? record.title : "",
      url: typeof record.url === "string" ? record.url : "",
    };
  });
}

/** Exa `results[]`, with highlights joined into the shared content field. */
export function normalizeExaResults(body: string, maxResults: number): SearchRow[] {
  const payload = JSON.parse(body) as { results?: unknown[] };
  const raw = Array.isArray(payload.results) ? payload.results : [];
  return raw.slice(0, maxResults).map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const highlights = Array.isArray(record.highlights)
      ? record.highlights.filter((value): value is string => typeof value === "string")
      : [];
    return {
      content: highlights.join("\n"),
      title: typeof record.title === "string" ? record.title : "",
      url: typeof record.url === "string" ? record.url : "",
    };
  });
}

export async function searchTavily(query: string, options: ProviderCallOptions): Promise<SearchRow[]> {
  const response = await providerRequest({
    body: JSON.stringify({ max_results: options.maxResults, query }),
    headers: buildTavilyAuthHeaders(options.apiKey),
    method: "POST",
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs,
    url: externalUrl("web.tavily_search_endpoint"),
  });
  if (response.statusCode !== 200) {
    throw new ProviderRequestError(`Tavily search returned HTTP ${response.statusCode}`, statusErrorCode(response.statusCode));
  }
  return normalizeTavilyResults(response.body, options.maxResults);
}

export async function searchExa(query: string, options: ProviderCallOptions): Promise<SearchRow[]> {
  const response = await providerRequest({
    body: JSON.stringify({
      contents: { highlights: { maxCharacters: 1_000 } },
      numResults: options.maxResults,
      query,
      type: "auto",
    }),
    headers: { "content-type": "application/json", "x-api-key": options.apiKey ?? "" },
    method: "POST",
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs,
    url: externalUrl("web.exa_search_endpoint"),
  });
  if (response.statusCode !== 200) {
    throw new ProviderRequestError(`Exa search returned HTTP ${response.statusCode}`, statusErrorCode(response.statusCode));
  }
  return normalizeExaResults(response.body, options.maxResults);
}

export async function searchBraveApi(query: string, options: ProviderCallOptions): Promise<SearchRow[]> {
  const url = new URL(externalUrl("web.brave_search_endpoint"));
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(options.maxResults));
  url.searchParams.set("text_decorations", "false");
  const response = await providerRequest({
    headers: { accept: "application/json", "x-subscription-token": options.apiKey ?? "" },
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs,
    url: url.toString(),
  });
  if (response.statusCode !== 200) {
    throw new ProviderRequestError(`Brave Search returned HTTP ${response.statusCode}`, statusErrorCode(response.statusCode));
  }
  return normalizeBraveResults(response.body, options.maxResults);
}
