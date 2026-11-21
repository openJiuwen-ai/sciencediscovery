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
 * Deterministic provenance gate — ported from the DeepAnalyze extraction
 * pipeline. Every evidence quote must be verifiable against the source text:
 * verbatim after whitespace normalization, or an ordered token subsequence
 * with ≥85% vocabulary coverage (tolerating minor extraction differences).
 * Unverifiable relations are dropped — never written to the graph. Requiring
 * order prevents a word-permuted or semantically inverted quote from passing
 * merely because its vocabulary occurs elsewhere in the document.
 */

export function normalizeGateText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function verifyEvidence(quote: string, haystack: string): boolean {
  const normalizedQuote = normalizeGateText(quote);
  const normalizedHaystack = normalizeGateText(haystack);
  if (normalizedQuote.length < 10) return false;
  if (normalizedHaystack.includes(normalizedQuote)) return true;

  const quoteTokens = normalizedQuote.split(" ").filter((word) => word.length > 0);
  if (quoteTokens.length === 0) return false;
  const quoteWords = new Set(quoteTokens);
  const haystackTokens = normalizedHaystack.split(" ");
  const haystackWords = new Set(haystackTokens);
  let hit = 0;
  for (const word of quoteWords) {
    if (haystackWords.has(word)) hit += 1;
  }
  if (hit / quoteWords.size < 0.85) return false;

  // Set overlap alone accepts arbitrary permutations. Preserve duplicates and
  // order so every quoted token must occur in the same sequence in the source;
  // intervening source tokens still tolerate omitted clauses and extraction
  // artifacts without allowing a semantically inverted rearrangement.
  const comparable = (token: string) => token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  const comparableQuote = quoteTokens.map(comparable);
  let quoteIndex = 0;
  for (const token of haystackTokens) {
    if (comparable(token) === comparableQuote[quoteIndex]) quoteIndex += 1;
    if (quoteIndex === quoteTokens.length) return true;
  }
  return false;
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
