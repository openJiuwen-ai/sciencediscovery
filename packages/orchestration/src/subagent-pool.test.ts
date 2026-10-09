import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { SubagentPool } from "./subagent-pool.js";

test("permits cover the full child lifetime, roll FIFO and release once", async () => {
  const pool = new SubagentPool(1);
  const signal = new AbortController().signal;
  const first = await pool.acquire(signal);
  const order: number[] = [];
  const second = pool.acquire(signal).then((release) => { order.push(2); return release; });
  const third = pool.acquire(signal).then((release) => { order.push(3); return release; });
  await Promise.resolve();
  assert.deepEqual(order, []);
  first(); first();
  const releaseSecond = await second;
  assert.deepEqual(order, [2]);
  releaseSecond();
  (await third)();
  assert.deepEqual(order, [2, 3]);
});

test("cancelled queued work is removed and never consumes a permit", async () => {
  const pool = new SubagentPool(1);
  const signal = new AbortController().signal;
  const release = await pool.acquire(signal);
  const controller = new AbortController();
  const waiting = pool.acquire(controller.signal);
  const rejected = assert.rejects(waiting, /cancelled/);
  controller.abort(new Error("cancelled"));
  await rejected;
  assert.throws(() => pool.acquire(controller.signal), /cancelled/);
  release();
  (await pool.acquire(signal))();
});

test("parallel tasks never exceed the configured limit, including after failure", async () => {
  const pool = new SubagentPool(2);
  let running = 0, peak = 0;
  const results = await Promise.allSettled(Array.from({ length: 8 }, async (_, index) => {
    const release = await pool.acquire(new AbortController().signal);
    running++; peak = Math.max(peak, running);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (index === 1) throw new Error("child failed");
    } finally { running--; release(); }
  }));
  assert.equal(peak, 2);
  assert.equal(running, 0);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});
