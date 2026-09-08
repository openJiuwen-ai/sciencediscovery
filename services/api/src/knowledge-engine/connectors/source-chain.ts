// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * Source chain — deterministic fallback across paper connectors.
 * Ported from the DeepAnalyze scholarly source-chain onto the
 * ScholarlyTransport seam. W1 scope: arxiv → unpaywall → europepmc →
 * openalex → pubmed (search), with Semantic Scholar kept for
 * search/citations. Sci-Hub (opt-in) and CORE are documented later ports.
 *
 * Error semantics (deterministic):
 * - NotFoundError: every source DEFINITIVELY has no full text (404 / non-PDF
 *   content / no PDF location). Not retryable.
 * - any other Error: at least one source failed transiently (timeout, 5xx,
 *   network). Retryable — the job runner applies backoff.
 * - RateLimitError propagates with its Retry-After delay.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { arxivPdfMirrors, createArxivConnector } from "./arxiv.js";
import { createEuropePmcConnector, type EuropePmcConnector } from "./europepmc.js";
import { createOpenAlexConnector, type OpenAlexConfig } from "./openalex.js";
import { createPubMedConnector } from "./pubmed.js";
import { createSemanticScholarConnector } from "./semantic-scholar.js";
import { createUnpaywallConnector, type UnpaywallConfig } from "./unpaywall.js";
import type { ScholarlyTransport } from "./transport.js";
import { NotFoundError, RateLimitError, paperDedupKey, type PaperConnector, type PaperRef } from "./types.js";

const MAX_PDF_BYTES = 80 * 1024 * 1024; // 80 MB safety cap

export interface SourceChainConfig {
  readonly transport: ScholarlyTransport;
  readonly openalex?: OpenAlexConfig;
  readonly unpaywall?: UnpaywallConfig;
}

export interface SourceChain {
  readonly connectors: PaperConnector[];
  readonly search: (query: string, limit: number) => Promise<PaperRef[]>;
  readonly europepmc: EuropePmcConnector;
}

/**
 * Build the default source chain in priority order. Self-gating connectors
 * (unpaywall without an email) return null when unconfigured, so the chain
 * is static.
 */
export function buildSourceChain(config: SourceChainConfig, onWarn?: (message: string) => void): SourceChain {
  const connectors: PaperConnector[] = [
    createArxivConnector(config.transport),
    createUnpaywallConnector(config.transport, config.unpaywall ?? {}),
    createEuropePmcConnector(config.transport),
    createOpenAlexConnector(config.transport, config.openalex ?? {}),
    createPubMedConnector(config.transport),
    createSemanticScholarConnector(config.transport),
  ];
  return {
    connectors,
    europepmc: connectors[2] as EuropePmcConnector,
    search: (query, limit) => searchAcrossChain(connectors, query, limit, onWarn),
  };
}

/**
 * Search across the chain and merge results, deduplicated by DOI/arXiv/title.
 * A source that fails is skipped (logged) — search is best-effort.
 */
export async function searchAcrossChain(
  chain: readonly PaperConnector[],
  query: string,
  limit: number,
  onWarn?: (message: string) => void,
): Promise<PaperRef[]> {
  const seen = new Set<string>();
  const merged: PaperRef[] = [];
  for (const connector of chain) {
    if (merged.length >= limit) break;
    try {
      const results = await connector.search(query, limit);
      for (const ref of results) {
        const key = paperDedupKey(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(ref);
        if (merged.length >= limit) break;
      }
    } catch (error) {
      onWarn?.(`[source-chain] search failed on ${connector.name}: ${errMsg(error)}`);
    }
  }
  return merged;
}

export interface DownloadOutcome {
  readonly bytes: Uint8Array;
  readonly url: string;
  readonly source: string;
}

export interface DownloadOptions {
  readonly transport: ScholarlyTransport;
  /**
   * SSRF guard hook. Defaults to DNS-based assertSafeUrl. Fixture/mocked
   * environments pass a no-op (their "URLs" never touch the network).
   */
  readonly assertUrl?: (url: string) => Promise<void>;
}

/**
 * Resolve and download a paper's PDF by walking the chain in order.
 * Resolution and download are interleaved per connector: the first source
 * that yields a working PDF wins — later sources are never touched.
 */
export async function downloadPaperPdf(
  chain: readonly PaperConnector[],
  ref: PaperRef,
  options: DownloadOptions,
  onWarn?: (message: string) => void,
): Promise<DownloadOutcome> {
  const transientErrors: Error[] = [];
  const assertUrl = options.assertUrl ?? assertSafeUrl;

  for (const connector of chain) {
    const candidateUrls: string[] = [];
    try {
      const url = await connector.resolvePdf(ref);
      if (url) {
        if (connector.name === "arxiv") {
          const id = ref.arxivId ?? /(\d{4}\.\d{4,5})/.exec(url)?.[1];
          if (id) {
            candidateUrls.push(...arxivPdfMirrors(id));
          } else {
            candidateUrls.push(url);
          }
        } else {
          candidateUrls.push(url);
        }
      }
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      transientErrors.push(error instanceof Error ? error : new Error(String(error)));
      onWarn?.(`[source-chain] resolvePdf failed on ${connector.name}: ${errMsg(error)}`);
    }

    for (const url of candidateUrls) {
      try {
        const bytes = await fetchPdf(url, options.transport, assertUrl);
        if (bytes) return { bytes, url, source: connector.name };
        // null = definitive miss (404 / not a PDF) — try next candidate.
      } catch (error) {
        if (error instanceof RateLimitError) throw error;
        transientErrors.push(error instanceof Error ? error : new Error(String(error)));
        onWarn?.(`[source-chain] download failed from ${url}: ${errMsg(error)}`);
      }
    }
  }

  // Transient failures take precedence: the paper may well exist, we just
  // couldn't reach it. Retryable — do NOT misclassify as "no full text".
  if (transientErrors.length > 0) {
    throw transientErrors[0]!;
  }
  throw new NotFoundError(`No downloadable PDF found for "${ref.title}" across ${chain.length} sources`);
}

/**
 * Fetch a URL and validate it is actually a PDF.
 * Returns null for DEFINITIVE misses (404, non-PDF content, oversize).
 * Throws for transient failures (timeout, 5xx, network) — retryable.
 */
async function fetchPdf(
  url: string,
  transport: ScholarlyTransport,
  assertUrl: (url: string) => Promise<void>,
): Promise<Uint8Array | null> {
  await assertUrl(url);
  const response = await transport.get(url, {
    headers: { accept: "application/pdf,*/*" },
    timeoutMs: 120_000,
  });

  if (response.status === 404 || response.status === 410) return null; // definitive
  if (response.status >= 500) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`); // transient
  if (response.status !== 200) return null; // other 4xx — definitive miss

  const contentLength = Number(response.header("content-length") ?? 0);
  if (contentLength > MAX_PDF_BYTES) return null;

  const bytes = await response.bytes();
  if (bytes.length > MAX_PDF_BYTES) return null;
  // PDF magic bytes; also allow leading whitespace before %PDF.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) return null;
  return bytes;
}

// ---------------------------------------------------------------------------
// SSRF guard — downloads must target public HTTP(S) hosts only
// ---------------------------------------------------------------------------

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      parts[0] === 0
    );
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

/** Reject non-HTTP(S) URLs and URLs resolving to private/loopback addresses. */
export async function assertSafeUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: ${url.slice(0, 120)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing non-HTTP(S) download URL scheme: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Refusing download from private address: ${hostname}`);
    return;
  }
  try {
    const { address } = await lookup(hostname);
    if (isPrivateIp(address)) {
      throw new Error(`Refusing download from ${hostname} resolving to private address ${address}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
    // DNS failure — transient, let the fetch itself report it.
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
