// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { waitUntil } from "./wait-until.ts";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("an accepted first observation returns without pausing", async () => {
  const pauses: number[] = [];
  const value = await waitUntil(() => ({ state: "ready" }), (current) => current.state === "ready", {
    pause: async (ms) => { pauses.push(ms); },
  });
  assert.deepEqual(value, { state: "ready" });
  assert.deepEqual(pauses, []);
});

test("observations repeat until one is accepted, which is returned", async () => {
  const states = ["queued", "running", "completed", "never read"];
  let reads = 0;
  const pauses: number[] = [];
  const value = await waitUntil(async () => states[reads++]!, (state) => state === "completed", {
    intervalMs: 5,
    pause: async (ms) => { pauses.push(ms); },
  });
  assert.equal(value, "completed");
  assert.equal(reads, 3);
  assert.deepEqual(pauses, [5, 5]);
});

test("the deadline counts time, and the failure names the description and the last observed state", async () => {
  let reads = 0;
  const started = performance.now();
  await assert.rejects(
    waitUntil(() => ({ state: "copying", reads: ++reads }), (current) => current.state === "ready", {
      timeoutMs: 60,
      intervalMs: 10,
      description: "Research continuation to finish",
      describe: (current) => `state ${current.state} after read ${current.reads}`,
    }),
    (error: Error) => {
      assert.equal(error.name, "AssertionError");
      assert.match(error.message, /^Research continuation to finish was not reached within 60 ms \(\d+ checks in \d+ ms\)/);
      // The last read happens after the deadline, so the message reports the final state.
      assert.ok(error.message.endsWith(`last observed: state copying after read ${reads}`), error.message);
      return true;
    },
  );
  assert.ok(performance.now() - started >= 60);
});

test("a slow observation still gets the whole deadline instead of a share of an attempt count", async () => {
  let reads = 0;
  const value = await waitUntil(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return ++reads;
  }, (count) => count === 4, { intervalMs: 1, timeoutMs: 10_000 });
  assert.equal(value, 4);
});

test("an observation that throws fails the wait at once", async () => {
  let reads = 0;
  const failure = new Error("GET /runs -> 500");
  await assert.rejects(waitUntil(() => { reads++; throw failure; }, () => true), (error) => error === failure);
  assert.equal(reads, 1);
});

test("a long last observation is shortened in the failure message", async () => {
  await assert.rejects(waitUntil(() => "x".repeat(5_000), () => false, { timeoutMs: 1, describe: (value) => value }), (error: Error) => {
    assert.ok(error.message.endsWith("x…"));
    assert.ok(error.message.length < 2_200);
    return true;
  });
});
