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
import { test } from "node:test";

import type { ModelInvocationUsage } from "@sciencediscovery/schema";

import { summarizeGlobalModelUsage, summarizeModelUsage } from "./model-usage.js";

function usage(overrides: Partial<ModelInvocationUsage>): ModelInvocationUsage {
  return {
    attemptIndex: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    finishedAt: "2026-01-01T00:00:01.000Z",
    id: `usage-${overrides.invocationKind ?? "task"}-${overrides.attemptIndex ?? 0}`,
    inputTokens: 10,
    invocationId: `invocation-${overrides.invocationKind ?? "task"}`,
    invocationKind: "task",
    model: "test-model",
    modelProfileId: "model-a",
    modelProfileName: "Model A",
    outputTokens: 5,
    projectId: "project-a",
    runId: "run-a",
    sessionId: "session-a",
    startedAt: "2026-01-01T00:00:00.000Z",
    totalTokens: 15,
    usageStatus: "reported",
    ...overrides,
  };
}

test("USG-003 usage summary aggregates task, semantic review, and paper vision invocations", () => {
  const summary = summarizeModelUsage("session-a", [
    usage({ invocationKind: "task", startedAt: "2026-01-01T00:00:00.000Z", totalTokens: 15 }),
    usage({ invocationKind: "semantic-review", modelProfileId: "model-b", modelProfileName: "Model B", runId: "run-a", startedAt: "2026-01-01T00:00:01.000Z", totalTokens: 9 }),
    usage({ invocationKind: "paper-vision", runId: undefined, startedAt: "2026-01-01T00:00:02.000Z", totalTokens: 6 }),
  ]);

  assert.equal(summary.totals.invocationCount, 3);
  assert.equal(summary.totals.totalTokens, 30);
  assert.equal(summary.byInvocationKind.find((bucket) => bucket.key === "task")?.totalTokens, 15);
  assert.equal(summary.byInvocationKind.find((bucket) => bucket.key === "semantic-review")?.totalTokens, 9);
  assert.equal(summary.byInvocationKind.find((bucket) => bucket.key === "paper-vision")?.totalTokens, 6);
  assert.equal(summary.byModel.find((bucket) => bucket.key === "model-a")?.totalTokens, 21);
  assert.equal(summary.byModel.find((bucket) => bucket.key === "model-b")?.totalTokens, 9);
  assert.equal(summary.byRun.find((bucket) => bucket.key === "run-a")?.totalTokens, 24);
  assert.equal(summary.latestInvocation?.invocationKind, "paper-vision");
});

test("USG-004 reported token usage remains visible when model pricing is unavailable", () => {
  const summary = summarizeModelUsage("session-a", [usage({ costUsd: null, totalTokens: 15 })]);

  assert.equal(summary.totals.totalTokens, 15);
  assert.equal(summary.totals.costUsd, null);
  assert.equal(summary.byModel[0]?.costUsd, null);
});

test("USG-005 invocation attempts keep a stable invocationId and increment attemptIndex", () => {
  const summary = summarizeModelUsage("session-a", [
    usage({ attemptIndex: 0, invocationId: "logical-call", totalTokens: null, usageStatus: "provider-not-reported", inputTokens: null, outputTokens: null }),
    usage({ attemptIndex: 1, invocationId: "logical-call", totalTokens: 15 }),
  ]);

  assert.deepEqual(summary.invocations.map((record) => record.invocationId), ["logical-call", "logical-call"]);
  assert.deepEqual(summary.invocations.map((record) => record.attemptIndex), [0, 1]);
  assert.equal(summary.totals.reportedInvocationCount, 1);
  assert.equal(summary.totals.unreportedInvocationCount, 1);
});

test("USG-007 cache tokens aggregate without treating missing fields as zero", () => {
  const summary = summarizeModelUsage("session-a", [
    usage({ cacheReadTokens: 8, cacheWriteTokens: 2, totalTokens: 15 }),
    usage({ cacheReadTokens: null, cacheWriteTokens: null, inputTokens: 4, outputTokens: 1, totalTokens: 5 }),
  ]);

  assert.equal(summary.totals.cacheReadTokens, 8);
  assert.equal(summary.totals.cacheWriteTokens, 2);
  assert.equal(summary.totals.inputTokens, 14);
  assert.equal(summary.totals.totalTokens, 20);
});

test("USG-008 unreported invocations stay unreported instead of showing zero tokens", () => {
  const summary = summarizeModelUsage("session-a", [
    usage({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageStatus: "provider-not-reported",
    }),
  ]);

  assert.equal(summary.totals.totalTokens, null);
  assert.equal(summary.totals.inputTokens, null);
  assert.equal(summary.totals.outputTokens, null);
  assert.equal(summary.totals.unreportedInvocationCount, 1);
  assert.equal(summary.totals.reportedInvocationCount, 0);
});

test("USG-009 global usage drills down model -> project -> session -> run", () => {
  const summary = summarizeGlobalModelUsage([
    usage({ id: "u1", projectId: "project-a", sessionId: "session-a", runId: "run-a", totalTokens: 15 }),
    usage({
      id: "u2",
      invocationKind: "paper-vision",
      modelProfileId: "model-b",
      modelProfileName: "Model B",
      projectId: "project-b",
      sessionId: "session-b",
      runId: undefined,
      totalTokens: 9,
    }),
  ], {
    projectIdBySessionId: new Map([
      ["session-a", "project-a"],
      ["session-b", "project-b"],
    ]),
    projectNameById: new Map([
      ["project-a", "Alpha"],
      ["project-b", "Beta"],
    ]),
    sessionTitleById: new Map([
      ["session-a", "Session A"],
      ["session-b", "Session B"],
    ]),
  });

  assert.equal(summary.totals.totalTokens, 24);
  assert.equal(summary.byModel.length, 2);
  const modelA = summary.byModel.find((group) => group.modelProfileId === "model-a");
  assert.equal(modelA?.projects[0]?.projectName, "Alpha");
  assert.equal(modelA?.projects[0]?.sessions[0]?.sessionTitle, "Session A");
  assert.equal(modelA?.projects[0]?.sessions[0]?.runs[0]?.runId, "run-a");
  assert.equal(modelA?.projects[0]?.sessions[0]?.runs[0]?.invocations.length, 1);
});
