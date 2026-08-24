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

import type { SessionRun } from "@sciencediscovery/schema";

import { isSessionRunning, runsRequiringEventReplay, shouldApplySessionScopedUpdate } from "../src/App.js";

test("applies stream updates only to the currently visible Session", () => {
  assert.equal(shouldApplySessionScopedUpdate("session-a", "session-a"), true);
  assert.equal(shouldApplySessionScopedUpdate("session-a", "session-b"), false);
  assert.equal(shouldApplySessionScopedUpdate("session-a", undefined), false);
  assert.equal(shouldApplySessionScopedUpdate(undefined, "session-a"), false);
});

test("derives running state from the visible Session only", () => {
  const streamCounts = new Map([
    ["session-a", 1],
    ["session-b", 0],
  ]);

  assert.equal(isSessionRunning("session-a", streamCounts), true);
  assert.equal(isSessionRunning("session-b", streamCounts), false);
  assert.equal(isSessionRunning("session-c", streamCounts), false);
  assert.equal(isSessionRunning(undefined, streamCounts), false);
});

function run(id: string, status: SessionRun["status"], queueOrder: number): SessionRun {
  return {
    annotationIds: [],
    createdAt: `2026-01-01T00:00:0${queueOrder}.000Z`,
    id,
    prompt: id,
    queueOrder,
    references: [],
    sessionId: "session-a",
    settingsSnapshot: {
      enabledConnectorIds: [],
      enabledSkillIds: [],
      modelId: "model-a",
      semanticReviewEnabled: false,
    },
    status,
  };
}

test("reconnects replay streams for queued, running, and blocked runs after refresh", () => {
  assert.deepEqual(
    runsRequiringEventReplay([
      run("completed", "completed", 4),
      run("queued", "queued", 3),
      run("running", "running", 1),
      run("blocked", "blocked", 2),
      run("cancelled", "cancelled", 5),
    ]).map((item) => item.id),
    ["running", "blocked", "queued"],
  );
});
