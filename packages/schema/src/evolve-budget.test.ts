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
import { test } from "node:test";

import {
  EVOLVE_BUDGET_FIELD_LIMITS,
  EVOLVE_MAX_SECONDS,
  EVOLVE_MAX_TOKENS,
  EVOLVE_QUIET_TOKENS_PER_CALL,
  EVOLVE_THINKING_CEILINGS,
  evolveBudgetField,
  evolveExpansionCeiling,
  evolvePerCallCeiling,
} from "./evolve-budget.js";

test("the run limits the dialog states are the ones the server applies", () => {
  // The dialog reads this table instead of writing 40 / 8 / 7200 / 600000 of
  // its own. Expansions/workers are the create_evolve_run argument bounds;
  // the caps below are the defaults the proposal path writes for every run.
  assert.equal(EVOLVE_BUDGET_FIELD_LIMITS.expansions.min, 1);
  assert.equal(EVOLVE_BUDGET_FIELD_LIMITS.expansions.max, 40);
  assert.equal(EVOLVE_BUDGET_FIELD_LIMITS.expansions.step, 1);
  assert.equal(EVOLVE_BUDGET_FIELD_LIMITS.workers.min, 1);
  assert.equal(EVOLVE_BUDGET_FIELD_LIMITS.workers.max, 8);
  assert.equal(EVOLVE_BUDGET_FIELD_LIMITS.maxSeconds.fixed, EVOLVE_MAX_SECONDS);
  assert.equal(EVOLVE_BUDGET_FIELD_LIMITS.maxSeconds.fixed, 7_200);
  assert.equal(EVOLVE_BUDGET_FIELD_LIMITS.maxTokens.fixed, EVOLVE_MAX_TOKENS);
  assert.equal(EVOLVE_BUDGET_FIELD_LIMITS.maxTokens.fixed, 600_000);
  // A per-call ceiling follows the run's algorithm and thinking setting, so it
  // has no single number until the design conversation names one.
  assert.equal(EVOLVE_BUDGET_FIELD_LIMITS.maxTokensPerCall.dependsOnRun, true);
});

test("each per-call ceiling leaves a different number of whole expansions", () => {
  // 16000 × 37 <= 600000, so thinking off leaves 37 whole expansions of the 40
  // the tool accepts; a thinking run leaves 6 (PUCT) or 4 (OpenEvolve). These
  // are planning figures for the dialog, derived rather than hard-coded.
  assert.equal(evolvePerCallCeiling("puct", "disabled"), EVOLVE_QUIET_TOKENS_PER_CALL);
  assert.equal(evolveExpansionCeiling(EVOLVE_QUIET_TOKENS_PER_CALL), 37);
  assert.equal(evolvePerCallCeiling("puct", "enabled"), 96_000);
  assert.equal(evolveExpansionCeiling(EVOLVE_THINKING_CEILINGS.puct), 6);
  assert.equal(evolvePerCallCeiling("openevolve", "enabled"), 128_000);
  assert.equal(evolveExpansionCeiling(EVOLVE_THINKING_CEILINGS.openevolve), 4);
  // The tool's own bound still holds whatever the arithmetic says.
  assert.equal(evolveExpansionCeiling(1_000), 40);
  // 40 expansions cost 640000 tokens at the quiet ceiling: more than the total.
  assert.equal(EVOLVE_QUIET_TOKENS_PER_CALL * 40 > EVOLVE_MAX_TOKENS, true);
  assert.equal(EVOLVE_QUIET_TOKENS_PER_CALL * 37 <= EVOLVE_MAX_TOKENS, true);
});

test("only a run-budget name gets the reference hint", () => {
  assert.equal(evolveBudgetField("expansions"), "expansions");
  assert.equal(evolveBudgetField(" maxSeconds "), "maxSeconds");
  assert.equal(evolveBudgetField("workers"), "workers");
  // A program field that merely contains a budget word keeps the generic
  // editor: the panel must not invent limits for it.
  assert.equal(evolveBudgetField("max_tokens"), undefined);
  assert.equal(evolveBudgetField("expansionsPerWave"), undefined);
  assert.equal(evolveBudgetField(""), undefined);
  assert.equal(evolveBudgetField("toString"), undefined);
});
