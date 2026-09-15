// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * Dataset-level regression pin for the resolver: runs the deterministic
 * L0–L2 gates over the packaged sample dataset and asserts the recorded
 * baseline. The ship gate (P≥0.95 / R≥0.60 / similar≥0.90) is deliberately
 * NOT asserted here — it targets the full L0–L4 stack whose L3/L4 layers
 * need a credentialed pipeline model (run scripts/ke-resolution-eval.mjs on
 * the live stack for that). The baseline numbers below were measured on the
 * DeepAnalyze-identical port and must not silently drift.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildMemoryRepo,
  computeMetrics,
  goldClusterOf,
  parseErDataset,
  runErItem,
} from "../index.js";

const DATASET_PATH = resolve(process.cwd(), "test-datasets", "entity-resolution", "pairs.sample.json");

test("deterministic L0–L2 baseline on pairs.sample stays pinned", async () => {
  const dataset = parseErDataset(readFileSync(DATASET_PATH, "utf-8"));
  const repo = buildMemoryRepo(dataset.graph);
  const scored = [];
  for (const item of dataset.items) {
    scored.push(await runErItem(item, repo));
  }
  const metrics = computeMetrics(scored, goldClusterOf(dataset));

  // Pinned baseline (2026-09-09, DA-parity port):
  //   precision 1.000 (zero false merges — the safety property)
  //   recall 7/12 (single/plural + cross-form splits are the known L3/L4 zone)
  //   similar 14/14, unrelated 8/8 (no over-merging)
  assert.equal(metrics.pairwise.precision, 1);
  assert.equal(metrics.pairwise.tp, 7);
  assert.equal(metrics.pairwise.fn, 5);
  assert.equal(metrics.perClass["similar"]!.correct, 14);
  assert.equal(metrics.perClass["unrelated"]!.correct, 8);
  // Gate honestly reports NOT-YET for the deterministic-only baseline.
  assert.equal(metrics.gate.precisionOk, true);
  assert.equal(metrics.gate.recallOk, false);
  assert.equal(metrics.gate.pass, false);
});
