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
 * Shared types for scholarly source connectors — ported from the DeepAnalyze
 * scholarly service (connectors/base.ts + types.ts). A connector wraps one
 * upstream scholarly data source and is deterministic and honest about
 * failure: RateLimitError on 429, NotFoundError when the source definitively
 * lacks the item, generic Error otherwise. The source chain decides fallback.
 */

/** Thrown on HTTP 429; carries the upstream-signalled wait when known. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Thrown when a source definitively does not have the requested item. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** A normalized reference to an academic paper, source-agnostic. */
export interface PaperRef {
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  abstract: string | null;
  /** Direct PDF URL if the source already knows one. */
  pdfUrl: string | null;
  /** Connector name that produced this ref (e.g. 'arxiv', 'semantic-scholar'). */
  source: string;
  /** Id within that source (arxiv id, S2 paperId, DOI...). */
  sourceId: string;
  /** Total citation count when the source provides it (importance prior). */
  citationCount?: number | null;
  /** Publication venue (journal/conference name, when provided). */
  venue?: string | null;
  /** PubMed Central id when the source provides it (EuropePMC JATS lookup). */
  pmcId?: string | null;
}

/**
 * Deterministic dedup key for a paper: DOI > arXiv id > normalized title.
 * Two refs with the same key are considered the same paper.
 */
export function paperDedupKey(ref: Pick<PaperRef, "doi" | "arxivId" | "title">): string {
  if (ref.doi) return `doi:${ref.doi.toLowerCase().trim()}`;
  if (ref.arxivId) return `arxiv:${ref.arxivId.toLowerCase().trim()}`;
  return `title:${ref.title.trim().toLowerCase().replace(/[\s\-_]+/g, " ")}`;
}

export interface PaperConnector {
  readonly name: string;

  /** Search papers by free-text query. */
  search(query: string, limit: number): Promise<PaperRef[]>;

  /** Fetch metadata for a source-specific id (or DOI / arXiv id). */
  fetchMetadata(id: string): Promise<PaperRef | null>;

  /**
   * Locate a downloadable PDF URL for a paper. Returns null when this source
   * has no full text for it (chain should try the next source).
   */
  resolvePdf(ref: PaperRef): Promise<string | null>;

  /**
   * Resolve the paper's reference list (outgoing citations) when the source
   * provides structured citation data. Optional capability.
   */
  resolveCitations?(ref: PaperRef): Promise<PaperRef[]>;

  /**
   * Resolve papers that cite this one (incoming/forward citations) — the
   * forward-snowball direction. Optional capability.
   */
  resolveCitingPapers?(ref: PaperRef): Promise<PaperRef[]>;
}
