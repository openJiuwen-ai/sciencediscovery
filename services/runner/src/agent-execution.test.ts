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

import { agentExecutionKey, KeyedTaskQueue } from "./agent-execution.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Session-Agent keys are collision-free and reject missing identities", () => {
  assert.notEqual(agentExecutionKey("a:b", "c"), agentExecutionKey("a", "b:c"));
  assert.throws(() => agentExecutionKey("session", "  "), /Agent ID is required/);
});

test("a Session teardown waits for active Agents and blocks later executions", async () => {
  const queue = new KeyedTaskQueue();
  const running = deferred();
  const releaseRunning = deferred();
  const releaseTeardown = deferred();
  const events: string[] = [];

  const first = queue.run("session:main", async () => {
    events.push("first:start");
    running.resolve();
    await releaseRunning.promise;
    events.push("first:end");
  }, "session");
  await running.promise;

  const teardown = queue.runGroupExclusive("session", async () => {
    events.push("teardown:start");
    await releaseTeardown.promise;
    events.push("teardown:end");
  });
  const later = queue.run("session:subagent", async () => {
    events.push("later:start");
  }, "session");

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseRunning.resolve();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start", "first:end", "teardown:start"]);
  releaseTeardown.resolve();
  await Promise.all([teardown, later]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "teardown:start",
    "teardown:end",
    "later:start",
  ]);
});
