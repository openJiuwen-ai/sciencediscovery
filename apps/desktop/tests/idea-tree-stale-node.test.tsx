// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api/client.js";
import { IdeaResearchPanel } from "../src/views/idea/IdeaResearchPanel.js";

function view(hypothesis: string, status = "running", revision = 1) {
  return {
    research: {
      id: "research-1", objective: "目标", status, phase: "building_tree", round: 1, batch: [],
      batchCompleted: 0, tokens: 0, usageKnown: false, reason: null, modelId: "m", currentNodeId: null,
      settings: { maxRounds: 3, candidatesPerRound: 2, maxSearchRounds: 2, maxNodes: 20, maxDepth: 3, maxActiveDirections: 2, pruneThreshold: 0.2 },
    },
    graph: {
      edges: [], objective: "目标", revision: revision, treeId: "t", updatedAt: "2026-11-18T00:00:00Z",
      nodes: [{
        activeExecutionId: null, artifactRefs: [], attemptCount: 1, childrenIds: [], completedResultHandle: null,
        createdAt: "2026-11-18T00:00:00Z", depth: 0, hypothesis, id: "n1", insight: null, lastExecutionId: null,
        parentId: null, priority: 1, pruneReason: null, result: null, score: 0.4, searchStatus: "active",
        status: "done", updatedAt: "2026-11-18T00:00:00Z", kind: "candidate",
        stages: { design: { text: "旧设计" } },
      }],
    },
  };
}

test("a stream frame replaces the selected node's detail instead of leaving a stale copy", async () => {
  let push: ((frame: string) => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      push = (frame: string) => controller.enqueue(encoder.encode(frame));
    },
  });
  const api = {
    request: async () => view("第一版假设"),
    fetchStream: async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  } as unknown as ApiClient;

  let panel!: ReactTestRenderer;
  const flush = async (times = 10) => { for (let i = 0; i < times; i += 1) await Promise.resolve(); };
  await act(async () => { panel = create(React.createElement(IdeaResearchPanel, { client: api, sessionId: "s1", researchId: "research-1" })); });
  await act(async () => { await flush(); });

  const nodeButton = panel.root.findAll((node) => node.type === "button")[0]!;
  await act(async () => { nodeButton.props.onClick(); });
  assert.match(JSON.stringify(panel.toJSON()), /第一版假设/);

  // The same node id arrives with new content: the detail must follow the view, not the
  // object captured when it was clicked.
  // The first frame of a stream is the whole tree, so it replaces what is on screen
  // at a newer revision instead of arriving as a delta.
  const frame = view("第二版假设", "running", 2);
  await act(async () => { push?.(`data: ${JSON.stringify({ ...frame, graph: { ...frame.graph, full: true, removed: [] } })}\n\n`); await flush(); });
  // Read the detail section itself: the hypothesis also appears in the tree row, so
  // asserting on the whole panel would pass even when the detail went stale.
  const detail = panel.root.findAll((node) => node.props?.className === "idea-node-detail")[0];
  assert.ok(detail, "the detail section is rendered");
  const collect = (instance: { children: Array<unknown> }): string =>
    instance.children.map((child) => (typeof child === "string" ? child : child && typeof child === "object" && "children" in child ? collect(child as { children: Array<unknown> }) : "")).join(" ");
  const text = collect(detail as unknown as { children: Array<unknown> });
  assert.match(text, /第二版假设/);
  assert.equal(text.includes("第一版假设"), false, "the stale node is not kept");
  panel.unmount();
});
