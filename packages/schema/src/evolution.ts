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
 * `/evolve` — the goal a search optimises and the events it emits.
 *
 * Two layers, with deliberately different certainty requirements (see
 * docs/evolve-scorecard.md §1): the **goal** is the user's sentence plus what is
 * being evolved and may stay vague, while the **scorecard** is what the search
 * actually maximises and must be executable, repeatable and unmodifiable by the
 * candidates it judges.
 *
 * A single criterion is `criteria.length === 1` — there is no separate
 * "simple metric" path, because two paths diverge immediately on normalisation
 * and freezing.
 */

/** Which search algorithm runs the loop. Not two code paths — one field. */
export type EvolveAlgorithm = "puct" | "openevolve";

/**
 * The name `"puct"` used to be `"era"`, after the upstream example the port came
 * from. Runs created before the rename carry the old value in their stored
 * goal, so every read path normalises rather than the store being rewritten:
 * a migration would have to touch the run record, its events and the search
 * graph mirror at once, and getting one of the three wrong is a run that opens
 * to an empty panel. Accepting one extra string on read costs nothing and is
 * reversible.
 */
export function evolveAlgorithm(raw: unknown): EvolveAlgorithm {
  return raw === "openevolve" ? "openevolve" : "puct";
}


/**
 * How the search spends its exploration budget — the two knobs of the PUCT
 * rule, set together because they scale each other.
 *
 * Absent means upstream: `cPuct` 1.0 and a uniform prior. This exists because
 * the two defaults are not neutral for every task, and because the drafting
 * agent knows things about the run that the engine cannot see — how noisy the
 * scoring is, how much budget there is, whether the landscape is flat.
 */
export interface EvolveSearchTuning {
  /**
   * The exploration constant. Exploitation is the candidate's *rank* in
   * `[0, 1]`; this scales `P · √totalVisits / (1 + visits)` against it, which is
   * worth roughly `cPuct / √nodes` at one visit. So it decides among candidates
   * the ranking has left close together and never overturns a clear one.
   */
  cPuct?: number;
  /**
   * How sharply the model's own rating of a direction bends `P(s, a)`.
   *
   * `0` — the default — is upstream: a uniform `1/N` for every node, to the
   * floating-point bit, and the rating is not even asked for. Above zero the
   * mutation prompt gains one line asking the model to end its reply with
   * `PROMISE: <n>` (1–10, how far this *approach* could go after further work),
   * and that number becomes the prior. It rides the reply the search was
   * already paying for, so it costs no extra call.
   *
   * The power is the point rather than a knob for its own sake. Upstream's own
   * arithmetic: with a prior proportional to the rating, a candidate rated 8
   * against a mean of 5.5 gets 1.45x the exploration term and a dead end rated
   * 2 still gets 0.36x. Squared, those become 2.12x and 0.13x — the difference
   * between widening exploration and *aiming* it. `2` is upstream's own
   * non-zero setting.
   *
   * **It cannot move the reported score.** The rating decides where the next
   * attempt starts; the number a run reports comes from the sandbox on held-out
   * shards.
   */
  priorExponent?: number;
}

/** What is being evolved. */
export type EvolveTarget =
  | { kind: "program"; programId: string; entrypoint: string }
  | { kind: "skill_dir"; skillId: string; layout: "claude_skill" }
  | { kind: "agent_dir"; agentId: string; layout: "claude_agent" }
  /**
   * A piece of writing: a prompt, an abstract, a protocol, a plan.
   *
   * Nothing is executed, so there is no entrypoint and no language — the
   * candidate *is* the content. It can only be scored by something that reads
   * it, which in practice means `llm_judge`, and that is the pairing the
   * pre-flight checks enforce.
   */
  | { kind: "text"; contentCas: string; label: string };

/**
 * Three-way split. Two-way splits report an improvement measured on the shards
 * the search optimised against, which is inflated by construction: only
 * `testShards` produces a number that can be quoted outside the run.
 */
export interface EvolveSplit {
  /** `null` = every row. */
  trainRows: number | null;
  /** Shards whose score the search can see. */
  rolloutShards: number;
  /** Shards the acceptance gate reads. Never shown to the search. */
  gateShards: number;
  /** Shards that never take part; reported once, at the end. */
  testShards: number;
  shardRows: number;
  seed: number;
}

export interface EvolveMetric {
  name: string;
  direction: "maximize" | "minimize";
}

/**
 * How one criterion's raw measurement reaches `[0, 1]`.
 *
 * `relative_to_baseline` is `r / (1 + r)` where `r = baseline / x`, for
 * smaller-is-better quantities. Not `clamp(r, 0, 1)`, which is what it used to
 * be: that hits its bound the moment a candidate beats the baseline, so every
 * improvement ties at 1.0 and the baseline itself scores 1.0 — at the default
 * solved threshold the search stops before its first expansion. This map is
 * strictly increasing and never reaches its bound: the baseline sits at 0.5,
 * half the error is 0.667, a tenth is 0.909.
 *
 * The reference is **always the baseline, never the current best** — a drifting
 * reference means yesterday's 0.8 and today's 0.8 are different numbers, which
 * pollutes the acceptance prior and makes a replay of the same candidates score
 * differently.
 */
export type EvolveNormalize =
  | { kind: "identity" }
  | { kind: "reciprocal" }
  | { kind: "relative_to_baseline" }
  | { kind: "clamp"; hi: number; lo: number };

/** How the three-way split maps onto a test suite's case groups. */
export interface EvolveCaseSplit {
  gateGroups: number;
  rolloutGroups: number;
  testGroups: number;
}

/**
 * Where one criterion's number comes from. The four measurement modes of
 * docs/evolve-goal-scoring.md §2.
 */
export type EvolveScoring =
  | {
    /** The dataset, content-addressed. One CSV today; the array is the seam for
     *  a dataset that arrives in parts. */
    datasetCas: string[];
    kind: "dataset_metric";
    metric: EvolveMetric;
    split: EvolveSplit;
    /** Column the candidate must predict. Dropped from the test file it is
     *  given and kept as the truth it is scored against — a candidate that can
     *  read the answer key optimises for reading it. */
    target: string;
  }
  | {
    caseSplit: EvolveCaseSplit;
    entrypoint: string[];
    /** Paths the reflector may not edit *and* the candidate may not rewrite at
     * run time. Both layers are required: without them the shortest path to a
     * high score is to weaken the thing measuring it. */
    frozen: string[];
    kind: "test_gate";
    setupCmd?: string[];
    testCmd: string[];
  }
  /** The evaluator is self-contained: it builds case `i` from the shard index
   *  rather than reading anything, because it runs alone in a scratch directory
   *  with only the candidate for company. Material that genuinely lives in a
   *  file belongs in `dataset_metric`, which owns the splitting too. */
  | { kind: "custom_script"; scriptCas: string; split: EvolveSplit; timeoutSeconds: number }
  | {
    /** Judges never see the candidate's identity, iteration or parent score. */
    blind: true;
    judgeModelId: string;
    kind: "llm_judge";
    rubricCas: string;
    /**
     * Material the candidate must stay faithful to, shown to the judge.
     *
     * Without it a rubric can only reward properties of the text itself, and a
     * candidate can fabricate any of those. Measured on the first real judged
     * run: a rubric asking for "checkable specifics" produced an abstract full
     * of invented benchmarks, model names and percentages, and scored full
     * marks. With the source in front of it the judge can be asked for
     * consistency instead of for specificity.
     */
    sourceCas?: string;
    /** Median of this many gradings; the spread is checked against
     * `varianceThreshold` and an over-spread candidate is recorded as
     * undecidable rather than as a zero. */
    samplesPerCandidate: number;
    scale: { max: number; min: number };
    split: EvolveSplit;
    varianceThreshold: number;
  };

export type EvolveScoringKind = EvolveScoring["kind"];

/**
 * A reward at or above this counts as solved, so no proposal is requested.
 * 0.999 is right for a binary scorer and wrong in a way that produces no error
 * for a graded one: an LLM judge rarely reaches it, so every rollout asks the
 * reflector to "fix" an answer that scored 0.95 and the run reports
 * below-threshold as if the reflector were the problem.
 */
export const SOLVED_THRESHOLD_BY_SCORING: Readonly<Record<EvolveScoringKind, number>> = {
  custom_script: 0.999,
  dataset_metric: 0.999,
  llm_judge: 0.85,
  test_gate: 0.999,
};

export interface ScorecardCriterion {
  direction: "maximize" | "minimize";
  id: string;
  measure: EvolveScoring;
  name: string;
  normalize: EvolveNormalize;
  /** Normalised across criteria so the weights sum to 1. */
  weight: number;
}

/**
 * A hard constraint. Violating it refuses the merge — it is not a penalty.
 *
 * Folding a constraint into a weight makes it tradable ("0.3 more F1 is worth
 * being three times slower"), and a constraint that can be traded away is not a
 * constraint. Writing it as "score 0 when violated" is equally wrong: every
 * violating candidate then ties at 0, which flattens the rank ordering the tree
 * exploits and makes "crashed" indistinguishable from "promising but illegal".
 */
export interface ScorecardConstraint {
  criterionId: string;
  id: string;
  name: string;
  op: "<" | "<=" | ">" | ">=";
  value: number | { relativeToBaseline: number };
}

export interface EvolveScorecard {
  /** `weighted_geomean` drags the total to 0 when any criterion is ~0 — the way
   * to say "no weak dimension is acceptable". */
  aggregate: "weighted_geomean" | "weighted_sum";
  constraints: ScorecardConstraint[];
  criteria: ScorecardCriterion[];
  confirmedAt: string;
  confirmedBy: string;
  derivedFrom: { draftRunId: string; statement: string };
  /** L0 freeze key. `--resume` refuses a run whose card hash moved: scores under
   * a different card are not comparable. */
  hash: string;
  schemaVersion: 1;
  solvedThreshold: number;
}

export interface EvolveBudget {
  candidateTimeoutSeconds: number;
  /** Must divide evenly by `workers`: the engine dispatches whole sweeps, so a
   *  remainder silently buys fewer expansions than the user asked for. */
  expansions: number;
  maxCostCents: number;
  /**
   * Ceiling for one mutation call.
   *
   * Modelled explicitly because it is a pre-flight check, not a detail: a
   * reasoning model with thinking left on spends the budget on hidden tokens
   * and returns an empty reply, and an empty reply becomes a failed node —
   * indistinguishable from a candidate that genuinely would not run. This is
   * measured, not assumed: at 16k a real reasoning model spent 16001 output
   * tokens on thinking and returned nothing, six times over. PUCT needs >= 32k;
   * OpenEvolve rewrites the whole genome and needs >= 64k.
   */
  maxTokensPerCall: number;
  maxSeconds: number;
  maxTokens: number;
  /**
   * Concurrent proposals, dispatched in waves of this size — each wave picks
   * its parents from the tree as it stands, so the next wave sees what landed.
   *
   * **Whether it buys anything depends on the provider, and the honest default
   * is 1.** The engine's own arithmetic says it should help: an expansion is
   * ~3 minutes of model call against ~30 seconds of sandboxed measurement, and
   * the model call is I/O bound. But measured end to end against a real
   * provider, four concurrent calls each took 11–20 minutes where one alone
   * took 3, and the wave finished *slower* than running the four in sequence
   * (19.8 minutes against 13). The concurrency limit was upstream, not here.
   *
   * So raise this only against a provider known to serve concurrent requests,
   * and measure rather than assume — the mechanism is real and the benefit is
   * not automatic.
   */
  workers: number;
}

/**
 * One evolution run, as the main agent proposes it.
 *
 * Deliberately *not* `EvolveGoal`: a goal names content by hash and carries a
 * frozen scorecard, and neither is something an agent mid-conversation has.
 * What it has is text it just wrote and paths it just read, so this speaks in
 * those terms and the control plane does the storing, the freezing and the
 * hashing. The asymmetry is the point — the agent designs, the server decides
 * what a run *is*.
 */
export interface EvolveRunProposal {
  /** Which search algorithm runs the loop. The user's `/evolve-design` command
   *  may carry `--algorithm openevolve`; the agent reads that and puts it here.
   *  Unset defaults to `"puct"`. */
  algorithm?: EvolveAlgorithm;
  /** What the search is for, in the user's terms. Shown on the run card. */
  statement: string;
  /** How a candidate gets its number, in plain words — the one line a person
   *  reads before approving. Every mode fills it; no mode's fields appear. */
  howScored: string;
  mode: EvolveScoringKind;
  /** Workspace path to start from, or `startingPointText` when the agent wrote
   *  the starting point itself. Exactly one. */
  startingPointPath?: string;
  startingPointText?: string;
  /** `dataset_metric`: the CSV, the column, and how the metric is oriented. */
  datasetPath?: string;
  targetColumn?: string;
  metric?: string;
  direction?: "maximize" | "minimize";
  normalize?: EvolveNormalize["kind"];
  split?: EvolveSplit;
  /** `custom_script`: the evaluator, verbatim. The agent is expected to have
   *  run it before proposing — that is the whole advantage of designing inside
   *  a loop that has an interpreter. */
  evaluatorSource?: string;
  /** `llm_judge`: the rubric and its top mark. */
  rubric?: string;
  scaleMax?: number;
  judgeModelId?: string;
  /** `test_gate`: how the project's own suite is run and what candidates may
   *  not touch. */
  testCmd?: string;
  frozenGlobs?: string[];
  entrypointPath?: string;
  caseSplit?: EvolveCaseSplit;
  /** Packages the candidates need that the runtime lacks. Names only. */
  packages?: string[];
  expansions: number;
  workers: number;
  thinking?: "disabled" | "enabled";
  /** How the search explores. Omit to take upstream's settings, which is the
   *  right answer whenever nothing about the task argues against them. */
  search?: EvolveSearchTuning;
  /** What to watch out for. Shown with the approval, so it has to be about
   *  *this* run — not general cautions about the technique. */
  risks?: string[];
}

/**
 * What the agent learns from proposing.
 *
 * A refusal is a normal outcome, not an exception: the probe exists to catch a
 * scoring scheme that cannot rank, and the agent is the right party to fix it.
 * `probe` travels back on success so the agent can quote real numbers into the
 * conversation instead of promising them.
 */
export interface EvolveRunProposalResult {
  run?: EvolveRun;
  probe?: { baseline: number; flat: boolean; label: string; worsened: number | null };
  refusedBecause?: string;
}

/**
 * A finished (or running) search, as the agent reports it.
 *
 * Only what a person would want said out loud. `bestTestScore` is the one
 * number quotable outside the run — the others were all optimised against, so
 * an improvement measured on them is inflated by construction.
 */
export interface EvolveRunSummary {
  bestScore: number | null;
  /** The held-out test split, which the search never saw. `null` when the
   *  split reserved none, in which case there is no external claim to make. */
  bestTestScore: number | null;
  baselineScore: number | null;
  candidates: number;
  /** The winning candidate's own one-line description of what it changed. */
  bestChange?: string;
  id: string;
  /** Said plainly when it happened: a run can finish `succeeded` having learned
   *  nothing, and that is worth reporting rather than dressing up. */
  note?: string;
  status: EvolveRunStatus;
  /** Set only when the search made fewer expansions than it planned, which a
   *  `succeeded` status and a real improvement otherwise hide completely. */
  stoppedEarly?: string;
  tokens: number;
}

export interface EvolveGoal {
  algorithm: EvolveAlgorithm;
  baselineProgramCas: string;
  budget: EvolveBudget;
  /**
   * Whether the mutation calls may use the model's hidden reasoning.
   *
   * A real trade-off, measured on GLM5.2 rewriting a small program:
   *
   * | thinking | output tokens/call | wall clock | held-out test score |
   * |----------|--------------------|------------|---------------------|
   * | on       | 11k–64k (2 of 8 hit a 64k cap) | ~5 min | 0.519 |
   * | off      | ~1.2k              | ~60 s      | 0.366 |
   *
   * So it is the user's call, not a default to bake in: thinking buys better
   * candidates and costs forty times the tokens and five times the wall clock,
   * and needs a ceiling high enough to hold the thinking *and* the program.
   * `undefined` sends nothing and lets the provider decide.
   */
  thinking?: "disabled" | "enabled";
  /**
   * Packages the candidates need that the runtime does not already have.
   *
   * Worked out by the drafting agent from the task, not asked of the user: a
   * search over gradient-boosted trees needs a gradient-boosting library, and
   * the person who typed "bring the error down" has no way to know that and no reason
   * to. Provisioned into the candidate runtime before the probe, so the
   * starting point and every candidate see the same environment.
   *
   * Names only, resolved from the default index. Shown on the wizard's plan
   * card before anything is started, because installing software is a side
   * effect on the host and the list a model chose is worth reading.
   */
  packages?: string[];
  /** Which engine implements `algorithm`. Unset means the algorithm's own —
   *  this exists to pin `stub` for a reproduction, or for a placeholder goal
   *  that has no dataset behind it yet. */
  engine?: string;
  /** How the search explores. Unset is upstream's own settings. */
  search?: EvolveSearchTuning;
  /** Which fields came from the drafting agent and were accepted unedited —
   * read when reviewing why a run went the way it did. */
  draftedBy?: { acceptedFields: string[]; runId: string };
  /** L0: the scoring definition itself (metric, test suite, script, rubric,
   * split seed). */
  frozen: string[];
  /** Which model profile the mutation calls use.
   *
   * On the goal rather than resolved at run time, because the pre-flight checks
   * are about *this* model — the token ceiling and the thinking setting are
   * per-model, and a run that silently switched models would invalidate them.
   * The sidecar never learns the model's key: it calls the control plane's
   * proxy with a run-scoped token. */
  modelId: string;
  scorecard: EvolveScorecard;
  schemaVersion: 2;
  /** The user's sentence, kept verbatim. */
  statement: string;
  target: EvolveTarget;
}

export type EvolveRunStatus =
  | "budget_exhausted"
  | "failed"
  | "pending"
  | "running"
  | "stopped"
  | "succeeded";

/** Terminal statuses — a run in one of these emits no further events. */
export const EVOLVE_TERMINAL_STATUSES: readonly EvolveRunStatus[] = [
  "budget_exhausted",
  "failed",
  "stopped",
  "succeeded",
];

export function isEvolveRunActive(status: EvolveRunStatus): boolean {
  return !EVOLVE_TERMINAL_STATUSES.includes(status);
}

export interface EvolveRun {
  algorithm: EvolveAlgorithm;
  bestNodeIndex?: number;
  candidates: number;
  costCents: number;
  createdAt: string;
  error?: string;
  finishedAt?: string;
  goal: EvolveGoal;
  id: string;
  /** Idempotency watermark: events at or below it have already been applied,
   * so a reconnect can replay without double-counting. */
  lastSeq: number;
  projectId?: string;
  /** Set when this run continues another run's search (`--resume`). */
  resumedFromRunId?: string;
  sessionId: string;
  startedAt?: string;
  status: EvolveRunStatus;
  tokens: number;
}

/** Why a candidate did not commit. The three refusals need opposite fixes, so
 * they are never collapsed into a boolean. */
export type EvolveRejectionCategory =
  /** The candidate never reached the gate: it would not parse, would not run,
   *  timed out, or the model returned nothing. Distinct from `below-threshold`
   *  because the two need opposite fixes — one is a prompt or an environment
   *  problem, the other is a search that is not finding improvements. */
  | "candidate-failed"
  | "below-threshold"
  | "constraint-violated"
  | "stale"
  | "trust-region";

/**
 * One thing that happened during a search. `inserted` / `migrated` are
 * openevolve-only; everything else is common to both algorithms.
 *
 * Counters are **absolute, never deltas**: visits and cell occupancy are the two
 * non-idempotent quantities in the system, and a replayed delta double-counts
 * where a replayed absolute does not.
 */
export type EvolveEvent =
  | { algorithm: EvolveAlgorithm; scorecardHash: string; type: "search_started" }
  | {
    baselineScore: number | null;
    /** The seed's own source, stored like an expansion's. Absent on runs
     *  written before it was recorded; the detail view falls back to an empty
     *  "before", which renders the whole candidate as added. */
    codeChars?: number;
    codeHash?: string;
    nodeIndex: number;
    type: "seeded";
  }
  | {
    /** Every ancestor whose visit count moved, with its **absolute** count. */
    ancestorVisits: Array<{ nodeIndex: number; visits: number }>;
    nodeIndex: number;
    rankScore?: number;
    puct?: number;
    type: "selected";
  }
  | {
    changeSummary?: string;
    codeChars?: number;
    codeHash?: string;
    depth: number;
    error?: string;
    /** openevolve: the archive entries that were in the mutation prompt. */
    inspirationIndexes?: number[];
    island?: number;
    iteration?: number;
    /** puct, when `priorExponent > 0`: the model's own rating of this
     *  candidate's direction, 1–10, read off the end of the mutation reply.
     *  Absent when the run did not ask for one, or the model did not answer —
     *  which is not the same as a zero, and `FlatPuct` treats it as the mean of
     *  the rated nodes rather than as a dead end. */
    promise?: number;
    nodeIndex: number;
    parentIndex: number | null;
    programId?: string;
    /** `null` when the candidate failed — `-inf` is not valid JSON and a failed
     * expansion is already recorded by `valid: false`. The node still enters the
     * tree: dropping it changes the rank denominator of every later iteration. */
    score: number | null;
    type: "expanded";
    valid: boolean;
    worker?: number;
  }
  | {
    /** Per-criterion normalised scores, keyed by criterion id. */
    criteria: Record<string, number>;
    gateScore?: number;
    nodeIndex: number;
    reward: number;
    rolloutScore?: number;
    type: "evaluated";
  }
  | {
    complexityBin: number;
    diversityBin: number;
    island: number;
    nodeIndex: number;
    type: "inserted";
    via: "insert" | "migration";
  }
  | { fromIsland: number; nodeIndex: number; toIsland: number; type: "migrated" }
  | {
    accepted: boolean;
    category?: EvolveRejectionCategory;
    nodeIndex: number;
    reason: string;
    /** Constraint id when `category === "constraint-violated"`. */
    rejectedBy?: string;
    type: "merged";
  }
  | {
    bestNodeIndex: number | null;
    bestTestScore?: number;
    candidates: number;
    /** What the run planned, next to the `candidates` it actually produced. */
    expansionsPlanned?: number;
    status: EvolveRunStatus;
    /** The framework's own word for why the search stopped — `max_iters`,
     * `patience`, `max_seconds`. Recorded even when it is the ordinary one:
     * a run that planned 20 expansions and made 8 is answerable only from
     * here, and the log deliberately stays quiet about the dull reasons. */
    stopReason?: string;
    type: "search_finished";
  }
  | { cents: number; tokens: number; type: "cost" }
  | { level: "error" | "info" | "warn"; message: string; type: "log" };


/** One line of a run's `events.ndjson`. Mirrors the shape run streams already
 * use (`{ createdAt, event, sequence }`) so the two readers stay symmetric. */
export interface EvolveEventRecord {
  createdAt: string;
  event: EvolveEvent;
  sequence: number;
}
