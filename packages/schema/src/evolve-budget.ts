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
 * The numbers an evolution run is sized against, in one place.
 *
 * These are limits and defaults, not a coercion: `create_evolve_run`'s schema
 * states an expansion count of 1–40 and a worker count of 1–8, pre-flight
 * refuses a count outside those bounds (or a worker count that does not divide
 * the expansions), and the proposal path writes the run's own token and time
 * caps from the defaults here. The desktop create dialog has to *state* these
 * rules before a run exists (#1346), so both sides read this module instead of
 * keeping a copy each — the copies drifting apart is how a dialog ends up
 * describing a limit the server does not have.
 */

import type { EvolveAlgorithm } from "./evolution.js";
import type { ModelThinkingMode } from "./model-usage.js";

/** The search size the engine accepts. `expansions` is the number of mutation
 *  calls; `workers` is how many of them run at once. */
export const EVOLVE_EXPANSIONS_MIN = 1;
export const EVOLVE_EXPANSIONS_MAX = 40;
export const EVOLVE_WORKERS_MIN = 1;
export const EVOLVE_WORKERS_MAX = 8;

/**
 * Each wave picks this many parents per worker, so fewer expansions than
 * `4 × workers` spends the first wave forking only the root and leaves the tree
 * flat; pre-flight refuses it rather than starting a search that cannot grow.
 */
export const EVOLVE_EXPANSIONS_PER_WORKER = 4;

/** The run's own caps. A per-call ceiling caps one call; these cap the search. */
export const EVOLVE_MAX_TOKENS = 600_000;
export const EVOLVE_MAX_SECONDS = 7_200;

/** One candidate's measurement is killed after this long; written by the
 *  proposal path and not settable from a run proposal. */
export const EVOLVE_CANDIDATE_TIMEOUT_SECONDS = 180;

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
export const EVOLVE_MIN_TOKENS_PER_CALL: Record<string, { thinking: number; quiet: number }> = {
  puct: { quiet: 8_000, thinking: 96_000 },
  // OpenEvolve rewrites the whole genome rather than editing it.
  openevolve: { quiet: 16_000, thinking: 128_000 },
};

/**
 * The ceiling a proposal gets when it does not name one.
 *
 * Deliberately the same for both algorithms: this is a working ceiling, not the
 * floor, and the floor only has to be at most this. The one exception is a
 * reasoning model, where the ceiling has to clear the algorithm's thinking
 * floor or every call is cut off before its first content token.
 */
export const EVOLVE_QUIET_TOKENS_PER_CALL = 16_000;

/** The per-call ceiling `create_evolve_run` will apply, from the setting the
 *  run will actually record. */
export function evolvePerCallCeiling(algorithm: EvolveAlgorithm, thinking: ModelThinkingMode): number {
  if (thinking === "disabled") return EVOLVE_QUIET_TOKENS_PER_CALL;
  return (EVOLVE_MIN_TOKENS_PER_CALL[algorithm] ?? EVOLVE_MIN_TOKENS_PER_CALL.puct!).thinking;
}

/** The ceilings a run can be budgeted at, one per algorithm, with thinking on:
 *  the numbers the dialog has to name when it says the ceiling is not settable. */
export const EVOLVE_THINKING_CEILINGS: Record<EvolveAlgorithm, number> = {
  openevolve: EVOLVE_MIN_TOKENS_PER_CALL.openevolve!.thinking,
  puct: EVOLVE_MIN_TOKENS_PER_CALL.puct!.thinking,
};

/**
 * How many expansions a per-call ceiling leaves room for inside the run's total
 * token cap — the `maxTokensPerCall × expansions <= maxTokens` arithmetic the
 * design conversation is told to check at checkpoint 3 before it spends money.
 *
 * This is planning arithmetic, not a server rule: the server does not rewrite
 * an expansion count, it stops the run with `budget_exhausted` once the total
 * cap is gone. With the defaults, thinking off leaves `600000 / 16000 = 37`
 * whole expansions; a thinking run leaves 6 (PUCT, 96000) or 4 (OpenEvolve,
 * 128000). The figure is derived, never hard-coded, so it follows whichever
 * ceiling the run ends up with.
 */
export function evolveExpansionCeiling(perCallCeiling: number, maxTokens: number = EVOLVE_MAX_TOKENS): number {
  if (!Number.isFinite(perCallCeiling) || perCallCeiling <= 0) return EVOLVE_EXPANSIONS_MAX;
  return Math.max(0, Math.min(EVOLVE_EXPANSIONS_MAX, Math.floor(maxTokens / perCallCeiling)));
}

/** The run-budget fields a design conversation's proposal names. */
export type EvolveBudgetField = "expansions" | "maxSeconds" | "maxTokens" | "maxTokensPerCall" | "workers";

/** How the dialog describes one budget field, without any wording. */
export interface EvolveBudgetFieldLimit {
  /** A value every run gets from the server; the dialog cannot set it. */
  fixed?: number;
  /** The run chooses this from its algorithm and thinking setting, so it has no
   *  single number to show until the design conversation names one. */
  dependsOnRun?: boolean;
  /** Inclusive bounds for a field the user can set. */
  max?: number;
  min?: number;
  /** The granularity the engine accepts: whole numbers, counted in `unit`. */
  step: number;
  unit: "count" | "seconds" | "tokens";
}

export const EVOLVE_BUDGET_FIELD_LIMITS: Record<EvolveBudgetField, EvolveBudgetFieldLimit> = {
  expansions: { max: EVOLVE_EXPANSIONS_MAX, min: EVOLVE_EXPANSIONS_MIN, step: 1, unit: "count" },
  maxSeconds: { fixed: EVOLVE_MAX_SECONDS, step: 1, unit: "seconds" },
  maxTokens: { fixed: EVOLVE_MAX_TOKENS, step: 1, unit: "tokens" },
  maxTokensPerCall: { dependsOnRun: true, step: 1, unit: "tokens" },
  workers: { max: EVOLVE_WORKERS_MAX, min: EVOLVE_WORKERS_MIN, step: 1, unit: "count" },
};

/** The run-budget field a parameter name happens to match, if any. */
export function evolveBudgetField(name: string): EvolveBudgetField | undefined {
  const trimmed = name.trim();
  return Object.prototype.hasOwnProperty.call(EVOLVE_BUDGET_FIELD_LIMITS, trimmed)
    ? trimmed as EvolveBudgetField
    : undefined;
}
