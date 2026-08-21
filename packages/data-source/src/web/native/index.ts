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
 * The Node-native web provider layer.
 *
 * Search is exposed as one aggregated capability rather than a provider the
 * user selects: `web_search` walks the paid providers that have a key, then
 * the free engines the operator left enabled, and returns the first engine
 * that produces rows. Fetch stays a single configured provider.
 *
 * `invoke()` keeps the response shape `WebBroker` already consumes, so
 * governance, caching, CAS, and auditing are untouched by this layer.
 */

import type {
  FreeSearchEngine,
  PaidSearchProvider,
  ResolvedProxy,
  WebFetchProvider,
  WebOperation,
  WebSearchProvider,
} from "@science-agent/schema";

import { MAX_PROVIDER_RESPONSE_BYTES, ProviderRequestError, thrownErrorCode, type ProviderErrorCode } from "./http.js";
import { fetchExa, fetchJina, fetchTavily } from "./fetch.js";
import { searchBing, searchBraveHtml, searchDuckDuckGo } from "./free-engines.js";
import { searchBraveApi, searchExa, searchTavily } from "./search.js";
import { PublicUrlError, assertPublicUrl } from "./url-guard.js";
import type { ProviderCallOptions, SearchRow } from "./types.js";

const MAX_QUERY_LENGTH = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 5;
const KEYED_FETCH_PROVIDERS = new Set<WebFetchProvider>(["exa", "tavily"]);

type SearchRunner = (query: string, options: ProviderCallOptions) => Promise<SearchRow[]>;

const PAID_RUNNERS: Record<PaidSearchProvider, SearchRunner> = {
  brave: searchBraveApi,
  exa: searchExa,
  tavily: searchTavily,
};

const FREE_RUNNERS: Record<FreeSearchEngine, SearchRunner> = {
  bing: searchBing,
  "brave-html": searchBraveHtml,
  duckduckgo: searchDuckDuckGo,
};

export interface WebProviderInvocation {
  apiKey?: string;
  operation: WebOperation;
  provider: WebFetchProvider | WebSearchProvider;
  proxy?: ResolvedProxy;
  request: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Response contract the broker records; mirrors the retired gateway wire shape. */
export interface WebProviderResponse {
  attempts?: Array<{
    durationMs: number;
    endpoint?: string;
    errorCode?: string;
    errorMessage?: string;
    isError: boolean;
  }>;
  content: string;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  isError: boolean;
}

export class WebProviderError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean) {
    super(message);
    this.name = "WebProviderError";
  }
}

/** True when a search engine name belongs to the keyed tier. */
export function isPaidSearchProvider(value: string): value is PaidSearchProvider {
  return value in PAID_RUNNERS;
}

/**
 * A provider can answer 200 and still be reporting failure in the document —
 * the vendor tools return `Error: ...` or `{"error": ...}` instead of raising.
 * Treating those as success would cache a failure and hide it from the audit.
 */
export function isErrorDocument(content: string): boolean {
  const value = content.trim();
  if (value.toLowerCase().startsWith("error:")) return true;
  try {
    const decoded: unknown = JSON.parse(value);
    return Boolean(decoded && typeof decoded === "object" && !Array.isArray(decoded)
      && (decoded as Record<string, unknown>).error);
  } catch {
    return false;
  }
}

/** Classify an error document's text with the same vocabulary as transport failures. */
export function errorDocumentCode(content: string): ProviderErrorCode {
  const message = content.toLowerCase();
  if (message.includes("timed out") || message.includes("timeout")) return "timeout";
  if (["401", "403", "unauthor", "forbidden"].some((marker) => message.includes(marker))) return "unauthorized";
  if (["429", "rate limit", "too many requests"].some((marker) => message.includes(marker))) return "rate-limited";
  if (["500", "502", "503", "504", "server error"].some((marker) => message.includes(marker))) return "server-error";
  return "semantic-error";
}

/** Render rows as the JSON document the model reads. */
export function renderSearchDocument(query: string, rows: SearchRow[]): string {
  return JSON.stringify({ query, total_results: rows.length, results: rows }, null, 2);
}

export class NativeWebProviderClient {
  /** Run one named search engine and return its document. */
  async search(
    engine: WebSearchProvider,
    query: string,
    options: WebProviderInvocation,
  ): Promise<WebProviderResponse> {
    return this.invoke({ ...options, operation: "search", provider: engine, request: query });
  }

  async invoke(input: WebProviderInvocation): Promise<WebProviderResponse> {
    const started = Date.now();
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const options: ProviderCallOptions = {
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      maxResults: DEFAULT_MAX_RESULTS,
      ...(input.proxy ? { proxy: input.proxy } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs,
    };

    // Argument and credential validation are contract errors, not attempts:
    // the broker maps them to INVALID_INPUT / UNAUTHORIZED without retrying.
    const needsKey = input.operation === "search"
      ? isPaidSearchProvider(input.provider)
      : KEYED_FETCH_PROVIDERS.has(input.provider as WebFetchProvider);
    if (needsKey && !input.apiKey?.trim()) {
      throw new WebProviderError(`${input.provider} requires a non-empty API key`, "unauthorized", false);
    }
    let argument: string;
    try {
      argument = input.operation === "search"
        ? validateQuery(input.request)
        : await assertPublicUrl(input.request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof PublicUrlError) && !(error instanceof Error)) throw error;
      throw new WebProviderError(message, "invalid-input", false);
    }

    try {
      if (input.operation === "search") {
        const runner = PAID_RUNNERS[input.provider as PaidSearchProvider]
          ?? FREE_RUNNERS[input.provider as FreeSearchEngine];
        if (!runner) {
          throw new WebProviderError(`${input.provider} does not support search`, "invalid-input", false);
        }
        const rows = await runner(argument, options);
        if (!rows.length) throw new ProviderRequestError("No results found", "semantic-error");
        return finalize(renderSearchDocument(argument, rows), Date.now() - started);
      }
      if (input.provider === "jina") {
        const result = await fetchJina(argument, options);
        const durationMs = Date.now() - started;
        if (result.errorCode) {
          return {
            attempts: result.attempts,
            content: "",
            durationMs,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage ?? "Jina Reader failed",
            isError: true,
          };
        }
        return finalize(result.content, durationMs, result.attempts);
      }
      const fetcher = input.provider === "tavily" ? fetchTavily : input.provider === "exa" ? fetchExa : undefined;
      if (!fetcher) {
        throw new WebProviderError(`${input.provider} does not support fetch`, "invalid-input", false);
      }
      return finalize(await fetcher(argument, options), Date.now() - started);
    } catch (error) {
      if (error instanceof WebProviderError) throw error;
      const errorCode = error instanceof ProviderRequestError ? error.code : thrownErrorCode(error);
      return {
        content: "",
        durationMs: Date.now() - started,
        errorCode,
        // Keep the provider's own wording: a bare class name would strip the
        // only clue about which upstream failed and why.
        errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        isError: true,
      };
    }
  }
}

function validateQuery(value: string): string {
  const query = typeof value === "string" ? value.trim() : "";
  if (!query || query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query must be a non-empty string no longer than ${MAX_QUERY_LENGTH} characters`);
  }
  return query;
}

function finalize(
  content: string,
  durationMs: number,
  attempts?: WebProviderResponse["attempts"],
): WebProviderResponse {
  if (Buffer.byteLength(content, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
    return {
      ...(attempts ? { attempts } : {}),
      content: "",
      durationMs,
      errorCode: "semantic-error",
      errorMessage: "Web provider response exceeded the 1 MB limit.",
      isError: true,
    };
  }
  if (isErrorDocument(content)) {
    return {
      ...(attempts ? { attempts } : {}),
      content,
      durationMs,
      errorCode: errorDocumentCode(content),
      errorMessage: content.slice(0, 1_000),
      isError: true,
    };
  }
  return { ...(attempts ? { attempts } : {}), content, durationMs, isError: false };
}
