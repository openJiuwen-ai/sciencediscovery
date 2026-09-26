// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../test/support/tagged/compat.mjs";
import { evolutionScorecard } from "../test/helpers/evolve-result.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });
const run = { id: "run", status: "succeeded", goal: { scorecard: { hash: "frozen-evaluator" } } };
const record = event => ({ event });
test("held-out score, not gate score or a percentage conversion, is the final quality score", () => {
  const result = evolutionScorecard(run, [
    record({ type: "seeded", baselineScore: .575674 }),
    record({ type: "evaluated", nodeIndex: 14, gateScore: .953965 }),
    record({ type: "search_finished", bestNodeIndex: 14, bestTestScore: .922426 }),
  ]);
  assert.equal(result.score, .922426);
  assert.equal(result.best_gate_score, .953965);
  assert.equal(result.scorecard.hash, "frozen-evaluator");
  assert.equal(result.gating, false);
});
test("zero score and a seed that stayed best are valid quality outcomes", () => {
  const result = evolutionScorecard(run, [record({ type: "seeded", baselineScore: 0 }),
    record({ type: "search_finished", bestNodeIndex: 0, bestTestScore: 0 })]);
  assert.equal(result.status, "scored");
  assert.equal(result.score, 0);
  assert.equal(result.best_gate_score, 0);
  assert.equal(result.gating, false);
});
test("missing or invalid held-out values stay unavailable, never replaced by gate", () => {
  for (const value of [undefined, null, "0.9", NaN, Infinity]) {
    const result = evolutionScorecard(run, [record({ type: "evaluated", nodeIndex: 1, gateScore: 1 }),
      record({ type: "search_finished", bestNodeIndex: 1, bestTestScore: value })]);
    assert.equal(result.status, "unavailable");
    assert.equal(result.score, null);
    assert.equal(result.best_gate_score, 1);
    assert.match(result.notes.join(" "), /not substituted/);
  }
});
