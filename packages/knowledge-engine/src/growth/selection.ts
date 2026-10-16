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
 * Growth admission scoring — MMR diversity selection and Adamic/Adar
 * bibliographic coupling, ported pure from the DeepAnalyze grow-runner.
 * Everything here is deterministic: the LLM is never involved in crawl
 * decisions, and embedding unavailability degrades to "score unknown"
 * (sorted last), never to a guess.
 */

import { cosineSimilarity } from "../text/cosine-scan.js";

/** Relevance floors by depth: the further from the seed set, the stricter. */
export const RELEVANCE_FLOORS = [0.55, 0.65, 0.75];
/** Candidates rediscovered ≥3 times earn a hub boost (exactly once). */
export const HUB_MIN_CITERS = 3;
export const HUB_BOOST = 0.1;
/** MMR λ (Carbonell & Goldstein 1998 recommend 0.7 for focused retrieval). */
export const MMR_LAMBDA = 0.7;
/** finalScore = α·cosine + (1−α)·normalize(AA) — cosine stays primary. */
export const AA_ALPHA = 0.6;
/** Candidates probed for AA per parent (bounds extra resolveCitations cost). */
export const AA_TOP_K = 8;
/** Citation-count prior: log1p(min(cc, CAP)) × WEIGHT added to cosine. */
export const CITATION_PRIOR_WEIGHT = 0.03;
export const CITATION_PRIOR_CAP = 500;

/** Minimal paper shape the scoring pipeline needs (structural, so the
 *  services-side PaperRef satisfies it without an import cycle). */
export interface ScoredPaper {
  title: string;
  abstract: string | null;
  citationCount?: number | null;
}

export interface RankedCandidate<T extends ScoredPaper = ScoredPaper> {
  ref: T;
  score: number | null;
  emb: Float32Array | null;
  dedupKey?: string;
}

export interface EmbedFn {
  (text: string): Promise<Float32Array | null>;
}

/**
 * Score candidates against the engine query embedding, best-first.
 * Deterministic: embedding cosine with a citation-count prior; candidates
 * without a usable embedding keep score null and sort last. Embeddings are
 * cached on the returned items for downstream MMR/AA reuse.
 */
export async function rankCandidatePool<T extends ScoredPaper>(
  citations: readonly T[],
  queryEmb: Float32Array | null,
  embed: EmbedFn,
  limit: number,
): Promise<Array<RankedCandidate<T>>> {
  const scored: Array<RankedCandidate<T>> = [];
  for (const ref of citations.slice(0, limit)) {
    if (!ref.title) continue;
    let score: number | null = null;
    let emb: Float32Array | null = null;
    if (ref.abstract && queryEmb) {
      emb = await embed(`${ref.title}\n${ref.abstract}`);
      score = emb ? cosineSimilarity(queryEmb, emb) : null;
      if (score !== null && typeof ref.citationCount === "number") {
        score += Math.log1p(Math.min(ref.citationCount, CITATION_PRIOR_CAP)) * CITATION_PRIOR_WEIGHT;
      }
    }
    scored.push({ ref, score, emb });
  }
  scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return scored;
}

/**
 * Maximal Marginal Relevance selection (Carbonell & Goldstein 1998). Greedily
 * picks `max` candidates maximizing λ·Sim₁(p,Q) − (1−λ)·max_{q∈S} Sim₂(p,q).
 * Cold start (S empty) → pure relevance. Only embedding-scored candidates
 * participate; abstract-less ones are appended as a fallback if slots remain.
 */
export function mmrSelect<T extends ScoredPaper>(
  pool: Array<RankedCandidate<T>>,
  lambda: number,
  max: number,
): Array<RankedCandidate<T>> {
  const withEmb = pool.filter((candidate) => candidate.emb && candidate.score != null);
  const noEmb = pool.filter((candidate) => !candidate.emb);
  const selected: typeof withEmb = [];
  const remaining = [...withEmb];
  while (selected.length < max && remaining.length > 0) {
    let bestIndex = 0;
    let bestMmr = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const sim1 = candidate.score!;
      let maxSim2 = 0;
      for (const chosen of selected) {
        const sim2 = cosineSimilarity(candidate.emb!, chosen.emb!);
        if (sim2 > maxSim2) maxSim2 = sim2;
      }
      const mmr = lambda * sim1 - (1 - lambda) * maxSim2;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIndex = index;
      }
    }
    selected.push(remaining[bestIndex]!);
    remaining.splice(bestIndex, 1);
  }
  for (const candidate of noEmb) {
    if (selected.length >= max) break;
    selected.push(candidate);
  }
  return selected;
}

/**
 * Adamic/Adar bibliographic-coupling score (Inciteful-style, library-view
 * degree). For each reference z shared between the candidate and some
 * ingested paper q, contributes 1/log(1+d_S(z)) where d_S(z) is the number
 * of ingested papers citing z. Returns the MAX over ingested q — a candidate
 * is coupled if it shares references with ANY ingested paper.
 */
export function aaCouplingScore(refIdsP: readonly string[], invertedIndex: ReadonlyMap<string, readonly string[]>): number {
  if (refIdsP.length === 0) return 0;
  const qScores = new Map<string, number>();
  for (const z of refIdsP) {
    const citingQs = invertedIndex.get(z);
    if (!citingQs || citingQs.length === 0) continue;
    const weight = 1 / Math.log(1 + citingQs.length);
    for (const q of citingQs) {
      qScores.set(q, (qScores.get(q) ?? 0) + weight);
    }
  }
  let max = 0;
  for (const score of qScores.values()) {
    if (score > max) max = score;
  }
  return max;
}

/** Build the AA inverted index (reference z → citing document ids) from
 *  documents carrying a refIds list (persisted after citation resolution). */
export function buildRefInvertedIndex(
  documents: ReadonlyArray<{ id: string; refIds: readonly string[] }>,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const doc of documents) {
    for (const z of doc.refIds) {
      let list = index.get(z);
      if (!list) {
        list = [];
        index.set(z, list);
      }
      list.push(doc.id);
    }
  }
  return index;
}

/** Apply the AA blend uniformly across the pool (probed candidates use their
 *  measured AA, unprobed default to 0), returning a re-sorted pool. */
export function blendAaScores<T extends ScoredPaper>(
  pool: Array<RankedCandidate<T>>,
  aaByCandidate: ReadonlyMap<RankedCandidate<T>, number>,
): Array<RankedCandidate<T>> {
  const maxAa = Math.max(0, ...aaByCandidate.values());
  if (maxAa <= 0) return pool;
  for (const candidate of pool) {
    if (candidate.score == null) continue;
    const aa = aaByCandidate.get(candidate) ?? 0;
    candidate.score = AA_ALPHA * candidate.score + (1 - AA_ALPHA) * (aa / maxAa);
  }
  return [...pool].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
