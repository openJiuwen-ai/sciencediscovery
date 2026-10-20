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

/** DeepSeek's raw Search/Fetch APIs share authentication and bounded transport. */
import { externalUrl } from "@sciencediscovery/schema";

import { ProviderRequestError, providerRequest, statusErrorCode } from "./http.js";
import type { ProviderCallOptions, SearchRow } from "./types.js";

async function callDeepSeek(operation: "search" | "fetch", body: object, options: ProviderCallOptions): Promise<Record<string, unknown>> {
  const response = await providerRequest({
    url: externalUrl(`web.deepseek_${operation}_endpoint`),
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify(body),
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs,
  });
  if (response.statusCode !== 200) {
    let code = statusErrorCode(response.statusCode);
    if (response.statusCode === 402) code = "insufficient-balance";
    else if (response.statusCode === 408 || response.statusCode === 504) code = "timeout";
    else if (response.statusCode === 403) code = operation === "fetch" ? "fetch-failed" : "semantic-error";
    else if (operation === "fetch" && response.statusCode === 404) code = "fetch-failed";
    const reason = response.statusCode === 403 ? "request rejected by DeepSeek's security policy"
      : code === "insufficient-balance" ? "insufficient balance; top up your DeepSeek account"
      : code === "unauthorized" ? "authentication failed; check your DeepSeek API key"
        : code === "rate-limited" ? "rate limit exceeded; retry after the cooldown"
          : code === "timeout" ? "request timed out"
            : code === "fetch-failed" ? "could not retrieve usable Markdown from this page"
              : "request failed";
    // Do not echo provider bodies: an upstream may include credentials or request data.
    throw new ProviderRequestError(`DeepSeek ${operation}: ${reason} (HTTP ${response.statusCode})`, code);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    // SyntaxError messages can quote the response, including echoed credentials.
    throw new ProviderRequestError(`DeepSeek ${operation} returned invalid JSON`, "semantic-error");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProviderRequestError(`DeepSeek ${operation} returned an invalid response`, "semantic-error");
  }
  return payload as Record<string, unknown>;
}

export async function searchDeepSeek(query: string, options: ProviderCallOptions): Promise<SearchRow[]> {
  if ([...query].length > 128) throw new ProviderRequestError("DeepSeek query must contain at most 128 Unicode characters", "semantic-error");
  const payload = await callDeepSeek("search", { query, count: options.maxResults }, options);
  if (!Array.isArray(payload.results)) throw new ProviderRequestError("DeepSeek search response is missing results", "semantic-error");
  return payload.results.slice(0, options.maxResults).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.url !== "string" || !row.url) return [];
    return [{
      title: typeof row.title === "string" ? row.title : "",
      url: row.url,
      content: typeof row.summary === "string" && row.summary ? row.summary : typeof row.snippet === "string" ? row.snippet : "",
    }];
  });
}

export async function fetchDeepSeek(url: string, options: ProviderCallOptions): Promise<string> {
  const payload = await callDeepSeek("fetch", { url }, options);
  if (typeof payload.content !== "string" || !payload.content.trim()) {
    throw new ProviderRequestError("DeepSeek fetch returned no usable Markdown content", "fetch-failed");
  }
  return typeof payload.title === "string" && payload.title ? `# ${payload.title}\n\n${payload.content}` : payload.content;
}
