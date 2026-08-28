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
 * What has to be true before a search is allowed to start.
 *
 * The engine will not stop any of this for you. It warns on an empty reply and
 * moves on — and an empty reply becomes a failed node, which is
 * **indistinguishable from a candidate that genuinely would not run**. So every
 * check here exists because its failure mode is silent, expensive, or both: a
 * run that cannot possibly accept anything still costs a full budget of model
 * calls before anyone notices.
 *
 * Refusals happen at creation, not at the first expansion. A user who has
 * watched a progress bar for a minute has already paid for the mistake.
 */

import type { EvolveGoal, ModelProfile } from "@sciencediscovery/schema";

import { casHash, needsData, validateSplit } from "./dataset.js";
import { hasBlockingIssue, validateScorecard } from "./scorecard.js";
import type { EvolveSandboxCapability } from "./sandbox.js";

export interface PreflightIssue {
  code: string;
  /** What the user should change. A refusal without one is a dead end. */
  fix: string;
  message: string;
}

export interface PreflightInput {
  /** Whether a content hash is in the store. Absent skips the dataset checks —
   *  a caller with no content store cannot answer, and guessing "missing" would
   *  refuse every run. */
  casHas?: (hash: string) => Promise<boolean>;
  goal: EvolveGoal;
  model: ModelProfile | undefined;
  sandbox: EvolveSandboxCapability;
}

/**
 * Floor for one mutation call, which depends on the *thinking* setting far more
 * than on the algorithm.
 *
 * Measured, not guessed, on GLM5.2 rewriting a small program:
 *
 * * thinking on, 16k ceiling: 16001 output tokens, **no content at all**, six
 *   expansions in a row — every one recorded as a candidate that would not run.
 * * thinking on, 64k ceiling: 11k–64k per call, and **two of eight still hit
 *   the cap**. So 64k is not comfortable either.
 * * thinking off: ~1.2k per call.
 *
 * Hence the two columns. With thinking on the budget must hold the reasoning
 * *and* the program, and the observed spread says six figures; with it off, a
 * few thousand is plenty and demanding more would refuse runs that work.
 */
const MIN_TOKENS_PER_CALL: Record<string, { thinking: number; quiet: number }> = {
  puct: { quiet: 8_000, thinking: 96_000 },
  // OpenEvolve rewrites the whole genome rather than editing it.
  openevolve: { quiet: 16_000, thinking: 128_000 },
};

/** Below this the held-out set is too small for the acceptance gate to say
 *  anything: four shards is the floor the split design settles on. */
//: The gate is what a node's score is measured on, so it is the split that has
//: to be largest and the one with the highest floor. Kept in step with
//: `MIN_GATE` in proposal.ts — the proposal path refuses first, this catches a
//: goal that arrived any other way.
const MIN_GATE_SHARDS = 8;

export async function preflight(input: PreflightInput): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  const { budget } = input.goal;

  // --- the model can actually be called -------------------------------------

  if (!input.model) {
    issues.push({
      code: "model_missing",
      fix: "pick a model that is already configured",
      message: "the model this search names does not exist",
    });
  } else if (!input.model.hasApiToken) {
    issues.push({
      code: "model_no_token",
      fix: `save an API token for ${input.model.name} in the model settings`,
      message: `${input.model.name} has no API token, so every mutation call would fail`,
    });
  }

  const floors = MIN_TOKENS_PER_CALL[input.goal.algorithm] ?? MIN_TOKENS_PER_CALL.puct!;
  const quiet = input.goal.thinking === "disabled";
  const floor = quiet ? floors.quiet : floors.thinking;
  if (budget.maxTokensPerCall < floor) {
    issues.push({
      code: "max_tokens_too_low",
      fix: quiet
        ? `raise the per-call ceiling above ${floor}`
        : `raise the per-call ceiling above ${floor}, or turn thinking off (which lowers the floor to ${floors.quiet})`,
      // The failure is silent: the reply comes back empty, the node is recorded
      // as failed, and the run looks like a search that could not find anything.
      message: `the per-call ceiling ${budget.maxTokensPerCall} is below the ${floor} floor `
        + `for ${input.goal.algorithm}${quiet ? "" : " with thinking on"}; `
        + "the model spends the budget on hidden thinking and returns an empty reply, "
        + "and an empty reply is recorded as a failed candidate",
    });
  }

  // --- the budget describes a search that can actually run -------------------

  if (budget.workers < 1) {
    issues.push({
      code: "workers_invalid",
      fix: "use at least 1 worker",
      message: "the worker count must be a positive integer",
    });
  } else if (budget.expansions % budget.workers !== 0) {
    issues.push({
      code: "expansions_not_divisible",
      fix: `make the expansion count a multiple of ${budget.workers}`,
      message: `${budget.expansions} expansions does not divide evenly by ${budget.workers} workers; `
        + "the engine dispatches whole waves (each wave picks that many parents, and only "
        + "the next wave sees what landed), so the remainder leaves the last wave short",
    });
  }
  if (budget.expansions < 1) {
    issues.push({
      code: "expansions_invalid",
      fix: "use at least 1 expansion",
      message: "the expansion count must be a positive integer",
    });
  }

  // --- the isolation exists -------------------------------------------------

  // A judged scorecard executes nothing — the candidate is text and a model
  // reads it — so requiring isolation there would refuse a run that never runs
  // anything, which is the opposite of what the refusal is for.
  const executes = input.goal.scorecard.criteria.some(
    (criterion) => criterion.measure.kind !== "llm_judge",
  );
  if (executes && !input.sandbox.backend) {
    issues.push({
      code: "sandbox_unavailable",
      fix: "install bubblewrap (bwrap) on Linux; macOS ships sandbox-exec",
      // Not a portability concession: a candidate is model-written Python that
      // gets executed, and running it unconfined is not a fallback.
      message: "there is no isolation backend for candidates, and a candidate is model-written "
        + "code that will not be executed unisolated",
    });
  }

  // --- the scorecard can decide anything ------------------------------------

  const scorecardIssues = validateScorecard(input.goal.scorecard);
  for (const issue of scorecardIssues) {
    if (issue.severity !== "error") continue;
    issues.push({
      code: `scorecard_${issue.code}`,
      fix: "fix the scorecard and try again",
      message: issue.message,
    });
  }

  for (const criterion of input.goal.scorecard.criteria) {
    const measure = criterion.measure;
    if (measure.kind !== "dataset_metric" && measure.kind !== "custom_script" && measure.kind !== "llm_judge") continue;
    if (measure.split.gateShards >= MIN_GATE_SHARDS) continue;
    issues.push({
      code: "gate_shards_too_few",
      fix: `raise the gate shard count above ${MIN_GATE_SHARDS}`,
      message: `criterion "${criterion.name}" has only ${measure.split.gateShards} gate shards; `
        + "the acceptance gate reads exactly those, and too few cannot tell an improvement "
        + "from noise",
    });
  }

  // --- a judged scorecard's own five requirements ----------------------------

  for (const criterion of input.goal.scorecard.criteria) {
    if (criterion.measure.kind !== "llm_judge") continue;
    const measure = criterion.measure;

    if (!measure.judgeModelId) {
      issues.push({
        code: "judge_model_missing",
        fix: "pick a model to grade with",
        message: `criterion "${criterion.name}" is graded by a model, but names no judge model`,
      });
    }
    if (!measure.rubricCas) {
      issues.push({
        code: "rubric_missing",
        fix: "write a rubric and save it",
        message: `criterion "${criterion.name}" has no rubric, so the judge has nothing to grade against`,
      });
    }
    if (input.goal.scorecard.solvedThreshold >= 0.999) {
      // At the default a graded scorer never counts as solved, so every rollout
      // asks for a proposal and the run reports `below-threshold` — which reads
      // as the reflector failing when nothing was ever counted as done.
      issues.push({
        code: "solved_threshold_too_high",
        fix: "0.85 is the suggested solved threshold for model grading",
        message: "a graded score rarely reaches 0.999, and at the default every rollout asks for "
          + "a proposal",
      });
    }
    if (!input.goal.frozen.includes(measure.rubricCas)) {
      // A search that can rewrite its own marking scheme learns to do that
      // instead of getting better.
      issues.push({
        code: "rubric_not_frozen",
        fix: "add the rubric to frozen",
        message: "the rubric must be frozen, or the search can rewrite what marks it instead of "
          + "getting better",
      });
    }
  }

  // --- a scripted scorecard's own two requirements ---------------------------

  for (const criterion of input.goal.scorecard.criteria) {
    if (criterion.measure.kind !== "custom_script") continue;
    const measure = criterion.measure;

    if (!measure.scriptCas) {
      issues.push({
        code: "script_missing",
        fix: "have the model write an evaluator, or pick a different scoring mode",
        message: `criterion "${criterion.name}" says it is scored by an evaluator script, but there is none`,
      });
    } else if (!input.goal.frozen.includes(measure.scriptCas)) {
      // Same rule as the rubric, for the same reason: a candidate is executed,
      // and a search that can rewrite what measures it learns to do that
      // instead of getting better.
      issues.push({
        code: "script_not_frozen",
        fix: "add the evaluator to frozen",
        message: "the evaluator must be frozen, or the search can rewrite what measures it instead "
          + "of getting better",
      });
    }
  }

  // --- a test-gated scorecard's own requirements -----------------------------

  for (const criterion of input.goal.scorecard.criteria) {
    if (criterion.measure.kind !== "test_gate") continue;
    const measure = criterion.measure;

    if (!measure.testCmd.length) {
      issues.push({
        code: "test_cmd_missing",
        fix: "give a command that runs this project's tests",
        message: `criterion "${criterion.name}" has no test command, so there is nothing to score with`,
      });
    }
    if (!measure.frozen.length) {
      // Upstream's own note: without it the shortest path to a high score is to
      // weaken the thing measuring it.
      issues.push({
        code: "tests_not_frozen",
        fix: "put the test paths in frozen, tests/** for instance",
        message: "test-gated scoring must freeze the test files, or the shortest path to a higher "
          + "score is to weaken the tests",
      });
    }
    if (measure.caseSplit.gateGroups < 4) {
      issues.push({
        code: "gate_groups_too_few",
        fix: "raise the hold-out groups above 4",
        message: `only ${measure.caseSplit.gateGroups} hold-out groups cannot tell an improvement from noise`,
      });
    }
    if (measure.caseSplit.rolloutGroups < 1) {
      issues.push({
        code: "rollout_groups_too_few",
        fix: "there must be at least 1 rollout group",
        message: "with no rollout groups the search has no score to rank by",
      });
    }
  }

  // --- the data the scorecard names actually exists --------------------------

  for (const criterion of input.goal.scorecard.criteria) {
    if (!needsData(criterion)) continue;
    const measure = criterion.measure as Extract<typeof criterion.measure, { kind: "dataset_metric" }>;
    if (measure.datasetCas.length === 0) {
      issues.push({
        code: "dataset_missing",
        fix: "point this criterion at a dataset: dataset_metric needs a datasetPath",
        message: `criterion "${criterion.name}" names no dataset, so there is nothing to measure on`,
      });
      continue;
    }
    if (input.casHas) {
      for (const ref of measure.datasetCas) {
        if (await input.casHas(casHash(ref))) continue;
        issues.push({
          code: "dataset_not_in_store",
          fix: "upload the dataset again, or use one that is still in the store",
          message: `criterion "${criterion.name}" references dataset ${ref}, which is not in the content store`,
        });
      }
    }
    if (!measure.target) {
      issues.push({
        code: "target_column_missing",
        fix: "say which column the candidate predicts",
        message: `criterion "${criterion.name}" does not say which column to predict`,
      });
    }
    // The arithmetic, without the data. Whether *this* dataset has enough rows
    // needs the dataset, and that check stays at staging where the rows are.
    const impossible = validateSplit(measure.split);
    if (impossible) {
      issues.push({
        code: "split_impossible",
        fix: "adjust the shard count and the rows per shard",
        message: `the split for criterion "${criterion.name}" does not hold up: ${impossible}`,
      });
    }
  }

  return issues;
}

/** Whether the scorecard's own structural checks passed. Exposed so the wizard
 *  can show them before the run request is even built. */
export { hasBlockingIssue };
