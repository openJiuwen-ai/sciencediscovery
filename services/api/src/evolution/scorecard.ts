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
 * The scorecard: normalise each criterion, aggregate into one reward, and check
 * the constraints — plus the validation that must pass before a run may start.
 *
 * Everything here is a pure function of (scorecard, measurements, baseline).
 * The engine binding and the acceptance policy call it; nothing in this file
 * touches disk, the network or the clock, which is what lets the awkward parts
 * (a drifting reference, a card that cannot rank) be tested exhaustively.
 *
 * **Normalisation always produces "higher is better".** The search maximises one
 * scalar, so a criterion the user wants small has to be turned around here
 * rather than anywhere downstream. Which normalisation may pair with which
 * direction is therefore not a style question but a correctness one, and
 * `validateScorecard` refuses the mismatches.
 *
 * **The reference is the baseline, never the current best.** A reference that
 * moves with the search makes yesterday's 0.8 and today's 0.8 different numbers:
 * the acceptance prior is polluted and replaying the same candidates no longer
 * reproduces their scores.
 */


import type {
  EvolveNormalize,
  EvolveScorecard,
  ScorecardConstraint,
  ScorecardCriterion,
} from "@sciencediscovery/schema";

/** Raw, un-normalised measurements keyed by criterion id. */
export type Measurements = Readonly<Record<string, number>>;

export interface ConstraintViolation {
  constraintId: string;
  criterionId: string;
  /** Human-readable, shown in the candidate row and stored on the node. */
  detail: string;
  limit: number;
  observed: number;
}

export interface CandidateScore {
  /** Per-criterion normalised values, keyed by criterion id. */
  criteria: Record<string, number>;
  /** The aggregate in `[0, 1]` — what the engine maximises. */
  reward: number;
  /** Empty when the candidate may merge. Non-empty refuses the merge; it does
   *  **not** change `reward`, because a violating candidate still has to rank. */
  violations: ConstraintViolation[];
}

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  code: string;
  criterionId?: string;
  message: string;
  severity: ValidationSeverity;
}

/** Baseline and a deliberately-degraded variant, both measured. The degraded
 *  one exists for one reason: a card whose total cannot tell them apart cannot
 *  rank anything, and that failure is silent. */
export interface ValidationProbes {
  baseline: Measurements;
  degraded?: Measurements;
}

const EPSILON = 1e-9;

// --- Normalisation ----------------------------------------------------------

/**
 * Which normalisations make sense for which direction.
 *
 * `relative_to_baseline` is minimise-only on purpose: a maximise criterion is
 * already higher-is-better and has no reason to be expressed as a ratio.
 *
 * The flattening this note used to describe — a ratio capping at 1.0 the moment
 * a candidate beats the baseline, so the ranking goes blind exactly where the
 * search is succeeding — was real, and restricting the direction did not avoid
 * it: for a minimise criterion the ratio is `baseline / raw`, which passes 1.0
 * on the same event. It is fixed in `normalize` instead, where it belongs.
 */
const ALLOWED: Record<EvolveNormalize["kind"], ReadonlyArray<ScorecardCriterion["direction"]>> = {
  clamp: ["maximize", "minimize"],
  identity: ["maximize"],
  reciprocal: ["minimize"],
  relative_to_baseline: ["minimize"],
};

/**
 * Map one raw measurement into `[0, 1]`, higher-is-better.
 *
 * `baseline` is only read by `relative_to_baseline`; passing the wrong one there
 * is the drift bug this module exists to prevent, so it is a required argument
 * rather than an optional context field.
 */
export function normalize(criterion: ScorecardCriterion, raw: number, baseline: number): number {
  if (!Number.isFinite(raw)) return 0;
  switch (criterion.normalize.kind) {
    case "identity":
      return clamp01(raw);
    case "reciprocal":
      return clamp01(1 / (1 + Math.max(raw, 0)));
    case "relative_to_baseline": {
      if (!Number.isFinite(baseline) || baseline <= 0) return 0;
      if (raw <= 0) return 1;
      // `ratio / (1 + ratio)`, not `clamp01(ratio)`. The plain ratio saturates
      // the instant a candidate beats the baseline — every improvement lands on
      // 1.0 and ties with every other, and with the default solved threshold
      // the *baseline itself* scores 1.0 and the search stops before its first
      // expansion. Watched exactly that happen on a real run: seeded at 1,
      // "succeeded", one candidate, nothing tried.
      //
      // This map is strictly increasing in improvement and never reaches its
      // bound: the baseline sits at 0.5, half the error is 0.667, a tenth is
      // 0.909, twice the error is 0.333.
      const ratio = baseline / raw;
      return clamp01(ratio / (1 + ratio));
    }
    case "clamp": {
      const { hi, lo } = criterion.normalize;
      if (hi - lo < EPSILON) return 0;
      const scaled = (raw - lo) / (hi - lo);
      return clamp01(criterion.direction === "minimize" ? 1 - scaled : scaled);
    }
  }
}

// --- Scoring ----------------------------------------------------------------

/** Weights as fractions of their sum, so a card whose weights read 3/1/1 works
 *  the same as one that reads 0.6/0.2/0.2. */
export function normalizedWeights(scorecard: EvolveScorecard): Map<string, number> {
  const total = scorecard.criteria.reduce((sum, criterion) => sum + Math.max(criterion.weight, 0), 0);
  const weights = new Map<string, number>();
  for (const criterion of scorecard.criteria) {
    weights.set(criterion.id, total > EPSILON ? Math.max(criterion.weight, 0) / total : 0);
  }
  return weights;
}

/**
 * Score one candidate.
 *
 * `violations` travel beside the reward rather than inside it: writing a refusal
 * as "score 0" would tie every violating candidate together, and the tree's
 * exploitation term is a *rank*, so a block of ties flattens exactly the signal
 * it reads. A violating candidate keeps its score, enters the tree, and can be
 * selected for expansion — it simply may not merge.
 */
export function scoreCandidate(
  scorecard: EvolveScorecard,
  measurements: Measurements,
  baseline: Measurements,
): CandidateScore {
  const weights = normalizedWeights(scorecard);
  const criteria: Record<string, number> = {};
  for (const criterion of scorecard.criteria) {
    const raw = measurements[criterion.id];
    criteria[criterion.id] = raw === undefined
      ? 0  // an unmeasured criterion scores 0; validation refuses this up front
      : normalize(criterion, raw, baseline[criterion.id] ?? Number.NaN);
  }
  return {
    criteria,
    reward: aggregate(scorecard, criteria, weights),
    violations: evaluateConstraints(scorecard, measurements, baseline),
  };
}

/**
 * Combine the normalised criteria.
 *
 * `weighted_geomean` drags the total to 0 when any criterion is ~0 — the way to
 * say "no weak dimension is acceptable". `weighted_sum` lets one dimension pay
 * for another, which is what most cards want and why it is the default.
 */
export function aggregate(
  scorecard: EvolveScorecard,
  criteria: Readonly<Record<string, number>>,
  weights = normalizedWeights(scorecard),
): number {
  if (!scorecard.criteria.length) return 0;
  if (scorecard.aggregate === "weighted_geomean") {
    let product = 1;
    for (const criterion of scorecard.criteria) {
      const weight = weights.get(criterion.id) ?? 0;
      const value = criteria[criterion.id] ?? 0;
      if (value <= EPSILON) return 0;
      product *= Math.pow(value, weight);
    }
    return clamp01(product);
  }
  let sum = 0;
  for (const criterion of scorecard.criteria) {
    sum += (weights.get(criterion.id) ?? 0) * (criteria[criterion.id] ?? 0);
  }
  return clamp01(sum);
}

/** Constraints read **raw** measurements, not normalised ones: "must finish
 *  within 300s" is a statement about seconds, and normalising first would make
 *  the threshold depend on the card's scaling choices. */
export function evaluateConstraints(
  scorecard: EvolveScorecard,
  measurements: Measurements,
  baseline: Measurements,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  for (const constraint of scorecard.constraints) {
    const observed = measurements[constraint.criterionId];
    if (observed === undefined || !Number.isFinite(observed)) continue;
    const limit = constraintLimit(constraint, baseline);
    if (limit === undefined) continue;
    if (!satisfies(observed, constraint.op, limit)) {
      violations.push({
        constraintId: constraint.id,
        criterionId: constraint.criterionId,
        detail: `${constraint.name}: ${constraint.criterionId} = ${observed}, requires ${constraint.op} ${limit}`,
        limit,
        observed,
      });
    }
  }
  return violations;
}

function constraintLimit(constraint: ScorecardConstraint, baseline: Measurements): number | undefined {
  if (typeof constraint.value === "number") return constraint.value;
  const reference = baseline[constraint.criterionId];
  if (reference === undefined || !Number.isFinite(reference)) return undefined;
  return reference * constraint.value.relativeToBaseline;
}

function satisfies(observed: number, op: ScorecardConstraint["op"], limit: number): boolean {
  switch (op) {
    case "<": return observed < limit;
    case "<=": return observed <= limit;
    case ">": return observed > limit;
    case ">=": return observed >= limit;
  }
}

// --- Freezing ---------------------------------------------------------------


// --- Validation -------------------------------------------------------------

/**
 * Everything that must hold before a run may start.
 *
 * The two checks worth the effort are the last two. **A baseline that already
 * violates a constraint** means the search can never accept anything: it will
 * burn the whole budget and end with a dashboard full of `constraint-violated`.
 * **A card with no discrimination** — where the total cannot separate the
 * baseline from a deliberately worse variant — sends the search wandering across
 * flat ground, and unlike a wrong scale (which the engine's reward contract
 * catches on the first rollout) nothing downstream ever reports it.
 */
export function validateScorecard(
  scorecard: EvolveScorecard,
  probes?: ValidationProbes,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (severity: ValidationSeverity, code: string, message: string, criterionId?: string) => {
    issues.push({ code, message, severity, ...(criterionId ? { criterionId } : {}) });
  };

  if (!scorecard.criteria.length) {
    push("error", "empty_criteria", "a scorecard needs at least one criterion");
    return issues;
  }

  const seen = new Set<string>();
  for (const criterion of scorecard.criteria) {
    if (seen.has(criterion.id)) push("error", "duplicate_criterion_id", `duplicate criterion id: ${criterion.id}`, criterion.id);
    seen.add(criterion.id);
    if (!(criterion.weight > 0)) {
      push("error", "weight_not_positive", `criterion ${criterion.id} needs a positive weight`, criterion.id);
    }
    const allowed = ALLOWED[criterion.normalize.kind] as string[] | undefined;
    if (!allowed) {
      // Only reachable from JSON that the type system did not see. Reported
      // rather than thrown: a goal posted with a normalisation nobody
      // implements would otherwise be a 500, or — worse — a search in which
      // every candidate scores 0 and nothing is ever accepted.
      push(
        "error",
        "unknown_normalize",
        `criterion ${criterion.id} uses a normalisation that does not exist: ${String(criterion.normalize.kind)}`,
        criterion.id,
      );
    } else if (!allowed.includes(criterion.direction)) {
      push(
        "error",
        "direction_normalize_mismatch",
        `criterion ${criterion.id}: ${criterion.normalize.kind} normalisation cannot be used `
        + `with ${criterion.direction} — after normalisation larger must be better`,
        criterion.id,
      );
    } else if (!isMonotone(criterion)) {
      // Belt and braces for a table that says a pairing is fine while the
      // implementation disagrees; cheap, and the failure it catches is silent.
      push(
        "error",
        "normalize_not_monotone",
        `the normalisation and direction of criterion ${criterion.id} are not monotone together`,
        criterion.id,
      );
    }
  }

  const weightSum = scorecard.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    push("warning", "weights_not_normalised", `the weights sum to ${weightSum}; they will be scaled to 1`);
  }

  for (const constraint of scorecard.constraints) {
    if (!seen.has(constraint.criterionId)) {
      push(
        "error",
        "constraint_unknown_criterion",
        `veto ${constraint.id} points at criterion ${constraint.criterionId}, which does not exist`,
      );
    }
  }
  if (!scorecard.constraints.length) {
    push("warning", "no_constraints", "no vetoes: any candidate with a higher total is accepted");
  }

  if (!probes) return issues;

  for (const criterion of scorecard.criteria) {
    const raw = probes.baseline[criterion.id];
    if (raw === undefined || !Number.isFinite(raw)) {
      push(
        "error",
        "criterion_unmeasured",
        `criterion ${criterion.id} produced no number on the baseline — a criterion that `
        + "cannot be measured should be removed rather than left as a placeholder",
        criterion.id,
      );
    }
  }

  const baselineViolations = evaluateConstraints(scorecard, probes.baseline, probes.baseline);
  for (const violation of baselineViolations) {
    push(
      "error",
      "baseline_violates_constraint",
      `the baseline itself violates the veto "${violation.detail}": nothing can be accepted `
      + "on the first step, so either loosen the constraint or improve the baseline first",
    );
  }

  if (probes.degraded) {
    const baselineScore = scoreCandidate(scorecard, probes.baseline, probes.baseline).reward;
    const degradedScore = scoreCandidate(scorecard, probes.degraded, probes.baseline).reward;
    if (Math.abs(baselineScore - degradedScore) < 1e-6) {
      push(
        "error",
        "no_discrimination",
        `the card as a whole does not discriminate: the baseline and the damaged sample both `
        + `total ${baselineScore.toFixed(6)}. However sensitive one criterion is, too small a `
        + "weight erases it in the weighted sum — the search wanders a flat landscape and "
        + "never reports an error",
      );
    }
  }

  return issues;
}

export function hasBlockingIssue(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

/** Sample the normalisation at two points and check the ordering matches the
 *  declared direction. */
function isMonotone(criterion: ScorecardCriterion): boolean {
  const [low, high] = sampleRange(criterion.normalize);
  const baseline = (low + high) / 2 || 1;
  const atLow = normalize(criterion, low, baseline);
  const atHigh = normalize(criterion, high, baseline);
  return criterion.direction === "maximize" ? atHigh >= atLow : atHigh <= atLow;
}

function sampleRange(kind: EvolveNormalize): [number, number] {
  if (kind.kind === "clamp") return [kind.lo, kind.hi];
  return [0.25, 0.75];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
