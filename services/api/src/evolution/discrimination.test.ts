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
 * The one pre-flight check whose failure is otherwise silent.
 *
 * A wrong scale makes the engine throw; a wrong direction is caught by the
 * normalisation table. A scorecard with no ordering power produces a search
 * that emits every event, records every candidate, and finds nothing — which
 * is indistinguishable from a hard problem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DAMAGES, ProbeRegistry, TEXT_DAMAGE, flatMessage, probeDiscrimination,
} from "./discrimination.js";

const BASELINE = "def train_and_predict(train_path, test_path):\n    return [1.0, 2.0]\n";

test("a scorer that notices the damage passes", async () => {
  const result = await probeDiscrimination({
    baseline: BASELINE,
    damage: DAMAGES[0]!,
    score: async (candidate) => (candidate === BASELINE ? 0.8 : 0.1),
  });

  assert.equal(result.flat, false);
  assert.equal(result.baseline, 0.8);
  assert.equal(result.worsened, 0.1);
});

test("a scorer that does not notice refuses the run", async () => {
  // The case worth the whole check: the search would walk randomly on flat
  // terrain and nothing on the dashboard would look wrong.
  const result = await probeDiscrimination({
    baseline: BASELINE, damage: DAMAGES[0]!, score: async () => 0.5,
  });

  assert.equal(result.flat, true);
  // Both numbers, because "the scoring has no ordering power" is hard to
  // believe without them.
  const message = flatMessage(result);
  assert.match(message, /0\.5000/);
  assert.match(message, /常数/);
});

test("a noisy scorer that barely moves is still flat", async () => {
  // Judged scorers wobble. An exact-equality test would pass a rubric that is
  // flat in every way that matters.
  let call = 0;
  const result = await probeDiscrimination({
    baseline: BASELINE,
    damage: DAMAGES[0]!,
    score: async () => (call++ === 0 ? 0.700_000_1 : 0.7),
    tolerance: 0.01,
  });

  assert.equal(result.flat, true);
});

test("a damaged copy that will not run is reported, not counted as a pass", async () => {
  // It says nothing about discrimination: the scorer never got to compare
  // anything, and treating that as "the check passed" would let a flat
  // scorecard through on a syntax error.
  const result = await probeDiscrimination({
    baseline: BASELINE,
    damage: DAMAGES[0]!,
    score: async (candidate) => (candidate === BASELINE ? 0.8 : null),
  });

  assert.equal(result.flat, false);
  assert.equal(result.worsened, null);
});

test("every damage keeps the program parseable and changes what it returns", () => {
  for (const damage of DAMAGES) {
    const worsened = damage.worsen(BASELINE);
    // Still a program the gate will accept — a damaged copy that fails to parse
    // measures the parser, not the scorer.
    assert.match(worsened, /def train_and_predict/);
    assert.notEqual(worsened, BASELINE);
    assert.ok(damage.label.length > 0);
  }
});

test("a text candidate is damaged into something any rubric should mark down", () => {
  const worsened = TEXT_DAMAGE.worsen("一段有内容的摘要。");
  assert.notEqual(worsened, "一段有内容的摘要。");
  // Deliberately crude: the point is to be obviously worse, so that a rubric
  // which cannot see it is definitely not going to separate two real drafts.
  assert.match(worsened, /一些/);
});

// --- the gate that makes the check unskippable -----------------------------------

test("a scorecard that was probed can start; one that was not cannot", () => {
  const probes = new ProbeRegistry();

  assert.equal(probes.has("sha256:card"), false);
  probes.record("sha256:card");
  assert.equal(probes.has("sha256:card"), true);
});

test("editing the scoring after probing it invalidates the pass", () => {
  // The whole point: the thing that was measured has to be the thing that runs.
  const probes = new ProbeRegistry();
  probes.record("sha256:before");

  assert.equal(probes.has("sha256:after"), false);
});

test("a pass does not outlive the dataset it was taken against", () => {
  const probes = new ProbeRegistry();
  const at = 1_000_000;
  probes.record("sha256:card", at);

  assert.equal(probes.has("sha256:card", at + 59 * 60_000), true);
  assert.equal(probes.has("sha256:card", at + 61 * 60_000), false);
  // …and the expired entry is dropped rather than accumulating.
  assert.equal(probes.size, 0);
});
