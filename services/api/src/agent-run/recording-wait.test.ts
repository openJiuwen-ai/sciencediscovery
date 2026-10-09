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
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { recordingStage, waitForRecording } from "./recording-wait.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("recording wait preserves results and rejects immediately for an already aborted signal", async () => {
  const controller = new AbortController();
  assert.equal(await waitForRecording(Promise.resolve(42), controller.signal), 42);
  controller.abort(new Error("cancelled"));
  let fail!: (error: Error) => void;
  const work = new Promise<void>((_resolve, reject) => { fail = reject; });
  await assert.rejects(waitForRecording(work, controller.signal), /cancelled/);
  fail(new Error("late failure"));
  await new Promise(resolve => setImmediate(resolve));
});

test("slow recording logs cancellation and actual completion without enabling verbose tracing or exposing payloads", { timeout: 3000 }, async (t) => {
  const previous = process.env.SCIENCE_AGENT_TRACE_GATEWAY_PROGRESS;
  delete process.env.SCIENCE_AGENT_TRACE_GATEWAY_PROGRESS;
  t.after(() => {
    if (previous === undefined) delete process.env.SCIENCE_AGENT_TRACE_GATEWAY_PROGRESS;
    else process.env.SCIENCE_AGENT_TRACE_GATEWAY_PROGRESS = previous;
  });
  const records: Array<Record<string, unknown>> = [];
  let pending!: () => void;
  const observed = new Promise<void>(resolve => { pending = resolve; });
  t.mock.method(console, "warn", (line: string) => {
    records.push(JSON.parse(line.slice("[recording-progress] ".length)));
    if (records.at(-1)?.event === "pending") pending();
  });
  let release!: (value: string) => void;
  const operation = new Promise<string>(resolve => { release = resolve; });
  const controller = new AbortController();
  const work = recordingStage("workspace_snapshot", { trajectoryId: "trajectory-test" }, () => operation, controller.signal, 10);
  // Keep the event loop alive while waiting for the unref'ed diagnostic timer.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await observed;
    controller.abort();
    release("private research payload");
    assert.equal(await work, "private research payload");
    assert.ok(records.some(record => record.event === "abort_requested"));
    assert.equal(records.at(-1)?.event, "completed");
    assert.equal(records.at(-1)?.aborted, true);
    assert.equal(new Set(records.map(record => record.operationId)).size, 1);
    assert.ok(records.every(record => record.trajectoryId === "trajectory-test"));
    assert.ok(!JSON.stringify(records).includes("private research payload"));
  } finally { release("cleanup"); await work; clearInterval(keepAlive); }
});
