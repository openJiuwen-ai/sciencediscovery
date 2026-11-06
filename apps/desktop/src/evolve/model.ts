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
 * A run's event log, folded into the one state the panel draws.
 *
 * Live SSE, a replay after the fact and a resume from a cursor all feed this
 * reducer. That is the reason there is exactly one fold: a second code path
 * for "the live one" is how two readings of the same run drift apart until
 * nobody can say which is right.
 *
 * It is pure and tolerant. Records may arrive out of order after a reconnect,
 * repeat after a replay, or name a candidate whose `expanded` has not landed
 * yet. None of that is an error — it is the normal shape of a resumable
 * stream.
 */

import {
  isEvolveRunActive,
  type EvolveEvent,
  type EvolveEventRecord,
  type EvolveRejectionCategory,
  type EvolveRunStatus,
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
  /** `null` for a failed candidate: `-inf` never reaches the wire, and the
   *  node still belongs in the tree. */
  score: number | null;
  /** What the acceptance gate read. Kept apart from `score` because they are
   *  different measurements on different shards, and a chart that drew one
   *  line for both would hide the case the split exists for: better on what
   *  the search sees, worse on what decides. */
  gateScore?: number;
  rolloutScore?: number;
  /** The model's own rating of a direction, 1–10, when the run asked for a
   *  prior. Absent is not zero: the model did not answer. */
  promise?: number;
  selectedPuct?: number;
  valid: boolean;
  visits: number;
  complexityBin?: number;
  diversityBin?: number;
  cellVia?: "insert" | "migration";
  migratedToIsland?: number;
  inspirationIndex?: number;
  programId?: string;
}

export interface EvolveRunView {
  algorithm?: string;
  baselineScore: number | null;
  bestNodeIndex?: number;
  /** Reported once, at the end, on shards the search never saw. */
  bestTestScore?: number;
  candidates: EvolveCandidateView[];
  costCents: number;
  /** How many expansions have been dispatched — including failed ones. */
  expansions: number;
  /** The highest sequence folded in; where a resumed subscription starts. */
  lastSequence: number;
  logLines: Array<{ level: "error" | "info" | "warn"; message: string }>;
  maxDepth: number;
  rootVisits: number;
  status: EvolveRunStatus;
  stopReason?: string;
  expansionsPlanned?: number;
  tokens: number;
}

export type EvolveFinishNotice =
  | { kind: "target"; made: number; planned: number | null }
  | { kind: "short"; made: number; planned: number; reason: string };

/**
 * What to say when a finished run made fewer expansions than it planned.
 *
 * `target_reward` means the goal was met, so it does not share the shortfall
 * sentence. Every other early stop still does.
 */
export function evolveFinishNotice(view: EvolveRunView): EvolveFinishNotice | null {
  if (isEvolveRunActive(view.status)) return null;
  if (view.stopReason === "target_reward") {
    return {
      kind: "target",
      made: view.expansions,
      planned: view.expansionsPlanned ?? null,
    };
  }
  if (view.expansionsPlanned !== undefined && view.expansions < view.expansionsPlanned) {
    return {
      kind: "short",
      made: view.expansions,
      planned: view.expansionsPlanned,
      reason: view.stopReason ?? "?",
    };
  }
  return null;
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

/** Fold a batch in order. Records at or below the watermark are ignored, so
 *  replaying a prefix is free. */
export function reduceEvolveRecords(
  state: EvolveRunView,
  records: readonly EvolveEventRecord[],
): EvolveRunView {
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
        // parent is the root, so without it every diff in the run would show
        // as pure addition.
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
        promise: event.promise,
        ...(event.programId === undefined ? {} : { programId: event.programId }),
        score: event.score,
        valid: event.valid,
        ...(event.inspirationIndexes === undefined || event.inspirationIndexes.length === 0
          ? {}
          : { inspirationIndex: event.inspirationIndexes[0] }),
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
      return withCandidate(state, event.nodeIndex, (candidate) => ({
        ...candidate,
        complexityBin: event.complexityBin,
        diversityBin: event.diversityBin,
        island: event.island,
        cellVia: event.via,
      }));

    case "migrated":
      return withCandidate(state, event.nodeIndex, (candidate) => ({
        ...candidate,
        migratedToIsland: event.toIsland,
      }));

    case "cost":
      return { ...state, costCents: event.cents, tokens: event.tokens };

    case "search_finished":
      return {
        ...state,
        ...(event.bestNodeIndex === null ? {} : { bestNodeIndex: event.bestNodeIndex }),
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
 * Take the status the run record reports.
 *
 * The event log is the source of truth about *what the search did*, but it is
 * not the authority on whether the run is over: a run the control plane
 * settles without the sidecar — it failed to persist a record, the sidecar
 * died — is terminal in `run.json` and has no `search_finished` to say so. The
 * header therefore follows the record. Returning the same object when nothing
 * changed keeps this from re-rendering the panel on every poll.
 */
export function adoptRunStatus(state: EvolveRunView, status: EvolveRunView["status"]): EvolveRunView {
  return state.status === status ? state : { ...state, status };
}

/**
 * Update one candidate, creating a placeholder if its `expanded` has not
 * arrived yet.
 *
 * A `selected` event names its ancestors, and after a resume those may be
 * nodes whose own records are below the watermark. Dropping the update would
 * lose their visit counts; a placeholder keeps the tree shaped correctly and
 * lets the real record fill it in.
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

/** The valid candidate with the highest acceptance-gate score. Failed nodes
 *  carry `null` and never win, even though they stay in the tree. */
export function bestCandidate(view: EvolveRunView): EvolveCandidateView | undefined {
  let best: EvolveCandidateView | undefined;
  let bestScore = -Infinity;
  for (const candidate of view.candidates) {
    if (!candidate.valid) continue;
    const score = candidate.gateScore ?? candidate.score;
    if (score === null || score === undefined || !Number.isFinite(score)) continue;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** The headline score: what the run achieved, or the starting point while
 *  nothing has beaten it yet. */
export function headlineScore(view: EvolveRunView): number | null {
  return bestCandidate(view)?.gateScore
    ?? bestCandidate(view)?.score
    ?? view.baselineScore;
}

/** Expansions dispatched against the budget, for the progress bar. */
export function runProgress(view: EvolveRunView, budgetExpansions: number): number {
  if (budgetExpansions <= 0) return 0;
  return Math.min(1, view.expansions / budgetExpansions);
}

export type Verdict = "accepted" | "failed" | "rejected" | "violated";

/** Which of the four outcomes a candidate row is showing.
 *
 *  Four, not two, because they send the reader somewhere different: accepted
 *  means it is now the best; a failed candidate never ran; a constraint
 *  violation is illegal rather than worse; and "rejected" simply lost. */
export function verdictOf(candidate: EvolveCandidateView): Verdict {
  if (candidate.accepted) return "accepted";
  if (!candidate.valid) return candidate.category === "constraint-violated" ? "violated" : "failed";
  return candidate.category === "constraint-violated" ? "violated" : "rejected";
}

/** Longest title, in columns: a CJK character is two columns wide. */
const TITLE_COLUMNS = 64;

const columnsOf = (char: string): number =>
  (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(char) ? 2 : 1);

/**
 * A one-line title for a run whose goal is the user's whole brief.
 *
 * The statement is kept verbatim because the search reads it; a brief with
 * audience, constraints and a rubric is a paragraph, and headers cannot show a
 * paragraph. This keeps the first sentence, drops a leading "任务：" label, and
 * cuts at a fixed width. The full statement stays wherever there is room.
 */
export function evolveShortTitle(statement: string): string {
  const flat = statement.replace(/\s+/g, " ").trim();
  const unlabelled = flat.replace(/^(?:任务|目标|Task|Goal|Objective)\s*[:：]\s*/i, "");
  const firstSentence = unlabelled.split(/[。！？!?；;]|\.(?=\s|$)/, 1)[0]?.trim() ?? "";
  const title = /[\p{L}\p{N}]/u.test(firstSentence)
    ? firstSentence
    : /[\p{L}\p{N}]/u.test(unlabelled) ? unlabelled : flat;
  let width = 0;
  let out = "";
  for (const char of title) {
    width += columnsOf(char);
    if (width > TITLE_COLUMNS) return `${out.trimEnd()}…`;
    out += char;
  }
  return out;
}

/** Whether a goal predates the conversational designer. Runs written before
 *  it exist on disk and still open; the panel says plainly that their
 *  scorecard was never chosen by anyone. */
export function isPlaceholderGoal(goal: { scorecard: { hash: string } }): boolean {
  return goal.scorecard.hash === "sha256:placeholder";
}

/** A score with enough decimals to separate candidates that differ in the
 *  fourth place, and an em dash where there is no measurement. */
export function formatScore(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(4);
}

/** A signed delta against the baseline, with the sign drawn as an arrow. */
export function formatDelta(value: number | null, baseline: number | null): string | undefined {
  if (value === null || baseline === null) return undefined;
  const delta = value - baseline;
  if (!Number.isFinite(delta)) return undefined;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(4)}`;
}

/** Tokens in the thousand/million units a reader scans, not a nine-digit
 *  number. `1234567` → `1.23M`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/** Seconds as a compact span. The boundary cases are 0 and over an hour, and
 *  both read badly as a bare second count. */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
