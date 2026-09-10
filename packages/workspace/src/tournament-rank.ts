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
 * C4 tournament ranking — Elo round-robin + divergence heuristic, ported
 * from DeepAnalyze debate-ranking.ts (mechanism) and the tournament_rank
 * tool wrapper's verdict-table normalization (tool-setup.ts, "mechanism over
 * policy": judging is the caller's job; the arithmetic here is deterministic,
 * no LLM, no network).
 *
 * Honest limitations (also disclosed in the tool description):
 *   - garbage in, garbage out: correctness of every verdict is the caller's
 *     responsibility;
 *   - Elo scores are only comparable within the same item set;
 *   - the round-robin follows the items array order, so later matches carry
 *     more weight — to reduce order sensitivity, re-run with shuffled items
 *     and aggregate;
 *   - divergence is a token-overlap heuristic, not a semantic measure.
 */

/** Elo result for one item; rankings are sorted by elo descending. */
export interface EloResult<T> {
  item: T;
  elo: number;
  /** Win rate across all matches (0-1); ties credit neither side. */
  winRate: number;
  matches: number;
}

export const TOURNAMENT_ELO_DEFAULT_K = 32;
export const TOURNAMENT_ELO_DEFAULT_INITIAL = 1000;

/**
 * Round-robin Elo tournament: every unordered pair is judged exactly once.
 * judgeFn(a, b) returns a's score against b in [0, 1] (1 = a wins, 0.5 = tie,
 * 0 = a loses). Standard update: expected = 1/(1+10^((opp-elo)/400)),
 * elo += K * (score - expected). Deterministic given the same judgeFn
 * outputs (no randomness). For n items, n*(n-1)/2 judge calls.
 */
export async function eloTournament<T>(
  items: readonly T[],
  judgeFn: (a: T, b: T) => Promise<number>,
  options: { k?: number; initial?: number } = {},
): Promise<EloResult<T>[]> {
  if (items.length === 0) return [];
  const k = options.k ?? TOURNAMENT_ELO_DEFAULT_K;
  const initial = options.initial ?? TOURNAMENT_ELO_DEFAULT_INITIAL;
  const elo = new Map<T, number>();
  const wins = new Map<T, number>();
  const matches = new Map<T, number>();
  for (const item of items) {
    elo.set(item, initial);
    wins.set(item, 0);
    matches.set(item, 0);
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const scoreA = Math.max(0, Math.min(1, await judgeFn(a, b)));
      const eloA = elo.get(a)!;
      const eloB = elo.get(b)!;
      const expectedA = 1 / (1 + 10 ** ((eloB - eloA) / 400));
      elo.set(a, eloA + k * (scoreA - expectedA));
      elo.set(b, eloB + k * ((1 - scoreA) - (1 - expectedA)));
      matches.set(a, matches.get(a)! + 1);
      matches.set(b, matches.get(b)! + 1);
      if (scoreA > 0.5) wins.set(a, wins.get(a)! + 1);
      else if (scoreA < 0.5) wins.set(b, wins.get(b)! + 1);
      // tie → no win credited to either
    }
  }

  return items
    .map((item) => ({
      item,
      elo: Math.round(elo.get(item)!),
      winRate: matches.get(item)! > 0 ? wins.get(item)! / matches.get(item)! : 0,
      matches: matches.get(item)!,
    }))
    .sort((left, right) => right.elo - left.elo);
}

/**
 * Divergence across member responses: 1 - mean pairwise token-overlap
 * (Jaccard). Close to 1 = members disagree broadly; close to 0 = convergence.
 *
 * Tokenization: whitespace split, with a character-bigram fallback for
 * whitespace-free runs longer than 8 chars (e.g. CJK sentences) — without it,
 * every Chinese response is one giant token and pairwise Jaccard is
 * degenerate (DA review finding M2). Deliberately simple: a heuristic, not a
 * semantic measure.
 */
export function computeDivergence(responses: readonly string[]): number {
  if (responses.length < 2) return 0;
  const tokenSets = responses.map((response) => new Set(tokenizeForDivergence(response)));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      const a = tokenSets[i]!;
      const b = tokenSets[j]!;
      let intersection = 0;
      for (const token of a) if (b.has(token)) intersection += 1;
      const union = a.size + b.size - intersection;
      sum += union > 0 ? 1 - intersection / union : 0;
      pairs += 1;
    }
  }
  return pairs > 0 ? sum / pairs : 0;
}

/** Whitespace tokens; any token longer than 8 chars is decomposed into char bigrams. */
export function tokenizeForDivergence(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    if (word.length <= 8) {
      out.push(word);
    } else {
      for (let i = 0; i < word.length - 1; i++) out.push(word.slice(i, i + 2));
    }
  }
  return out;
}

export interface TournamentVerdict {
  /** Both must be entries of the rank items list. */
  a: string;
  b: string;
  /** a's score against b in [0,1]: 1 = a wins, 0.5 = tie, 0 = a loses. */
  scoreA: number;
}

export interface TournamentRankResult {
  ranking: Array<{ item: string; elo: number; winRate: number; matches: number }>;
  totalPairs: number;
  judgedPairs: number;
  /** Pairs with no submitted verdict, filled in as 0.5 ties (honest count). */
  autoTies: number;
  /** Pairs submitted more than once; the later submission wins (counted). */
  duplicatePairs: number;
}

/**
 * Rank string-labelled items from a verdict table. Normalization rules
 * (ported verbatim from DA's tool wrapper, review finding C1):
 *   - pair keys are item-INDEX based: orientation-free (a reversed submission
 *     flips the score) and immune to label-content collisions;
 *   - verdicts referencing unknown items, self-pairs, or out-of-range scores
 *     are rejected with an error (thrown — the caller maps it to a tool
 *     error payload);
 *   - pairs with no verdict are filled as 0.5 ties and counted in autoTies;
 *   - a duplicate pair submission overrides the earlier one, counted in
 *     duplicatePairs.
 */
export async function rankFromVerdicts(
  items: readonly string[],
  verdicts: readonly TournamentVerdict[],
): Promise<TournamentRankResult> {
  const trimmed = items.map((item) => item.trim()).filter(Boolean);
  if (trimmed.length < 2) throw new Error("rank requires items (at least 2 candidate labels).");
  if (new Set(trimmed).size !== trimmed.length) throw new Error("items contain duplicate labels; keep them unique.");

  const indexOf = new Map(trimmed.map((item, index) => [item, index]));
  const table = new Map<string, number>();
  let duplicatePairs = 0;
  for (const verdict of verdicts) {
    if (!indexOf.has(verdict.a) || !indexOf.has(verdict.b)) {
      throw new Error(`verdict pair (${verdict.a}, ${verdict.b}) references an item not in items.`);
    }
    if (verdict.a === verdict.b) {
      throw new Error(`verdict pair (${verdict.a}, ${verdict.b}) is a self-pair; invalid.`);
    }
    if (!Number.isFinite(verdict.scoreA) || verdict.scoreA < 0 || verdict.scoreA > 1) {
      throw new Error(`verdict pair (${verdict.a}, ${verdict.b}) scoreA must be a finite number in [0,1].`);
    }
    const indexA = indexOf.get(verdict.a)!;
    const indexB = indexOf.get(verdict.b)!;
    const key = `${Math.min(indexA, indexB)}:${Math.max(indexA, indexB)}`;
    if (table.has(key)) duplicatePairs += 1;
    // Reverse orientation → flip so it reads "earlier-item's score".
    table.set(key, indexA < indexB ? verdict.scoreA : 1 - verdict.scoreA);
  }

  let autoTies = 0;
  const ranking = await eloTournament(trimmed, async (a, b) => {
    const verdict = table.get(`${indexOf.get(a)!}:${indexOf.get(b)!}`);
    if (verdict === undefined) {
      autoTies += 1;
      return 0.5;
    }
    return verdict;
  });

  return {
    ranking: ranking.map((entry) => ({
      item: entry.item,
      elo: entry.elo,
      winRate: Number(entry.winRate.toFixed(3)),
      matches: entry.matches,
    })),
    totalPairs: (trimmed.length * (trimmed.length - 1)) / 2,
    judgedPairs: verdicts.length,
    autoTies,
    duplicatePairs,
  };
}
