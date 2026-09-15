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
 * Europe PMC connector — biomedical literature with a full-text OA subset.
 * Ported from the DeepAnalyze scholarly EuropePMC connector, PLUS the new
 * JATS full-text capability (W1 decision): for OA articles the structured
 * JATS XML is a strictly better text source than any PDF parser — the
 * no-docling decision's key patch.
 */

import type { PaperConnector, PaperRef } from "./types.js";
import type { ScholarlyTransport } from "./transport.js";

const API = "https://www.ebi.ac.uk/europepmc/webservices/rest";

interface EPMCResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  pubYear?: string;
  abstractText?: string;
  isOpenAccess?: string;
  fullTextUrlList?: { fullTextUrl?: Array<{ url?: string; documentStyle?: string }> };
}

export function epmcToRef(result: EPMCResult): PaperRef | null {
  if (!result.title) return null;
  // Only HTTP(S) PDF URLs — ftp:// etc. would fail downstream guards.
  const pdfUrl =
    result.fullTextUrlList?.fullTextUrl?.find(
      (url) => url.documentStyle === "pdf" && typeof url.url === "string" && /^https?:\/\//i.test(url.url),
    )?.url ?? null;
  return {
    title: result.title,
    authors: (result.authorString ?? "").split(",").map((author) => author.trim()).filter(Boolean),
    year: result.pubYear ? Number(result.pubYear) : null,
    doi: result.doi ?? null,
    arxivId: null,
    abstract: result.abstractText?.replace(/<[^>]+>/g, "") ?? null,
    pdfUrl,
    source: "europepmc",
    sourceId: result.pmcid ?? result.pmid ?? result.id ?? "",
    pmcId: result.pmcid ?? null,
  };
}

export interface EuropePmcConnector extends PaperConnector {
  /**
   * Fetch the article's JATS full-text XML (OA subset only). Returns null
   * when EuropePMC has no structured full text for the article.
   */
  resolveFullTextXml(ref: PaperRef): Promise<string | null>;
}

export function createEuropePmcConnector(transport: ScholarlyTransport): EuropePmcConnector {
  async function epmcGet(path: string): Promise<unknown> {
    const response = await transport.get(`${API}${path}`, { headers: { accept: "application/json" } });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`Europe PMC API HTTP ${response.status}`);
    return response.json();
  }

  const connector: EuropePmcConnector = {
    name: "europepmc",

    async search(query: string, limit: number): Promise<PaperRef[]> {
      const path = `/search?query=${encodeURIComponent(query)}&format=json&pageSize=${Math.min(limit, 25)}&resultType=core`;
      const data = (await epmcGet(path)) as { resultList?: { result?: EPMCResult[] } } | null;
      return (data?.resultList?.result ?? []).map(epmcToRef).filter((ref): ref is PaperRef => ref !== null);
    },

    async fetchMetadata(id: string): Promise<PaperRef | null> {
      // Accepts PMCID / PMID / DOI.
      const query = id.toUpperCase().startsWith("PMC")
        ? `EXT_ID:${id.replace(/^PMC/i, "")} AND SRC:PMC`
        : id.includes("/")
          ? `DOI:"${id}"`
          : `EXT_ID:${id}`;
      const data = (await epmcGet(
        `/search?query=${encodeURIComponent(query)}&format=json&pageSize=1&resultType=core`,
      )) as { resultList?: { result?: EPMCResult[] } } | null;
      const first = data?.resultList?.result?.[0];
      return first ? epmcToRef(first) : null;
    },

    async resolvePdf(ref: PaperRef): Promise<string | null> {
      if (ref.pdfUrl) return ref.pdfUrl;
      const key = ref.doi ?? (ref.source === "europepmc" ? ref.sourceId : null);
      if (!key) return null;
      const fresh = await connector.fetchMetadata(key);
      return fresh?.pdfUrl ?? null;
    },

    async resolveFullTextXml(ref: PaperRef): Promise<string | null> {
      let pmcId = ref.pmcId ?? (ref.sourceId.toUpperCase().startsWith("PMC") ? ref.sourceId : null);
      if (!pmcId) {
        // One metadata hop: DOI → PMCID (only when the article is in PMC).
        const key = ref.doi ?? null;
        if (!key) return null;
        const fresh = await connector.fetchMetadata(key);
        pmcId = fresh?.pmcId ?? null;
      }
      if (!pmcId) return null;
      const normalized = pmcId.toUpperCase().startsWith("PMC") ? pmcId : `PMC${pmcId}`;
      const response = await transport.get(`${API}/${encodeURIComponent(normalized)}/fullTextXML`);
      if (response.status === 404) return null;
      if (response.status !== 200) return null; // non-OA articles 403/400 here — not an error, just no JATS
      const xml = await response.text();
      return xml.includes("<article") ? xml : null;
    },
  };
  return connector;
}
