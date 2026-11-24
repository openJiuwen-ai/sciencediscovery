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

import {
  EVOLVE_MAX_SECONDS,
  EVOLVE_MAX_TOKENS,
  EVOLVE_MIN_TOKENS_PER_CALL,
  EVOLVE_QUIET_TOKENS_PER_CALL,
  evolvePerCallCeiling,
  type EvolveBudgetPlan,
  type ModelProfile,
  type ModelThinkingEffort,
  type ModelThinkingMode,
} from "@sciencediscovery/schema";

import { thinkingControlGap, type ThinkingControlGap } from "./model-thinking.js";

/**
 * The table lives in `@sciencediscovery/schema` because the create dialog has
 * to show the same numbers before a run exists; these names are kept for the
 * callers here and carry the meaning they always did.
 *
 * Floor for one mutation call, which depends on the *thinking* setting far more
 * than on the algorithm — measured on GLM5.2, see the table's own comment.
 */
export const MIN_TOKENS_PER_CALL = EVOLVE_MIN_TOKENS_PER_CALL;

/** The ceiling a proposal gets when it does not name one. */
export const QUIET_TOKENS_PER_CALL = EVOLVE_QUIET_TOKENS_PER_CALL;

/** The run's own caps. A per-call ceiling caps one call; these cap the search. */
export const DEFAULT_MAX_TOKENS = EVOLVE_MAX_TOKENS;
export const DEFAULT_MAX_SECONDS = EVOLVE_MAX_SECONDS;

/** The per-call ceiling `create_evolve_run` will apply, from the setting the
 *  run will actually record. */
export const perCallCeiling = evolvePerCallCeiling;

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
/** What to tell the user when "thinking off" cannot be honored, by cause. */
const UNHONORED: Record<ThinkingControlGap, string> = {
  "declared-unsupported": "this model is recorded as not honoring thinking control, so "
    + "\"thinking off\" cannot be relied on; the run budgets for reasoning",
  "model-unsupported": "this model is recorded without thinking control, so "
    + "\"thinking off\" cannot be relied on; the run budgets for reasoning",
  "no-control-field": "this endpoint's API variant has no thinking-control field, so "
    + "\"thinking off\" is accepted and ignored; the run budgets for reasoning",
  "no-disabled-mode": "this endpoint's API variant exposes a thinking control but no "
    + "\"disabled\" mode, so the run cannot turn thinking off; it budgets for reasoning",
};

export function describeEvolveBudget(
  model: ModelProfile | undefined,
  requestedThinking: ModelThinkingMode = "auto",
  thinkingEffort?: ModelThinkingEffort,
): EvolveBudgetPlan {
  const gap = requestedThinking === "disabled" ? thinkingControlGap(model) : undefined;
  const effective = gap ? "enabled" : requestedThinking;
  // Keep the effort in the frozen run settings even when mode is `auto`: the
  // parent Run has a complete, auditable configuration and switching to
  // `enabled` later must use the same fallback. The sidecar omits the effort
  // on the wire while `auto` is active, so this does not override the
  // provider's own automatic mode.
  const effort = effective === "disabled" ? undefined : thinkingEffort ?? "high";
  return {
    maxSeconds: DEFAULT_MAX_SECONDS,
    model: model?.name ?? null,
    perCallCeiling: {
      openevolve: perCallCeiling("openevolve", effective),
      puct: perCallCeiling("puct", effective),
    },
    thinking: gap
      ? { effective, ...(effort ? { effort } : {}), note: UNHONORED[gap] }
      : { effective, ...(effort ? { effort } : {}) },
    totalTokenCap: DEFAULT_MAX_TOKENS,
  };
}
