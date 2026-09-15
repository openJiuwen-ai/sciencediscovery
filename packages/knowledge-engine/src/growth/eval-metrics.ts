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
 * Growth-eval metrics — retrospective delta-recall measurement for the grow
 * loop, modelled on the "evidence gap discovery" protocol of DeepEvidence
 * (Wang et al., Nat. Mach. Intell. 2026): given a candidate pool ranked by the
 * production scorer, would the papers the engine eventually admitted (the
 * delta) land in the top-K?
 *
 * Pure functions — no DB / network. Ported verbatim from the DeepAnalyze
 * scholarly/growth-eval-metrics module; shared by scripts/ke-growth-eval.mjs
 * and the package tests.
 */

/** One ranked candidate. `isPositive` = belongs to the post-cutoff delta. */
export interface RankedItem {
  key: string;
  isPositive: boolean;
}

export interface GrowthEvalMetrics {
  k: number;
  /** Number of query groups evaluated. */
  queries: number;
  /**
   * Fraction of query groups (that contain at least one positive) whose top-K
   * includes ≥1 positive — "did we detect the gap at all" (DeepEvidence's gap
   * detection rate). Groups without positives cannot produce a hit and are
   * excluded from this denominator.
   */
  gapDetectionRate: number;
  /** Positives found in top-K / total positives, micro-averaged over groups. */
  recallAtK: number;
  /** Negatives in top-K / top-K length, micro-averaged (share of slots spent
   *  on papers the engine never admitted). Context metric, not a quality
   *  verdict — an unadmitted paper may still be legitimately relevant. */
  negativeShareAtK: number;
  positivesTotal: number;
  positivesFound: number;
  topKTotal: number;
  negativesInTopK: number;
}

/**
 * Compute growth-eval metrics over per-query ranked candidate lists.
 *
 * Each group is one query's candidate pool ordered best-first (production
 * scoring order). Items are (dedupKey, isPositive) pairs; in-library papers
 * should be filtered out by the caller before ranking (production dedups them
 * pre-ranking), leaving positives (delta) + negatives (never admitted).
 *
 * @throws RangeError when k < 1.
 */
export function computeGrowthEvalMetrics(groups: RankedItem[][], k: number): GrowthEvalMetrics {
  if (!Number.isFinite(k) || k < 1) {
    throw new RangeError(`k must be >= 1, got ${k}`);
  }

  let positivesTotal = 0;
  let positivesFound = 0;
  let topKTotal = 0;
  let negativesInTopK = 0;
  let gapGroups = 0;
  let gapHits = 0;

  for (const group of groups) {
    if (group.length === 0) continue;
    const groupPositives = group.filter((i) => i.isPositive).length;
    positivesTotal += groupPositives;
    if (groupPositives > 0) {
      // Only queries with an actual gap can produce a gap-detection hit.
      gapGroups++;
    }

    let hitInTopK = false;
    for (const item of group.slice(0, k)) {
      topKTotal++;
      if (item.isPositive) {
        positivesFound++;
        hitInTopK = true;
      } else {
        negativesInTopK++;
      }
    }
    if (groupPositives > 0 && hitInTopK) gapHits++;
  }

  return {
    k,
    queries: groups.filter((g) => g.length > 0).length,
    gapDetectionRate: gapGroups > 0 ? gapHits / gapGroups : 0,
    recallAtK: positivesTotal > 0 ? positivesFound / positivesTotal : 0,
    negativeShareAtK: topKTotal > 0 ? negativesInTopK / topKTotal : 0,
    positivesTotal,
    positivesFound,
    topKTotal,
    negativesInTopK,
  };
}
