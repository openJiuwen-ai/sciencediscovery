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
 * The `/evolve` shell: command parsing, the event fold, and the workspace card.
 *
 * The fold is where the interesting cases live, because the same reducer serves
 * three sources (live SSE, the run's log, the graph) and they must render
 * identically — including when records arrive out of order or twice, which is
 * the normal shape of a stream that can be resumed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { EvolveEvent, EvolveEventRecord, EvolveGoal, EvolveRun } from "@sciencediscovery/schema";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { isPlaceholderGoal } from "../src/evolve/command.js";
import { EvolveRunCard } from "../src/evolve/EvolveRunCard.js";
import {
  bestCandidate,
  emptyRunView,
  reduceEvolveRecords,
  runProgress,
  type EvolveCandidateView,
  type EvolveRunView,
} from "../src/evolve/model.js";
import { SearchGraphTable } from "../src/evolve/SearchGraphTable.js";
import { diffGraph, layoutSearchGraph, rankScores } from "../src/evolve/search-graph-layout.js";
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";

function render(node: ReactElement): string {
  return renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" }, node));
}

function record(sequence: number, event: EvolveEvent): EvolveEventRecord {
  return { createdAt: "2026-08-19T00:00:00.000Z", event, sequence };
}

// --- command parsing --------------------------------------------------------

test("a goal from before the wizard is still recognisable as a placeholder", () => {
  // The wizard cannot make one any more, but runs created before it exist on
  // disk and still open — the dashboard says plainly that their scorecard was
  // never chosen by anyone.
  const goal = placeholderShaped();
  assert.ok(isPlaceholderGoal(goal));
  assert.equal(isPlaceholderGoal({ ...goal, scorecard: { ...goal.scorecard, hash: "sha256:real" } }), false);
});

/** A goal shaped like the ones created before the wizard existed. */
function placeholderShaped(): EvolveGoal {
  return {
    algorithm: "era",
    baselineProgramCas: "sha256:placeholder",
    budget: {
      candidateTimeoutSeconds: 60, expansions: 6, maxCostCents: 500,
      maxSeconds: 1800, maxTokens: 200_000, maxTokensPerCall: 16_000, workers: 1,
    },
    engine: "stub",
    frozen: [],
    modelId: "",
    scorecard: {
      aggregate: "weighted_sum", confirmedAt: "", confirmedBy: "placeholder",
      constraints: [], criteria: [{
        direction: "maximize", id: "stub",
        measure: {
          datasetCas: [], kind: "dataset_metric",
          metric: { direction: "maximize", name: "stub" },
          split: { gateShards: 4, rolloutShards: 4, seed: 0, shardRows: 0, testShards: 4, trainRows: null },
          target: "y",
        },
        name: "stub", normalize: { kind: "identity" }, weight: 1,
      }],
      derivedFrom: { draftRunId: "", statement: "把分数做上去" },
      hash: "sha256:placeholder", schemaVersion: 1, solvedThreshold: 0.999,
    },
    schemaVersion: 2,
    statement: "把分数做上去",
    target: { entrypoint: "main.py", kind: "program", programId: "p" },
  };
}

// --- the fold ---------------------------------------------------------------

const START: EvolveEvent = { algorithm: "era", scorecardHash: "sha256:card", type: "search_started" };
const SEED: EvolveEvent = { baselineScore: 0.5, nodeIndex: 0, type: "seeded" };

test("a whole sequence folds into the view the dashboard reads", () => {
  const view = reduceEvolveRecords(emptyRunView(), [
    record(1, START),
    record(2, SEED),
    record(3, { ancestorVisits: [{ nodeIndex: 0, visits: 1 }], nodeIndex: 0, puct: 0.5, type: "selected" }),
    record(4, { depth: 1, nodeIndex: 1, parentIndex: 0, score: 0.62, type: "expanded", valid: true }),
    record(5, { criteria: { f1: 0.62 }, nodeIndex: 1, reward: 0.62, type: "evaluated" }),
    record(6, { accepted: true, nodeIndex: 1, reason: "提升", type: "merged" }),
    record(7, { cents: 21, tokens: 2100, type: "cost" }),
    record(8, { bestNodeIndex: 1, candidates: 2, status: "succeeded", type: "search_finished" }),
  ]);

  assert.equal(view.status, "succeeded");
  assert.equal(view.algorithm, "era");
  assert.equal(view.baselineScore, 0.5);
  assert.equal(view.expansions, 1);
  assert.equal(view.maxDepth, 1);
  assert.equal(view.tokens, 2100);
  assert.equal(view.rootVisits, 1);
  assert.equal(view.lastSequence, 8);
  assert.deepEqual(view.candidates.map((candidate) => candidate.nodeIndex), [0, 1]);
  assert.equal(view.candidates[1]?.accepted, true);
  assert.equal(bestCandidate(view)?.nodeIndex, 1);
});

test("records may arrive out of order and twice", () => {
  const ordered = reduceEvolveRecords(emptyRunView(), [record(1, START), record(2, SEED)]);
  const shuffled = reduceEvolveRecords(emptyRunView(), [record(2, SEED), record(1, START), record(1, START)]);

  // A reconnect replays; the fold has to be indifferent to that.
  assert.deepEqual(shuffled, ordered);
});

test("a replayed visit count is assigned, not accumulated", () => {
  const selected = record(3, {
    ancestorVisits: [{ nodeIndex: 0, visits: 4 }], nodeIndex: 0, type: "selected",
  });
  const once = reduceEvolveRecords(emptyRunView(), [selected]);
  const twice = reduceEvolveRecords(once, [selected]);

  assert.equal(once.rootVisits, 4);
  assert.equal(twice.rootVisits, 4, "absolute counts are what makes a replay free");
});

test("a failed candidate is in the tree, scores null, and can never win", () => {
  const view = reduceEvolveRecords(emptyRunView(), [
    record(2, SEED),
    record(3, {
      depth: 1, error: "SyntaxError", nodeIndex: 1, parentIndex: 0,
      score: null, type: "expanded", valid: false,
    }),
    record(4, { depth: 1, nodeIndex: 2, parentIndex: 0, score: 0.61, type: "expanded", valid: true }),
  ]);

  const failed = view.candidates.find((candidate) => candidate.nodeIndex === 1);
  assert.equal(failed?.valid, false);
  assert.equal(failed?.score, null);
  assert.equal(failed?.error, "SyntaxError");
  assert.equal(view.expansions, 2, "a failed expansion still counts against the budget");
  assert.equal(bestCandidate(view)?.nodeIndex, 2);
});

test("the two refusal kinds stay distinguishable", () => {
  const view = reduceEvolveRecords(emptyRunView(), [
    record(3, { depth: 1, nodeIndex: 1, parentIndex: 0, score: 0.9, type: "expanded", valid: true }),
    record(4, {
      accepted: false, category: "constraint-violated", nodeIndex: 1,
      reason: "太慢", rejectedBy: "too-slow", type: "merged",
    }),
    record(5, { depth: 1, nodeIndex: 2, parentIndex: 0, score: 0.51, type: "expanded", valid: true }),
    record(6, { accepted: false, category: "below-threshold", nodeIndex: 2, reason: "不显著", type: "merged" }),
  ]);

  assert.equal(view.candidates[0]?.category, "constraint-violated");
  assert.equal(view.candidates[0]?.rejectedBy, "too-slow");
  assert.equal(view.candidates[1]?.category, "below-threshold");
  // A refused candidate keeps its score: the tree ranks on it either way.
  assert.equal(bestCandidate(view)?.nodeIndex, 1);
});

test("an event about an unseen candidate creates a placeholder rather than dropping", () => {
  // After a resume, `selected` can name ancestors whose own records are already
  // below the watermark; losing their visit counts would misshape the tree.
  const view = reduceEvolveRecords(emptyRunView(), [
    record(9, { ancestorVisits: [{ nodeIndex: 4, visits: 2 }], nodeIndex: 4, type: "selected" }),
  ]);
  assert.equal(view.candidates.length, 1);
  assert.equal(view.candidates[0]?.visits, 2);
});

test("progress is bounded by the budget", () => {
  const view = { ...emptyRunView(), expansions: 9 };
  assert.equal(runProgress(view, 6), 1);
  assert.equal(runProgress({ ...emptyRunView(), expansions: 3 }, 6), 0.5);
  assert.equal(runProgress(view, 0), 0);
});

// --- the card ---------------------------------------------------------------

function run(overrides: Partial<EvolveRun> = {}): EvolveRun {
  const goal = placeholderShaped();
  return {
    algorithm: "era",
    candidates: 2,
    costCents: 0,
    createdAt: "2026-08-19T00:00:00.000Z",
    goal,
    id: "run-1",
    lastSeq: 8,
    sessionId: "s1",
    status: "succeeded",
    tokens: 0,
    ...overrides,
  };
}

test("a session with no runs leaves no footprint", () => {
  // Same rule the memory-graph card follows: a feature with nothing to show
  // must not occupy the workspace panel.
  assert.equal(render(createElement(EvolveRunCard, { onOpenRun: () => {}, runs: [] })), "");
});

test("the card survives the panel: finished runs stay listed", () => {
  const markup = render(createElement(EvolveRunCard, {
    onOpenRun: () => {},
    runs: [run({ id: "a", status: "succeeded" }), run({ id: "b", status: "failed" })],
  }));

  assert.match(markup, /把分数做上去/);
  assert.match(markup, /已完成/);
  assert.match(markup, /失败/);
});

test("terminal statuses are labelled apart, not merged into one", () => {
  // "you stopped it", "it ran out of budget" and "it broke" need different next
  // steps, so they must not share a label.
  const markup = render(createElement(EvolveRunCard, {
    onOpenRun: () => {},
    runs: [
      run({ id: "a", status: "stopped" }),
      run({ id: "b", status: "budget_exhausted" }),
      run({ id: "c", status: "failed" }),
    ],
  }));

  assert.match(markup, /已停止/);
  assert.match(markup, /预算触顶/);
  assert.match(markup, /失败/);
});

test("running runs are always shown; older finished ones fold away", () => {
  const runs = [
    run({ id: "live", status: "running" }),
    ...Array.from({ length: 5 }, (_, index) => run({ id: `old-${index}`, status: "succeeded" })),
  ];
  const markup = render(createElement(EvolveRunCard, { onOpenRun: () => {}, runs }));

  assert.match(markup, /进行中/);
  assert.match(markup, /另有 2 次更早的运行/);
});

// --- the search graph -------------------------------------------------------

function viewOf(candidates: Array<Partial<EvolveCandidateView> & { nodeIndex: number }>, extra: Partial<EvolveRunView> = {}): EvolveRunView {
  return {
    ...emptyRunView(),
    candidates: candidates.map((candidate) => ({
      depth: 0, parentIndex: null, score: 0.5, valid: true, visits: 0, ...candidate,
    })),
    ...extra,
  };
}

test("coordinates are a formula over depth and sibling order, not a solver's output", () => {
  const layout = layoutSearchGraph(viewOf([
    { nodeIndex: 0 },
    { depth: 1, nodeIndex: 1, parentIndex: 0 },
    { depth: 1, nodeIndex: 2, parentIndex: 0 },
    { depth: 2, nodeIndex: 3, parentIndex: 1 },
  ]));

  const at = (index: number) => layout.nodes.find((node) => node.nodeIndex === index)!;
  assert.equal(at(0).x, 0);
  assert.equal(at(1).x, at(2).x, "same depth, same column");
  assert.ok(at(1).y !== at(2).y, "siblings do not overlap");
  assert.ok(at(3).x > at(1).x, "depth grows to the right");
  assert.deepEqual(layout.edges.map((edge) => edge.id), ["e0-1", "e0-2", "e1-3"]);
});

test("appending a candidate leaves every existing position untouched", () => {
  const before = layoutSearchGraph(viewOf([{ nodeIndex: 0 }, { depth: 1, nodeIndex: 1, parentIndex: 0 }]));
  const after = layoutSearchGraph(viewOf([
    { nodeIndex: 0 },
    { depth: 1, nodeIndex: 1, parentIndex: 0 },
    { depth: 1, nodeIndex: 2, parentIndex: 0 },
  ]));

  // This is why the layout is computed rather than solved: a search appends a
  // node every few seconds, and a re-solve would shuffle the picture under the
  // user's cursor.
  for (const node of before.nodes) {
    const same = after.nodes.find((candidate) => candidate.id === node.id)!;
    assert.equal(same.x, node.x);
    assert.equal(same.y, node.y);
  }
});

test("a property change is a patch, never a move", () => {
  const before = layoutSearchGraph(viewOf([
    { nodeIndex: 0, visits: 1 },
    { depth: 1, nodeIndex: 1, parentIndex: 0, score: 0.6 },
  ]));
  const after = layoutSearchGraph(viewOf([
    { nodeIndex: 0, visits: 5 },
    { depth: 1, nodeIndex: 1, parentIndex: 0, score: 0.9 },
  ], { bestNodeIndex: 1 }));

  const diff = diffGraph(before, after);
  assert.equal(diff.rebuild, false, "nothing moved, so nothing is re-laid-out");
  assert.equal(diff.added.nodes.length, 0);
  assert.equal(diff.patched.length, 2, "both the visit count and the new best redraw in place");
  assert.ok(diff.patched.some((node) => node.elected));
});

test("only new elements are added between frames", () => {
  const before = layoutSearchGraph(viewOf([{ nodeIndex: 0 }]));
  const after = layoutSearchGraph(viewOf([{ nodeIndex: 0 }, { depth: 1, nodeIndex: 1, parentIndex: 0 }]));

  const diff = diffGraph(before, after);
  assert.deepEqual(diff.added.nodes.map((node) => node.nodeIndex), [1]);
  assert.deepEqual(diff.added.edges.map((edge) => edge.id), ["e0-1"]);
  assert.equal(diff.rebuild, false);
});

test("rank is a position, not a score, and a lone candidate sits in the middle", () => {
  assert.deepEqual([...rankScores([
    { depth: 0, nodeIndex: 0, parentIndex: null, score: 0.9, valid: true, visits: 0 },
  ]).values()], [0.5], "the engine's own single-node convention");

  const ranks = rankScores([
    { depth: 0, nodeIndex: 0, parentIndex: null, score: 0.1, valid: true, visits: 0 },
    { depth: 0, nodeIndex: 1, parentIndex: null, score: 0.9, valid: true, visits: 0 },
    { depth: 0, nodeIndex: 2, parentIndex: null, score: 0.5, valid: true, visits: 0 },
  ]);
  assert.equal(ranks.get(0), 0);
  assert.equal(ranks.get(2), 0.5);
  assert.equal(ranks.get(1), 1);
});

test("a failed candidate is drawn, dimmed, and has no rank", () => {
  const view = viewOf([
    { nodeIndex: 0, score: 0.5 },
    { depth: 1, nodeIndex: 1, parentIndex: 0, score: null, valid: false },
  ]);
  const layout = layoutSearchGraph(view);
  const failed = layout.nodes.find((node) => node.nodeIndex === 1)!;

  assert.equal(layout.nodes.length, 2, "it is a node in the tree, not a hidden row");
  assert.equal(failed.valid, false);
  assert.equal(rankScores(view.candidates).has(1), false);
});

test("a constraint refusal is marked apart from a gate refusal", () => {
  const layout = layoutSearchGraph(viewOf([
    { accepted: false, category: "constraint-violated", nodeIndex: 0, rejectedBy: "too-slow" },
    { accepted: false, category: "below-threshold", nodeIndex: 1 },
  ]));

  assert.equal(layout.nodes[0]?.refused, true);
  assert.equal(layout.nodes[1]?.refused, false);
});

test("openevolve bands the islands apart", () => {
  const layout = layoutSearchGraph(viewOf([
    { island: 0, nodeIndex: 0 },
    { island: 1, nodeIndex: 1 },
  ], { algorithm: "openevolve" }));

  // Interleaving islands would draw crossings that mean nothing: lineage there
  // is a forest, not one tree.
  assert.ok(layout.nodes[0]!.y !== layout.nodes[1]!.y);
  assert.ok(layout.nodes[0]!.color !== layout.nodes[1]!.color);
});

test("beyond the cap, the best candidate's ancestors are kept and truncation is reported", () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    depth: index === 0 ? 0 : 1,
    nodeIndex: index,
    parentIndex: index === 0 ? null : 0,
    score: index === 29 ? 0.99 : 0.1,
  }));
  const view = viewOf(candidates, { bestNodeIndex: 29 });

  const layout = layoutSearchGraph(view, 5);
  const drawn = layout.nodes.map((node) => node.nodeIndex);

  assert.equal(layout.nodes.length, 5);
  assert.equal(layout.hidden, 25, "truncation is stated, never silent");
  assert.ok(drawn.includes(29), "the best candidate is kept");
  assert.ok(drawn.includes(0), "and so is its ancestor chain");
});

test("a changed drawn set forces a rebuild rather than a patch", () => {
  const many = viewOf(Array.from({ length: 10 }, (_, index) => ({
    depth: index === 0 ? 0 : 1, nodeIndex: index, parentIndex: index === 0 ? null : 0, score: index / 10,
  })), { bestNodeIndex: 9 });

  const wide = layoutSearchGraph(many, 10);
  const narrow = layoutSearchGraph(many, 4);
  assert.equal(diffGraph(wide, narrow).rebuild, true);
});

test("the table carries every channel the picture encodes", () => {
  const markup = render(createElement(SearchGraphTable, {
    view: viewOf([
      { nodeIndex: 0, score: 0.5, visits: 3 },
      { accepted: false, category: "constraint-violated", depth: 1, nodeIndex: 1, parentIndex: 0, rejectedBy: "too-slow", score: 0.91 },
      { depth: 1, nodeIndex: 2, parentIndex: 0, score: null, valid: false },
    ], { bestNodeIndex: 0 }),
  }));

  // A canvas is unreachable to a keyboard and invisible to a screen reader, so
  // the table is not a fallback — it has to be the same view.
  assert.match(markup, /0\.9100/, "scores");
  assert.match(markup, /too-slow/, "which constraint refused it");
  assert.match(markup, /失败/, "the failed candidate is a row, not a gap");
  assert.match(markup, /★/, "the best candidate is marked");
  assert.match(markup, /<caption class="visually-hidden">/, "screen readers get a description");
  assert.match(markup, /<button[^>]*>[^<]*#1<\/button>/, "every candidate is focusable");
});

test("种子带上自己的代码哈希，diff 才有 before 可比", () => {
  // Every diff in a live run rendered as pure addition, nothing ever removed.
  // `expanded` carried `codeHash`; `seeded` did not, and `CandidateDetail`
  // diffs against `parent.codeHash`. A flat tree is ERA's normal shape — ten
  // of eleven nodes forked from the root on one run — so almost every parent
  // *is* the root, and an absent hash meant an empty "before" every time.
  const view = reduceEvolveRecords(emptyRunView(), [
    record(1, START),
    record(2, { baselineScore: 0.5417, codeHash: "sha256:seed", nodeIndex: 0, type: "seeded" }),
    record(3, { codeHash: "sha256:child", depth: 1, nodeIndex: 1, parentIndex: 0,
                score: 0.4146, type: "expanded", valid: true }),
  ]);

  const root = view.candidates.find((candidate) => candidate.nodeIndex === 0);
  assert.equal(root?.codeHash, "sha256:seed");

  // An older run that never stored the seed still folds, with no hash rather
  // than a hash that resolves to nothing.
  const legacy = reduceEvolveRecords(emptyRunView(), [record(1, START), record(2, SEED)]);
  assert.equal(legacy.candidates.find((c) => c.nodeIndex === 0)?.codeHash, undefined);
});

test("提前结束的 run 面板要说出原因和缺口", () => {
  // Twice the user asked "为什么提前结束/为什么8个就结束" about runs whose
  // events carried the answer. The fold dropped stopReason/expansionsPlanned,
  // so the panel had it and never said.
  const view = reduceEvolveRecords(emptyRunView(), [
    record(1, START),
    record(2, SEED),
    record(3, { depth: 1, nodeIndex: 1, parentIndex: 0, score: 0.62, type: "expanded", valid: true }),
    record(4, { bestNodeIndex: 1, candidates: 2, expansionsPlanned: 20,
                status: "succeeded", stopReason: "max_iters", type: "search_finished" }),
  ]);
  assert.equal(view.stopReason, "max_iters");
  assert.equal(view.expansionsPlanned, 20);

  // An old run whose finish event predates the fields folds unchanged.
  const legacy = reduceEvolveRecords(emptyRunView(), [
    record(1, START), record(2, SEED),
    record(3, { bestNodeIndex: null, candidates: 1, status: "succeeded", type: "search_finished" }),
  ]);
  assert.equal(legacy.stopReason, undefined);
});

test("引擎的日志行折进视图，供面板渲染", () => {
  // logLines were folded into the view from day one and rendered nowhere in
  // the panel — that render is verified in the browser harness; this pins the
  // fold half so the panel has something to show.
  const view = reduceEvolveRecords(emptyRunView(), [
    record(1, START), record(2, SEED),
    record(3, { level: "info", message: "修好了一个一分没拿到的候选（0.4781）", type: "log" }),
    record(4, { level: "warn", message: "9 个候选的分数全都一样", type: "log" }),
  ]);
  assert.equal(view.logLines.length, 2);
  assert.equal(view.logLines[1]!.level, "warn");
});
