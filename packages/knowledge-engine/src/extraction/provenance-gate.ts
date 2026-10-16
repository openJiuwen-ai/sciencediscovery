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
 * Deterministic provenance gate — ported verbatim in behavior from the
 * DeepAnalyze extraction-pipeline. Every evidence quote must be verifiable
 * against the source text: verbatim after whitespace normalization, or
 * ≥85% word-level overlap (tolerating minor punctuation differences from
 * PDF/JATS extraction). Unverifiable relations are dropped — never written
 * to the graph.
 *
 * Known limitation (inherited): the fallback uses unordered set overlap, so
 * it is word-order and negation blind. n-gram containment is a documented
 * later upgrade.
 */

export function normalizeGateText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function verifyEvidence(quote: string, haystack: string): boolean {
  const normalizedQuote = normalizeGateText(quote);
  const normalizedHaystack = normalizeGateText(haystack);
  if (normalizedQuote.length < 10) return false;
  if (normalizedHaystack.includes(normalizedQuote)) return true;

  const quoteWords = new Set(normalizedQuote.split(" ").filter((word) => word.length > 1));
  if (quoteWords.size === 0) return false;
  const haystackWords = new Set(normalizedHaystack.split(" "));
  let hit = 0;
  for (const word of quoteWords) {
    if (haystackWords.has(word)) hit += 1;
  }
  return hit / quoteWords.size >= 0.85;
}

export interface ProvenanceGateResult<T> {
  readonly verified: T[];
  readonly dropped: number;
}

/** Partition relations by the gate, preserving order. */
export function applyProvenanceGate<T extends { evidence_quote: string }>(
  relations: readonly T[],
  haystack: string,
): ProvenanceGateResult<T> {
  const verified: T[] = [];
  let dropped = 0;
  for (const relation of relations) {
    if (verifyEvidence(relation.evidence_quote, haystack)) {
      verified.push(relation);
    } else {
      dropped += 1;
    }
  }
  return { verified, dropped };
}
