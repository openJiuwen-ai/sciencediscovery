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
 * Node-native web fetch providers.
 *
 * Content shapes match what the Python path produced, so cached pages and the
 * model's expectations survive the move:
 *   - jina: the reader's markdown, verbatim
 *   - tavily / exa: `# {title}\n\n{text truncated to 4096 chars}`
 *
 * Jina keeps its multi-endpoint failover: the mirror list is operator-owned
 * (`config/external-urls.json`), the per-attempt budget is the remaining time
 * split across the routes still to try, and a definitive client rejection stops
 * the walk instead of burning the budget on endpoints that will answer the same.
 */

import { externalUrl, externalUrlList } from "@sciencediscovery/schema";

import { ProviderRequestError, providerRequest, statusErrorCode, thrownErrorCode } from "./http.js";
import { buildTavilyAuthHeaders } from "./search.js";
import type { ProviderAttemptRecord, ProviderCallOptions, ProviderFetchResult } from "./types.js";

// Declared in the operator-visible URL registry alongside the search hosts.
const TAVILY_EXTRACT_ENDPOINT = () => externalUrl("web.tavily_extract_endpoint");
const EXA_CONTENTS_ENDPOINT = () => externalUrl("web.exa_contents_endpoint");
const MAX_DOCUMENT_CHARS = 4_096;

function jinaEndpoints(): string[] {
  const endpoints = [...externalUrlList("web.jina_endpoints")];
  return endpoints.length ? endpoints : ["https://r.jina.ai"];
}

/** Jina Reader with ordered mirror failover; every try is recorded as an attempt. */
export async function fetchJina(url: string, options: ProviderCallOptions): Promise<ProviderFetchResult> {
  const endpoints = jinaEndpoints();
  const attempts: ProviderAttemptRecord[] = [];
  const deadline = Date.now() + options.timeoutMs;

  for (const [index, endpoint] of endpoints.entries()) {
    const started = Date.now();
    const routesLeft = endpoints.length - index;
    const attemptTimeout = Math.max(100, Math.floor((deadline - started) / routesLeft));
    try {
      const response = await providerRequest({
        body: JSON.stringify({ url }),
        headers: {
          "content-type": "application/json",
          "x-return-format": "markdown",
          "x-timeout": String(Math.max(1, Math.round(options.timeoutMs / 1_000))),
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        method: "POST",
        ...(options.proxy ? { proxy: options.proxy } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: attemptTimeout,
        url: `${endpoint}/`,
      });
      const durationMs = Date.now() - started;
      const content = response.body.trim();
      if (response.statusCode === 200 && content) {
        attempts.push({ durationMs, endpoint, isError: false });
        return { attempts, content };
      }
      const errorCode = statusErrorCode(response.statusCode);
      const errorMessage = response.statusCode === 200
        ? "Jina Reader returned an empty response"
        : `Jina Reader returned HTTP ${response.statusCode}`;
      attempts.push({ durationMs, endpoint, errorCode, errorMessage, isError: true });
      // A credential or request-shape rejection will repeat on every mirror.
      const definitive = response.statusCode === 401 || response.statusCode === 403
        || (response.statusCode >= 400 && response.statusCode < 500 && response.statusCode !== 429);
      if (definitive) return { attempts, content: "", errorCode, errorMessage };
    } catch (error) {
      attempts.push({
        durationMs: Date.now() - started,
        endpoint,
        errorCode: thrownErrorCode(error),
        errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        isError: true,
      });
    }
  }

  const last = attempts.at(-1);
  return {
    attempts,
    content: "",
    errorCode: last?.errorCode ?? "semantic-error",
    errorMessage: last?.errorMessage ?? "Jina Reader failed",
  };
}

function document(title: string, text: string): string {
  return `# ${title}\n\n${text.slice(0, MAX_DOCUMENT_CHARS)}`;
}

/** Tavily extract. Returns the vendor's `Error: ...` string on a failed page. */
export async function fetchTavily(url: string, options: ProviderCallOptions): Promise<string> {
  const response = await providerRequest({
    body: JSON.stringify({ urls: [url] }),
    headers: buildTavilyAuthHeaders(options.apiKey),
    method: "POST",
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs,
    url: TAVILY_EXTRACT_ENDPOINT(),
  });
  if (response.statusCode !== 200) {
    throw new ProviderRequestError(
      `Tavily extract returned HTTP ${response.statusCode}`,
      statusErrorCode(response.statusCode),
    );
  }
  const payload = JSON.parse(response.body) as {
    failed_results?: Array<{ error?: unknown }>;
    results?: Array<Record<string, unknown>>;
  };
  return renderTavilyExtract(payload);
}

/** Tavily extract payload → the vendor's document or `Error: ...` string. */
export function renderTavilyExtract(payload: {
  failed_results?: Array<{ error?: unknown }>;
  results?: Array<Record<string, unknown>>;
}): string {
  const failed = payload.failed_results?.[0];
  if (failed) return `Error: ${typeof failed.error === "string" ? failed.error : "extraction failed"}`;
  const result = payload.results?.[0];
  if (!result) return "Error: No results found";
  return document(
    typeof result.title === "string" && result.title ? result.title : "Untitled",
    typeof result.raw_content === "string" ? result.raw_content : "",
  );
}

/** Exa contents. Returns the vendor's `Error: ...` string on an empty page. */
export async function fetchExa(url: string, options: ProviderCallOptions): Promise<string> {
  const response = await providerRequest({
    body: JSON.stringify({ text: { maxCharacters: MAX_DOCUMENT_CHARS }, urls: [url] }),
    headers: { "content-type": "application/json", "x-api-key": options.apiKey ?? "" },
    method: "POST",
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs,
    url: EXA_CONTENTS_ENDPOINT(),
  });
  if (response.statusCode !== 200) {
    throw new ProviderRequestError(
      `Exa contents returned HTTP ${response.statusCode}`,
      statusErrorCode(response.statusCode),
    );
  }
  return renderExaContents(JSON.parse(response.body) as { results?: Array<Record<string, unknown>> });
}

/** Exa contents payload → the vendor's document or `Error: ...` string. */
export function renderExaContents(payload: { results?: Array<Record<string, unknown>> }): string {
  const result = payload.results?.[0];
  if (!result) return "Error: No results found";
  return document(
    typeof result.title === "string" && result.title ? result.title : "Untitled",
    typeof result.text === "string" ? result.text : "",
  );
}
