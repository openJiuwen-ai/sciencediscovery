// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
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
 * Events in, one view state out.
 *
 * There are three ways a search can reach the screen — live over SSE, replayed
 * from the run's own log, or read back from the graph — and all three must
 * render identically. The way to get that is to have exactly one fold from
 * records to state and let every source feed it; a second code path for "the
 * live one" is how the two drift until nobody can say which is right.
 *
 * The reducer is pure and tolerant: records may arrive out of order (a
 * reconnect replays), may repeat (the same reason), and may be about a
 * candidate whose `expanded` event has not landed yet. None of that is an
 * error condition — it is the normal shape of a stream that can be resumed.
 */

import type {
  EvolveEvent,
  EvolveEventRecord,
  EvolveRejectionCategory,
  EvolveRunStatus,
} from "@sciencediscovery/schema";

export interface EvolveCandidateView {
  accepted?: boolean;
  changeSummary?: string;
  /** Set when a scorecard constraint refused it, not the statistical gate. */
  category?: EvolveRejectionCategory;
  codeHash?: string;
  criteria?: Record<string, number>;
  depth: number;
  error?: string;
  island?: number;
  nodeIndex: number;
  parentIndex: number | null;
  reason?: string;
  rejectedBy?: string;
  reward?: number;
  /** `null` for a failed candidate: `-inf` never reaches the wire, and the node
   *  still belongs in the tree. */
  score: number | null;
  /** What the acceptance gate read. Kept apart from `score` because they are
   *  different measurements on different shards, and a chart that drew one line
   *  for both would hide the case the split exists for: better on what the
   *  search sees, worse on what decides. */
  gateScore?: number;
  rolloutScore?: number;
  /** era: the PUCT value at the moment this node was chosen. */
  selectedPuct?: number;
  valid: boolean;
  visits: number;
}

export interface EvolveRunView {
  algorithm?: string;
  baselineScore: number | null;
  bestNodeIndex?: number;
  /** Reported once, at the end, on shards the search never saw. */
  bestTestScore?: number;
  /** Insertion-ordered, which for both algorithms is `node_index` order. */
  candidates: EvolveCandidateView[];
  costCents: number;
  /** How many expansions have been dispatched — including the failed ones. */
  expansions: number;
  /** The highest sequence folded in; where a resumed subscription starts. */
  lastSequence: number;
  logLines: Array<{ level: "error" | "info" | "warn"; message: string }>;
  maxDepth: number;
  rootVisits: number;
  status: EvolveRunStatus;
  /** The framework's own word for why the search stopped — `max_iters`,
   *  `patience` — recorded even for ordinary endings. The user's first
   *  question about a run of 20 that shows 5 nodes is "why did it stop", and
   *  the event carries the answer; dropping it here made the panel unable to
   *  say. */
  stopReason?: string;
  /** What the run planned, next to the expansions it actually made. */
  expansionsPlanned?: number;
  tokens: number;
}

export function emptyRunView(): EvolveRunView {
  return {
    baselineScore: null,
    candidates: [],
    costCents: 0,
    expansions: 0,
    lastSequence: 0,
    logLines: [],
    maxDepth: 0,
    rootVisits: 0,
    status: "pending",
    tokens: 0,
  };
}

/** Fold a batch in order. Records at or below the current watermark are
 *  ignored, so replaying a prefix is free. */
export function reduceEvolveRecords(state: EvolveRunView, records: readonly EvolveEventRecord[]): EvolveRunView {
  return [...records]
    .sort((left, right) => left.sequence - right.sequence)
    .reduce(reduceEvolveRecord, state);
}

export function reduceEvolveRecord(state: EvolveRunView, record: EvolveEventRecord): EvolveRunView {
  if (record.sequence <= state.lastSequence) return state;
  const next = applyEvent(state, record.event);
  return next === state
    ? { ...state, lastSequence: record.sequence }
    : { ...next, lastSequence: record.sequence };
}

function applyEvent(state: EvolveRunView, event: EvolveEvent): EvolveRunView {
  switch (event.type) {
    case "search_started":
      return { ...state, algorithm: event.algorithm, status: "running" };

    case "seeded":
      return withCandidate(state, event.nodeIndex, (candidate) => ({
        ...candidate,
        // Carried so the root can be a diff's "before". Almost every node's
        // parent is the root, so without it every diff in the run showed as
        // pure addition with nothing ever removed.
        codeHash: event.codeHash ?? candidate.codeHash,
        depth: 0,
        parentIndex: null,
        score: event.baselineScore,
        valid: true,
      }), { baselineScore: event.baselineScore });

    case "selected": {
      // Absolute counts, so this is an assignment rather than an increment —
      // which is what makes a replayed record harmless.
      let next = state;
      for (const entry of event.ancestorVisits) {
        next = withCandidate(next, entry.nodeIndex, (candidate) => ({ ...candidate, visits: entry.visits }));
      }
      const root = next.candidates.find((candidate) => candidate.nodeIndex === 0);
      next = withCandidate(next, event.nodeIndex, (candidate) => ({
        ...candidate,
        ...(event.puct === undefined ? {} : { selectedPuct: event.puct }),
      }));
      return { ...next, rootVisits: root?.visits ?? next.rootVisits };
    }

    case "expanded": {
      const next = withCandidate(state, event.nodeIndex, (candidate) => ({
        ...candidate,
        changeSummary: event.changeSummary,
        codeHash: event.codeHash,
        depth: event.depth,
        error: event.error,
        island: event.island,
        parentIndex: event.parentIndex,
        score: event.score,
        valid: event.valid,
      }));
      return {
        ...next,
        expansions: next.expansions + 1,
        maxDepth: Math.max(next.maxDepth, event.depth),
      };
    }

    case "evaluated":
      return withCandidate(state, event.nodeIndex, (candidate) => ({
        ...candidate,
        criteria: event.criteria,
        ...(event.gateScore === undefined ? {} : { gateScore: event.gateScore }),
        reward: event.reward,
        ...(event.rolloutScore === undefined ? {} : { rolloutScore: event.rolloutScore }),
      }));

    case "merged":
      return withCandidate(state, event.nodeIndex, (candidate) => ({
        ...candidate,
        accepted: event.accepted,
        category: event.category,
        reason: event.reason,
        rejectedBy: event.rejectedBy,
      }));

    case "inserted":
      return withCandidate(state, event.nodeIndex, (candidate) => ({ ...candidate, island: event.island }));

    case "cost":
      return { ...state, costCents: event.cents, tokens: event.tokens };

    case "search_finished":
      return {
        ...state,
        ...(event.bestNodeIndex === null ? {} : { bestNodeIndex: event.bestNodeIndex }),
        // The one number measured on shards that took no part in the search,
        // and so the only one that means anything outside this run. It arrives
        // once, at the end, which is why it is on the view and not a candidate.
        ...(event.bestTestScore === undefined ? {} : { bestTestScore: event.bestTestScore }),
        ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
        ...(event.expansionsPlanned === undefined ? {} : { expansionsPlanned: event.expansionsPlanned }),
        status: event.status,
      };

    case "log":
      return { ...state, logLines: [...state.logLines, { level: event.level, message: event.message }] };

    default:
      return state;
  }
}

/**
 * Update one candidate, creating a placeholder if its `expanded` has not
 * arrived yet.
 *
 * A `selected` event names its ancestors, and after a resume those ancestors
 * may be nodes whose own records are already below the watermark. Dropping the
 * update would lose their visit counts; inventing a placeholder keeps the tree
 * shaped correctly and lets the real record fill it in if it ever arrives.
 */
function withCandidate(
  state: EvolveRunView,
  nodeIndex: number,
  update: (candidate: EvolveCandidateView) => EvolveCandidateView,
  extra: Partial<EvolveRunView> = {},
): EvolveRunView {
  const index = state.candidates.findIndex((candidate) => candidate.nodeIndex === nodeIndex);
  const current = index >= 0 ? state.candidates[index]! : placeholder(nodeIndex);
  const updated = update(current);
  const candidates = index >= 0
    ? state.candidates.map((candidate, position) => (position === index ? updated : candidate))
    : [...state.candidates, updated].sort((left, right) => left.nodeIndex - right.nodeIndex);
  return { ...state, ...extra, candidates };
}

function placeholder(nodeIndex: number): EvolveCandidateView {
  return { depth: 0, nodeIndex, parentIndex: null, score: null, valid: true, visits: 0 };
}

/** The best *valid* candidate. A failed one scores `null` and can never win,
 *  even though it is part of the tree. */

/** Expansions dispatched against the budget, for the card's progress ring. */
export function runProgress(view: EvolveRunView, budgetExpansions: number): number {
  if (budgetExpansions <= 0) return 0;
  return Math.min(1, view.expansions / budgetExpansions);
}
