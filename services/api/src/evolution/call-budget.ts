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
 * What one mutation call is allowed to spend, in one place.
 *
 * Two callers have to agree: the proposal path writes the ceiling, and
 * pre-flight refuses a ceiling below the floor. They disagreed once — the
 * proposal path wrote 96k for every algorithm while pre-flight demanded 128k
 * for OpenEvolve, so asking for thinking on an OpenEvolve run was refused by
 * the default the path had just written itself. Sharing the table is what
 * makes "what a run gets" and "what a run needs" the same number.
 */

import type { EvolveAlgorithm, EvolveBudgetPlan, ModelProfile } from "@sciencediscovery/schema";

import { endpointCanDisableThinking } from "./model-thinking.js";

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
export const MIN_TOKENS_PER_CALL: Record<string, { thinking: number; quiet: number }> = {
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
export const QUIET_TOKENS_PER_CALL = 16_000;

/** The run's own caps. A per-call ceiling caps one call; these cap the search. */
export const DEFAULT_MAX_TOKENS = 600_000;
export const DEFAULT_MAX_SECONDS = 7_200;

/** The per-call ceiling `create_evolve_run` will apply, from the setting the
 *  run will actually record. */
export function perCallCeiling(algorithm: EvolveAlgorithm, thinking: "enabled" | "disabled"): number {
  if (thinking === "disabled") return QUIET_TOKENS_PER_CALL;
  return (MIN_TOKENS_PER_CALL[algorithm] ?? MIN_TOKENS_PER_CALL.puct!).thinking;
}

/**
 * What a run on this model would be budgeted at, read *before* the checkpoint
 * that asks the user to spend.
 *
 * The agent designs the run and shows the user its shape, and the shape is only
 * honest if it carries the numbers: a per-call ceiling multiplied by the
 * expansion count is what decides whether the search can finish, and on an
 * endpoint that cannot turn thinking off that ceiling is the reason, not a
 * detail. Returns the numbers `create_evolve_run` will apply rather than a
 * second opinion about them.
 */
export function describeEvolveBudget(
  model: ModelProfile | undefined,
  requestedThinking: "enabled" | "disabled" = "disabled",
): EvolveBudgetPlan {
  const effective = requestedThinking === "disabled" && !endpointCanDisableThinking(model)
    ? "enabled"
    : requestedThinking;
  return {
    maxSeconds: DEFAULT_MAX_SECONDS,
    model: model?.name ?? null,
    perCallCeiling: {
      openevolve: perCallCeiling("openevolve", effective),
      puct: perCallCeiling("puct", effective),
    },
    thinking: effective === requestedThinking
      ? { effective }
      : {
        effective,
        note: "this endpoint's API variant has no thinking-control field, so "
          + "\"thinking off\" is accepted and ignored; the run budgets for reasoning",
      },
    totalTokenCap: DEFAULT_MAX_TOKENS,
  };
}
