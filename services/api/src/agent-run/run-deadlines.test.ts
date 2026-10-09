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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { RunDeadlines } from "./run-deadlines.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a run without progress expires on the idle deadline, and says so", async () => {
  let expired = 0;
  const deadlines = new RunDeadlines(0, 60, () => { expired += 1; });
  deadlines.start();
  await pause(30);
  deadlines.progress();
  await pause(40);
  assert.equal(expired, 0, "progress starts the idle deadline again");
  await pause(40);
  assert.equal(expired, 1);
  assert.equal(deadlines.expired, "idle");
  assert.match(deadlines.error().message, /stalled: no gateway progress for 60 ms/);
  deadlines.stop();
});

test("waiting on an approval stops both deadlines until it is released", async () => {
  let expired = 0;
  const deadlines = new RunDeadlines(80, 50, () => { expired += 1; });
  deadlines.start();
  const release = deadlines.beginWait();
  await pause(120);
  assert.equal(expired, 0);
  release();
  await pause(70);
  assert.equal(expired, 1);
  assert.equal(deadlines.expired, "idle");
  deadlines.stop();
});

test("the turn deadline counts only the time the run was not waiting", async () => {
  const deadlines = new RunDeadlines(100, 0, () => undefined);
  deadlines.start();
  await pause(60);
  const release = deadlines.beginWait();
  await pause(100);
  release();
  await pause(20);
  assert.equal(deadlines.expired, undefined);
  await pause(50);
  assert.equal(deadlines.expired, "turn");
  assert.match(deadlines.error().message, /timeout: gateway turn exceeded 100 ms/);
  deadlines.stop();
});
