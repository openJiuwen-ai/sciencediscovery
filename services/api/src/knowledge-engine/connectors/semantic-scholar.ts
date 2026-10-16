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
 * Semantic Scholar connector — Graph API: search / metadata / open-access
 * PDF location / reference lists (both snowball directions). Ported from the
 * DeepAnalyze scholarly S2 connector onto the ScholarlyTransport seam.
 */

import type { PaperConnector, PaperRef } from "./types.js";
import type { ScholarlyTransport } from "./transport.js";

const API = "https://api.semanticscholar.org/graph/v1";
const FIELDS = "title,authors,year,abstract,externalIds,openAccessPdf,isOpenAccess,citationCount,venue";
const REF_FIELDS = "title,authors,year,abstract,externalIds,openAccessPdf,citationCount,venue";

interface S2Paper {
  paperId: string;
  title?: string;
  authors?: Array<{ name: string }>;
  year?: number | null;
  abstract?: string | null;
  externalIds?: Record<string, string> | null;
  openAccessPdf?: { url: string } | null;
  citationCount?: number | null;
  venue?: string | null;
}

export function s2ToRef(paper: S2Paper): PaperRef | null {
  if (!paper.title) return null;
  return {
    title: paper.title,
    authors: (paper.authors ?? []).map((author) => author.name),
    year: paper.year ?? null,
    doi: paper.externalIds?.["DOI"] ?? null,
    arxivId: paper.externalIds?.["ArXiv"] ?? null,
    abstract: paper.abstract ?? null,
    pdfUrl: paper.openAccessPdf?.url ?? null,
    source: "semantic-scholar",
    sourceId: paper.paperId,
    citationCount: typeof paper.citationCount === "number" ? paper.citationCount : null,
    venue: paper.venue ?? null,
    pmcId: paper.externalIds?.["PubMedCentral"] ?? null,
  };
}

export function createSemanticScholarConnector(transport: ScholarlyTransport, apiKey?: string): PaperConnector {
  const authHeaders = apiKey ? { "x-api-key": apiKey } : undefined;
  async function s2Get(path: string): Promise<unknown> {
    const response = await transport.get(`${API}${path}`, authHeaders ? { headers: authHeaders } : undefined);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`Semantic Scholar API HTTP ${response.status}`);
    return response.json();
  }

  /** S2 accepts its own paperId, or DOI:/ARXIV: prefixed external ids. */
  function s2IdFor(ref: PaperRef): string | null {
    if (ref.source === "semantic-scholar") return ref.sourceId;
    if (ref.doi) return `DOI:${ref.doi}`;
    if (ref.arxivId) return `ARXIV:${ref.arxivId}`;
    return null;
  }

  return {
    name: "semantic-scholar",

    async search(query: string, limit: number): Promise<PaperRef[]> {
      const path = `/paper/search?query=${encodeURIComponent(query)}&limit=${Math.min(limit, 20)}&fields=${FIELDS}`;
      const data = (await s2Get(path)) as { data?: S2Paper[] } | null;
      return (data?.data ?? []).map(s2ToRef).filter((ref): ref is PaperRef => ref !== null);
    },

    async fetchMetadata(id: string): Promise<PaperRef | null> {
      const data = (await s2Get(`/paper/${encodeURIComponent(id)}?fields=${FIELDS}`)) as S2Paper | null;
      return data ? s2ToRef(data) : null;
    },

    async resolvePdf(ref: PaperRef): Promise<string | null> {
      if (ref.pdfUrl) return ref.pdfUrl;
      const id = s2IdFor(ref);
      if (!id) return null;
      const fresh = await this.fetchMetadata(id);
      return fresh?.pdfUrl ?? null;
    },

    async resolveCitations(ref: PaperRef): Promise<PaperRef[]> {
      const id = s2IdFor(ref);
      if (!id) return [];
      const data = (await s2Get(`/paper/${encodeURIComponent(id)}/references?fields=${REF_FIELDS}&limit=200`)) as {
        data?: Array<{ citedPaper?: S2Paper }>;
      } | null;
      return (data?.data ?? [])
        .map((entry) => (entry.citedPaper ? s2ToRef(entry.citedPaper) : null))
        .filter((result): result is PaperRef => result !== null);
    },

    async resolveCitingPapers(ref: PaperRef): Promise<PaperRef[]> {
      const id = s2IdFor(ref);
      if (!id) return [];
      const data = (await s2Get(`/paper/${encodeURIComponent(id)}/citations?fields=${REF_FIELDS}&limit=200`)) as {
        data?: Array<{ citingPaper?: S2Paper }>;
      } | null;
      return (data?.data ?? [])
        .map((entry) => (entry.citingPaper ? s2ToRef(entry.citingPaper) : null))
        .filter((result): result is PaperRef => result !== null);
    },
  };
}
