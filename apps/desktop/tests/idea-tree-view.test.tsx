// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";

import type { IdeaTreeGraph, IdeaTreeNode } from "@sciencediscovery/schema";
import {
  IDEA_TREE_ZOOM_MAX,
  IDEA_TREE_ZOOM_MIN,
  IdeaNodeDetail,
  IdeaTreeView,
  ideaNodeStages,
  ideaScoreText,
  ideaTreeFitScale,
  ideaTreeAutoFit,
  ideaTreeLayout,
  ideaTreeRows,
  ideaTreeScrollAfterZoom,
  ideaTreeWheelScale,
  ideaTreeZoomScale,
} from "../src/views/idea/IdeaTree.js";
import { TEXT } from "../src/text.js";

const t = TEXT.ideaTree.detail;

function node(patch: Partial<IdeaTreeNode> & { id: string }): IdeaTreeNode {
  return {
    activeExecutionId: null, artifactRefs: [], attemptCount: 0, childrenIds: [], completedResultHandle: null,
    createdAt: "2026-11-18T00:00:00Z", depth: 0, hypothesis: "假设", id: patch.id, insight: null,
    lastExecutionId: null, parentId: null, priority: 0, pruneReason: null, result: null, score: null,
    searchStatus: "active", status: "pending", updatedAt: "2026-11-18T00:00:00Z", ...patch,
  };
}

function graph(nodes: IdeaTreeNode[]): IdeaTreeGraph {
  return { edges: [], nodes, objective: "目标", revision: 1, treeId: "tree-1", updatedAt: "2026-11-18T00:00:00Z" };
}

test("stages are read from the node's stage map, not from design/assessments fields", () => {
  const stages = ideaNodeStages(node({
    id: "n1",
    stages: {
      design: { text: "设计方案" },
      assessor_a: { text: "评估 A", score: 0.4 },
      aggregate: { text: "汇总", score: 0.5 },
    },
  }));
  assert.equal(stages.design?.text, "设计方案");
  assert.equal(stages.aggregate?.score, 0.5);
  assert.deepEqual(stages.assessments.map((entry) => entry.stage), ["assessor_a"]);
});

test("a missing score is unavailable while a reported 0 is a score", () => {
  assert.equal(ideaScoreText(null), t.unavailable);
  assert.equal(ideaScoreText(0), "0");
});

test("rows put every parent before its children, and keep an orphan", () => {
  const rows = ideaTreeRows(graph([
    node({ id: "child", parentId: "root", depth: 1 }),
    node({ id: "root", childrenIds: ["child"] }),
    node({ id: "orphan", parentId: "missing" }),
  ]));
  assert.deepEqual(rows.map((row) => [row.node.id, row.depth]), [["root", 0], ["child", 1], ["orphan", 0]]);
});

test("node detail shows unavailable for what the engine did not report", () => {
  const html = renderToStaticMarkup(React.createElement(IdeaNodeDetail, { node: node({ id: "n1" }) }));
  assert.ok(html.includes(t.unavailable), "missing design/insight/assessments are unavailable");
  assert.equal(html.includes("0 ·"), false, "a missing stage score is not 0");
  assert.ok(html.includes(t.notPruned), "null pruneReason reads as not pruned");
});

test("selecting a node in the tree calls back with that node", async () => {
  const picked: string[] = [];
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(React.createElement(IdeaTreeView, {
      graph: graph([node({ id: "n1", hypothesis: "可检验的假设", score: 0.3, status: "done", searchStatus: "pruned" })]),
      onSelect: (selected) => picked.push(selected.id),
    }));
  });
  // The zoom controls are buttons too, so pick the node's own button out.
  const button = view.root.findAll((item) => item.type === "button" && String(item.props.className).includes("idea-tree-node-button"))[0]!;
  await act(async () => { button.props.onClick(); });
  assert.deepEqual(picked, ["n1"]);
  const html = JSON.stringify(view.toJSON());
  assert.match(html, /可检验的假设/);
  assert.match(html, /0\.3/);
  view.unmount();
});

test("the layout puts a parent over the middle of its children, one row per depth", () => {
  const layout = ideaTreeLayout(graph([
    node({ id: "root", kind: "direction", childrenIds: ["a", "b"] }),
    node({ id: "a", parentId: "root", depth: 1, kind: "candidate" }),
    node({ id: "b", parentId: "root", depth: 1, kind: "candidate" }),
  ]));
  const byId = new Map(layout.nodes.map((placed) => [placed.node.id, placed]));
  const root = byId.get("root")!;
  const a = byId.get("a")!;
  const b = byId.get("b")!;
  assert.equal(root.x, (a.x + b.x) / 2, "the parent is centred over its children");
  assert.ok(a.y > root.y && a.y === b.y, "one row per depth");
  assert.equal(layout.edges.length, 2);
  // Two leaves, so the drawing is one node wide per leaf plus the gaps.
  assert.ok(layout.width > 2 * 176, "the drawing is as wide as the fan-out, not the column");
});

test("a node whose parent did not list it is still drawn as a child", () => {
  const layout = ideaTreeLayout(graph([
    node({ id: "root", childrenIds: [] }),
    node({ id: "forgotten", parentId: "root", depth: 1 }),
  ]));
  assert.equal(layout.edges.length, 1);
  assert.equal(layout.edges[0]!.to.node.id, "forgotten");
});

test("a parent cycle does not hang the layout", () => {
  const layout = ideaTreeLayout(graph([
    node({ id: "a", parentId: "b", childrenIds: ["b"] }),
    node({ id: "b", parentId: "a", childrenIds: ["a"] }),
  ]));
  assert.equal(layout.nodes.length, 2);
});

test("the fit never magnifies and never goes below the readable scale", () => {
  assert.equal(ideaTreeFitScale(200, 410), 1, "a narrow drawing is not blown up past its own size");
  assert.equal(ideaTreeFitScale(1000, 410), 0.6, "a wide drawing stops at the readable floor");
  assert.equal(ideaTreeFitScale(500, 410), 0.8, "between the two it takes the column's width");
});

test("hand zoom stops at the limits the buttons share", () => {
  assert.equal(ideaTreeZoomScale(1, 2), IDEA_TREE_ZOOM_MAX);
  assert.equal(ideaTreeZoomScale(0.5, 0.5), IDEA_TREE_ZOOM_MIN);
  assert.equal(ideaTreeZoomScale(1, 1.2), 1.2);
});

test("a wheel asks for a scale, and says so when it cannot move the one it has", () => {
  // Up is closer, down is further; the sign is the only thing a device agrees on.
  assert.ok(ideaTreeWheelScale(1, -120, 0, 400) > 1, "a wheel up magnifies");
  assert.ok(ideaTreeWheelScale(1, 120, 0, 400) < 1, "a wheel down shrinks");
  // Lines are 16px and a page is the scrollport, so the same notch moves the
  // same amount of drawing whatever unit the platform reports.
  assert.equal(ideaTreeWheelScale(1, 3, 1, 400), ideaTreeWheelScale(1, 48, 0, 400));
  assert.equal(ideaTreeWheelScale(1, 1, 2, 400), ideaTreeWheelScale(1, 400, 0, 400));
  // Both ends of the range, and a gesture with no vertical delta at all, return
  // the scale unchanged: that is how the listener tells a zoom from a scroll and
  // leaves the event to the box instead of swallowing it.
  assert.equal(ideaTreeWheelScale(IDEA_TREE_ZOOM_MAX, -120, 0, 400), IDEA_TREE_ZOOM_MAX);
  assert.equal(ideaTreeWheelScale(IDEA_TREE_ZOOM_MIN, 120, 0, 400), IDEA_TREE_ZOOM_MIN);
  assert.equal(ideaTreeWheelScale(1, 0, 0, 400), 1);
});

test("the tree zooms from the keyboard and a double click, and both go back to the fit", async () => {
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(React.createElement(IdeaTreeView, { graph: graph([node({ id: "root" })]) }));
  });
  const planeScale = (): string =>
    String(view.root.findAll((item) => item.props.className === "idea-tree-plane")[0]!.props.style.transform);
  const treeProps = () => view.root.findAll((item) => item.props.className === "idea-tree")[0]!.props;
  const press = async (key: string) => {
    // The handler only acts when the key came from the region itself.
    const host = {};
    await act(async () => { treeProps().onKeyDown({ key, preventDefault: () => undefined, target: host, currentTarget: host }); });
  };

  await press("+");
  assert.match(planeScale(), /scale\(1\.2\)/);
  await press("-");
  assert.match(planeScale(), /scale\(1\)/);
  await press("+");
  await press("+");
  await press("0");
  assert.match(planeScale(), /scale\(1\)/, "0 is the fit");

  const doubleClick = async () => {
    await act(async () => { treeProps().onDoubleClick({ target: { closest: () => null } }); });
  };
  await doubleClick();
  assert.match(planeScale(), /scale\(1\.5\)/, "a double click moves further than one button press");
  await doubleClick();
  assert.match(planeScale(), /scale\(1\)/, "the second double click is the way back");
  view.unmount();
});

test("a double click on a node is that node's, not the canvas's", async () => {
  const picked: string[] = [];
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(React.createElement(IdeaTreeView, {
      graph: graph([node({ id: "n1" })]),
      onSelect: (selected) => picked.push(selected.id),
    }));
  });
  const treeProps = () => view.root.findAll((item) => item.props.className === "idea-tree")[0]!.props;
  await act(async () => { treeProps().onDoubleClick({ target: { closest: () => ({}) } }); });
  const planeScale = String(view.root.findAll((item) => item.props.className === "idea-tree-plane")[0]!.props.style.transform);
  assert.match(planeScale, /scale\(1\)/, "a double click on a node does not zoom the canvas");
  assert.deepEqual(picked, []);
  view.unmount();
});

test("an automatic fit leaves a hand-set scale alone", () => {
  assert.equal(ideaTreeAutoFit(true, 0.7), undefined, "new data must not take the reader's scale back");
  assert.equal(ideaTreeAutoFit(false, 0.7), 0.7, "before any hand zoom the fit still tracks the column");
});

test("zooming keeps the middle of the viewport over the same part of the drawing", () => {
  const scroll = { left: 100, top: 50 };
  const area = { height: 300, width: 400 };
  const after = ideaTreeScrollAfterZoom(scroll, area, 2);
  const centreBefore = (scroll.left + area.width / 2) / 1;
  const centreAfter = (after.left + area.width / 2) / 2;
  assert.equal(centreAfter, centreBefore, "the same drawing column stays under the viewport's middle");
  assert.equal(after.left, 400);
  assert.equal(after.top, 250);
  assert.deepEqual(ideaTreeScrollAfterZoom({ left: 0, top: 0 }, area, 0.5), { left: 0, top: 0 });
});

test("the tree can be zoomed by hand and keeps that scale when new nodes arrive", async () => {
  const zoom = t.zoom;
  const planeScale = (view: ReturnType<typeof create>): string =>
    String(view.root.findAll((item) => item.props.className === "idea-tree-plane")[0]!.props.style.transform);
  const press = async (view: ReturnType<typeof create>, label: string) => {
    const button = view.root.findAll((item) => item.type === "button" && item.props["aria-label"] === label)[0]!;
    await act(async () => { button.props.onClick(); });
  };

  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(React.createElement(IdeaTreeView, { graph: graph([node({ id: "root", childrenIds: ["a"] }), node({ id: "a", parentId: "root", depth: 1 })]) }));
  });
  assert.match(planeScale(view), /scale\(1\)/);
  await press(view, zoom.in);
  assert.match(planeScale(view), /scale\(1\.2\)/);
  await press(view, zoom.in);
  assert.match(planeScale(view), /scale\(1\.44\)/);

  // A running research pushes a new graph on every event: the scale the reader
  // chose must survive it, or a live tree cannot be zoomed at all.
  await act(async () => {
    view.update(React.createElement(IdeaTreeView, {
      graph: graph([
        node({ id: "root", childrenIds: ["a", "b"] }),
        node({ id: "a", parentId: "root", depth: 1 }),
        node({ id: "b", parentId: "root", depth: 1 }),
      ]),
    }));
  });
  assert.match(planeScale(view), /scale\(1\.44\)/);

  // A different tree is a different drawing and opens at its own scale.
  await act(async () => {
    view.update(React.createElement(IdeaTreeView, {
      graph: { ...graph([node({ id: "root" })]), treeId: "tree-2" },
    }));
  });
  assert.match(planeScale(view), /scale\(1\)/);
  view.unmount();
});
