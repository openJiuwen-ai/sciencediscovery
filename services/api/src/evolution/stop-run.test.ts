// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { stopEvolveRunForSession, type StopEvolveRunDeps } from "./stop-run.js";

const isActive = (status: string): boolean => status === "running" || status === "pending";

function deps(over: Partial<StopEvolveRunDeps> = {}): { d: StopEvolveRunDeps; stopped: string[] } {
  const stopped: string[] = [];
  const base: StopEvolveRunDeps = {
    isActive,
    listRuns: async () => [{ id: "run-mine", status: "running" }],
    readRun: async (id) => (id === "run-mine" ? { id, sessionId: "s1", status: "running" } : undefined),
    sessionId: "s1",
    stop: async (id) => { stopped.push(id); },
    ...over,
  };
  return { d: base, stopped };
}

test("an active search is stopped and the answer says so", async () => {
  const { d, stopped } = deps();
  assert.deepEqual(await stopEvolveRunForSession("run-mine", d),
    { runId: "run-mine", status: "stopping", stopping: true });
  assert.deepEqual(stopped, ["run-mine"]);
});

test("a finished search reports its final status and is not stopped again", async () => {
  // The caller races the terminal event constantly: the card says "running",
  // the run finished a moment ago. Here stop() must not be called at all.
  const { d, stopped } = deps({
    readRun: async (id) => ({ id, sessionId: "s1", status: "succeeded" }),
  });
  assert.deepEqual(await stopEvolveRunForSession("run-mine", d),
    { runId: "run-mine", status: "succeeded", stopping: false });
  assert.deepEqual(stopped, [], "a terminal run must not reach the orchestrator");
});

test("a run belonging to another session is refused and is not stopped", async () => {
  const { d, stopped } = deps({
    readRun: async (id) => ({ id, sessionId: "someone-else", status: "running" }),
  });
  await assert.rejects(() => stopEvolveRunForSession("run-mine", d), /no such search in this session/);
  assert.deepEqual(stopped, [], "another session's run is not this session's to stop");
});

test("an unknown id answers with the searches this session does have", async () => {
  const { d, stopped } = deps({
    listRuns: async () => [
      { id: "run-a", status: "succeeded" },
      { id: "run-b", status: "running" },
    ],
  });
  await assert.rejects(() => stopEvolveRunForSession("made-up", d),
    /no such search in this session: made-up\. The searches in this session: run-a（succeeded）、run-b（running）/);
  assert.deepEqual(stopped, []);
});

test("a session with no searches says so instead of listing nothing", async () => {
  const { d } = deps({ listRuns: async () => [] });
  await assert.rejects(() => stopEvolveRunForSession("made-up", d),
    /This session has no searches yet\./);
});

test("a subtask:evolve: handle is resolved to its run id", async () => {
  const { d, stopped } = deps();
  const result = await stopEvolveRunForSession("subtask:evolve:run-mine", d);
  assert.equal(result.runId, "run-mine");
  assert.deepEqual(stopped, ["run-mine"]);
});