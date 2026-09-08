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
 * OpenAlex connector — Works API: metadata + referenced_works (citation
 * resolution) + OA location. Ported from the DeepAnalyze scholarly OpenAlex
 * connector onto the ScholarlyTransport seam. API key and mailto are passed
 * in via config (in DeepAnalyze they were read from the settings store).
 */

import type { PaperConnector, PaperRef } from "./types.js";
import type { ScholarlyTransport } from "./transport.js";

const API = "https://api.openalex.org";
const DEFAULT_MAILTO = "sciencediscovery@localhost";

export interface OpenAlexConfig {
  readonly apiKey?: string | null;
  readonly mailto?: string | null;
}

interface OAWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  publication_year?: number | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: { pdf_url?: string | null; source?: { display_name?: string } | null };
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  referenced_works?: string[];
  ids?: { openalex?: string; doi?: string; mag?: string };
  cited_by_count?: number | null;
}

export function deinvertAbstract(index: Record<string, number[]> | null | undefined): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      words[position] = word;
    }
  }
  const text = words.filter(Boolean).join(" ");
  return text.length > 0 ? text : null;
}

export function openAlexToRef(work: OAWork): PaperRef | null {
  if (!work.title) return null;
  const doiUrl = work.doi ?? work.ids?.doi ?? null;
  const doi = doiUrl ? doiUrl.replace(/^https?:\/\/doi\.org\//i, "") : null;
  const arxivId = work.primary_location?.pdf_url?.match(/arxiv\.org\/pdf\/(\d{4}\.\d{4,5})/)?.[1] ?? null;
  return {
    title: work.title,
    authors: (work.authorships ?? []).map((authorship) => authorship.author?.display_name ?? "").filter(Boolean),
    year: work.publication_year ?? null,
    doi,
    arxivId,
    abstract: deinvertAbstract(work.abstract_inverted_index),
    pdfUrl: work.open_access?.oa_url ?? work.primary_location?.pdf_url ?? null,
    source: "openalex",
    sourceId: work.id.replace(/^https?:\/\/openalex\.org\//i, ""),
    citationCount: typeof work.cited_by_count === "number" ? work.cited_by_count : null,
    venue: work.primary_location?.source?.display_name ?? null,
  };
}

export function createOpenAlexConnector(transport: ScholarlyTransport, config: OpenAlexConfig = {}): PaperConnector {
  async function oaGet(path: string): Promise<unknown> {
    const mailto = config.mailto && config.mailto.includes("@") ? config.mailto : DEFAULT_MAILTO;
    const separator = path.includes("?") ? "&" : "?";
    let url = `${API}${path}${separator}mailto=${encodeURIComponent(mailto)}`;
    if (config.apiKey) {
      url += `&api_key=${encodeURIComponent(config.apiKey)}`;
    }
    const response = await transport.get(url);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`OpenAlex API HTTP ${response.status}`);
    return response.json();
  }

  function keyFor(ref: PaperRef): string | null {
    if (ref.source === "openalex") return ref.sourceId;
    if (ref.doi) return `doi:${ref.doi}`;
    return null;
  }

  return {
    name: "openalex",

    async search(query: string, limit: number): Promise<PaperRef[]> {
      const data = (await oaGet(`/works?search=${encodeURIComponent(query)}&per-page=${Math.min(limit, 25)}`)) as {
        results?: OAWork[];
      } | null;
      return (data?.results ?? []).map(openAlexToRef).filter((ref): ref is PaperRef => ref !== null);
    },

    async fetchMetadata(id: string): Promise<PaperRef | null> {
      // Accepts OpenAlex short id (W...), full URL, doi: prefix, or bare DOI.
      const key = id.startsWith("doi:") || id.startsWith("W") || id.includes("openalex.org") ? id : `doi:${id}`;
      const data = (await oaGet(`/works/${encodeURIComponent(key)}`)) as OAWork | null;
      return data ? openAlexToRef(data) : null;
    },

    async resolvePdf(ref: PaperRef): Promise<string | null> {
      if (ref.pdfUrl) return ref.pdfUrl;
      if (!ref.doi) return null;
      const fresh = await this.fetchMetadata(`doi:${ref.doi}`);
      return fresh?.pdfUrl ?? null;
    },

    async resolveCitations(ref: PaperRef): Promise<PaperRef[]> {
      const key = keyFor(ref);
      if (!key) return [];
      const work = (await oaGet(`/works/${encodeURIComponent(key)}`)) as OAWork | null;
      const ids = work?.referenced_works ?? [];
      if (ids.length === 0) return [];
      // Batch-fetch referenced works (OpenAlex filter supports up to ~50 ids).
      const shortIds = ids.slice(0, 50).map((url) => url.replace(/^https?:\/\/openalex\.org\//i, ""));
      const data = (await oaGet(`/works?filter=openalex_id:${shortIds.join("|")}&per-page=50`)) as {
        results?: OAWork[];
      } | null;
      return (data?.results ?? []).map(openAlexToRef).filter((ref): ref is PaperRef => ref !== null);
    },

    async resolveCitingPapers(ref: PaperRef): Promise<PaperRef[]> {
      const key = keyFor(ref);
      if (!key) return [];
      const work = (await oaGet(`/works/${encodeURIComponent(key)}`)) as OAWork | null;
      const shortId = work?.id?.replace(/^https?:\/\/openalex\.org\//i, "");
      if (!shortId) return [];
      // Newest citers first — the forward snowball cares about recent work.
      const data = (await oaGet(
        `/works?filter=cites:${encodeURIComponent(shortId)}&per-page=50&sort=publication_date:desc`,
      )) as { results?: OAWork[] } | null;
      return (data?.results ?? []).map(openAlexToRef).filter((ref): ref is PaperRef => ref !== null);
    },
  };
}
