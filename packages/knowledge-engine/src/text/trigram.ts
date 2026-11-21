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
 * pg_trgm-equivalent trigram similarity in pure TypeScript.
 *
 * The DeepAnalyze knowledge engine tuned its entity-resolution thresholds
 * against PostgreSQL pg_trgm (measured: singular/plural variants ≈ 0.85–0.88,
 * abbreviation↔full-name ≈ 0.05, shared-prefix collisions near the 0.80
 * decision line). The SQLite port has no pg_trgm, so this module reproduces
 * its semantics: lowercase, split into words on non-alphanumeric boundaries,
 * pad EACH word with two leading and one trailing space, extract 3-character
 * shingles as a set, similarity = |∩| / |∪|. Word-splitting matters for
 * biomedical names: "SARS-CoV-2" vs "SARS CoV 2" and "GP1,2" vs "GP1.2"
 * must score 1.0, exactly as pg_trgm scores them.
 *
 * FTS5 (or another coarse recall layer) supplies the candidate set; this
 * function is the deterministic scorer on top of it.
 */

/** Extract the pg_trgm shingle set for a string (per-word padding). */
export function trigrams(input: string): Set<string> {
  const words = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const grams = new Set<string>();
  for (const word of words) {
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1) {
      grams.add(padded.slice(index, index + 3));
    }
  }
  return grams;
}

/**
 * pg_trgm similarity(a, b): |shared trigrams| / |all trigrams|, in [0, 1].
 * Two empty strings are dissimilar (0), matching pg_trgm.
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const gramsA = trigrams(a);
  const gramsB = trigrams(b);
  if (gramsA.size === 0 && gramsB.size === 0) {
    return 0;
  }
  let shared = 0;
  const [smaller, larger] = gramsA.size <= gramsB.size ? [gramsA, gramsB] : [gramsB, gramsA];
  for (const gram of smaller) {
    if (larger.has(gram)) {
      shared += 1;
    }
  }
  const union = gramsA.size + gramsB.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface TrigramMatch<T> {
  readonly item: T;
  readonly score: number;
}

/**
 * Score and rank candidates by trigram similarity against a query.
 * Candidates below `threshold` are dropped; results sort by score desc and
 * equal scores keep input order (Array.prototype.sort is stable), so results
 * are deterministic for a fixed input order.
 */
export function rankByTrigram<T>(
  query: string,
  candidates: readonly T[],
  read: (item: T) => string,
  options: { threshold?: number; topK?: number } = {},
): Array<TrigramMatch<T>> {
  const threshold = options.threshold ?? 0;
  const scored: Array<TrigramMatch<T>> = [];
  for (const item of candidates) {
    const score = trigramSimilarity(query, read(item));
    if (score >= threshold) {
      scored.push({ item, score });
    }
  }
  scored.sort((left, right) => right.score - left.score);
  return options.topK === undefined ? scored : scored.slice(0, options.topK);
}
