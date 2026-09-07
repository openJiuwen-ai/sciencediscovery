// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  resolveMaxParallelToolCalls,
  scheduleToolCalls,
  type ToolExecutionMode,
} from "./tool-scheduler.js";

interface Call { id: number; mode: ToolExecutionMode }

test("rolling pool never exceeds maxParallelToolCalls", async () => {
  const calls = Array.from({ length: 1_000 }, (_, id): Call => ({ id, mode: "parallel" }));
  let active = 0;
  let peak = 0;
  const committed: number[] = [];
  const results = await scheduleToolCalls({
    calls,
    classify: (call) => call.mode,
    execute: async (call) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return call.id;
    },
    maxParallelToolCalls: 10,
    onResult: (_call, result) => committed.push(result),
    signal: new AbortController().signal,
  });
  assert.equal(peak, 10);
  assert.deepEqual(results, calls.map((call) => call.id));
  assert.deepEqual(committed, calls.map((call) => call.id));
});

test("rolling pool starts the next call as soon as one slot becomes free", async () => {
  const releases = new Map<number, () => void>();
  const started: number[] = [];
  const running = scheduleToolCalls({
    calls: [0, 1, 2],
    classify: () => "parallel",
    execute: (id) => new Promise<number>((resolve) => {
      started.push(id);
      releases.set(id, () => resolve(id));
    }),
    maxParallelToolCalls: 2,
    signal: new AbortController().signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  releases.get(0)!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  releases.get(1)!();
  releases.get(2)!();
  assert.deepEqual(await running, [0, 1, 2]);
});

test("out-of-order completion still commits in model order", async () => {
  const releases = new Map<number, () => void>();
  const committed: number[] = [];
  const running = scheduleToolCalls({
    calls: [0, 1, 2], classify: () => "parallel",
    execute: (id) => new Promise<number>((resolve) => releases.set(id, () => resolve(id))),
    maxParallelToolCalls: 3,
    onResult: (_call, result) => committed.push(result),
    signal: new AbortController().signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  releases.get(2)!();
  releases.get(1)!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(committed, []);
  releases.get(0)!();
  assert.deepEqual(await running, [0, 1, 2]);
});

test("exclusive calls drain the pool and bar later calls", async () => {
  const calls: Call[] = [
    { id: 0, mode: "parallel" }, { id: 1, mode: "parallel" },
    { id: 2, mode: "exclusive" }, { id: 3, mode: "parallel" },
  ];
  const active = new Set<number>();
  const starts: Array<{ active: number[]; id: number }> = [];
  await scheduleToolCalls({
    calls, classify: (call) => call.mode,
    execute: async (call) => {
      starts.push({ active: [...active], id: call.id });
      active.add(call.id);
      await new Promise((resolve) => setImmediate(resolve));
      active.delete(call.id);
      return call.id;
    },
    maxParallelToolCalls: 2,
    signal: new AbortController().signal,
  });
  assert.deepEqual(starts.map((entry) => entry.id), [0, 1, 2, 3]);
  assert.deepEqual(starts.find((entry) => entry.id === 2)?.active, []);
  assert.deepEqual(starts.find((entry) => entry.id === 3)?.active, []);
});

test("cancellation stops replenishment and drains started calls", async () => {
  const controller = new AbortController();
  const started: number[] = [];
  let active = 0;
  const results = await scheduleToolCalls({
    calls: Array.from({ length: 20 }, (_, id) => id), classify: () => "parallel",
    execute: async (id) => {
      started.push(id);
      active += 1;
      if (started.length === 3) controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return id;
    },
    maxParallelToolCalls: 3,
    signal: controller.signal,
  });
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(results, [0, 1, 2]);
  assert.equal(active, 0);
});

test("configuration defaults and validates", () => {
  assert.equal(resolveMaxParallelToolCalls(undefined), DEFAULT_MAX_PARALLEL_TOOL_CALLS);
  assert.equal(resolveMaxParallelToolCalls(1), 1);
  for (const value of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => resolveMaxParallelToolCalls(value), /positive integer/u);
  }
});

test("generic scheduler commits undefined results", async () => {
  let committed = 0;
  const results = await scheduleToolCalls<number, undefined>({
    calls: [0], classify: () => "parallel", execute: async () => undefined,
    maxParallelToolCalls: 1,
    onResult: () => { committed += 1; },
    signal: new AbortController().signal,
  });
  assert.deepEqual(results, [undefined]);
  assert.equal(committed, 1);
});
