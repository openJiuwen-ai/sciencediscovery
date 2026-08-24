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
 * Free search engines: public result pages, no credential.
 *
 * Each engine reads the vendor's own HTML SERP, so all three share the same
 * failure mode — a layout change yields zero rows, which the aggregation treats
 * as a failed attempt and moves past. That is why there are several: one engine
 * being blocked, rate-limited, or restyled should not take web search down.
 */

import { externalUrl } from "@sciencediscovery/schema";

import { ProviderRequestError, providerRequest, statusErrorCode } from "./http.js";
import { decodeEntities, firstMatch, sliceBlocks, textOf } from "./html.js";
import type { ProviderCallOptions, SearchRow } from "./types.js";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** CJK queries get a Chinese locale, matching what the engines expect. */
function containsCjk(value: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿]/.test(value);
}

function searchHeaders(query: string): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": containsCjk(query)
      ? "zh-CN,zh-Hans;q=0.9,zh;q=0.8,en;q=0.6"
      : "en-US,en;q=0.9",
    "user-agent": BROWSER_USER_AGENT,
  };
}

// ── DuckDuckGo ──────────────────────────────────────────────────────────────

/** DuckDuckGo wraps outbound links; unwrap to the real destination. */
export function unwrapDuckDuckGoUrl(href: string): string {
  const value = href.startsWith("//") ? `https:${href}` : href;
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    return parsed.searchParams.get("uddg") ?? parsed.toString();
  } catch {
    return value;
  }
}

export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchRow[] {
  const rows: SearchRow[] = [];
  const snippets = [...html.matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((match) => textOf(match[1] ?? ""));
  let index = 0;
  for (const match of html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    if (rows.length >= maxResults) break;
    const url = unwrapDuckDuckGoUrl(decodeEntities(match[1] ?? ""));
    const title = textOf(match[2] ?? "");
    if (!url || !title) continue;
    rows.push({ content: snippets[index] ?? "", title, url });
    index += 1;
  }
  return rows;
}

export async function searchDuckDuckGo(query: string, options: ProviderCallOptions): Promise<SearchRow[]> {
  const response = await providerRequest({
    body: new URLSearchParams({ kl: "wt-wt", q: query }).toString(),
    headers: { ...searchHeaders(query), "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs,
    url: externalUrl("web.duckduckgo_html_endpoint"),
  });
  if (response.statusCode !== 200) {
    throw new ProviderRequestError(`DuckDuckGo returned HTTP ${response.statusCode}`, statusErrorCode(response.statusCode));
  }
  return parseDuckDuckGoHtml(response.body, options.maxResults);
}

// ── Bing ────────────────────────────────────────────────────────────────────

/**
 * Decode a Bing `/ck/a` redirect back to its destination.
 *
 * Bing wraps organic links; without decoding, every result URL would point at
 * bing.com and `web_fetch` would follow a tracker instead of the page. The `a1`
 * prefix marks a base64url payload — anything else is either already a plain
 * URL or a shape this does not recognise, in which case the original is kept
 * rather than guessed at.
 */
export function decodeBingRedirect(href: string): string {
  let parsed: URL;
  try {
    parsed = new URL(href, "https://www.bing.com");
  } catch {
    return href;
  }
  if (!parsed.hostname.toLowerCase().endsWith("bing.com") || parsed.pathname !== "/ck/a") return href;
  const encoded = parsed.searchParams.get("u");
  if (!encoded) return href;
  if (encoded.startsWith("http://") || encoded.startsWith("https://")) return encoded;
  if (!encoded.startsWith("a1")) return href;
  const payload = encoded.slice(2);
  try {
    const decoded = Buffer.from(payload + "=".repeat((4 - (payload.length % 4)) % 4), "base64url").toString("utf8");
    return decoded.startsWith("http://") || decoded.startsWith("https://") ? decoded : href;
  } catch {
    return href;
  }
}

/** Parse Bing's organic `li.b_algo` blocks. */
export function parseBingHtml(html: string, maxResults: number): SearchRow[] {
  // Prefer the main results container so sidebars and ads stay out.
  const area = html.match(/<main[^>]+aria-label="Search Results"[\s\S]*?<\/main>/)?.[0] ?? html;
  const rows: SearchRow[] = [];
  const seen = new Set<string>();
  for (const block of sliceBlocks(area, /<li[^>]+class="[^"]*\bb_algo\b[^"]*"/)) {
    if (rows.length >= maxResults) break;
    const anchor = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!anchor) continue;
    const url = decodeBingRedirect(decodeEntities(anchor[1] ?? ""));
    const title = textOf(anchor[2] ?? "");
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const caption = firstMatch(block, /<div[^>]+class="[^"]*\bb_caption\b[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)
      ?? firstMatch(block, /<p[^>]*>([\s\S]*?)<\/p>/);
    rows.push({ content: caption ? textOf(caption) : "", title, url });
  }
  return rows;
}

export async function searchBing(query: string, options: ProviderCallOptions): Promise<SearchRow[]> {
  const url = new URL(externalUrl("web.bing_search_endpoint"));
  url.searchParams.set("q", query);
  if (containsCjk(query)) {
    url.searchParams.set("setlang", "zh-Hans");
    url.searchParams.set("mkt", "zh-CN");
    url.searchParams.set("cc", "CN");
  } else {
    url.searchParams.set("setlang", "en-US");
    url.searchParams.set("mkt", "en-US");
    url.searchParams.set("cc", "US");
  }
  const response = await providerRequest({
    headers: searchHeaders(query),
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs,
    url: url.toString(),
  });
  if (response.statusCode !== 200) {
    throw new ProviderRequestError(`Bing returned HTTP ${response.statusCode}`, statusErrorCode(response.statusCode));
  }
  return parseBingHtml(response.body, options.maxResults);
}

// ── Brave (public result page, no key) ──────────────────────────────────────

/** Parse Brave's public SERP `div[data-type="web"]` blocks. */
export function parseBraveHtml(html: string, maxResults: number): SearchRow[] {
  const rows: SearchRow[] = [];
  const seen = new Set<string>();
  for (const block of sliceBlocks(html, /<div[^>]+data-type="web"/)) {
    if (rows.length >= maxResults) break;
    const href = firstMatch(block, /<a[^>]+href="(https?:\/\/[^"]+)"/);
    if (!href) continue;
    const url = decodeEntities(href);
    if (seen.has(url)) continue;
    const title = textOf(
      firstMatch(block, /<div[^>]+class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)
      ?? firstMatch(block, /<a[^>]+href="https?:\/\/[^"]+"[^>]*>([\s\S]*?)<\/a>/)
      ?? "",
    );
    if (!title) continue;
    seen.add(url);
    const snippet = firstMatch(block, /<div[^>]+class="[^"]*\bsnippet-description\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)
      ?? firstMatch(block, /<div[^>]+class="[^"]*\bsnippet\b[^"]*"[\s\S]*?<div[^>]+class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    rows.push({ content: snippet ? textOf(snippet) : "", title, url });
  }
  return rows;
}

export async function searchBraveHtml(query: string, options: ProviderCallOptions): Promise<SearchRow[]> {
  const url = new URL(externalUrl("web.brave_html_endpoint"));
  url.searchParams.set("q", query);
  url.searchParams.set("source", "web");
  const response = await providerRequest({
    headers: searchHeaders(query),
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs,
    url: url.toString(),
  });
  if (response.statusCode !== 200) {
    throw new ProviderRequestError(`Brave returned HTTP ${response.statusCode}`, statusErrorCode(response.statusCode));
  }
  return parseBraveHtml(response.body, options.maxResults);
}
