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

import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  CATALOG_FAILURES_BEFORE_STALE,
  CATALOG_POLL_MS,
  createCatalogPoll,
} from "../src/app/catalog-poll.js";
import type { PanelTimers } from "../src/app/panel-refresh.js";

const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

/** A clock the test moves by hand: the poll is defined by what it does
 *  between intervals, so the test has to own the intervals. */
function fakeClock(): { advance(ms: number): void; pending(): number; timers: PanelTimers } {
  let next = 0;
  let now = 0;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  return {
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...scheduled]) {
        if (entry.at > now) continue;
        scheduled.delete(id);
        entry.callback();
      }
    },
    pending: () => scheduled.size,
    timers: {
      cancel(handle) {
        scheduled.delete(handle as number);
      },
      schedule(callback, delayMs) {
        next += 1;
        scheduled.set(next, { at: now + delayMs, callback });
        return next;
      },
    },
  };
}

/** Reads the test finishes when it chooses: whether the poll stacks requests
 *  or waits for the last one is only visible with a read still in flight. */
function controllableReads() {
  const calls: { resolve(): void; reject(): void }[] = [];
  return {
    calls,
    read: () => new Promise<void>((resolve, reject) => {
      calls.push({ reject, resolve });
    }),
  };
}

/** Let promise callbacks — the poll's settle step — run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("the catalog poll", () => {
  it("reads at once, then once per interval, and never stacks reads", async () => {
    const clock = fakeClock();
    const { calls, read } = controllableReads();
    const poll = createCatalogPoll(read, { hidden: () => false, timers: clock.timers });

    assert.equal(calls.length, 1);
    clock.advance(CATALOG_POLL_MS * 3);
    assert.equal(calls.length, 1, "a read still in flight is not joined by another");

    calls[0]!.resolve();
    await flush();
    assert.equal(clock.pending(), 1);
    clock.advance(CATALOG_POLL_MS - 1);
    assert.equal(calls.length, 1);
    clock.advance(1);
    assert.equal(calls.length, 2);

    poll.stop();
    calls[1]!.resolve();
    await flush();
    assert.equal(clock.pending(), 0, "a stopped poll schedules nothing more");
  });

  it("fetches nothing while the window is hidden and reads once when it is shown", async () => {
    const clock = fakeClock();
    const { calls, read } = controllableReads();
    let hidden = false;
    const poll = createCatalogPoll(read, { hidden: () => hidden, timers: clock.timers });

    assert.equal(calls.length, 1);
    calls[0]!.resolve();
    await flush();
    assert.equal(clock.pending(), 1);

    hidden = true;
    poll.visibilityChanged();
    assert.equal(clock.pending(), 0, "the waiting read is dropped, not deferred");
    clock.advance(CATALOG_POLL_MS * 10);
    assert.equal(calls.length, 1, "a hidden window reads nothing");

    hidden = false;
    poll.visibilityChanged();
    assert.equal(calls.length, 2, "coming back reads at once rather than after an interval");
    calls[1]!.resolve();
    await flush();
    assert.equal(clock.pending(), 1, "and the cadence resumes");
  });

  it("does not schedule the next read when the window goes away mid-read", async () => {
    const clock = fakeClock();
    const { calls, read } = controllableReads();
    let hidden = false;
    const poll = createCatalogPoll(read, { hidden: () => hidden, timers: clock.timers });

    hidden = true;
    calls[0]!.resolve();
    await flush();
    assert.equal(clock.pending(), 0);

    hidden = false;
    poll.visibilityChanged();
    assert.equal(calls.length, 2);
    poll.stop();
  });

  it("counts failures in a row and starts over after a read succeeds", async () => {
    const clock = fakeClock();
    const { calls, read } = controllableReads();
    const counts: number[] = [];
    createCatalogPoll(read, {
      hidden: () => false,
      onFailing: (count) => counts.push(count),
      timers: clock.timers,
    });

    for (let attempt = 0; attempt < CATALOG_FAILURES_BEFORE_STALE; attempt += 1) {
      calls[attempt]!.reject(new Error("the catalog did not answer"));
      await flush();
      clock.advance(CATALOG_POLL_MS);
    }
    assert.deepEqual(counts, [1, 2, 3]);

    calls[3]!.resolve();
    await flush();
    clock.advance(CATALOG_POLL_MS);
    calls[4]!.reject(new Error("the catalog did not answer"));
    await flush();
    assert.deepEqual(counts, [1, 2, 3, 1]);
  });

  it("stays quiet when the panel is opened on a hidden window", async () => {
    const clock = fakeClock();
    const { calls, read } = controllableReads();
    let hidden = true;
    const poll = createCatalogPoll(read, { hidden: () => hidden, timers: clock.timers });

    assert.equal(calls.length, 0);
    hidden = false;
    poll.visibilityChanged();
    assert.equal(calls.length, 1);
    poll.stop();
  });
});
