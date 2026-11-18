// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";

import type { IdeaTreeGraph, IdeaTreeNode } from "@sciencediscovery/schema";
import { IdeaNodeDetail, IdeaTreeView, ideaNodeStages, ideaScoreText, ideaTreeLayout, ideaTreeRows } from "../src/views/idea/IdeaTree.js";
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
  const button = view.root.findAll((item) => item.type === "button")[0]!;
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
