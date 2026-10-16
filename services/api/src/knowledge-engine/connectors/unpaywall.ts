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
 * Unpaywall connector — legal open-access PDF location by DOI. Requires a
 * contact email (Unpaywall API terms) passed via config; the connector
 * self-gates (returns null) when unset, exactly like the DeepAnalyze chain.
 */

import type { PaperConnector, PaperRef } from "./types.js";
import type { ScholarlyTransport } from "./transport.js";

const API = "https://api.unpaywall.org/v2";

export interface UnpaywallConfig {
  readonly email?: string | null;
}

interface UPWResponse {
  doi?: string;
  title?: string;
  year?: number;
  is_oa?: boolean;
  best_oa_location?: { url_for_pdf?: string | null; url?: string | null } | null;
  oa_locations?: Array<{ url_for_pdf?: string | null }>;
}

export function createUnpaywallConnector(transport: ScholarlyTransport, config: UnpaywallConfig = {}): PaperConnector {
  function email(): string | null {
    return config.email && config.email.includes("@") ? config.email : null;
  }

  const connector: PaperConnector = {
    name: "unpaywall",

    // Unpaywall is a DOI-lookup service, not a search engine.
    async search(): Promise<PaperRef[]> {
      return [];
    },

    async fetchMetadata(id: string): Promise<PaperRef | null> {
      const contact = email();
      if (!contact) return null;
      const doi = id.replace(/^doi:/i, "");
      const response = await transport.get(`${API}/${encodeURIComponent(doi)}?email=${encodeURIComponent(contact)}`, {
        timeoutMs: 15_000,
      });
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error(`Unpaywall API HTTP ${response.status}`);
      const data = (await response.json()) as UPWResponse;
      if (!data.title) return null;
      return {
        title: data.title,
        authors: [],
        year: data.year ?? null,
        doi: data.doi ?? doi,
        arxivId: null,
        abstract: null,
        pdfUrl: data.best_oa_location?.url_for_pdf ?? null,
        source: "unpaywall",
        sourceId: doi,
      };
    },

    async resolvePdf(ref: PaperRef): Promise<string | null> {
      if (!ref.doi) return null;
      const fresh = await connector.fetchMetadata(ref.doi);
      return fresh?.pdfUrl ?? null;
    },
  };
  return connector;
}
