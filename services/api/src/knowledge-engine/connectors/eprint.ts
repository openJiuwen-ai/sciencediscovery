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
 * arXiv e-print (LaTeX source) retrieval — the Z5 LaTeX-first pathway,
 * ported from the DeepAnalyze scholarly/eprint.ts onto the
 * ScholarlyTransport seam (fixture replayable, rate limited, SSRF guarded).
 * Pure unpacking/combination lives in
 * packages/knowledge-engine/src/text/latex.ts.
 */

import { extractCombinedTex } from "@sciencediscovery/knowledge-engine";

import type { ScholarlyTransport } from "./transport.js";

const EPRINT_HOSTS = ["https://arxiv.org", "https://cn.arxiv.org"];
const MAX_EPRINT_BYTES = 100 * 1024 * 1024;
const EPRINT_TIMEOUT_MS = 120_000;

/** Mirror URL list for an e-print download (primary first). */
export function arxivEprintMirrors(arxivId: string): string[] {
  return EPRINT_HOSTS.map((host) => `${host}/e-print/${arxivId}`);
}

/**
 * Download the e-print for an arXiv id and return the combined TeX source,
 * or null when the paper has no usable LaTeX source (PDF-only submission,
 * single-file non-TeX — a 404 or unusable payload). Re-throws transport
 * errors so the caller's fail-soft decides the fallback.
 */
export async function downloadArxivEprint(
  arxivId: string,
  transport: ScholarlyTransport,
): Promise<string | null> {
  for (const url of arxivEprintMirrors(arxivId)) {
    try {
      const response = await transport.get(url, { timeoutMs: EPRINT_TIMEOUT_MS });
      if (response.status === 404) continue; // mirror has no e-print
      if (response.status === 429 || response.status >= 500) {
        // Mirrors share rate-limit state — do not hammer the next one.
        throw new Error(`e-print HTTP ${response.status} from ${new URL(url).host}`);
      }
      if (response.status !== 200) continue;
      const raw = Buffer.from(await response.bytes());
      if (raw.length > MAX_EPRINT_BYTES) continue;
      const tex = extractCombinedTex(raw);
      if (tex) return tex;
    } catch (error) {
      // A transport failure on the primary mirror still tries the fallback
      // mirror once (GFW resilience); a 429-ish failure throws through.
      if (error instanceof Error && /HTTP (429|5\d\d)/.test(error.message)) throw error;
    }
  }
  return null;
}
