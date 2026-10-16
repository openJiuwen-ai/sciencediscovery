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
 * PubMed (NCBI E-utilities) connector — metadata/search tail of the chain.
 * No direct PDFs; useful for metadata and DOI resolution. Ported from the
 * DeepAnalyze scholarly PubMed connector onto the ScholarlyTransport seam.
 */

import type { PaperConnector, PaperRef } from "./types.js";
import type { ScholarlyTransport } from "./transport.js";
import { decodeXmlEntities } from "./arxiv.js";

const API = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export function parsePubmedArticles(xml: string): PaperRef[] {
  const refs: PaperRef[] = [];
  const articleRe = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match: RegExpExecArray | null;
  while ((match = articleRe.exec(xml)) !== null) {
    const article = match[1]!;
    const title = /<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/.exec(article)?.[1];
    if (!title) continue;
    const pmid = /<PMID[^>]*>(\d+)<\/PMID>/.exec(article)?.[1] ?? "";
    const doi = /<ArticleId IdType="doi">([^<]+)<\/ArticleId>/.exec(article)?.[1] ?? null;
    const pmcId = /<ArticleId IdType="pmc">(PMC\d+)<\/ArticleId>/.exec(article)?.[1] ?? null;
    const year = /<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/.exec(article)?.[1];
    const authors = [
      ...article.matchAll(/<Author[\s>][\s\S]*?<LastName>([^<]+)<\/LastName>[\s\S]*?<ForeName>([^<]+)<\/ForeName>[\s\S]*?<\/Author>/g),
    ].map((author) => `${author[2]} ${author[1]}`);
    const abstract = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/.exec(article)?.[1] ?? null;
    refs.push({
      title: decodePubmedText(title),
      authors,
      year: year ? Number(year) : null,
      doi,
      arxivId: null,
      abstract: abstract ? decodePubmedText(abstract) : null,
      pdfUrl: null,
      source: "pubmed",
      sourceId: pmid,
      pmcId,
    });
  }
  return refs;
}

function decodePubmedText(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, "")).trim();
}

export function createPubMedConnector(transport: ScholarlyTransport): PaperConnector {
  async function efetch(path: string): Promise<string> {
    const response = await transport.get(`${API}${path}`);
    if (response.status !== 200) throw new Error(`PubMed API HTTP ${response.status}`);
    return response.text();
  }

  return {
    name: "pubmed",

    async search(query: string, limit: number): Promise<PaperRef[]> {
      const searchXml = await efetch(
        `/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${Math.min(limit, 20)}&retmode=xml`,
      );
      const ids = [...searchXml.matchAll(/<Id>(\d+)<\/Id>/g)].map((match) => match[1]!);
      if (ids.length === 0) return [];
      const fetchXml = await efetch(`/efetch.fcgi?db=pubmed&id=${ids.join(",")}&retmode=xml`);
      return parsePubmedArticles(fetchXml);
    },

    async fetchMetadata(id: string): Promise<PaperRef | null> {
      const xml = await efetch(`/efetch.fcgi?db=pubmed&id=${encodeURIComponent(id)}&retmode=xml`);
      return parsePubmedArticles(xml)[0] ?? null;
    },

    // PubMed never hosts PDFs directly.
    async resolvePdf(): Promise<string | null> {
      return null;
    },
  };
}
