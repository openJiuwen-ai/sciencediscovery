// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ResourceRateLimiter,
  ResourceRateLimitQueueFullError,
  ResourceRateLimitQueueTimeoutError,
} from "./resource-rate-limiter.js";

const base = {
  maxConcurrent: 2,
  maxQueueDepth: 8,
  minIntervalMs: 0,
  queueTimeoutMs: 5_000,
};

test("enforces maximum concurrency until a lease is released", async () => {
  const limiter = new ResourceRateLimiter();
  const first = await limiter.acquire("res", base);
  const second = await limiter.acquire("res", base);
  let thirdGranted = false;
  const thirdPromise = limiter.acquire("res", base).then((lease) => {
    thirdGranted = true;
    return lease;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(thirdGranted, false);
  first.release();
  const third = await thirdPromise;
  assert.equal(thirdGranted, true);
  assert.ok(third.queueWaitMs >= 0);
  second.release();
  third.release();
});

test("paces grants by the minimum interval and keeps FIFO order", async () => {
  const limiter = new ResourceRateLimiter();
  const options = { ...base, maxConcurrent: 4, minIntervalMs: 40 };
  const started: number[] = [];
  const leases = await Promise.all([0, 1, 2].map(async (index) => {
    const lease = await limiter.acquire("paced", options);
    started.push(index);
    return lease;
  }));
  assert.deepEqual(started, [0, 1, 2]);
  // Three grants spaced 40ms apart: the last one waited at least ~80ms.
  const lastLease = leases.at(-1)!;
  assert.ok(lastLease.queueWaitMs >= 60, `queueWaitMs=${lastLease.queueWaitMs}`);
  for (const lease of leases) lease.release();
});

test("paces grants without imposing a concurrency limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const limiter = new ResourceRateLimiter();
  const first = await limiter.acquire("paced-unlimited", { minIntervalMs: 100 });
  let secondGranted = false;
  const secondPromise = limiter.acquire("paced-unlimited", { minIntervalMs: 100 }).then((lease) => {
    secondGranted = true;
    return lease;
  });
  t.mock.timers.tick(99);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondGranted, false);
  t.mock.timers.tick(1);
  const second = await secondPromise;
  // The first lease is still held, so this grant proves concurrency is unlimited.
  assert.equal(secondGranted, true);
  first.release();
  second.release();
});

test("allows queues deeper than eight when maxQueueDepth is omitted", async () => {
  const limiter = new ResourceRateLimiter();
  const options = { maxConcurrent: 1, minIntervalMs: 0, queueTimeoutMs: 5_000 };
  let current = await limiter.acquire("unbounded-queue", options);
  const queued = Array.from({ length: 12 }, () => limiter.acquire("unbounded-queue", options));
  for (const pending of queued) {
    current.release();
    current = await pending;
  }
  current.release();
});

test("waits indefinitely when queueTimeoutMs is omitted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const limiter = new ResourceRateLimiter();
  const options = { maxConcurrent: 1 };
  const held = await limiter.acquire("no-queue-timeout", options);
  let settled = false;
  const queued = limiter.acquire("no-queue-timeout", options).then((lease) => {
    settled = true;
    return lease;
  });
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  held.release();
  (await queued).release();
});

test("grants continuously when minIntervalMs is omitted", async () => {
  const limiter = new ResourceRateLimiter();
  const options = { maxConcurrent: 2, maxQueueDepth: 0, queueTimeoutMs: 1_000 };
  const first = await limiter.acquire("unpaced", options);
  const second = await limiter.acquire("unpaced", options);
  assert.equal(first.queueWaitMs, 0);
  assert.equal(second.queueWaitMs, 0);
  first.release();
  second.release();
});

test("maxQueueDepth zero still rejects when a request would queue", async () => {
  const limiter = new ResourceRateLimiter();
  const options = { maxConcurrent: 1, maxQueueDepth: 0 };
  const held = await limiter.acquire("zero-queue", options);
  await assert.rejects(
    limiter.acquire("zero-queue", options),
    (error: unknown) => error instanceof ResourceRateLimitQueueFullError && error.queueDepth === 0,
  );
  held.release();
});

test("validates only configured dimensions", async () => {
  const limiter = new ResourceRateLimiter();
  (await limiter.acquire("no-limits", {})).release();
  await assert.rejects(limiter.acquire("invalid-concurrency", { maxConcurrent: 0 }), /maxConcurrent/);
  await assert.rejects(limiter.acquire("invalid-depth", { maxQueueDepth: -1 }), /maxQueueDepth/);
  await assert.rejects(limiter.acquire("invalid-interval", { minIntervalMs: -1 }), /minIntervalMs/);
  await assert.rejects(limiter.acquire("invalid-timeout", { queueTimeoutMs: 0 }), /queueTimeoutMs/);
});

test("fails fast when the queue is full", async () => {
  const limiter = new ResourceRateLimiter();
  const options = { ...base, maxConcurrent: 1, maxQueueDepth: 1 };
  const held = await limiter.acquire("full", options);
  const queued = limiter.acquire("full", options);
  await assert.rejects(
    limiter.acquire("full", options),
    (error: unknown) => error instanceof ResourceRateLimitQueueFullError && error.queueDepth === 1,
  );
  held.release();
  (await queued).release();
});

test("rejects with a queue timeout and later acquires still succeed", async () => {
  const limiter = new ResourceRateLimiter();
  const options = { ...base, maxConcurrent: 1, queueTimeoutMs: 30 };
  const held = await limiter.acquire("slow", options);
  await assert.rejects(
    limiter.acquire("slow", options),
    (error: unknown) => error instanceof ResourceRateLimitQueueTimeoutError && error.queueWaitMs >= 25,
  );
  held.release();
  // The timed-out waiter must not leak a slot or block the queue.
  const next = await limiter.acquire("slow", options);
  next.release();
});

test("abort while queued removes the waiter without leaking the slot", async () => {
  const limiter = new ResourceRateLimiter();
  const options = { ...base, maxConcurrent: 1 };
  const held = await limiter.acquire("abort", options);
  const controller = new AbortController();
  const queued = limiter.acquire("abort", { ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
  held.release();
  const next = await limiter.acquire("abort", options);
  next.release();
});

test("acquire rejects immediately when the signal is already aborted", async () => {
  const limiter = new ResourceRateLimiter();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(limiter.acquire("pre-aborted", { ...base, signal: controller.signal }));
});

test("release is idempotent", async () => {
  const limiter = new ResourceRateLimiter();
  const options = { ...base, maxConcurrent: 1 };
  const first = await limiter.acquire("idempotent", options);
  first.release();
  first.release();
  const second = await limiter.acquire("idempotent", options);
  const thirdPromise = limiter.acquire("idempotent", options);
  let thirdGranted = false;
  void thirdPromise.then(() => { thirdGranted = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // A double release must not have freed a phantom slot.
  assert.equal(thirdGranted, false);
  second.release();
  (await thirdPromise).release();
});

test("empty-queue cooldown fallback honours the pacing of the last acquire", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const limiter = new ResourceRateLimiter();
  const options = { ...base, maxConcurrent: 1, minIntervalMs: 3_000 };
  (await limiter.acquire("fallback", options)).release();
  // Let the pacing window pass so only the cooldown can delay the next grant.
  t.mock.timers.tick(3_500);
  limiter.reportUpstreamRateLimit("fallback");
  let granted = false;
  const next = limiter.acquire("fallback", options).then((lease) => {
    granted = true;
    return lease;
  });
  // A 1s-only fallback would grant here; max(minIntervalMs, 1s) must still hold.
  t.mock.timers.tick(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(granted, false);
  t.mock.timers.tick(1_100);
  (await next).release();
  assert.equal(granted, true);
});

test("empty-queue cooldown fallback remains one second without pacing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const limiter = new ResourceRateLimiter();
  (await limiter.acquire("fallback-unpaced", {})).release();
  limiter.reportUpstreamRateLimit("fallback-unpaced");
  let granted = false;
  const next = limiter.acquire("fallback-unpaced", {}).then((lease) => {
    granted = true;
    return lease;
  });
  t.mock.timers.tick(999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(granted, false);
  t.mock.timers.tick(1);
  (await next).release();
  assert.equal(granted, true);
});

test("upstream 429 cooldown delays the next grant", async () => {
  const limiter = new ResourceRateLimiter();
  const options = { ...base, maxConcurrent: 1 };
  const held = await limiter.acquire("cooldown", options);
  const queuedAt = Date.now();
  const queued = limiter.acquire("cooldown", options);
  limiter.reportUpstreamRateLimit("cooldown", 80);
  held.release();
  const lease = await queued;
  assert.ok(Date.now() - queuedAt >= 60, "grant should wait out the cooldown");
  lease.release();
});
