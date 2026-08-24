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
 * The dashboard's four blocks, at the level where they can be wrong silently.
 *
 * The chart's job is to keep three measurements apart; the stream's is to name
 * which of four things happened to a candidate; the diff's is to show the few
 * lines that changed inside a program that grew. Each of those is a pure
 * function underneath, and each fails by drawing something plausible.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { EvolveGoal } from "@sciencediscovery/schema";

import { formatDuration } from "../src/evolve/BudgetBar.js";
import { EvolveRunCard } from "../src/evolve/EvolveRunCard.js";
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";
import { verdictOf } from "../src/evolve/CandidateStream.js";
import { collectSeries } from "../src/evolve/ScoreChart.js";
import { collapseContext, diffLines } from "../src/evolve/text-diff.js";
import { emptyRunView, type EvolveCandidateView, type EvolveRunView } from "../src/evolve/model.js";

function candidate(overrides: Partial<EvolveCandidateView> = {}): EvolveCandidateView {
  return {
    depth: 1, nodeIndex: 1, parentIndex: 0, score: 0.5, valid: true, visits: 1, ...overrides,
  };
}

function view(candidates: EvolveCandidateView[], extra: Partial<EvolveRunView> = {}): EvolveRunView {
  return { ...emptyRunView(), candidates, ...extra };
}

// --- ① the chart --------------------------------------------------------------

test("the chart keeps the three measurements apart", () => {
  const series = collectSeries(view([
    candidate({ gateScore: 0.4, nodeIndex: 1, rolloutScore: 0.9 }),
  ]));

  // Better on what the search sees, worse on what decides — the case the whole
  // rollout/gate split exists to catch. One averaged line would draw it as
  // progress.
  assert.deepEqual(series.rollout, [{ index: 1, value: 0.9 }]);
  assert.deepEqual(series.gate, [{ index: 1, value: 0.4 }]);
});

test("an engine that measures once still gets one line, not none", () => {
  // ERA scores a node on the gate shards and ranks on that same number, so
  // there is no separate rollout figure to draw. Falling back to `score` beats
  // an empty chart on a run that is working.
  const series = collectSeries(view([candidate({ score: 0.62 })]));
  assert.deepEqual(series.gate, [{ index: 1, value: 0.62 }]);
  assert.deepEqual(series.rollout, [{ index: 1, value: 0.62 }]);
});

test("a failed expansion is a point on the axis, not a gap in the line", () => {
  const series = collectSeries(view([
    candidate({ nodeIndex: 1, score: 0.5 }),
    candidate({ nodeIndex: 2, score: null, valid: false }),
    candidate({ nodeIndex: 3, score: 0.7 }),
  ]));

  // A gap reads as "nothing happened here". What happened is that a candidate
  // was spent.
  assert.deepEqual(series.failed, [2]);
  assert.deepEqual(series.gate.map((point) => point.index), [1, 3]);
});

// --- ③ the stream --------------------------------------------------------------

test("the stream names which of four things happened", () => {
  // A score column alone renders all four as a blank, and each one sends the
  // user somewhere different.
  assert.equal(verdictOf(candidate({ accepted: true })), "accepted");
  assert.equal(verdictOf(candidate({ accepted: false, category: "below-threshold" })), "rejected");
  assert.equal(verdictOf(candidate({
    accepted: false, category: "candidate-failed", score: null, valid: false,
  })), "failed");
  assert.equal(verdictOf(candidate({
    accepted: false, category: "constraint-violated", score: null, valid: false,
  })), "violated");
});

test("a violated constraint is not filed as an ordinary failure", () => {
  // "It broke a rule" and "it would not run" need opposite fixes.
  const violated = candidate({ accepted: false, category: "constraint-violated", valid: false });
  assert.notEqual(verdictOf(violated), "failed");
});

// --- ④ the budget --------------------------------------------------------------

test("elapsed time reads as a duration at every scale", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(605), "10m05s");
  assert.equal(formatDuration(3_725), "1h02m");
  // A negative span (clocks move) is not a negative duration.
  assert.equal(formatDuration(-5), "0s");
});

// --- the diff -------------------------------------------------------------------

test("an insertion is an insertion, not a rewrite", () => {
  // A naive line-by-line walk reports every following line as changed, which is
  // exactly the reading the diff exists to prevent.
  const rows = diffLines("a\nb\nc", "x\na\nb\nc");

  assert.deepEqual(rows.map((row) => row.kind), ["added", "context", "context", "context"]);
  assert.equal(rows[0]?.text, "x");
  assert.equal(rows[0]?.leftLine, undefined);
  assert.equal(rows[0]?.rightLine, 1);
});

test("a deletion and a replacement are both visible", () => {
  const removed = diffLines("a\nb\nc", "a\nc");
  assert.deepEqual(removed.filter((row) => row.kind === "removed").map((row) => row.text), ["b"]);

  const replaced = diffLines("a\nb", "a\nB");
  assert.deepEqual(replaced.map((row) => row.kind), ["context", "removed", "added"]);
});

test("an unchanged candidate produces no changed rows", () => {
  const rows = diffLines("same\nlines", "same\nlines");
  assert.equal(rows.every((row) => row.kind === "context"), true);
  // …and collapsing leaves nothing, which is what the "byte-for-byte its
  // parent" message keys off.
  assert.equal(collapseContext(rows).rows.length, 0);
});

test("the baseline's first child diffs against nothing and is all new", () => {
  const rows = diffLines("", "def f():\n    return 1");
  assert.equal(rows.every((row) => row.kind === "added"), true);
});

test("collapsing hides distant context and says how much", () => {
  const before = Array.from({ length: 40 }, (_, at) => `line ${at}`).join("\n");
  const after = before.replace("line 20", "line 20  # changed");

  const { hidden, rows } = collapseContext(diffLines(before, after), 2);

  // The change plus a couple of lines either side, and no more: the point of
  // the diff is that the interesting part is three lines inside two screens.
  assert.ok(rows.length <= 8, `kept ${rows.length} rows`);
  assert.ok(hidden > 30);
  // A fold that does not report its size is indistinguishable from a short file.
  assert.equal(hidden + rows.length, diffLines(before, after).length);
});

test("a program too large to diff degrades instead of freezing the tab", () => {
  const huge = Array.from({ length: 3_100 }, (_, at) => `l${at}`).join("\n");
  const rows = diffLines(huge, `${huge}\nextra`);

  // Every line removed and re-added: a worse diff, and an honest one.
  assert.equal(rows.some((row) => row.kind === "context"), false);
  assert.equal(rows.filter((row) => row.kind === "added").length, 3_101);
});

// --- the wizard -----------------------------------------------------------------

