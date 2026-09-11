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
 * Convergence assessment — four deterministic signals, ported from the
 * DeepAnalyze convergence module. All signals compute from stored state
 * alone (no LLM, no optional infrastructure):
 *
 *   1. Concept saturation — new entities/edges in the last NOVELTY_WINDOW
 *      extraction jobs fall below NOVELTY_FLOOR.
 *   2. Citation coverage — (done+failed+skipped)/total frontier > threshold.
 *   3. Frontier exhaustion — no pending items, or the paper budget ran out.
 *   4. Boundary coverage — Chao1 capture–recapture over the discovery-path
 *      hit matrix; Lincoln–Petersen recall estimate as the n/a fallback
 *      (Brittain & Böhning 2009: L-P and Chao1 coincide under source
 *      symmetry; L-P underestimates under positive correlation, so Chao1 is
 *      preferred and L-P only stands in).
 *
 * Rule: converged when ≥3 of 4 signals are met; when the recall dimension is
 * n/a, ≥2 of the remaining 3 suffices. Data access goes through the
 * ConvergenceDataAccess port so the math is storage-agnostic and testable.
 */

const NOVELTY_WINDOW = 20;
const NOVELTY_FLOOR = 0.5; // exported below for the living-review monitor
const COVERAGE_THRESHOLD = 0.8;
const BOUNDARY_COVERAGE_THRESHOLD = 0.9;
const BOUNDARY_MIN_OBSERVED = 30;
const BOUNDARY_MIN_F2 = 3;
const BOUNDARY_MAX_UNSOURCED_SHARE = 0.5;
const RECALL_SAMPLE = 50;
const RECALL_MIN_SAMPLE = 30;
const RECALL_THRESHOLD = 0.9;
const RECALL_MIN_M_FOR_CI = 8;

/** Storage port the assessment reads through (implemented by the KE store). */
export interface ConvergenceDataAccess {
  /** Succeeded extraction-job completion times, newest first. */
  extractionCompletions(kbId: string): Promise<string[]>;
  countEntitiesCreatedSince(kbId: string, sinceIso: string): Promise<number>;
  countEdgesCreatedSince(kbId: string, sinceIso: string): Promise<number>;
  frontierCounts(cycleId: string): Promise<{ total: number; pending: number; done: number; failed: number; skipped: number }>;
  frontierSourceStats(kbId: string): Promise<{ observed: number; f1: number; f2: number; unsourced: number }>;
  /** All KB document dedup keys + count (L-P marked population / recapture). */
  documentDedupKeys(kbId: string): Promise<{ count: number; dedupKeys: string[] }>;
}

export interface SearchPapersFn {
  (query: string, limit: number): Promise<Array<{ dedupKey: string }>>;
}

export interface RecallEstimate {
  method: "lincoln-petersen";
  n1: number;
  n2: number;
  m: number;
  estimatedTotal: number | null;
  recall: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  insufficientData: boolean;
}

export interface ConvergenceSignals {
  conceptSaturation: {
    met: boolean;
    newEntities: number;
    newEdges: number;
    window: number;
    insufficientData: boolean;
  };
  citationCoverage: { met: boolean; processed: number; total: number; ratio: number };
  frontierExhaustion: { met: boolean; pending: number; budgetExhausted: boolean };
  boundaryCoverage: {
    met: boolean;
    observed: number;
    f1: number;
    f2: number;
    estimatedTotal: number | null;
    coverage: number | null;
    insufficientData: boolean;
    recallEstimate: RecallEstimate | null;
  };
}

export interface ConvergenceResult {
  converged: boolean;
  signals: ConvergenceSignals;
}

// ------------------------------------------------- living review (Z7, DA port)

/** Same novelty floor that declares saturation in assessConvergence. */
export { NOVELTY_FLOOR };
/** Grace window after convergence before a reopen check is meaningful. */
export const LIVING_REVIEW_MIN_DAYS = 14;

export interface LivingReviewResult {
  reopen: boolean;
  reason: "not-converged" | "too-recent" | "novelty-recovery" | "stable";
  newEntities: number;
  daysSinceConverged: number;
}

/**
 * Living-review monitor (DA convergence.ts monitorConvergence): has a
 * converged KB drifted back into growth? Counts only new ENTITIES, not
 * edges — new entities require new source material; edges between existing
 * entities can be back-filled by re-extraction. Reopens when the novelty
 * rate (new entities per day since convergence) exceeds the same floor
 * that declared saturation; only after the grace window to avoid churn.
 * Symmetric to assessConvergence: that asks "should we stop?", this asks
 * "should we restart?".
 */
export function monitorConvergence(input: {
  convergedAt: string | null | undefined;
  newEntities: number;
  now?: Date;
}): LivingReviewResult {
  if (!input.convergedAt) {
    return { reopen: false, reason: "not-converged", newEntities: 0, daysSinceConverged: 0 };
  }
  const now = input.now ?? new Date();
  const days = (now.getTime() - new Date(input.convergedAt).getTime()) / 86_400_000;
  if (days < LIVING_REVIEW_MIN_DAYS) {
    return { reopen: false, reason: "too-recent", newEntities: input.newEntities, daysSinceConverged: days };
  }
  const noveltyRate = days > 0 ? input.newEntities / days : input.newEntities;
  const reopen = noveltyRate > NOVELTY_FLOOR;
  return {
    reopen,
    reason: reopen ? "novelty-recovery" : "stable",
    newEntities: input.newEntities,
    daysSinceConverged: days,
  };
}

/**
 * Lincoln–Petersen recall estimate (Chapman 1951 + Seber 1970 variance).
 * n1 = ingested papers; sample n2 from a domain search; m = already in KB.
 * N̂ = (n1+1)(n2+1)/(m+1) − 1; recall = n1/N̂.
 */
export async function estimateRecallLp(
  data: ConvergenceDataAccess,
  kbId: string,
  query: string,
  searchPapers: SearchPapersFn,
): Promise<RecallEstimate> {
  const results = await searchPapers(query, RECALL_SAMPLE);
  const n2 = results.length;
  if (n2 < RECALL_MIN_SAMPLE) {
    return { method: "lincoln-petersen", n1: 0, n2, m: 0, estimatedTotal: null, recall: null, ciLow: null, ciHigh: null, insufficientData: true };
  }
  const docs = await data.documentDedupKeys(kbId);
  const n1 = docs.count;
  const ingested = new Set(docs.dedupKeys);
  let m = 0;
  for (const result of results) {
    if (ingested.has(result.dedupKey)) m += 1;
  }
  if (m === 0) {
    return { method: "lincoln-petersen", n1, n2, m, estimatedTotal: null, recall: null, ciLow: null, ciHigh: null, insufficientData: true };
  }
  const estimatedTotal = ((n1 + 1) * (n2 + 1)) / (m + 1) - 1;
  const variance = ((n1 + 1) * (n2 + 1) * (n1 - m) * (n2 - m)) / ((m + 1) * (m + 1) * (m + 2));
  const se = Math.sqrt(Math.max(0, variance));
  const recall = n1 / estimatedTotal;
  const useCi = m >= RECALL_MIN_M_FOR_CI;
  return {
    method: "lincoln-petersen",
    n1,
    n2,
    m,
    estimatedTotal,
    recall,
    ciLow: useCi ? Math.max(n1, estimatedTotal - 1.96 * se) : null,
    ciHigh: useCi ? estimatedTotal + 1.96 * se : null,
    insufficientData: false,
  };
}

export interface AssessOptions {
  readonly maxPapers: number;
  readonly query?: string;
  readonly searchPapers?: SearchPapersFn;
}

export async function assessConvergence(
  data: ConvergenceDataAccess,
  kbId: string,
  cycleId: string,
  options: AssessOptions,
): Promise<ConvergenceResult> {
  // --- Signal 1: concept saturation over the last NOVELTY_WINDOW jobs.
  const completions = await data.extractionCompletions(kbId);
  const windowJobs = completions.slice(0, NOVELTY_WINDOW);
  const insufficientNovelty = completions.length < NOVELTY_WINDOW;
  let newEntities = 0;
  let newEdges = 0;
  if (windowJobs.length > 0) {
    // Window boundary = the OLDEST window job's completion time: entities and
    // edges are written when a job completes, so enqueue time would over-count.
    const windowStart = windowJobs[windowJobs.length - 1]!;
    [newEntities, newEdges] = await Promise.all([
      data.countEntitiesCreatedSince(kbId, windowStart),
      data.countEdgesCreatedSince(kbId, windowStart),
    ]);
  }
  const saturationMet =
    !insufficientNovelty && newEntities / NOVELTY_WINDOW < NOVELTY_FLOOR && newEdges / NOVELTY_WINDOW < NOVELTY_FLOOR;

  // --- Signal 2: citation coverage of this cycle's frontier.
  const counts = await data.frontierCounts(cycleId);
  const processed = counts.done + counts.failed + counts.skipped;
  const ratio = counts.total > 0 ? processed / counts.total : 0;
  const coverageMet = counts.total > 0 && ratio > COVERAGE_THRESHOLD;

  // --- Signal 3: frontier exhaustion (natural stop).
  const budgetExhausted = counts.done >= options.maxPapers;
  const exhaustionMet = counts.pending === 0 || budgetExhausted;

  // --- Signal 4: boundary coverage (Chao1), with an L-P fallback.
  const srcStats = await data.frontierSourceStats(kbId);
  const boundaryInsufficient =
    srcStats.observed < BOUNDARY_MIN_OBSERVED ||
    srcStats.f2 < BOUNDARY_MIN_F2 ||
    srcStats.unsourced > (srcStats.observed + srcStats.unsourced) * BOUNDARY_MAX_UNSOURCED_SHARE;
  let estimatedTotal: number | null = null;
  let boundaryCoverage: number | null = null;
  let boundaryMet = false;
  if (!boundaryInsufficient) {
    estimatedTotal = srcStats.observed + (srcStats.f1 * srcStats.f1) / (2 * srcStats.f2);
    boundaryCoverage = srcStats.observed / estimatedTotal;
    boundaryMet = boundaryCoverage >= BOUNDARY_COVERAGE_THRESHOLD;
  }
  let recallEstimate: RecallEstimate | null = null;
  let lpAvailable = false;
  if (boundaryInsufficient && options.searchPapers && options.query) {
    recallEstimate = await estimateRecallLp(data, kbId, options.query, options.searchPapers);
    if (!recallEstimate.insufficientData && recallEstimate.recall !== null) {
      boundaryMet = recallEstimate.recall >= RECALL_THRESHOLD;
      lpAvailable = true;
    }
  }
  const recallDimensionNa = boundaryInsufficient && !lpAvailable;

  const signals: ConvergenceSignals = {
    conceptSaturation: {
      met: saturationMet,
      newEntities,
      newEdges,
      window: NOVELTY_WINDOW,
      insufficientData: insufficientNovelty,
    },
    citationCoverage: { met: coverageMet, processed, total: counts.total, ratio },
    frontierExhaustion: { met: exhaustionMet, pending: counts.pending, budgetExhausted },
    boundaryCoverage: {
      met: boundaryMet,
      observed: srcStats.observed,
      f1: srcStats.f1,
      f2: srcStats.f2,
      estimatedTotal,
      coverage: boundaryCoverage,
      insufficientData: recallDimensionNa,
      recallEstimate,
    },
  };

  const metCount = (saturationMet ? 1 : 0) + (coverageMet ? 1 : 0) + (exhaustionMet ? 1 : 0) + (boundaryMet ? 1 : 0);
  const converged = recallDimensionNa ? metCount >= 2 : metCount >= 3;
  return { converged, signals };
}
