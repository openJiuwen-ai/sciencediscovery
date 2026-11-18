// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { ApiRequestError, type ApiClient } from "../src/api/client.js";
import { IdeaResearchPanel } from "../src/views/idea/IdeaResearchPanel.js";
import { TEXT } from "../src/text.js";

const t = TEXT.ideaTree;

function view(status = "running") {
  return {
    research: {
      id: "research-1", objective: "提升膜通量", status, phase: "building_tree", round: 1,
      batch: [], batchCompleted: 0, tokens: 0, usageKnown: false, reason: null, modelId: "m",
      currentNodeId: null,
      settings: { maxRounds: 3, candidatesPerRound: 2, maxSearchRounds: 2, maxNodes: 20, maxDepth: 3, maxActiveDirections: 2, pruneThreshold: 0.2 },
    },
    graph: { edges: [], nodes: [], objective: "提升膜通量", revision: 1, treeId: "tree-1", updatedAt: "2026-11-18T00:00:00Z" },
  };
}

function fakeClient(options: { unavailable?: boolean; streamBody?: string } = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const stub = {
    calls,
    request: async (path: string, init?: { method?: string; body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) as { operation: string } : undefined;
      calls.push({ path, method: init?.method ?? "GET", body });
      if (options.unavailable) throw new ApiRequestError("Evolve is not initialized or unavailable", 503);
      if (body?.operation === "pause") return view("paused");
      return view("running");
    },
    fetchStream: async () => new Response(options.streamBody ?? "", { status: 200, headers: { "content-type": "text/event-stream" } }),
  };
  return stub as unknown as ApiClient & { calls: typeof calls };
}

async function flush(times = 10): Promise<void> {
  for (let tick = 0; tick < times; tick += 1) await Promise.resolve();
}

test("the panel renders the persisted research it was opened on", async () => {
  const api = fakeClient();
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(IdeaResearchPanel, { client: api, sessionId: "s1", researchId: "research-1" })); });
  await act(async () => { await flush(); });
  const text = JSON.stringify(panel.toJSON());
  assert.match(text, /提升膜通量/);
  assert.match(text, /构建假设树/);
  assert.match(text, /token 用量未上报/);
  panel.unmount();
});

test("a 503 is a prerequisite, not an empty tree", async () => {
  const api = fakeClient({ unavailable: true });
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(IdeaResearchPanel, { client: api, sessionId: "s1", researchId: "research-1" })); });
  await act(async () => { await flush(); });
  assert.match(JSON.stringify(panel.toJSON()), /尚未就绪/);
  panel.unmount();
});

test("pause sends one control call and shows the returned state", async () => {
  const api = fakeClient();
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(IdeaResearchPanel, { client: api, sessionId: "s1", researchId: "research-1" })); });
  await act(async () => { await flush(); });
  const button = panel.root.findAll((node) => node.type === "button" && JSON.stringify(node.props.children).includes(t.pause))[0]!;
  await act(async () => { button.props.onClick(); });
  await act(async () => { await flush(); });
  const control = api.calls.filter((call) => call.method === "POST" && (call.body as { operation?: string }).operation === "pause");
  assert.equal(control.length, 1);
  assert.match(JSON.stringify(panel.toJSON()), /已暂停/);
  panel.unmount();
});

test("a live stream frame replaces the view without refetching", async () => {
  const stopped = { ...view("completed"), research: { ...view("running").research, status: "completed", usageKnown: true, tokens: 900 } };
  const api = fakeClient({ streamBody: `data: ${JSON.stringify(stopped)}\n\n` });
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(IdeaResearchPanel, { client: api, sessionId: "s1", researchId: "research-1" })); });
  await act(async () => { await flush(); });
  const before = api.calls.length;
  assert.match(JSON.stringify(panel.toJSON()), /已完成/);
  assert.equal(api.calls.length, before, "the frame is the update; nothing is fetched again");
  panel.unmount();
});
