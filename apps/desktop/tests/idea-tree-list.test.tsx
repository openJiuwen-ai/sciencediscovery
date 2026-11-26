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

function Harness({ client, sessionId = "s1", onState }: { client: ApiClient; sessionId?: string; onState: (state: State) => void }) {
  const state = useIdeaResearches(client, sessionId);
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

test("a resumed research replaces the stale entry and goes back on the poll", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const api = fakeClient({ status: "interrupted" });
  let latest!: State;
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(Harness, { client: api, onState: (state) => { latest = state; } })); });
  await act(async () => { await flush(); });
  const afterLoad = api.calls;
  assert.equal(latest.views[0]?.research.status, "interrupted");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.equal(api.calls, afterLoad, "interrupted is not live, so the list has stopped asking");

  // Exactly what the panel reports after 继续: the view the control call returned.
  await act(async () => { latest.apply(view("running")); });
  assert.equal(latest.views[0]?.research.status, "running", "the answer replaces the snapshot the reader resumed from");
  assert.equal(latest.views.length, 1, "the research is replaced, not added a second time");

  await act(async () => { t.mock.timers.tick(5_000); await flush(); });
  assert.ok(api.calls > afterLoad, "the resumed research counts as live, so the card keeps asking until it ends");
  panel.unmount();
});

test("a snapshot for a research this list does not hold is ignored", async () => {
  const api = fakeClient({ status: "completed" });
  let latest!: State;
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(Harness, { client: api, onState: (state) => { latest = state; } })); });
  await act(async () => { await flush(); });
  // A research this session's list does not contain must not be added to it: the
  // list is the session's set, and a card added from elsewhere outlives whatever
  // the reader moves on to.
  const foreign = { ...view("running"), research: { ...view("running").research, id: "research-2" } };
  await act(async () => { latest.apply(foreign); });
  assert.deepEqual(latest.views.map((item) => item.research.id), ["research-1"]);
  panel.unmount();
});

test("a snapshot from another session is not written into this list", async () => {
  const api = fakeClient({ status: "interrupted" });
  let latest!: State;
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(Harness, { client: api, sessionId: "s1", onState: (state) => { latest = state; } })); });
  await act(async () => { await flush(); });
  const fromOtherSession = { ...view("running"), research: { ...view("running").research, id: "research-1" } };
  await act(async () => { latest.apply(fromOtherSession, "s2"); });
  assert.equal(latest.views[0]?.research.status, "interrupted", "the session that is on screen decides, not the caller");
  panel.unmount();
});

test("a list read that started before the control answer cannot undo it", async () => {
  let release!: () => void;
  let reads = 0;
  const api = {
    request: async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { items: [view("interrupted")] };
    },
  } as unknown as ApiClient;
  let latest!: State;
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(Harness, { client: api, sessionId: "s1", onState: (state) => { latest = state; } })); });
  await act(async () => { await flush(); });
  assert.equal(latest.views[0]?.research.status, "interrupted");

  // A read is in flight — the poll's, or a shell re-list — when the panel answers
  // 继续 with `running`.
  await act(async () => { latest.reload(); await flush(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  await act(async () => { latest.apply(view("running"), "s1"); });
  assert.equal(latest.views[0]?.research.status, "running");

  // That older read answers with the status it saw before the resume.
  await act(async () => { release(); await flush(); });
  assert.equal(
    latest.views[0]?.research.status,
    "running",
    "a read that started before the answer must not put the interrupted status back",
  );
  panel.unmount();
});

/** A client whose second session's read is held open, so a switch can be
 *  observed while that read is still pending (or failing). */
function switchingClient(options: { second: "pending" | "fails" } = { second: "pending" }) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const api = {
    calls: [] as string[],
    release: () => release(),
    request: async (path: string) => {
      api.calls.push(path);
      if (path.includes("/sessions/s1/")) return { items: [{ ...view("completed"), research: { ...view("completed").research, id: "research-a" } }] };
      await held;
      if (options.second === "fails") throw new ApiRequestError("list failed", 500);
      return { items: [{ ...view("completed"), research: { ...view("completed").research, id: "research-b" } }] };
    },
  };
  return api as unknown as ApiClient & { calls: string[]; release: () => void };
}

test("switching sessions drops the previous list while the new read is pending", async () => {
  const api = switchingClient();
  let latest!: State;
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(Harness, { client: api, sessionId: "s1", onState: (state) => { latest = state; } })); });
  await act(async () => { await flush(); });
  assert.deepEqual(latest.views.map((item) => item.research.id), ["research-a"]);

  await act(async () => { panel.update(React.createElement(Harness, { client: api, sessionId: "s2", onState: (state) => { latest = state; } })); });
  await act(async () => { await flush(); });
  assert.deepEqual(latest.views, [], "the previous session's cards are not this session's");
  assert.equal(latest.loads, 0, "no read has finished for the new session, so a command has no baseline to inherit");

  await act(async () => { api.release(); await flush(); });
  assert.deepEqual(latest.views.map((item) => item.research.id), ["research-b"]);
  panel.unmount();
});

test("switching sessions keeps nothing when the new read fails", async () => {
  const api = switchingClient({ second: "fails" });
  let latest!: State;
  let panel!: ReactTestRenderer;
  await act(async () => { panel = create(React.createElement(Harness, { client: api, sessionId: "s1", onState: (state) => { latest = state; } })); });
  await act(async () => { await flush(); });
  assert.equal(latest.views.length, 1);

  await act(async () => { panel.update(React.createElement(Harness, { client: api, sessionId: "s2", onState: (state) => { latest = state; } })); });
  await act(async () => { api.release(); await flush(); });
  assert.deepEqual(latest.views, [], "a failed read is not the previous session's list");
  assert.equal(latest.error, "list failed");
  panel.unmount();
});
