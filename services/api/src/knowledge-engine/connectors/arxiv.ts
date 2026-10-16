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
 * arXiv connector — Atom API for search/metadata with China mirror fallback
 * (GFW resilience); PDF via /pdf/{id}. Ported from the DeepAnalyze scholarly
 * arxiv connector onto the ScholarlyTransport seam.
 */

import type { PaperConnector, PaperRef } from "./types.js";
import type { ScholarlyTransport } from "./transport.js";

const API_HOSTS = ["https://export.arxiv.org", "https://cn.arxiv.org"];
const PDF_HOSTS = ["https://arxiv.org", "https://cn.arxiv.org"];
const MAX_RESULTS_CAP = 50;

/** Extract a bare arXiv id from common forms (url, versioned id, prefix). */
export function normalizeArxivId(raw: string): string | null {
  const match = raw.match(/(\d{4}\.\d{4,5})(v\d+)?$/) ?? raw.match(/([a-z\-]+\/\d{7})(v\d+)?$/i);
  return match ? match[1]! : null;
}

/** Minimal Atom XML parsing — arXiv's feed format is stable. */
export function parseArxivEntries(xml: string): PaperRef[] {
  const entries: PaperRef[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(xml)) !== null) {
    const entry = match[1]!;
    const idUrl = atomTag(entry, "id");
    const arxivId = idUrl ? normalizeArxivId(idUrl) : null;
    if (!arxivId) continue;
    const title = atomTag(entry, "title")?.replace(/\s+/g, " ").trim();
    if (!title) continue;
    const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((author) => author[1]!.trim());
    const published = atomTag(entry, "published");
    const doi = atomTag(entry, "arxiv:doi");
    entries.push({
      title,
      authors,
      year: published ? new Date(published).getFullYear() : null,
      doi: doi ?? null,
      arxivId,
      abstract: atomTag(entry, "summary")?.trim() ?? null,
      pdfUrl: null,
      source: "arxiv",
      sourceId: arxivId,
    });
  }
  return entries;
}

function atomTag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXmlEntities(match[1]!) : null;
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function createArxivConnector(transport: ScholarlyTransport): PaperConnector {
  async function apiGet(path: string): Promise<string> {
    let lastError: unknown = null;
    for (const host of API_HOSTS) {
      try {
        const response = await transport.get(`${host}${path}`);
        if (!response.status || response.status >= 400) {
          throw new Error(`arXiv API HTTP ${response.status}`);
        }
        return await response.text();
      } catch (error) {
        lastError = error; // try next mirror
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    name: "arxiv",

    async search(query: string, limit: number): Promise<PaperRef[]> {
      const count = Math.min(limit, MAX_RESULTS_CAP);
      const path = `/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${count}&sortBy=relevance`;
      return parseArxivEntries(await apiGet(path));
    },

    async fetchMetadata(id: string): Promise<PaperRef | null> {
      const arxivId = normalizeArxivId(id);
      if (!arxivId) return null;
      const entries = parseArxivEntries(await apiGet(`/api/query?id_list=${encodeURIComponent(arxivId)}`));
      return entries[0] ?? null;
    },

    async resolvePdf(ref: PaperRef): Promise<string | null> {
      const arxivId = ref.arxivId ?? normalizeArxivId(ref.sourceId);
      if (!arxivId) return null;
      return `${PDF_HOSTS[0]}/pdf/${arxivId}`;
    },
  };
}

/** Mirror URL list for an arXiv PDF download (primary first). */
export function arxivPdfMirrors(arxivId: string): string[] {
  return PDF_HOSTS.map((host) => `${host}/pdf/${arxivId}`);
}
