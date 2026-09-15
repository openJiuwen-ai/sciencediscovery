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
 * CORE connector (core.ac.uk) — large OA aggregator. Ported from the
 * DeepAnalyze scholarly connectors/core.ts onto the ScholarlyTransport
 * seam. Self-gating: without SCIENCE_AGENT_CORE_API_KEY the connector
 * skips silently (search returns [], resolvePdf null) so the source chain
 * falls through — DA read the key from its settings store; SD keeps
 * connector credentials in the environment (same shape as the embedding
 * stub config).
 */

import type { PaperConnector, PaperRef } from "./types.js";
import type { ScholarlyTransport } from "./transport.js";

const API = "https://api.core.ac.uk/v3";
const MAX_RESULTS_CAP = 25;

interface CoreWork {
  id?: number;
  title?: string;
  authors?: Array<{ name?: string }>;
  yearPublished?: number | null;
  doi?: string | null;
  arxivId?: string | null;
  abstract?: string | null;
  downloadUrl?: string | null;
}

function toRef(work: CoreWork): PaperRef | null {
  if (!work.title) return null;
  return {
    title: work.title,
    authors: (work.authors ?? []).map((author) => author.name ?? "").filter(Boolean),
    year: work.yearPublished ?? null,
    doi: work.doi ?? null,
    arxivId: work.arxivId ?? null,
    abstract: work.abstract ?? null,
    pdfUrl: work.downloadUrl ?? null,
    source: "core",
    sourceId: String(work.id ?? ""),
  };
}

export function createCoreConnector(transport: ScholarlyTransport, apiKey: string | undefined): PaperConnector {
  const enabled = Boolean(apiKey && apiKey.length > 0);

  async function coreGet(path: string): Promise<unknown | null> {
    if (!enabled) return null;
    const response = await transport.get(`${API}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`CORE API HTTP ${response.status}`);
    return response.json();
  }

  return {
    name: "core",

    async search(query: string, limit: number): Promise<PaperRef[]> {
      const data = (await coreGet(
        `/search/works?q=${encodeURIComponent(query)}&limit=${Math.min(limit, MAX_RESULTS_CAP)}`,
      )) as { results?: CoreWork[] } | null;
      return (data?.results ?? []).map(toRef).filter((ref): ref is PaperRef => ref !== null);
    },

    async fetchMetadata(id: string): Promise<PaperRef | null> {
      const data = (await coreGet(`/works/${encodeURIComponent(id)}`)) as CoreWork | null;
      return data ? toRef(data) : null;
    },

    async resolvePdf(ref: PaperRef): Promise<string | null> {
      if (ref.pdfUrl) return ref.pdfUrl;
      if (ref.source !== "core" || !ref.sourceId) return null;
      const fresh = await this.fetchMetadata(ref.sourceId);
      return fresh?.pdfUrl ?? null;
    },
  };
}
