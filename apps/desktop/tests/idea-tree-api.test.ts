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

test("every stream frame is a whole view, and the last one is the resting state", async () => {
  const stopped = { ...VIEW, research: { ...VIEW.research, status: "completed", usageKnown: true, tokens: 1200 } };
  const body = `data: ${JSON.stringify(VIEW)}\n\ndata: ${JSON.stringify(stopped)}\n\n`;
  const api = fakeClient(body);
  const seen: string[] = [];
  await subscribeIdeaResearchEvents(api, "s1", "research-1", (view) => seen.push(view.research.status));
  assert.deepEqual(seen, ["running", "completed"]);
});
