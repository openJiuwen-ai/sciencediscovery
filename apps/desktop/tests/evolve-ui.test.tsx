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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself is built with the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EvolveRun } from "@sciencediscovery/schema";

import type { ApiClient } from "../src/api/client.js";
import type { EvolveStatus } from "../src/api/evolve.js";
import type { EvolveCandidateView, EvolveRunView } from "../src/evolve/model.js";
import { emptyRunView } from "../src/evolve/model.js";
import { TEXT } from "../src/text.js";
import { CandidateInspector } from "../src/views/evolve/CandidateInspector.js";
import { EvolveCreateDialog } from "../src/views/evolve/EvolveCreateDialog.js";
import { EvolveDetail, lastGain } from "../src/views/evolve/EvolveDetail.js";
import { EvolveNodeList } from "../src/views/evolve/EvolveNodeList.js";
import { EvolveRuntimeDialog } from "../src/views/evolve/EvolveRuntimeDialog.js";
import { EvolveRuns } from "../src/views/evolve/EvolveRuns.js";
import { EvolveTree, layoutTree, zoomToward } from "../src/views/evolve/EvolveTree.js";
import type { TreeView } from "../src/views/evolve/EvolveTree.js";
import { ScoreChart, collectSeries } from "../src/views/evolve/ScoreChart.js";
import { act, create } from "./support/dom-renderer.js";

const client = {} as ApiClient;

const budget = {
  candidateTimeoutSeconds: 120,
  expansions: 40,
  maxCostCents: 500,
  maxSeconds: 3600,
  maxTokens: 1_000_000,
  maxTokensPerCall: 32_000,
  workers: 1,
};

function run(over: Partial<EvolveRun> = {}): EvolveRun {
  return {
    algorithm: "puct",
    candidates: 12,
    costCents: 0,
    createdAt: "2026-10-01T09:00:00.000Z",
    goal: {
      algorithm: "puct",
      budget,
      frozen: [],
      modelId: "model-1",
      scorecard: { hash: "sha256:card" },
      schemaVersion: 2,
      statement: "让压缩比更高",
    },
    id: "run-1",
    lastSeq: 10,
    sessionId: "session-1",
    startedAt: "2026-10-01T09:00:00.000Z",
    status: "running",
    tokens: 1200,
    ...over,
  } as unknown as EvolveRun;
}

function candidate(over: Partial<EvolveCandidateView>): EvolveCandidateView {
  return {
    depth: 1,
    nodeIndex: 1,
    parentIndex: 0,
    score: 0.5,
    valid: true,
    visits: 0,
    ...over,
  };
}

/** The words a rendered subtree shows, in document order. */
function nodeText(node: unknown): string {
  if (typeof node === "string") return node;
  const children = (node as { children?: unknown[] }).children ?? [];
  return children.map(nodeText).join(" ");
}

function switchTag(html: string): string {
  return html.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? "";
}


function view(over: Partial<EvolveRunView> = {}): EvolveRunView {
  return {
    ...emptyRunView(),
    baselineScore: 0.4,
    candidates: [
      candidate({ depth: 0, nodeIndex: 0, parentIndex: null, score: 0.4 }),
      candidate({ accepted: true, gateScore: 0.62, nodeIndex: 1, rolloutScore: 0.55 }),
      candidate({ nodeIndex: 2, parentIndex: 1, score: 0.51 }),
      candidate({ nodeIndex: 3, parentIndex: 0, score: null, valid: false }),
    ],
    expansions: 3,
    status: "running",
    ...over,
  };
}

test("the transcript draws nothing for a session that has no searches", () => {
  const html = renderToStaticMarkup(
    <EvolveRuns onOpen={() => {}} runs={[]} />,
  );
  assert.equal(html, "");
});

test("a search designed without pauses says so on its card", () => {
  const html = renderToStaticMarkup(
    <EvolveRuns
      onOpen={() => {}}
      runs={[
        run({ goal: { ...run().goal, checkpointMode: "auto" }, id: "auto" }),
        run({ id: "confirm" }),
      ]}
    />,
  );
  // Only the auto run is marked; a goal written before the switch existed has
  // no field and therefore no badge.
  assert.equal((html.match(/evolve-chip-auto/g) ?? []).length, 1);
  assert.match(html, />自动</);
});

test("a card names the search, how long it took and where it stands", () => {
  const html = renderToStaticMarkup(
    <EvolveRuns
      onOpen={() => {}}
      runs={[run({
        finishedAt: "2026-10-01T09:38:20.000Z",
        id: "done",
        status: "succeeded",
      })]}
    />,
  );
  assert.match(html, /evolve-run-title">让压缩比更高</);
  assert.match(html, /已耗时 38分钟/);
  assert.match(html, /evolve-run-state is-good">已完成/);
  // A finished search has no clock to re-render and no spark to spin.
  assert.doesNotMatch(html, /evolve-run-spin/);
});

test("a live card says it is working rather than repeating its status", () => {
  const html = renderToStaticMarkup(
    <EvolveRuns onOpen={() => {}} runs={[run({ finishedAt: undefined })]} />,
  );
  assert.match(html, /evolve-run-state is-live">/);
  assert.match(html, /正在优化/);
  assert.match(html, /evolve-run-spin/);
});

test("the transcript shows the running search first and folds the rest", () => {
  const runs = [
    run({ createdAt: "2026-10-01T08:00:00.000Z", id: "old", status: "succeeded" }),
    run({ createdAt: "2026-10-01T10:00:00.000Z", id: "live" }),
    run({ createdAt: "2026-10-01T09:00:00.000Z", id: "finished", status: "stopped" }),
    run({ createdAt: "2026-10-01T07:00:00.000Z", id: "older", status: "failed" }),
  ];
  const html = renderToStaticMarkup(
    <EvolveRuns onOpen={() => {}} runs={runs} />,
  );
  assert.match(html, /evolve-runs/);
  // Three cards, then the fourth behind a count. There is no bar above the
  // conversation any more, so nothing here starts a search from the transcript.
  assert.equal((html.match(/evolve-run-card/g) ?? []).length, 3);
  assert.match(html, /还有 1 个/);
  assert.doesNotMatch(html, /新建实验/);
  assert.equal(html.indexOf("is-live") < html.indexOf("已停止"), true);
});

test("the task panel names the search and offers a stop while it is live", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run()}
    />,
  );
  assert.match(html, /evolve-detail/);
  assert.match(html, /evolve-task-head/);
  assert.match(html, /让压缩比更高/);
  assert.match(html, />停止</);
  // A search outlives the turn that started it, so the detail is a column
  // rather than a dialog over the conversation.
  assert.equal(html.includes("evolve-overlay"), false);
  assert.equal(html.includes('role="dialog"'), false);
  assert.equal(html.includes("evolve-task-status"), false);
});

test("the task panel leads with the totals, the chart, the tree and the budget", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run({
        finishedAt: "2026-10-01T09:38:20.000Z",
        status: "succeeded",
      })}
    />,
  );

  for (const label of ["最优解", "有效节点数/总数", "代际数", "算法", "Token"]) {
    assert.match(html, new RegExp(label), `${label}: the overview has a cell`);
  }
  assert.equal((html.match(/evolve-overview-cell/g) ?? []).length, 5);
  // The run's algorithm stands in before the first event arrives.
  assert.match(html, />puct</);

  // The handoff's order: how far, how it got there, what it tried, what it cost.
  const overview = html.indexOf("evolve-overview");
  const chart = html.indexOf("实时算法优化结果");
  const tree = html.indexOf("优化树");
  const budget = html.indexOf(">预算<");
  assert.equal(overview < chart && chart < tree && tree < budget, true);

  // Budget rows read value over limit, with the clock taken from the record.
  assert.match(html, /0 \/ 1,000,000/);
  assert.match(html, /38m20s \/ 1h00m/);
  assert.match(html, /0\.00 \/ 5\.00/);
  assert.equal((html.match(/role="progressbar"/g) ?? []).length, 3);
});

test("a finished run drops the stop button and keeps the panel", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run({ finishedAt: "2026-10-01T09:20:00.000Z", status: "succeeded" })}
    />,
  );
  assert.match(html, /evolve-detail/);
  assert.equal(html.includes(">停止<"), false);
});

test("the overview's delta is the last step of the best staircase", () => {
  // Baseline 0.4, then a gate-measured 0.62: the one improvement is +55%.
  assert.ok(Math.abs((lastGain(view()) ?? 0) - 55) < 1e-9);
  // Nothing has beaten the starting point yet.
  assert.equal(lastGain({ ...emptyRunView(), baselineScore: 0.5 }), undefined);
  // A run with no baseline still reports the step that set the first best.
  const gained = lastGain({
    ...emptyRunView(),
    baselineScore: null,
    candidates: [
      candidate({ gateScore: 0.2, nodeIndex: 1 }),
      candidate({ gateScore: 0.25, nodeIndex: 2 }),
    ],
  });
  assert.ok(Math.abs((gained ?? 0) - 25) < 1e-9);
});

test("a budget without a price table says so instead of drawing a cost bar", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run({
        finishedAt: "2026-10-01T09:20:00.000Z",
        goal: { ...run().goal, budget: { ...budget, maxCostCents: 0 } },
        status: "succeeded",
      })}
    />,
  );
  assert.match(html, /未配置价格表/);
  assert.match(html, /evolve-budget-track is-muted/);
});

test("a run past its clock budget marks the row rather than clipping the bar", () => {
  // The test run started in 2026, so a live one has already outlived the
  // hour-long clock in its budget.
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run()}
    />,
  );
  assert.match(html, /evolve-budget-track[^"]*is-over/);
  assert.match(html, /class="is-over"/);
});

test("a failed record states its error above the totals", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run({ error: "sidecar exited", status: "failed" })}
    />,
  );
  assert.match(html, /evolve-notice is-error/);
  assert.match(html, /sidecar exited/);
});

test("the chart draws a rising line and says what its axes mean", () => {
  const html = renderToStaticMarkup(<ScoreChart view={view()} />);
  assert.match(html, /evolve-chart-line/);
  assert.match(html, /evolve-chart-baseline/);
  assert.match(html, /evolve-chart-best-line/);
  // The x axis counts expansions, not wall-clock minutes.
  assert.match(html, /扩展次数/);
  assert.match(html, /evolve-chart-x/);
  // Every reading has a key in the legend.
  for (const label of ["最优产物", "显著节点", "测试", "失败", "低于基线"]) {
    assert.match(html, new RegExp(label), `${label}: the legend names it`);
  }
});

test("the chart keeps the gate and the failures apart", () => {
  const series = collectSeries(view());
  // Only a candidate the acceptance gate measured is plotted; a rollout score
  // alone is not a comparable reading, and an invalid node never reached the
  // floor.
  assert.deepEqual(series.significant.map((point) => point.index), [1]);
  assert.deepEqual(series.failed, [3]);

  const html = renderToStaticMarkup(<ScoreChart view={view()} />);
  assert.match(html, /evolve-chart-dot is-significant/);
  assert.doesNotMatch(html, /is-insignificant/);
  assert.match(html, /evolve-chart-failed/);
  assert.match(html, /evolve-chart-best/);
  // The significant point's title carries its score.
  assert.match(html, /0\.6200/);
});

test("pointing at a node names it, its generation and its score", async () => {
  let chart;
  await act(async () => { chart = create(<ScoreChart view={view()} />); });
  try {
    // Nothing follows the pointer until one is over a point.
    assert.equal(
      chart!.root.findAll((node) => node.props.className === "evolve-chart-tooltip").length,
      0,
    );

    const hit = chart!.root.findAll((node) =>
      node.props.className === "evolve-chart-hit"
      && String(node.props["aria-label"]).startsWith("#1"))[0];
    assert.ok(hit, "the best node has a hit area larger than its dot");
    await act(async () => { (hit.props.onMouseEnter as () => void)(); });

    // The dashed rule marks the expansion the point belongs to.
    assert.equal(chart!.root.findAll((node) => node.props.className === "evolve-chart-guide").length, 1);
    const tooltip = chart!.root.findAll((node) =>
      typeof node.props.className === "string"
      && node.props.className.startsWith("evolve-chart-tooltip")
      && !node.props.className.startsWith("evolve-chart-tooltip-"))[0];
    const text = nodeText(tooltip);
    assert.match(text, /Node #1/);
    assert.match(text, /代际 01/);
    // The handoff tags the best node rather than leaving the reader to compare
    // the score with the rule above.
    assert.match(text, /最佳/);
    assert.match(
      String(chart!.root.findByProps({ className: "evolve-chart-tooltip-score" }).children),
      /0\.6200/,
    );

    // Leaving the point takes the reading with it.
    await act(async () => { (hit.props.onMouseLeave as () => void)(); });
    assert.equal(
      chart!.root.findAll((node) => node.props.className === "evolve-chart-tooltip").length,
      0,
    );
    assert.equal(chart!.root.findAll((node) => node.props.className === "evolve-chart-guide").length, 0);
  } finally {
    await act(async () => { chart!.unmount(); });
  }
});

test("a failed node answers the pointer with its verdict, not a score", async () => {
  let chart;
  await act(async () => { chart = create(<ScoreChart view={view()} />); });
  try {
    const hit = chart!.root.findAll((node) =>
      node.props.className === "evolve-chart-hit"
      && String(node.props["aria-label"]).startsWith("#3"))[0];
    assert.ok(hit, "the failed node is hoverable too");
    await act(async () => { (hit.props.onMouseEnter as () => void)(); });

    const tooltip = chart!.root.findAll((node) =>
      typeof node.props.className === "string"
      && node.props.className.startsWith("evolve-chart-tooltip")
      && !node.props.className.startsWith("evolve-chart-tooltip-"))[0];
    const text = nodeText(tooltip);
    assert.match(text, /Node #3/);
    assert.match(text, /失败/);
    // It never ran, so there is no score to print.
    assert.equal(chart!.root.findAll((node) => node.props.className === "evolve-chart-tooltip-score").length, 0);
  } finally {
    await act(async () => { chart!.unmount(); });
  }
});

test("a chart with nothing measured says so instead of drawing an empty frame", () => {
  const html = renderToStaticMarkup(<ScoreChart view={emptyRunView()} />);
  assert.match(html, /还没有可以画出的得分/);
  assert.equal(html.includes("<svg"), false);
});

test("the node list reads the tree as rows and marks the winner", () => {
  const html = renderToStaticMarkup(
    <EvolveNodeList
      bestIndex={1}
      candidates={view().candidates}
      onSelect={() => {}}
      selectedIndex={2}
    />,
  );
  assert.match(html, /节点列表/);
  assert.equal((html.match(/class="evolve-node-row /g) ?? []).length, 4);
  assert.match(html, /Node #1/);
  assert.match(html, /代际 01/);
  // The best row is badged; the time-sort column from the handoff is absent.
  assert.equal((html.match(/最佳/g) ?? []).length, 1);
  assert.match(html, /evolve-node-row is-best/);
  assert.match(html, /evolve-node-row is-quiet/);
  assert.match(html, /evolve-node-row is-failed/);
  assert.match(html, /is-quiet is-selected/);
  assert.equal(html.includes("按时间"), false);
  // An invalid node has no score to print.
  assert.match(html, /class="evolve-node-score">-</);
});

test("the tree lays each parent over the middle of its children", () => {
  const layout = layoutTree(view().candidates);
  const at = (index: number) => {
    const node = layout.nodes.find((placed) => placed.candidate.nodeIndex === index);
    assert.ok(node, `node ${index} is placed`);
    return node;
  };
  // Node 1 has one child, node 3 is a leaf, and node 0 sits between them.
  assert.equal(at(2).x, 0);
  assert.equal(at(3).x, 1);
  assert.equal(at(1).x, 0);
  assert.equal(at(0).x, 0.5);
  assert.equal(at(2).depth, 2);
  assert.equal(layout.edges.length, 3);
  // 44px padding each side, a 32px radius, 82px between columns and 200
  // between generations.
  assert.equal(layout.width, 44 * 2 + 32 * 2 + 1 * 82);
  assert.equal(layout.height, 44 * 2 + 32 * 2 + 2 * 200);
});

/** The drawing coordinate under a screen point, mirroring where the canvas
 *  rests: centred horizontally while it fits, flush left and top after. */
function drawingPoint(
  view: TreeView,
  cursor: { x: number; y: number },
  viewport: { height: number; width: number },
  content: { height: number; width: number },
) {
  const baseX = Math.max(0, (viewport.width - content.width * view.zoom) / 2);
  return {
    x: (cursor.x - baseX - view.pan.x) / view.zoom,
    y: (cursor.y - view.pan.y) / view.zoom,
  };
}

test("a wheel step zooms about the cursor, not about a fixed corner", () => {
  const viewport = { height: 600, width: 800 };
  const content = { height: 900, width: 1000 };
  const start: TreeView = { pan: { x: 0, y: 0 }, zoom: 1 };
  const cursor = { x: 640, y: 180 };
  const zoomed = zoomToward(start, cursor, 2, viewport, content);
  assert.equal(zoomed.zoom, 2);
  // The drawing point under the pointer has to be the same one after the
  // zoom. The canvas rests flush left once it outgrows the column, so that
  // point is read against that origin, not against the viewport centre.
  const before = drawingPoint(start, cursor, viewport, content);
  const after = drawingPoint(zoomed, cursor, viewport, content);
  assert.ok(Math.abs(after.x - before.x) < 1e-9, `x drifted by ${after.x - before.x}`);
  assert.ok(Math.abs(after.y - before.y) < 1e-9, `y drifted by ${after.y - before.y}`);
});

test("a wheel step keeps the anchor when the view is already panned", () => {
  const viewport = { height: 600, width: 800 };
  const content = { height: 900, width: 1000 };
  // Zoomed out past the point where the canvas is wider than the column, so
  // the resting position itself changes from flush left to centred.
  const start: TreeView = { pan: { x: -120, y: -40 }, zoom: 1 };
  const cursor = { x: 500, y: 300 };
  const zoomed = zoomToward(start, cursor, 0.5, viewport, content);
  assert.equal(zoomed.zoom, 0.5);
  const before = drawingPoint(start, cursor, viewport, content);
  const after = drawingPoint(zoomed, cursor, viewport, content);
  assert.ok(Math.abs(after.x - before.x) < 1e-9, `x drifted by ${after.x - before.x}`);
  assert.ok(Math.abs(after.y - before.y) < 1e-9, `y drifted by ${after.y - before.y}`);
});

test("zooming stops at its limits instead of running away", () => {
  const viewport = { height: 600, width: 800 };
  const content = { height: 900, width: 1000 };
  const centre = { x: 400, y: 300 };
  const maxed = zoomToward({ pan: { x: 0, y: 0 }, zoom: 1 }, centre, 100, viewport, content);
  assert.equal(zoomToward(maxed, centre, 100, viewport, content), maxed);
  const floored = zoomToward({ pan: { x: 0, y: 0 }, zoom: 0.3 }, centre, 0.01, viewport, content);
  assert.equal(floored.zoom, 0.3);
});

test("the tree draws the four node tones in a draggable viewport", () => {
  const html = renderToStaticMarkup(
    <EvolveTree bestIndex={1} candidates={view().candidates} onSelect={() => {}} />,
  );
  assert.match(html, /aria-label="优化树，共 4 个节点"/);
  assert.match(html, /evolve-tree-node is-best/);
  assert.match(html, /evolve-tree-node is-quiet/);
  assert.match(html, /evolve-tree-node is-failed/);
  assert.match(html, /evolve-tree-edge/);
  assert.match(html, /evolve-tree-badge/);
  assert.match(html, /evolve-tree-viewport/);
  assert.doesNotMatch(html, /evolve-tree-zoom/);
});

test("a tree with no nodes says so instead of drawing an empty frame", () => {
  const html = renderToStaticMarkup(
    <EvolveTree candidates={[]} onSelect={() => {}} />,
  );
  assert.match(html, /还没有节点/);
  // Nothing to place: no node canvas is drawn.
  assert.equal(html.includes("evolve-tree-canvas"), false);
});

test("the inspector explains a root instead of diffing it against nothing", () => {
  const root = candidate({ depth: 0, nodeIndex: 0, parentIndex: null, score: 0.4 });
  const html = renderToStaticMarkup(
    <CandidateInspector candidate={root} client={client} onClose={() => {}} runId="run-1" />,
  );
  assert.match(html, /这是起点，没有父代/);
  assert.match(html, /evolve-drawer-meta">起点/);
});

test("the node drawer shows the score, the parent and one way to expand the diff", () => {
  const html = renderToStaticMarkup(
    <CandidateInspector
      best
      candidate={candidate({ codeHash: "sha256:child", depth: 2 })}
      childCount={3}
      client={client}
      onClose={() => {}}
      parent={candidate({ codeHash: "sha256:parent", depth: 1, nodeIndex: 0, parentIndex: null })}
      runId="run-1"
    />,
  );
  assert.match(html, /Node #1/);
  assert.match(html, /最佳/);
  assert.match(html, /父代 #0/);
  assert.match(html, /代际 02/);
  assert.match(html, /优化分数/);
  assert.match(html, /0\.5000/);
  assert.match(html, /子节点数/);
  assert.match(html, />3</);
  assert.match(html, /代码变更/);
  assert.match(html, /aria-label="展开代码变更"/);
  // The handoff's copy button and the modal's footer are deliberately absent.
  assert.equal(html.includes("复制"), false);
  assert.equal(html.includes("aria-modal"), false);
});

test("the create dialog offers the two searches as illustrated cards", () => {
  const status: EvolveStatus = { canInitialize: true, state: "ready" };
  const html = renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );
  assert.match(html, /新建程序演进实验/);
  assert.match(html, /选择搜索算法/);
  assert.match(html, /PUCT算法/);
  assert.match(html, /OpenEvolve算法/);
  // Each card states what the search is good at and how it moves.
  assert.match(html, /逐步改进/);
  assert.match(html, /搜索空间窄/);
  assert.match(html, /基于PUCT策略，优先扩展高潜力节点/);
  assert.match(html, /搜索空间宽/);
  assert.match(html, /避免过早收敛/);
  assert.match(html, /MAP-Elites网格保留多样化优质候选/);
  // The illustration is part of the choice, not decoration a screen reader
  // has to describe.
  assert.equal((html.match(/class="evolve-algorithm-art is-/g) ?? []).length, 2);
  // The goal is written in the composer after the token now; the dialog does
  // not ask for it a second time.
  assert.equal(html.includes("<textarea"), false);
  assert.match(html, /开始设计/);
});

test("the create dialog pauses at checkpoints unless the command said otherwise", () => {
  const status: EvolveStatus = { canInitialize: true, state: "ready" };
  const render = (checkpointMode?: "auto" | "confirm") => renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initialCheckpointMode={checkpointMode}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );

  const byDefault = render();
  assert.match(byDefault, /检查点需要人工确认/);
  assert.match(byDefault, /等你确认后再继续/);
  assert.equal(switchTag(byDefault).includes("checked"), true);

  // A `--no-confirm` draft that had to detour through setup comes back with
  // the switch still off, so the detour does not silently undo the choice.
  const auto = render("auto");
  assert.match(auto, /连续完成设计与启动/);
  assert.equal(switchTag(auto).includes("checked"), false);
});

test("the create dialog opens on the search the command named", () => {
  const status: EvolveStatus = { canInitialize: true, state: "ready" };
  const render = (initialAlgorithm?: "puct" | "openevolve") => renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initialAlgorithm={initialAlgorithm}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );

  // A `--algorithm openevolve` draft that had to detour through setup comes
  // back with that search selected, not on the dialog's own default.
  const openEvolve = render("openevolve");
  assert.match(openEvolve, /aria-checked="true"[\s\S]{0,600}?evolve-algorithm-name">OpenEvolve算法/);
  assert.match(openEvolve, /aria-checked="false"[\s\S]{0,600}?evolve-algorithm-name">PUCT算法/);

  const byDefault = render();
  assert.match(byDefault, /aria-checked="true"[\s\S]{0,600}?evolve-algorithm-name">PUCT算法/);
});

test("a host with no sandbox warns that candidates run unconfined", () => {
  // The warning is a statement under the title, not a switch: consent is asked
  // when the search is started, so the form must not offer to give it early.
  const render = (sandbox: EvolveStatus["sandbox"], state: EvolveStatus["state"]) => renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={{ canInitialize: true, sandbox, state }}
    />,
  );

  const direct = render("direct", "ready");
  assert.match(direct, /class="evolve-create-notice"/);
  assert.match(direct, /role="note"/);
  assert.match(direct, /没有沙箱的情况下运行候选代码/);
  assert.match(direct, /这台机器没有可用的沙箱/);
  assert.match(direct, /可以读写你的文件、访问网络/);
  assert.match(direct, /会再确认一次/);
  // The warning sits above the search cards, where a title-adjacent banner is
  // read before anything is chosen.
  assert.equal(direct.indexOf("evolve-create-notice") < direct.indexOf("选择搜索算法"), true);
  // No control carries the consent: the only switch left is the checkpoint one.
  assert.equal((direct.match(/role="switch"/g) ?? []).length, 1);

  // Before the runtime is ready it has not said which isolation it will use,
  // so the dialog states the risk instead of promising one.
  assert.match(render("bwrap", "not_initialized"), /class="evolve-create-notice"/);

  // A ready runtime on a sandboxed host has nothing to warn about.
  for (const sandbox of ["bwrap", "seatbelt", null, undefined] as const) {
    assert.equal(
      render(sandbox, "ready").includes("evolve-create-notice"),
      false,
      `${String(sandbox)}: a sandboxed host must not warn about unconfined runs`,
    );
  }
});

test("a runtime warning is drawn only while the runtime is not usable", () => {
  const render = (status: EvolveStatus) => renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );

  // A ready runtime states itself by the absence of the warning, even on a host
  // with no sandbox — that host has its own, separate notice.
  const ready = render({ canInitialize: true, sandbox: "direct", state: "ready" });
  assert.equal(ready.includes("优化进程不可用"), false);
  assert.equal(ready.includes("查看详情"), false);

  for (const state of ["not_initialized", "installing", "error"] as const) {
    const html = render({ canInitialize: true, state });
    assert.match(html, /优化进程不可用|优化进程正在准备/, `${state}: the warning names the problem`);
    assert.match(html, /查看详情/, `${state}: the warning leads somewhere`);
    assert.equal(html.indexOf("查看详情") < html.indexOf("选择搜索算法"), true, `${state}: above the choice`);
  }
});

test("a search that ran without a sandbox is marked in the transcript and the panel", () => {
  const marked = run({ goal: { ...run().goal, allowUnisolated: true } });
  const cards = renderToStaticMarkup(
    <EvolveRuns onOpen={() => {}} runs={[marked, run({ id: "isolated" })]} />,
  );
  // Only the run whose goal recorded the confirmation is marked.
  assert.equal((cards.match(/evolve-chip-unisolated/g) ?? []).length, 1);
  assert.match(cards, />无隔离</);
  assert.match(cards, /候选代码没有在沙箱中执行/);

  const detail = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={marked}
    />,
  );
  assert.match(detail, /evolve-unisolated/);
  assert.match(detail, /候选代码没有在沙箱中执行/);

  // A goal written before the field existed has no badge.
  const plain = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run()}
    />,
  );
  assert.equal(plain.includes("无隔离"), false);
});

test("an unusable runtime keeps the form and greys out the start", () => {
  const status: EvolveStatus = { canInitialize: true, state: "not_initialized" };
  const html = renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );
  // The choice the user made is not replaced by a setup pane: only the button
  // that cannot work is disabled.
  assert.match(html, /选择搜索算法/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>开始设计<\/button>/);
  // The install lives behind 查看详情, not in the form.
  assert.equal(html.includes("准备运行时"), false);
});

test("the runtime details name the files and the install that fix it", () => {
  const status: EvolveStatus = {
    canInitialize: true,
    error: "Evolve service is unavailable or authentication failed.",
    state: "error",
  };
  const html = renderToStaticMarkup(
    <EvolveRuntimeDialog
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      status={status}
    />,
  );
  assert.match(html, /演化运行时不可用/);
  // The server's own words are kept verbatim.
  assert.match(html, /Evolve service is unavailable or authentication failed\./);
  // The Windows paths a desktop user can actually open.
  assert.match(html, /%USERPROFILE%\\\.sciencediscovery\\logs\\api\.log/);
  assert.match(html, /%USERPROFILE%\\\.sciencediscovery\\logs\\evolve\.log/);
  assert.match(html, /%USERPROFILE%\\\.sciencediscovery\\evolve/);
  assert.match(html, /shell\.log/);
  // And the one action the dialog can take for the user.
  assert.match(html, /<button[^>]*>准备运行时<\/button>/);
});

test("a deployment that will not install says so instead of offering a dead button", () => {
  const status: EvolveStatus = { canInitialize: false, state: "not_initialized" };
  const html = renderToStaticMarkup(
    <EvolveRuntimeDialog
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      status={status}
    />,
  );
  assert.match(html, /请联系管理员/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>准备运行时<\/button>/);
});
