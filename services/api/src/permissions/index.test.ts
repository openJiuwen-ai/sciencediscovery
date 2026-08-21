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

import { PermissionDecisionQueue } from "./index.js";

/** A promise plus the handle that settles it, so a test can hold an operation open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, reject, resolve };
}

test("decisions on one Session do not overlap", async () => {
  const queue = new PermissionDecisionQueue();
  const first = deferred();
  let running = 0;
  let maxConcurrent = 0;
  const enter = () => { running += 1; maxConcurrent = Math.max(maxConcurrent, running); };

  const a = queue.run("session-1", async () => { enter(); await first.promise; running -= 1; return "a"; });
  const b = queue.run("session-1", async () => { enter(); running -= 1; return "b"; });

  // b must still be waiting: only the holder of the turn may be inside.
  await Promise.resolve();
  assert.equal(maxConcurrent, 1);

  first.resolve();
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.equal(maxConcurrent, 1);
});

test("waiting decisions run in arrival order", async () => {
  const queue = new PermissionDecisionQueue();
  const gate = deferred();
  const order: string[] = [];

  const held = queue.run("session-1", async () => { await gate.promise; order.push("held"); });
  const queued = ["second", "third", "fourth"].map((label) =>
    queue.run("session-1", async () => { order.push(label); }));

  gate.resolve();
  await Promise.all([held, ...queued]);
  assert.deepEqual(order, ["held", "second", "third", "fourth"]);
});

test("a different Session is not blocked by a busy one", async () => {
  const queue = new PermissionDecisionQueue();
  const blocked = deferred();
  const slow = queue.run("session-1", async () => { await blocked.promise; return "slow"; });

  // Resolves while session-1 is still holding its turn.
  assert.equal(await queue.run("session-2", async () => "independent"), "independent");

  blocked.resolve();
  assert.equal(await slow, "slow");
});

test("a failed decision propagates and still frees the Session", async () => {
  const queue = new PermissionDecisionQueue();
  const failure = new Error("decision write failed");

  await assert.rejects(queue.run("session-1", async () => { throw failure; }), (error) => error === failure);
  // The turn was handed back in `finally`, so the Session is usable again.
  assert.equal(await queue.run("session-1", async () => "after failure"), "after failure");
});

test("a decision queued behind a failing one still runs", async () => {
  const queue = new PermissionDecisionQueue();
  const gate = deferred();

  const failing = queue.run("session-1", async () => { await gate.promise; throw new Error("boom"); });
  const following = queue.run("session-1", async () => "ran anyway");

  gate.resolve();
  await assert.rejects(failing);
  assert.equal(await following, "ran anyway");
});

test("a drained Session leaves no retained state", async () => {
  const queue = new PermissionDecisionQueue();
  const internals = queue as unknown as { holders: Set<string>; waiters: Map<string, unknown> };

  await Promise.all([
    queue.run("session-1", async () => undefined),
    queue.run("session-1", async () => undefined),
    queue.run("session-2", async () => undefined),
  ]);

  assert.equal(internals.holders.size, 0);
  assert.equal(internals.waiters.size, 0);
});
