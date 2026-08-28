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

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { EvolveScorecard, ScorecardConstraint, ScorecardCriterion } from "@sciencediscovery/schema";

import {
  aggregate,
  evaluateConstraints,
  hasBlockingIssue,
  normalize,
  normalizedWeights,
  scoreCandidate,
  validateScorecard,
} from "./scorecard.js";

function criterion(overrides: Partial<ScorecardCriterion> = {}): ScorecardCriterion {
  return {
    direction: "maximize",
    id: "f1",
    measure: {
      datasetCas: ["sha256:data"],
      kind: "dataset_metric",
      metric: { direction: "maximize", name: "macro_f1" },
      split: { gateShards: 4, rolloutShards: 4, seed: 0, shardRows: 100, testShards: 4, trainRows: null },
      target: "y",
    },
    name: "macro F1",
    normalize: { kind: "identity" },
    weight: 1,
    ...overrides,
  };
}

function card(
  criteria: ScorecardCriterion[],
  constraints: ScorecardConstraint[] = [],
  overrides: Partial<EvolveScorecard> = {},
): EvolveScorecard {
  return {
    aggregate: "weighted_sum",
    confirmedAt: "2026-08-19T00:00:00.000Z",
    confirmedBy: "tester",
    constraints,
    criteria,
    derivedFrom: { draftRunId: "draft-1", statement: "Push the score up" },
    hash: "sha256:placeholder",
    schemaVersion: 1,
    solvedThreshold: 0.999,
    ...overrides,
  };
}

// --- Normalisation ----------------------------------------------------------

test("every normalisation produces higher-is-better", () => {
  const identity = criterion({ normalize: { kind: "identity" } });
  assert.ok(normalize(identity, 0.8, 0.5) > normalize(identity, 0.6, 0.5));

  const reciprocal = criterion({ direction: "minimize", normalize: { kind: "reciprocal" } });
  assert.ok(normalize(reciprocal, 0.2, 1) > normalize(reciprocal, 2, 1), "smaller RMSE must score higher");

  const relative = criterion({ direction: "minimize", normalize: { kind: "relative_to_baseline" } });
  assert.ok(normalize(relative, 150, 300) > normalize(relative, 400, 300), "faster than baseline scores higher");

  const clampedDown = criterion({ direction: "minimize", normalize: { hi: 10, kind: "clamp", lo: 0 } });
  assert.ok(normalize(clampedDown, 2, 5) > normalize(clampedDown, 8, 5));
});

test("normalisation is bounded and survives junk input", () => {
  const identity = criterion();
  assert.equal(normalize(identity, 4, 0.5), 1, "an out-of-range value clamps rather than escaping [0,1]");
  assert.equal(normalize(identity, -1, 0.5), 0);
  assert.equal(normalize(identity, Number.NaN, 0.5), 0);
  assert.equal(normalize(identity, Number.POSITIVE_INFINITY, 0.5), 0);
});

test("relative_to_baseline reads the baseline it is given, and nothing else", () => {
  const runtime = criterion({ direction: "minimize", id: "runtime", normalize: { kind: "relative_to_baseline" } });
  // Same candidate, two different references: the score must follow the
  // reference, which is exactly why the reference must be frozen to baseline.
  assert.equal(normalize(runtime, 200, 200), 0.5);
  assert.equal(normalize(runtime, 200, 100), 1 / 3);
});

test("beating the baseline keeps improving the score instead of pinning it at 1", () => {
  // The bug this replaced: `clamp01(baseline / raw)` hit its bound the moment a
  // candidate was better, so every improvement tied — and with the default
  // solved threshold the baseline itself scored 1.0 and the search stopped
  // before its first expansion. Seen on a real run: seeded at 1, "succeeded",
  // one candidate, nothing tried.
  const runtime = criterion({ direction: "minimize", id: "runtime", normalize: { kind: "relative_to_baseline" } });
  const scores = [400, 200, 100, 50, 20].map((raw) => normalize(runtime, raw, 200));

  for (let at = 1; at < scores.length; at += 1) {
    assert.ok(scores[at]! > scores[at - 1]!, `${scores[at - 1]} → ${scores[at]}`);
  }
  // Bounded, and never at the bound — so a better candidate always outranks a
  // good one, and nothing is "solved" for being merely better than the start.
  assert.ok(scores.at(-1)! < 1);
});

// --- Aggregation ------------------------------------------------------------

test("weights are used as fractions of their sum", () => {
  const scorecard = card([
    criterion({ id: "a", weight: 3 }),
    criterion({ id: "b", weight: 1 }),
  ]);
  const weights = normalizedWeights(scorecard);
  assert.equal(weights.get("a"), 0.75);
  assert.equal(weights.get("b"), 0.25);
  assert.equal(aggregate(scorecard, { a: 1, b: 0 }), 0.75);
});

test("a geometric mean is dragged to zero by one weak dimension, a sum is not", () => {
  const criteria = [criterion({ id: "a", weight: 0.9 }), criterion({ id: "b", weight: 0.1 })];
  const measurements = { a: 0.9, b: 0 };

  const sum = card(criteria);
  const geomean = card(criteria, [], { aggregate: "weighted_geomean" });

  assert.ok(aggregate(sum, measurements) > 0.8, "a sum lets one dimension pay for another");
  assert.equal(aggregate(geomean, measurements), 0, "a geomean refuses a weak dimension outright");
});

// --- Scoring and constraints ------------------------------------------------

test("a violating candidate keeps its score — the refusal travels beside it", () => {
  const scorecard = card(
    [
      criterion({ id: "f1", weight: 0.7 }),
      criterion({ direction: "minimize", id: "runtime", normalize: { kind: "relative_to_baseline" }, weight: 0.3 }),
    ],
    [{ criterionId: "runtime", id: "too-slow", name: "too slow", op: "<", value: 300 }],
  );
  const baseline = { f1: 0.60, runtime: 200 };

  const fast = scoreCandidate(scorecard, { f1: 0.71, runtime: 180 }, baseline);
  const slow = scoreCandidate(scorecard, { f1: 0.83, runtime: 412 }, baseline);

  assert.equal(fast.violations.length, 0);
  assert.equal(slow.violations.length, 1);
  assert.equal(slow.violations[0]?.constraintId, "too-slow");
  // The whole point: the illegal candidate still outranks the legal one on the
  // scalar the tree reads, so the rank ordering keeps its gradient.
  assert.ok(slow.reward > 0, "a violating candidate is not scored 0");
  assert.ok(slow.criteria.f1! > fast.criteria.f1!);
});

test("a constraint can be stated relative to the baseline", () => {
  const scorecard = card(
    [criterion({ id: "rare_recall" })],
    [{ criterionId: "rare_recall", id: "no-sacrifice", name: "sacrificing the rare class", op: ">=", value: { relativeToBaseline: 0.8 } }],
  );
  const baseline = { rare_recall: 0.50 };

  assert.equal(evaluateConstraints(scorecard, { rare_recall: 0.45 }, baseline).length, 0, "0.45 >= 0.4");
  assert.equal(evaluateConstraints(scorecard, { rare_recall: 0.32 }, baseline).length, 1, "0.32 < 0.4");
});

test("an unmeasured criterion neither violates nor silently passes", () => {
  const scorecard = card(
    [criterion({ id: "runtime" })],
    [{ criterionId: "runtime", id: "too-slow", name: "too slow", op: "<", value: 300 }],
  );
  // No number means unknown: the constraint cannot fire, and validation is what
  // refuses to start such a run in the first place.
  assert.equal(evaluateConstraints(scorecard, {}, {}).length, 0);
  assert.ok(hasBlockingIssue(validateScorecard(scorecard, { baseline: {} })));
});

// --- Freezing ---------------------------------------------------------------


// --- Validation -------------------------------------------------------------

function codes(scorecard: EvolveScorecard, probes?: Parameters<typeof validateScorecard>[1]): string[] {
  return validateScorecard(scorecard, probes).map((issue) => issue.code);
}

test("a direction the normalisation cannot express is refused", () => {
  // identity + minimize would mean "bigger is better" for a quantity the user
  // wants small — the search would optimise the wrong way and never say so.
  assert.ok(codes(card([criterion({ direction: "minimize" })])).includes("direction_normalize_mismatch"));
  assert.ok(codes(card([criterion({ normalize: { kind: "reciprocal" } })])).includes("direction_normalize_mismatch"));
  assert.ok(
    codes(card([criterion({ normalize: { kind: "relative_to_baseline" } })])).includes("direction_normalize_mismatch"),
    "relative_to_baseline is minimise-only: raw/baseline would cap every improvement at 1.0",
  );
  assert.equal(codes(card([criterion()])).includes("direction_normalize_mismatch"), false);
});

test("structural problems are reported before anything is measured", () => {
  assert.ok(codes(card([])).includes("empty_criteria"));
  assert.ok(codes(card([criterion({ id: "a" }), criterion({ id: "a" })])).includes("duplicate_criterion_id"));
  assert.ok(codes(card([criterion({ weight: 0 })])).includes("weight_not_positive"));
  assert.ok(codes(card([criterion()], [
    { criterionId: "missing", id: "c", name: "c", op: "<", value: 1 },
  ])).includes("constraint_unknown_criterion"));
});

test("weights that do not sum to 1 are a warning, not a refusal", () => {
  const issues = validateScorecard(card([criterion({ id: "a", weight: 3 }), criterion({ id: "b", weight: 1 })]));
  const weightIssue = issues.find((issue) => issue.code === "weights_not_normalised");
  assert.equal(weightIssue?.severity, "warning");
  assert.equal(hasBlockingIssue(issues.filter((issue) => issue.code === "weights_not_normalised")), false);
});

test("a criterion that cannot be measured on the baseline blocks the run", () => {
  const scorecard = card([criterion({ id: "f1" }), criterion({ id: "rare_recall" })]);
  const issues = validateScorecard(scorecard, { baseline: { f1: 0.6 } });
  const missing = issues.find((issue) => issue.code === "criterion_unmeasured");
  assert.equal(missing?.criterionId, "rare_recall");
  assert.equal(missing?.severity, "error");
});

test("a baseline that already violates a constraint blocks the run", () => {
  // The most common configuration error: the gate is set stricter than today's
  // reality, so the search can never accept anything and burns the whole budget.
  const scorecard = card(
    [criterion({ direction: "minimize", id: "runtime", normalize: { kind: "relative_to_baseline" } })],
    [{ criterionId: "runtime", id: "too-slow", name: "too slow", op: "<", value: 60 }],
  );
  const issues = validateScorecard(scorecard, { baseline: { runtime: 90 } });
  const blocked = issues.find((issue) => issue.code === "baseline_violates_constraint");
  assert.equal(blocked?.severity, "error");
  assert.match(blocked?.message ?? "", /loosen the constraint or improve the baseline/);
});

test("a card that cannot separate the baseline from a worse variant blocks the run", () => {
  // Single sensitive criterion, but weighted so low that the total cannot tell
  // the two apart. Nothing downstream would ever report this.
  const scorecard = card([
    criterion({ id: "f1", weight: 0.999 }),
    criterion({ id: "rare_recall", weight: 0.001 }),
  ]);
  const issues = validateScorecard(scorecard, {
    baseline: { f1: 0.6, rare_recall: 0.5 },
    degraded: { f1: 0.6, rare_recall: 0.5 - 1e-9 },
  });
  const flat = issues.find((issue) => issue.code === "no_discrimination");
  assert.equal(flat?.severity, "error");
});

test("a card with real discrimination passes", () => {
  const scorecard = card(
    [
      criterion({ id: "f1", weight: 0.7 }),
      criterion({ direction: "minimize", id: "runtime", normalize: { kind: "relative_to_baseline" }, weight: 0.3 }),
    ],
    [{ criterionId: "runtime", id: "too-slow", name: "too slow", op: "<", value: 300 }],
  );
  const issues = validateScorecard(scorecard, {
    baseline: { f1: 0.60, runtime: 200 },
    degraded: { f1: 0.41, runtime: 260 },
  });
  assert.equal(hasBlockingIssue(issues), false, JSON.stringify(issues));
});

// --- Measurement cache ------------------------------------------------------

test("this implementation still matches the fixture the sidecar asserts against", async () => {
  // The same formulas exist in Python, where the run is actually scored. A
  // shared fixture makes a divergence a failing test rather than two answers to
  // "what is this candidate worth" — the wizard would then preview a number the
  // search does not use.
  const { readFile } = await import("node:fs/promises");
  // Relative to this file, not to `process.cwd()`: the suite is run both from
  // the repo root and from the package directory.
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "../../../../packages/schema/fixtures/scorecard-golden.json");
  const golden = JSON.parse(await readFile(path, "utf8")) as {
    cases: Array<{
      baseline: Record<string, number>;
      expected: { criteria: Record<string, number>; reward: number; violations: string[] };
      name: string;
      raw: Record<string, number>;
      scorecard: EvolveScorecard;
    }>;
  };

  assert.ok(golden.cases.length >= 10, "the fixture must keep covering every normalisation");
  for (const item of golden.cases) {
    const result = scoreCandidate(item.scorecard, item.raw, item.baseline);
    assert.ok(
      Math.abs(result.reward - item.expected.reward) < 1e-9,
      `${item.name}: reward ${result.reward} !== ${item.expected.reward}`,
    );
    assert.deepEqual(
      result.violations.map((violation) => violation.constraintId).sort(),
      item.expected.violations,
      item.name,
    );
  }
});

test("a normalisation nobody implements is an error, not a crash", () => {
  // Reachable from JSON the type system never saw — a goal posted over HTTP.
  // Left unhandled this is a 500; left unvalidated it is a search in which
  // every candidate scores 0 and nothing is ever accepted.
  const broken = card([criterion({ normalize: { kind: "linear" } as never })]);

  const issues = validateScorecard(broken);
  assert.ok(issues.some((issue) => issue.code === "unknown_normalize" && issue.severity === "error"));
  assert.equal(hasBlockingIssue(issues), true);
});
