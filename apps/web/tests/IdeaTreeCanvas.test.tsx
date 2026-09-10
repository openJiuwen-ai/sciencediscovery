// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { IdeaTreeGraph, IdeaTreeNode } from "@sciencediscovery/schema";

import { chooseIdeaTreeOrientation, IDEA_TREE_STATUS_COLORS, layoutIdeaTree } from "../src/IdeaTreeCanvas.js";
import { IdeaTreeExplorer } from "../src/IdeaTreeExplorer.js";
import { sameIdeaTreeGraphSnapshot } from "../src/IdeaTreeView.js";

function node(id: string, depth: number, parentId: string | null, childrenIds: string[]): IdeaTreeNode {
  return {
    activeExecutionId: null,
    artifactRefs: [],
    attemptCount: 0,
    childrenIds,
    completedResultHandle: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    depth,
    hypothesis: `Hypothesis ${id}`,
    id,
    insight: null,
    lastExecutionId: null,
    parentId,
    priority: 0,
    pruneReason: null,
    result: null,
    score: null,
    searchStatus: "active",
    status: "pending",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

const graph: IdeaTreeGraph = {
  edges: [
    { ordinal: 0, source: "ROOT", target: "1", type: "child" },
    { ordinal: 1, source: "ROOT", target: "2", type: "child" },
    { ordinal: 0, source: "1", target: "1.1", type: "child" },
  ],
  nodes: [
    node("ROOT", 0, null, ["1", "2"]),
    node("1", 1, "ROOT", ["1.1"]),
    node("2", 1, "ROOT", []),
    node("1.1", 2, "1", []),
  ],
  objective: "Explore",
  revision: 4,
  treeId: "tree-1234567890abcdef",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

test("Idea Tree layout follows depth and centers parents over their children", () => {
  const positions = layoutIdeaTree(graph);
  assert.ok(positions.get("ROOT")!.y < positions.get("1")!.y);
  assert.ok(positions.get("1")!.y < positions.get("1.1")!.y);
  assert.ok(positions.get("1")!.x < positions.get("2")!.x);
  assert.equal(
    positions.get("ROOT")!.x,
    (positions.get("1")!.x + positions.get("2")!.x) / 2,
  );
});

test("Idea Tree horizontal layout advances depth from left to right", () => {
  const positions = layoutIdeaTree(graph, "left-right");
  assert.ok(positions.get("ROOT")!.x < positions.get("1")!.x);
  assert.ok(positions.get("1")!.x < positions.get("1.1")!.x);
  assert.ok(positions.get("1")!.y < positions.get("2")!.y);
  assert.equal(
    positions.get("ROOT")!.y,
    (positions.get("1")!.y + positions.get("2")!.y) / 2,
  );
});

test("Idea Tree automatically selects the layout that keeps nodes larger", () => {
  const wideGraph: IdeaTreeGraph = {
    ...graph,
    edges: [
      ...graph.edges,
      { ordinal: 0, source: "2", target: "2.1", type: "child" },
      { ordinal: 1, source: "2", target: "2.2", type: "child" },
      { ordinal: 2, source: "2", target: "2.3", type: "child" },
      { ordinal: 3, source: "2", target: "2.4", type: "child" },
    ],
    nodes: [
      graph.nodes[0]!,
      graph.nodes[1]!,
      node("2", 1, "ROOT", ["2.1", "2.2", "2.3", "2.4"]),
      graph.nodes[3]!,
      node("2.1", 2, "2", []),
      node("2.2", 2, "2", []),
      node("2.3", 2, "2", []),
      node("2.4", 2, "2", []),
    ],
  };
  assert.equal(chooseIdeaTreeOrientation(wideGraph, { height: 680, width: 1100 }), "left-right");
  assert.equal(chooseIdeaTreeOrientation(graph, { height: 680, width: 1100 }), "top-down");
});

test("Idea Tree polling reuses an unchanged graph snapshot", () => {
  assert.equal(sameIdeaTreeGraphSnapshot(graph, structuredClone(graph)), true);
  assert.equal(sameIdeaTreeGraphSnapshot(graph, { ...graph, revision: graph.revision + 1 }), false);
  assert.equal(sameIdeaTreeGraphSnapshot(graph, { ...graph, updatedAt: "2026-08-26T00:00:01.000Z" }), false);
  assert.equal(sameIdeaTreeGraphSnapshot(graph, { ...graph, treeId: "another-tree" }), false);
});

test("Idea Tree loading overlay keeps the canvas mounted", () => {
  const markup = renderToStaticMarkup(createElement(IdeaTreeExplorer, {
    graph,
    loading: true,
    onClose: () => undefined,
    onSelectTree: () => undefined,
    treeIds: [graph.treeId],
  }));
  assert.match(markup, /class="idea-tree-canvas"/u);
  assert.match(markup, /class="idea-tree-loading"/u);
});

test("Idea Tree canvas covers every runtime node status", () => {
  assert.deepEqual(
    Object.keys(IDEA_TREE_STATUS_COLORS).toSorted(),
    ["done", "failed", "needs_retry", "pending", "running"],
  );
});

test("autonomous research presents stage results without legacy execution fields", () => {
  const researchGraph: IdeaTreeGraph = {...graph, nodes: graph.nodes.map(n => n.id === "ROOT" ? {
    ...n, kind: "direction", stages: {aggregate: {text: "Prefer recoverable materials; verify leaching."}},
  } : n)};
  const html = renderToStaticMarkup(createElement(IdeaTreeExplorer, {
    autonomous: true, graph: researchGraph, onClose() {}, onSelectTree() {}, treeIds: [graph.treeId],
  }));
  assert.match(html, /综合评估/);
  assert.match(html, /Prefer recoverable materials/);
  assert.doesNotMatch(html, /Result handle|Active execution|revision 4/);
});
