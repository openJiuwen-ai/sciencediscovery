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

import { createSessionActivity } from "../src/session-activity.js";

test("run activity never counts as an open stream, so a refreshed page still resubscribes", () => {
  const activity = createSessionActivity();
  activity.setRunActivity("session-a", true);
  assert.equal(activity.streamCount("session-a"), 0,
    "a blocked run reported by the server must not look like an existing subscription");
  assert.deepEqual([...activity.runningSessionIds()], ["session-a"], "the indicator still shows running");

  activity.addStream("session-a");
  assert.equal(activity.streamCount("session-a"), 1, "the resumed subscription is counted");
  activity.setRunActivity("session-a", false);
  assert.equal(activity.streamCount("session-a"), 1, "clearing the indicator cannot drop a live stream");
  assert.deepEqual([...activity.runningSessionIds()], ["session-a"]);
});

test("stream counts nest and floor at zero independently of the indicator", () => {
  const activity = createSessionActivity();
  activity.addStream("session-a");
  activity.addStream("session-a");
  assert.equal(activity.streamCount("session-a"), 2);
  assert.equal(activity.removeStream("session-a"), 1);
  assert.equal(activity.removeStream("session-a"), 0);
  assert.equal(activity.removeStream("session-a"), 0, "removal never goes negative");
  assert.deepEqual([...activity.runningSessionIds()], [], "no stream and no active run means not running");

  activity.setRunActivity("session-b", true);
  activity.addStream("session-c");
  assert.deepEqual([...activity.runningSessionIds()].toSorted(), ["session-b", "session-c"],
    "running is the union of open streams and server-reported active runs");
  activity.removeStream("session-c");
  activity.setRunActivity("session-b", false);
  assert.deepEqual([...activity.runningSessionIds()], []);
});
