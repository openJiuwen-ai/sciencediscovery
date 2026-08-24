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
 * The checks that stop a run which could never have worked.
 *
 * Each one is here because its failure mode is silent or expensive: the engine
 * warns and carries on, so a misconfigured search spends its whole budget
 * before anyone can tell it apart from a search that simply found nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvolveGoal, ModelProfile, ScorecardCriterion } from "@sciencediscovery/schema";

import { preflight } from "./preflight.js";
import type { EvolveSandboxCapability } from "./sandbox.js";

const SANDBOX: EvolveSandboxCapability = {
  backend: "bwrap", bwrapPath: "bwrap", disableUserns: false, procMode: "proc",
};

const MODEL: ModelProfile = {
  baseUrl: "http://127.0.0.1:1", createdAt: "", hasApiToken: true, id: "model-1",
  model: "glm-5.2", name: "GLM", proxyPolicy: "inherit" as never, updatedAt: "", vision: false,
};

function goal(overrides: Partial<EvolveGoal> = {}): EvolveGoal {
  return {
    algorithm: "era",
    baselineProgramCas: "sha256:baseline",
    budget: {
      candidateTimeoutSeconds: 60, expansions: 6, maxCostCents: 500,
      maxSeconds: 1800, maxTokens: 200_000, maxTokensPerCall: 96_000, workers: 1,
    },
    frozen: [],
    modelId: "model-1",
    scorecard: {
      aggregate: "weighted_sum",
      confirmedAt: "", confirmedBy: "", constraints: [],
      criteria: [{
        direction: "maximize", id: "f1",
        measure: {
          datasetCas: ["sha256:data"], kind: "dataset_metric",
          metric: { direction: "maximize", name: "f1" },
          split: { gateShards: 4, rolloutShards: 4, seed: 0, shardRows: 10, testShards: 4, trainRows: null },
          target: "y",
        },
        name: "宏 F1", normalize: { kind: "identity" }, weight: 1,
      }],
      derivedFrom: { draftRunId: "", statement: "" },
      hash: "sha256:card", schemaVersion: 1, solvedThreshold: 0.999,
    },
    schemaVersion: 2,
    statement: "把分数做上去",
    target: { entrypoint: "main.py", kind: "program", programId: "p" },
    ...overrides,
  };
}

async function codes(overrides: Partial<EvolveGoal> = {}, extra: {
  casHas?: (hash: string) => Promise<boolean>;
  model?: ModelProfile | undefined;
  sandbox?: EvolveSandboxCapability;
} = {}): Promise<string[]> {
  const issues = await preflight({
    casHas: extra.casHas ?? (async () => true),
    goal: goal(overrides),
    model: "model" in extra ? extra.model : MODEL,
    sandbox: extra.sandbox ?? SANDBOX,
  });
  return issues.map((issue) => issue.code);
}

type DatasetMeasure = Extract<ScorecardCriterion["measure"], { kind: "dataset_metric" }>;

/** Rewrite the one criterion's measure, keeping the rest of the card intact. */
function withMeasure(edit: (measure: DatasetMeasure) => DatasetMeasure) {
  const card = goal().scorecard;
  return {
    ...card,
    criteria: [{ ...card.criteria[0]!, measure: edit(card.criteria[0]!.measure as DatasetMeasure) }],
  };
}

test("a well-formed run passes", async () => {
  assert.deepEqual(await codes(), []);
});

test("the token floor follows the thinking setting, not just the algorithm", async () => {
  // Measured on GLM5.2 rewriting a small program: with thinking on, 16k gave
  // 16001 output tokens and no content at all, six expansions in a row; 64k
  // still hit the cap on two calls of eight. With it off, ~1.2k per call.
  const at = (maxTokensPerCall: number) => ({ ...goal().budget, maxTokensPerCall });

  // Thinking left to the provider: the high floor applies.
  assert.ok((await codes({ budget: at(16_000) })).includes("max_tokens_too_low"));
  assert.ok((await codes({ budget: at(64_000) })).includes("max_tokens_too_low"),
    "64k was observed to cap a quarter of the calls");
  assert.equal((await codes({ budget: at(96_000) })).includes("max_tokens_too_low"), false);

  // Thinking off: demanding six figures would refuse runs that work fine.
  const quiet = { budget: at(8_000), thinking: "disabled" as const };
  assert.equal((await codes(quiet)).includes("max_tokens_too_low"), false);
  assert.ok((await codes({ ...quiet, budget: at(2_000) })).includes("max_tokens_too_low"));

  // OpenEvolve rewrites the whole genome, so its floors are higher again.
  assert.ok((await codes({ algorithm: "openevolve", budget: at(96_000) }))
    .includes("max_tokens_too_low"));
});

test("a refused ceiling offers turning thinking off as the other way out", async () => {
  const issues = await preflight({
    casHas: async () => true,
    goal: goal({ budget: { ...goal().budget, maxTokensPerCall: 16_000 } }),
    model: MODEL,
    sandbox: SANDBOX,
  });
  const issue = issues.find((candidate) => candidate.code === "max_tokens_too_low");
  // Two knobs solve this, and naming only one sends the user to the expensive
  // side of a forty-times token difference.
  assert.match(issue?.fix ?? "", /思考/);
});

test("expansions that do not divide by workers are refused", async () => {
  // The engine dispatches whole sweeps, so a remainder silently buys fewer
  // expansions than the user asked for.
  const uneven = await codes({ budget: { ...goal().budget, expansions: 7, workers: 2 } });
  assert.ok(uneven.includes("expansions_not_divisible"));
  const even = await codes({ budget: { ...goal().budget, expansions: 6, workers: 3 } });
  assert.equal(even.includes("expansions_not_divisible"), false);
});

test("a run with no isolation is refused rather than run unconfined", async () => {
  const none: EvolveSandboxCapability = {
    backend: null, bwrapPath: "bwrap", disableUserns: false, procMode: "proc",
  };
  assert.ok((await codes({}, { sandbox: none })).includes("sandbox_unavailable"));
});

test("a model that cannot be called is caught before the run exists", async () => {
  assert.ok((await codes({}, { model: undefined })).includes("model_missing"));
  assert.ok((await codes({}, { model: { ...MODEL, hasApiToken: false } })).includes("model_no_token"));
});

test("a held-out set too small to decide anything is refused", async () => {
  const narrow = withMeasure((measure) => ({
    ...measure, split: { ...measure.split, gateShards: 2 },
  }));
  assert.ok((await codes({ scorecard: narrow })).includes("gate_shards_too_few"));
});

test("a scorecard the search cannot steer by is refused", async () => {
  const card = goal().scorecard;
  // identity + minimize means "bigger is better" for a quantity the user wants
  // small: the search would optimise the wrong way and never say so.
  const inverted = {
    ...card,
    criteria: [{ ...card.criteria[0]!, direction: "minimize" as const }],
  };
  assert.ok((await codes({ scorecard: inverted })).some((code) => code.startsWith("scorecard_")));
});

test("a dataset that is not in the store is caught before the run exists", async () => {
  // Otherwise this surfaces at staging, after the run record exists and the
  // user is watching a spinner.
  assert.ok((await codes({}, { casHas: async () => false })).includes("dataset_not_in_store"));

  const unnamed = withMeasure((measure) => ({ ...measure, datasetCas: [] }));
  assert.ok((await codes({ scorecard: unnamed })).includes("dataset_missing"));
});

test("a criterion that does not say what to predict is refused", async () => {
  const blind = withMeasure((measure) => ({ ...measure, target: "" }));
  assert.ok((await codes({ scorecard: blind })).includes("target_column_missing"));
});

test("a split that could not fit any dataset is refused before one is read", async () => {
  const impossible = withMeasure((measure) => ({
    ...measure, split: { ...measure.split, shardRows: 0 },
  }));
  assert.ok((await codes({ scorecard: impossible })).includes("split_impossible"));
});

test("every refusal says what to change", async () => {
  // A refusal without a fix is a dead end: the user is told no and left to
  // guess which of six knobs to touch.
  const issues = await preflight({
    casHas: async () => false,
    goal: goal({ budget: { ...goal().budget, expansions: 7, maxTokensPerCall: 1_000, workers: 2 } }),
    model: undefined,
    sandbox: { backend: null, bwrapPath: "bwrap", disableUserns: false, procMode: "proc" },
  });

  assert.ok(issues.length >= 5);
  for (const issue of issues) {
    assert.ok(issue.fix.length > 0, `${issue.code} has no fix`);
    assert.ok(issue.message.length > 0, `${issue.code} has no message`);
  }
});

/** A scorecard graded by a model rather than measured on data. */
function judged(overrides: Partial<{
  judgeModelId: string; rubricCas: string; solvedThreshold: number;
}> = {}): EvolveGoal {
  const rubricCas = overrides.rubricCas ?? "sha256:rubric";
  const card = goal().scorecard;
  return {
    ...goal(),
    frozen: [rubricCas],
    scorecard: {
      ...card,
      criteria: [{
        direction: "maximize",
        id: "quality",
        measure: {
          blind: true,
          judgeModelId: overrides.judgeModelId ?? "model-judge",
          kind: "llm_judge",
          rubricCas,
          samplesPerCandidate: 1,
          scale: { max: 9, min: 0 },
          split: { gateShards: 4, rolloutShards: 4, seed: 0, shardRows: 1, testShards: 0, trainRows: null },
          varianceThreshold: 0.2,
        },
        name: "质量",
        normalize: { kind: "identity" },
        weight: 1,
      }],
      solvedThreshold: overrides.solvedThreshold ?? 0.85,
    },
  };
}

test("a judged run needs no sandbox and no dataset", async () => {
  // This mode exists for searches with neither. Demanding isolation for a run
  // that executes nothing, or a dataset for one that measures nothing, would
  // refuse exactly the searches it is for.
  const none: EvolveSandboxCapability = {
    backend: null, bwrapPath: "bwrap", disableUserns: false, procMode: "proc",
  };
  const issues = await preflight({
    casHas: async () => true, goal: judged(), model: MODEL, sandbox: none,
  });

  assert.deepEqual(issues.map((issue) => issue.code), []);
});

test("a judged scorecard's own requirements are checked", async () => {
  const codesOf = async (overrides: Parameters<typeof judged>[0], frozen?: string[]) => {
    const target = judged(overrides);
    const issues = await preflight({
      casHas: async () => true,
      goal: frozen ? { ...target, frozen } : target,
      model: MODEL,
      sandbox: SANDBOX,
    });
    return issues.map((issue) => issue.code);
  };

  assert.ok((await codesOf({ judgeModelId: "" })).includes("judge_model_missing"));
  assert.ok((await codesOf({ rubricCas: "" })).includes("rubric_missing"));

  // At the default threshold a graded scorer never counts as solved, so every
  // rollout asks for a proposal and the run reports `below-threshold` — which
  // reads as the reflector failing when nothing was ever counted as done.
  assert.ok((await codesOf({ solvedThreshold: 0.999 })).includes("solved_threshold_too_high"));

  // A search that can rewrite its own marking scheme learns to do that instead
  // of getting better.
  assert.ok((await codesOf({}, [])).includes("rubric_not_frozen"));
});

test("a test-gated scorecard must freeze the tests it is scored by", async () => {
  const gated = (overrides: Partial<{
    frozen: string[]; gateGroups: number; rolloutGroups: number; testCmd: string[];
  }> = {}): EvolveGoal => ({
    ...goal(),
    scorecard: {
      ...goal().scorecard,
      criteria: [{
        direction: "maximize",
        id: "pass_rate",
        measure: {
          caseSplit: {
            gateGroups: overrides.gateGroups ?? 4,
            rolloutGroups: overrides.rolloutGroups ?? 4,
            testGroups: 2,
          },
          entrypoint: ["solver.py"],
          frozen: overrides.frozen ?? ["tests/**"],
          kind: "test_gate",
          testCmd: overrides.testCmd ?? ["pytest", "-q"],
        },
        name: "通过率",
        normalize: { kind: "identity" },
        weight: 1,
      }],
    },
  });

  const codesOf = async (goalOverride: EvolveGoal) => (await preflight({
    casHas: async () => true, goal: goalOverride, model: MODEL, sandbox: SANDBOX,
  })).map((issue) => issue.code);

  assert.deepEqual(await codesOf(gated()), []);
  // The one that is not a preference: the shortest path to a high score is to
  // weaken the thing measuring it.
  assert.ok((await codesOf(gated({ frozen: [] }))).includes("tests_not_frozen"));
  assert.ok((await codesOf(gated({ testCmd: [] }))).includes("test_cmd_missing"));
  assert.ok((await codesOf(gated({ gateGroups: 2 }))).includes("gate_groups_too_few"));
  assert.ok((await codesOf(gated({ rolloutGroups: 0 }))).includes("rollout_groups_too_few"));
});
