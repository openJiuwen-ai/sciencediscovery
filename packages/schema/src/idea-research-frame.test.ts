// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  applyIdeaResearchFrame, reconcileIdeaResearchFrame, type IdeaResearchFrame, type IdeaResearchView,
  type IdeaTreeFrameNode, type IdeaTreeNode,
} from "./idea-tree.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

/** A node as an explicit `get` answer carries it, `result` included. */
function node(id: string, parentId: string | null, patch: Partial<IdeaTreeNode> = {}): IdeaTreeNode {
  return {
    activeExecutionId: null, artifactRefs: [], attemptCount: 0, childrenIds: [], completedResultHandle: null,
    createdAt: "2026-11-18T00:00:00Z", depth: parentId ? 1 : 0, hypothesis: `hypothesis ${id}`, id, insight: null,
    lastExecutionId: null, parentId, priority: 0, pruneReason: null, result: `{"design":{"text":"${id}"}}`,
    score: null, searchStatus: "active", status: "pending", updatedAt: "2026-11-18T00:00:00Z",
    stages: { design: { text: `design ${id}` } }, insightRecords: [{ id: `insight-${id}` }],
    ...patch,
  } as IdeaTreeNode;
}

/** The same node as a live frame carries it: no `result`, no learning log. */
function frameNode(id: string, parentId: string | null, patch: Partial<IdeaTreeFrameNode> = {}): IdeaTreeFrameNode {
  const { result: _result, ...lean } = node(id, parentId) as IdeaTreeNode & { insightRecords?: unknown };
  delete (lean as { insightRecords?: unknown }).insightRecords;
  return { ...lean, ...patch };
}

function research(status = "running") {
  return {
    batch: [], batchCompleted: 0, currentNodeId: null, id: "research-1", modelId: "m", objective: "Objective",
    phase: "ideate", reason: null, round: 1, status, tokens: 10, usageKnown: true,
    settings: { maxRounds: 3, candidatesPerRound: 2, maxSearchRounds: 2, maxNodes: 20, maxDepth: 3, maxActiveDirections: 2, pruneMinAssessments: 3, pruneScoreGap: 2.5 },
  } as IdeaResearchView["research"];
}

function view(nodes: IdeaTreeNode[], revision: number): IdeaResearchView {
  return {
    research: research(),
    graph: { edges: [], nodes, objective: "Objective", revision, treeId: "research-1", updatedAt: "" },
  };
}

function frame(graph: Partial<IdeaResearchFrame["graph"]> & { revision: number }, status = "running"): IdeaResearchFrame {
  return {
    research: research(status),
    graph: {
      edges: [], full: false, nodes: [], objective: "Objective", removed: [], treeId: "research-1", updatedAt: "",
      ...graph,
    },
  };
}

test("a full frame replaces the held tree instead of merging into it", () => {
  const held = view([node("ROOT", null), node("stale", "ROOT")], 3);
  const next = applyIdeaResearchFrame(held, frame({ full: true, nodes: [node("ROOT", null), node("1", "ROOT")], revision: 9 }));
  assert.deepEqual(next?.graph.nodes.map((item) => item.id), ["ROOT", "1"], "the stale node is gone");
  assert.equal(next?.graph.revision, 9);
  assert.equal(next?.research.status, "running");
});

test("a delta frame replaces the nodes it names and keeps the rest", () => {
  const root = node("ROOT", null, { childrenIds: ["1"] });
  const held = view([root, node("1", "ROOT", { status: "running" })], 4);
  const next = applyIdeaResearchFrame(held, frame({
    edges: [{ ordinal: 1, source: "ROOT", target: "1", type: "child" }],
    nodes: [node("1", "ROOT", { status: "done", score: 8 })],
    revision: 5, since: 4,
  }, "completed"));
  assert.deepEqual(next?.graph.nodes.map((item) => [item.id, item.status, item.score]), [["ROOT", "pending", null], ["1", "done", 8]]);
  assert.deepEqual(next?.graph.edges, [{ ordinal: 1, source: "ROOT", target: "1", type: "child" }]);
  assert.equal(next?.graph.revision, 5);
  assert.equal(next?.research.status, "completed");
});

test("a delta frame drops the ids it reports removed", () => {
  const held = view([node("ROOT", null), node("1", "ROOT")], 4);
  const next = applyIdeaResearchFrame(held, frame({ removed: ["1"], revision: 5, since: 4 }));
  assert.deepEqual(next?.graph.nodes.map((item) => item.id), ["ROOT"]);
});

test("a delta computed from a revision the consumer does not hold is refused", () => {
  const held = view([node("ROOT", null)], 2);
  assert.equal(applyIdeaResearchFrame(held, frame({ nodes: [node("1", "ROOT")], revision: 7, since: 5 })), undefined,
    "the frames between 2 and 5 were lost, so a merge would drop their nodes");
  assert.equal(applyIdeaResearchFrame(undefined, frame({ nodes: [node("1", "ROOT")], revision: 7, since: 5 })), undefined,
    "there is no tree to merge into");
  assert.notEqual(applyIdeaResearchFrame(held, frame({ nodes: [node("1", "ROOT")], revision: 7, since: 2 })), undefined,
    "a delta is applied when the consumer already holds what it was computed from");
});

test("a frame never carries the fields the tree view does not draw", () => {
  const held = view([node("ROOT", null)], 1);
  const next = applyIdeaResearchFrame(held, frame({ nodes: [frameNode("ROOT", null, { status: "done" })], revision: 2, since: 1 }));
  const merged = next!.graph.nodes[0]!;
  // `IdeaTreeFrameNode` has no `result`, so this is a statement about the type as
  // well as the value: nothing merges a stale stage dump back onto the node.
  assert.equal(merged.result, undefined, "the duplicate stage serialisation is not in the frame");
  assert.equal((merged as { insightRecords?: unknown }).insightRecords, undefined, "the learning log is not in the frame");
  assert.deepEqual(merged.stages, { design: { text: "design ROOT" } }, "the detail view still gets the stages");
});

test("a whole read that fills a lost-frame gap wins over the older frame that exposed it", () => {
  // Revision 7 paused, while the gapped frame still describes revision 5 running:
  // merging the frame would show the research as live again and re-apply its nodes.
  const restored: IdeaResearchView = {
    research: { ...research("paused") },
    graph: {
      edges: [], nodes: [node("ROOT", null, { insight: "newer" })], objective: "Objective",
      revision: 7, treeId: "research-1", updatedAt: "2026-11-18T00:10:00Z",
    },
  };
  const gapped = frame({ nodes: [frameNode("ROOT", null, { insight: "stale" })], revision: 5, since: 3 }, "running");
  const kept = reconcileIdeaResearchFrame(restored, gapped);
  assert.equal(kept?.research.status, "paused", "the terminal state the read reported survives");
  assert.equal(kept?.graph.revision, 7, "the view does not roll back to the frame's revision");
  assert.equal(kept?.graph.updatedAt, restored.graph.updatedAt, "and keeps the newer timestamp");
  assert.equal(kept?.graph.nodes[0]?.insight, "newer", "the stale node is not re-applied");
  // A read older than the frame is still merged, so the frame is not simply dropped.
  const older: IdeaResearchView = { ...restored, graph: { ...restored.graph, revision: 4 } };
  const merged = reconcileIdeaResearchFrame(older, frame({ nodes: [frameNode("1", "ROOT")], revision: 5, since: 4 }));
  assert.deepEqual(merged?.graph.nodes.map((item) => item.id).sort(), ["1", "ROOT"]);
  assert.equal(merged?.graph.revision, 5);
});

test("a frame older than the held view is ignored, not applied over it", () => {
  // The whole read that filled a gap returned revision 7 paused; the stream still
  // has queued frames from revision 6. Applying one would roll the research back to
  // `pausing` and re-apply its nodes, and if the terminal frame was the one lost,
  // the panel would keep a stale live state for good.
  const held: IdeaResearchView = {
    research: research("paused"),
    graph: {
      edges: [], nodes: [node("ROOT", null, { insight: "newer" })], objective: "Objective",
      revision: 7, treeId: "research-1", updatedAt: "2026-11-18T00:10:00Z",
    },
  };
  for (const status of ["pausing", "running"]) {
    const stale = frame({ nodes: [frameNode("ROOT", null, { insight: "stale" })], revision: 6, since: 5 }, status);
    assert.equal(applyIdeaResearchFrame(held, stale), held, `a rev6 ${status} frame leaves the view alone`);
    // A stale full frame is just as old a description of the research.
    assert.equal(applyIdeaResearchFrame(held, frame({ full: true, nodes: [frameNode("ROOT", null)], revision: 6 }, status)), held);
  }
  // The terminal frame at the held revision is still applied, so the stream's last
  // word is not dropped by the guard.
  const terminal = frame({ nodes: [frameNode("ROOT", null, { score: 9 })], revision: 7, since: 6 }, "completed");
  const ended = applyIdeaResearchFrame(held, terminal);
  assert.equal(ended?.research.status, "completed");
  assert.equal(ended?.graph.nodes[0]?.score, 9);
});

test("a frame node replaces the result an earlier get answer carried", () => {
  const held = view([node("ROOT", null)], 1);
  assert.equal(held.graph.nodes[0]!.result, '{"design":{"text":"ROOT"}}', "the read model still carries it");
  const next = applyIdeaResearchFrame(held, frame({ nodes: [frameNode("ROOT", null, { insight: "later" })], revision: 2, since: 1 }));
  assert.equal(next!.graph.nodes[0]!.result, undefined,
    "the node a frame replaced is the node the panel draws, and it has no result");
  assert.equal(next!.graph.nodes[0]!.insight, "later");
});
