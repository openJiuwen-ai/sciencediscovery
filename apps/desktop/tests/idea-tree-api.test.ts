// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ApiClient } from "../src/api/client.js";
import {
  controlIdeaResearch, getIdeaTreeGraph, listIdeaResearches, subscribeIdeaResearchEvents,
} from "../src/api/idea-tree.js";

const VIEW = {
  research: {
    id: "research-1", objective: "提升膜通量", status: "running", phase: "building_tree",
    round: 2, batch: [], batchCompleted: 0, tokens: 0, usageKnown: false, reason: null,
    modelId: "model-x", currentNodeId: null,
    settings: { maxRounds: 3, candidatesPerRound: 2, maxSearchRounds: 2, maxNodes: 20, maxDepth: 3, maxActiveDirections: 2, pruneThreshold: 0.2 },
  },
  graph: { edges: [], nodes: [], objective: "提升膜通量", revision: 4, treeId: "tree-1", updatedAt: "2026-11-18T00:00:00Z" },
};

function fakeClient(streamBody?: string) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const stub = {
    calls,
    request: async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
      if (path.includes("/idea-tree/graph")) return { graph: VIEW.graph, hasIdeaTreeRun: true, treeIds: ["tree-1"] };
      return VIEW;
    },
    fetchStream: async () => new Response(streamBody ?? "", { status: 200, headers: { "content-type": "text/event-stream" } }),
  };
  return stub as unknown as ApiClient & { calls: typeof calls };
}

test("the list route accepts both shapes the engine has answered with", async () => {
  const api = fakeClient();
  const one = await listIdeaResearches(api, "s1");
  assert.equal(one.length, 1);
  assert.equal(one[0]!.research.id, "research-1");

  const listing = { request: async () => ({ items: [VIEW, VIEW] }) } as unknown as ApiClient;
  assert.equal((await listIdeaResearches(listing, "s1")).length, 2);
});

test("control sends one operation with its research id", async () => {
  const api = fakeClient();
  await controlIdeaResearch(api, "s1", "research-1", "pause");
  const call = api.calls.at(-1)!;
  assert.equal(call.path, "/api/sessions/s1/idea-tree/research");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { operation: "pause", researchId: "research-1" });
});

test("the graph route passes a requested tree id through", async () => {
  const api = fakeClient();
  const graph = await getIdeaTreeGraph(api, "s1", "tree-1");
  assert.equal(graph.hasIdeaTreeRun, true);
  assert.match(api.calls.at(-1)!.path, /tree_id=tree-1$/);
});

function treeNode(id: string, parentId: string | null, patch: Record<string, unknown> = {}) {
  return {
    activeExecutionId: null, artifactRefs: [], attemptCount: 0, childrenIds: [], completedResultHandle: null,
    createdAt: "2026-11-18T00:00:00Z", depth: parentId ? 1 : 0, hypothesis: `hypothesis ${id}`, id, insight: null,
    lastExecutionId: null, parentId, priority: 0, pruneReason: null, result: null, score: null,
    searchStatus: "active", status: "pending", stages: {}, updatedAt: "2026-11-18T00:00:00Z", ...patch,
  };
}

function frame(research: unknown, graph: Record<string, unknown>) {
  return `data: ${JSON.stringify({ research, graph: { edges: [], full: false, nodes: [], objective: "提升膜通量", removed: [], treeId: "tree-1", updatedAt: "", ...graph } })}\n\n`;
}

test("the first frame of a stream is the whole tree and later frames are merged into it", async () => {
  const body = [
    frame(VIEW.research, { full: true, revision: 4, nodes: [treeNode("ROOT", null), treeNode("1", "ROOT", { status: "running" })] }),
    frame({ ...VIEW.research, status: "completed", usageKnown: true, tokens: 1200 }, {
      revision: 9, since: 4,
      nodes: [treeNode("1", "ROOT", { status: "done", score: 8 })],
      edges: [{ ordinal: 1, source: "ROOT", target: "1", type: "child" }],
    }),
  ].join("");
  const api = fakeClient(body);
  const seen: IdeaResearchView[] = [];
  await subscribeIdeaResearchEvents(api, "s1", "research-1", (view) => seen.push(view));
  assert.equal(seen.length, 2, "each frame is reported once");
  assert.deepEqual(seen[0]!.graph.nodes.map((node) => node.id), ["ROOT", "1"], "the first frame is the whole tree");
  assert.equal(seen[0]!.graph.nodes[1]!.status, "running");
  assert.deepEqual(seen[1]!.graph.nodes.map((node) => [node.id, node.status, node.score]), [["ROOT", "pending", null], ["1", "done", 8]],
    "the delta replaces the node it names and keeps the rest");
  assert.equal(seen[1]!.research.status, "completed", "the last frame carries the resting state");
  assert.deepEqual(seen[1]!.graph.edges, [{ ordinal: 1, source: "ROOT", target: "1", type: "child" }]);
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0, "a merged frame needs no refetch");
});

test("a delta the held tree is too old for refetches a whole view instead of losing nodes", async () => {
  // The frames between these two were lost, so their nodes would never reach the
  // panel: `since` 7 is newer than the revision 4 the first frame carried.
  const body = [
    frame(VIEW.research, { full: true, revision: 4, nodes: [treeNode("ROOT", null)] }),
    frame(VIEW.research, { revision: 9, since: 7, nodes: [treeNode("2", "ROOT")] }),
  ].join("");
  const operations: string[] = [];
  const stub = {
    request: async (_path: string, init?: { body?: string }) => {
      operations.push((JSON.parse(init!.body!) as { operation: string }).operation);
      // A whole read answers at the current revision, which is what makes the
      // pending delta applicable again.
      return {
        research: VIEW.research,
        graph: { edges: [], nodes: [treeNode("ROOT", null), treeNode("1", "ROOT"), treeNode("2", "ROOT")], objective: "提升膜通量", revision: 9, treeId: "tree-1", updatedAt: "" },
      };
    },
    fetchStream: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  } as unknown as ApiClient;
  const seen: IdeaResearchView[] = [];
  await subscribeIdeaResearchEvents(stub, "s1", "research-1", (view) => seen.push(view));
  assert.deepEqual(operations, ["get"], "one whole read recovers the lost frames");
  assert.deepEqual(seen.map((view) => view.graph.nodes.map((node) => node.id)), [["ROOT"], ["ROOT", "1", "2"]]);
});

test("a frame queued behind the gap and older than the read leaves the resting state alone", async () => {
  // After the read reports paused at revision 7, the stream still delivers frames
  // from revision 6: the queued stale one, then the terminal one. The stale frame
  // must not roll the panel back to a live state, and the terminal frame must still
  // land — including the variant where the terminal frame never arrives.
  const paused = { ...VIEW.research, status: "paused", usageKnown: true, tokens: 40 };
  const stale = frame(VIEW.research, { revision: 6, since: 5, nodes: [treeNode("1", "ROOT", { insight: "stale" })] });
  const terminal = frame({ ...VIEW.research, status: "completed" }, {
    revision: 7, since: 6, nodes: [treeNode("1", "ROOT", { status: "done", score: 9, insight: "final" })],
  });
  for (const body of [
    [frame(VIEW.research, { full: true, revision: 4, nodes: [treeNode("ROOT", null)] }), frame(VIEW.research, { revision: 5, since: 7 }), stale].join(""),
    [frame(VIEW.research, { full: true, revision: 4, nodes: [treeNode("ROOT", null)] }), frame(VIEW.research, { revision: 5, since: 7 }), stale, terminal].join(""),
  ]) {
    const stub = {
      request: async () => ({
        research: paused,
        graph: { edges: [], nodes: [treeNode("ROOT", null), treeNode("1", "ROOT", { insight: "newer" })], objective: "提升膜通量", revision: 7, treeId: "tree-1", updatedAt: "2026-11-18T00:10:00Z" },
      }),
      fetchStream: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    } as unknown as ApiClient;
    const seen: IdeaResearchView[] = [];
    await subscribeIdeaResearchEvents(stub, "s1", "research-1", (view) => seen.push(view));
    const last = seen.at(-1)!;
    const terminalArrived = body.includes('"completed"');
    assert.equal(last.research.status, terminalArrived ? "completed" : "paused",
      "the stale frame changes nothing; the terminal frame still applies");
    assert.equal(last.graph.revision, 7, "the view never goes back to revision 6");
    assert.equal(last.graph.nodes.find((node) => node.id === "1")!.insight, terminalArrived ? "final" : "newer",
      "the stale node is not re-applied");
  }
});

test("a gap filled by a whole read does not roll the view back to the older frame", async () => {
  // The research paused at revision 7 while the gapped frame still says `running`
  // at revision 5. Merging that frame would show a finished research as live again
  // and re-apply its nodes, and the terminal frame that follows is exactly what a
  // dropped connection may have already lost.
  const paused = { ...VIEW.research, status: "paused", usageKnown: true, tokens: 40 };
  const body = [
    frame(VIEW.research, { full: true, revision: 4, nodes: [treeNode("ROOT", null)] }),
    frame(VIEW.research, { revision: 5, since: 7, nodes: [treeNode("1", "ROOT", { insight: "stale" })] }),
  ].join("");
  const stub = {
    request: async () => ({
      research: paused,
      graph: { edges: [], nodes: [treeNode("ROOT", null), treeNode("1", "ROOT", { insight: "newer" })], objective: "提升膜通量", revision: 7, treeId: "tree-1", updatedAt: "2026-11-18T00:10:00Z" },
    }),
    fetchStream: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  } as unknown as ApiClient;
  const seen: IdeaResearchView[] = [];
  await subscribeIdeaResearchEvents(stub, "s1", "research-1", (view) => seen.push(view));
  const last = seen.at(-1)!;
  assert.equal(last.research.status, "paused", "the state the read reported is not rolled back");
  assert.equal(last.graph.revision, 7, "nor is its revision");
  assert.equal(last.graph.updatedAt, "2026-11-18T00:10:00Z", "nor its timestamp");
  assert.equal(last.graph.nodes.find((node) => node.id === "1")!.insight, "newer", "the stale node is not re-applied");
});
