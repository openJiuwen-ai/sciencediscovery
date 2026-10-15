// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { stopAndVerifySession, type SessionSnapshot } from "./session-shutdown.ts";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });

type Run = { id: string; status: string };
const snap = (runs: Run[] = [], executions: Array<{ id: string; state: string }> = [],
  timers: Array<{ id: string; state: string }> = [], stopped = true): SessionSnapshot<Run> => ({
  runs, activity: { agents: [{ agentId: "main", stopped }], executions, timers },
});

test("stops wake admission even when root Run already completed and a timer is pending", async () => {
  let time = 0;
  let stopped = false;
  let timer = "pending";
  const calls: string[] = [];
  const result = await stopAndVerifySession({
    stop: async () => { calls.push("stop"); stopped = true; },
    snapshot: async () => snap([{ id: "root", status: "completed" }], [], [{ id: "timer", state: timer }], stopped),
    cancelRun: async (id) => { calls.push(`run:${id}`); },
    cancelExecution: async (id) => { calls.push(`execution:${id}`); },
    cancelTimer: async (id) => { calls.push(`timer:${id}`); timer = "cancelled"; },
  }, { now: () => time, sleep: async (ms) => { time += ms; }, quietMs: 2, pollMs: 1, timeoutMs: 20 });
  assert.equal(result.status, "stopped");
  assert.deepEqual(calls, ["stop", "timer:timer"]);
  assert.equal(result.wakeGatesClosed, true);
});

test("cancels active shell execution and a late wake Run before declaring quiet", async () => {
  let time = 0;
  let execution = "running";
  let wake = "absent";
  let reads = 0;
  const cancelled: string[] = [];
  const result = await stopAndVerifySession({
    stop: async () => {},
    snapshot: async () => {
      reads += 1;
      if (reads === 3) wake = "running";
      return snap([{ id: "root", status: "completed" }, ...(wake === "absent" ? [] : [{ id: "wake", status: wake }])],
        [{ id: "shell", state: execution }]);
    },
    cancelRun: async (id) => { cancelled.push(id); wake = "cancelled"; },
    cancelExecution: async (id) => { cancelled.push(id); execution = "cancelled"; },
    cancelTimer: async () => {},
  }, { now: () => time, sleep: async (ms) => { time += ms; }, quietMs: 3, pollMs: 1, timeoutMs: 20 });
  assert.equal(result.status, "stopped");
  assert.deepEqual(cancelled, ["shell", "wake"]);
  assert.ok(reads >= 6);
});

test("failed snapshots never become an empty successful shutdown", async () => {
  let time = 0;
  const result = await stopAndVerifySession({
    stop: async () => { throw new Error("stop unavailable"); },
    snapshot: async (): Promise<SessionSnapshot<Run>> => { throw new Error("read unavailable"); },
    cancelRun: async () => {}, cancelExecution: async () => {}, cancelTimer: async () => {},
  }, { now: () => time, sleep: async (ms) => { time += ms; }, quietMs: 2, pollMs: 1, timeoutMs: 3 });
  assert.equal(result.status, "unverified");
  assert.equal(result.runs, null);
  assert.ok(result.errors.some((error) => error.includes("read unavailable")));
});

test("active work at the deadline is a cleanup failure", async () => {
  let time = 0;
  const result = await stopAndVerifySession({
    stop: async () => {},
    snapshot: async () => snap([{ id: "root", status: "running" }]),
    cancelRun: async () => {}, cancelExecution: async () => {}, cancelTimer: async () => {},
  }, { now: () => time, sleep: async (ms) => { time += ms; }, quietMs: 2, pollMs: 1, timeoutMs: 3 });
  assert.equal(result.status, "cleanup_failed");
  assert.deepEqual(result.activeRuns, [{ id: "root", status: "running" }]);
});


test("a cancel endpoint failure is retried, never treated as stopped while the execution remains active", async () => {
  let time = 0;
  let attempts = 0;
  let execution = "running";
  const result = await stopAndVerifySession({
    stop: async () => {},
    snapshot: async () => snap([], [{ id: "shell", state: execution }]),
    cancelRun: async () => {},
    cancelExecution: async () => { attempts += 1; if (attempts < 2) throw new Error("cancel failed"); execution = "cancelled"; },
    cancelTimer: async () => {},
  }, { now: () => time, sleep: async (ms) => { time += ms; }, quietMs: 2, pollMs: 1, timeoutMs: 10 });
  assert.equal(result.status, "stopped");
  assert.equal(attempts, 2);
  assert.ok(result.errors.some((error) => error.includes("cancel failed")));
});
