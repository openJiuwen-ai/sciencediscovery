// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create } from "react-test-renderer";

import type { IdeaTreeGraph } from "@sciencediscovery/schema";
import { ApiRequestError, type ApiClient } from "../src/api/client.js";
import { LegacyIdeaCard, LegacyIdeaTreePanel, useLegacyIdeaTree } from "../src/views/idea/LegacyIdeaTree.js";
import { TEXT } from "../src/text.js";

const t = TEXT.ideaTree;

const graph: IdeaTreeGraph = {
  edges: [{ ordinal: 0, source: "root", target: "leaf", type: "child" }],
  nodes: [
    { activeExecutionId: null, artifactRefs: [], attemptCount: 1, childrenIds: ["leaf"], completedResultHandle: null, createdAt: "2026-11-01T00:00:00Z", depth: 0, hypothesis: "旧版根节点", id: "root", insight: null, lastExecutionId: null, parentId: null, priority: 1, pruneReason: null, result: null, score: null, searchStatus: "active", status: "done", updatedAt: "2026-11-01T00:00:00Z", kind: "direction", stages: {} },
    { activeExecutionId: null, artifactRefs: [], attemptCount: 1, childrenIds: [], completedResultHandle: null, createdAt: "2026-11-01T00:00:00Z", depth: 1, hypothesis: "旧版叶子", id: "leaf", insight: null, lastExecutionId: null, parentId: "root", priority: 2, pruneReason: null, result: null, score: 0.3, searchStatus: "pruned", status: "done", updatedAt: "2026-11-01T00:00:00Z", kind: "candidate", stages: {} },
  ],
  objective: "旧版目标",
  revision: 3,
  treeId: "tree-legacy",
  updatedAt: "2026-11-01T00:00:00Z",
};

async function flush(times = 10): Promise<void> {
  for (let tick = 0; tick < times; tick += 1) await Promise.resolve();
}

function Harness({ client, enabled, onState }: { client: ApiClient; enabled: boolean; onState: (state: ReturnType<typeof useLegacyIdeaTree>) => void }) {
  const state = useLegacyIdeaTree(client, "s1", enabled);
  onState(state);
  return null;
}

test("the legacy graph is read only when the session has no research", async () => {
  const calls: string[] = [];
  const api = {
    request: async (path: string) => { calls.push(path); return { graph, hasIdeaTreeRun: true, treeIds: ["tree-legacy"] }; },
  } as unknown as ApiClient;
  let state!: ReturnType<typeof useLegacyIdeaTree>;
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(React.createElement(Harness, { client: api, enabled: false, onState: (next) => { state = next; } })); });
  await act(async () => { await flush(); });
  assert.equal(calls.length, 0, "a session with researches does not ask the legacy route");
  assert.equal(state.graph, undefined);

  await act(async () => { renderer.update(React.createElement(Harness, { client: api, enabled: true, onState: (next) => { state = next; } })); });
  await act(async () => { await flush(); });
  assert.equal(calls.length, 1);
  assert.equal(state.graph?.nodes.length, 2);
  renderer.unmount();
});

test("a 503 on the legacy route is a prerequisite rather than an empty tree", async () => {
  const api = {
    request: async () => { throw new ApiRequestError("Evolve is not initialized or unavailable", 503); },
  } as unknown as ApiClient;
  let state!: ReturnType<typeof useLegacyIdeaTree>;
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(React.createElement(Harness, { client: api, enabled: true, onState: (next) => { state = next; } })); });
  await act(async () => { await flush(); });
  assert.equal(state.graph, undefined);
  assert.equal(state.error, t.unavailable);
  renderer.unmount();
});

test("the legacy card names the tree rather than a research", async () => {
  let opened = 0;
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(React.createElement(LegacyIdeaCard, { graph, onOpen: () => { opened += 1; } })); });
  const button = renderer.root.findAll((node) => node.type === "button")[0]!;
  assert.match(JSON.stringify(renderer.toJSON()), /旧版假设树/);
  assert.match(JSON.stringify(renderer.toJSON()), /2 个节点/);
  await act(async () => { button.props.onClick(); });
  assert.equal(opened, 1);
  renderer.unmount();
});

test("the legacy panel draws the tree with no lifecycle controls", async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(React.createElement(LegacyIdeaTreePanel, { graph })); });
  const text = JSON.stringify(renderer.toJSON());
  assert.match(text, /旧版目标/);
  assert.match(text, /旧版根节点/);
  assert.equal(renderer.root.findAll((node) => node.type === "button").length, 2, "only the tree's own node buttons");
  renderer.unmount();
});
