// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { ApiRequestError, type ApiClient } from "../src/api/client.js";
import { useIdeaResearches } from "../src/app/use-idea-researches.js";

type State = ReturnType<typeof useIdeaResearches>;

function view(status: string) {
  return {
    research: {
      id: "research-1", objective: "目标", status, phase: "building_tree", round: 1, batch: [],
      batchCompleted: 0, tokens: 0, usageKnown: false, reason: null, modelId: "m", currentNodeId: null,
      settings: { maxRounds: 3, candidatesPerRound: 2, maxSearchRounds: 2, maxNodes: 20, maxDepth: 3, maxActiveDirections: 2, pruneThreshold: 0.2 },
    },
    graph: { edges: [], nodes: [], objective: "目标", revision: 1, treeId: "t", updatedAt: "2026-11-18T00:00:00Z" },
  };
}

function fakeClient(options: { unavailable?: boolean; status?: string } = {}) {
  let calls = 0;
  const stub = {
    get calls() { return calls; },
    request: async () => {
      calls += 1;
      if (options.unavailable) throw new ApiRequestError("Evolve is not initialized or unavailable", 503);
      return { items: [view(options.status ?? "completed")] };
    },
  };
  return stub as unknown as ApiClient & { readonly calls: number };
}

async function flush(times = 10): Promise<void> {
  for (let tick = 0; tick < times; tick += 1) await Promise.resolve();
}

function Harness({ client, onState }: { client: ApiClient; onState: (state: State) => void }) {
  const state = useIdeaResearches(client, "s1");
  onState(state);
  return null;
}

test("the list loads the session's researches and is not empty-until-loaded", async () => {
  const api = fakeClient();
  let latest!: State;
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(Harness, { client: api, onState: (state) => { latest = state; } })); });
  await act(async () => { await flush(); });
  assert.equal(latest.views.length, 1);
  assert.equal(latest.unavailable, false);
  assert.equal(latest.error, undefined);
  panel.unmount();
});

test("a 503 is reported as a prerequisite rather than an empty list", async () => {
  const api = fakeClient({ unavailable: true });
  let latest!: State;
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(Harness, { client: api, onState: (state) => { latest = state; } })); });
  await act(async () => { await flush(); });
  assert.equal(latest.unavailable, true);
  assert.deepEqual(latest.views, []);
  panel.unmount();
});

test("an idle session does not poll for updates", async () => {
  const api = fakeClient({ status: "completed" });
  let latest!: State;
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(Harness, { client: api, onState: (state) => { latest = state; } })); });
  await act(async () => { await flush(); });
  const afterLoad = api.calls;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.equal(api.calls, afterLoad, "nothing live means no timer");
  panel.unmount();
});
