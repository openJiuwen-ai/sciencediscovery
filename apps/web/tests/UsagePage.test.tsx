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
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GlobalModelUsageSummary, ModelInvocationUsage, ModelUsageBucket } from "@science-agent/schema";

import { InvocationTable, RunUsageInline, UsagePage } from "../src/UsagePage.js";
import { formatCompactTokenValue, usageBreakdownLabel, usageInlineLabel, usageInOutLabel } from "../src/usageFormat.js";

function bucket(overrides: Partial<ModelUsageBucket> = {}): ModelUsageBucket {
  return {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    inputTokens: 10,
    invocationCount: 1,
    key: "bucket",
    label: "Bucket",
    outputTokens: 5,
    reportedInvocationCount: 1,
    totalTokens: 15,
    unreportedInvocationCount: 0,
    ...overrides,
  };
}

test("USG-011 usage formatting omits missing token fields instead of unreported", () => {
  assert.equal(formatCompactTokenValue(null), "—");
  assert.equal(formatCompactTokenValue(undefined), "—");
  assert.equal(
    usageInlineLabel(bucket({
      cacheReadTokens: 2_000,
      cacheWriteTokens: null,
      inputTokens: 6_600,
      outputTokens: 102,
    })),
    "input 6.6K / output 102 / cache read 2.0K",
  );
  assert.doesNotMatch(usageInlineLabel(bucket({ cacheWriteTokens: null })), /unreported|cache write/);
  assert.equal(usageInOutLabel(bucket({ cacheReadTokens: 19_000 })), "in 10 · out 5");
  assert.doesNotMatch(usageInOutLabel(bucket({ cacheReadTokens: 19_000 })), /cache/);
  assert.equal(usageBreakdownLabel(bucket({ inputTokens: null, unreportedInvocationCount: 1 })), "out 5");
});

test("USG-012 usage page renders model drilldown and inline/table usage", () => {
  const invocation: ModelInvocationUsage = {
    attemptIndex: 0,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    costUsd: null,
    finishedAt: "2026-08-03T06:40:00.000Z",
    id: "usage-a",
    inputTokens: 10,
    invocationId: "invocation-a",
    invocationKind: "task",
    model: "model-a",
    modelProfileId: "model-a",
    modelProfileName: "Model A",
    outputTokens: 5,
    runId: "run-a",
    sessionId: "session-a",
    startedAt: "2026-08-03T06:39:00.000Z",
    totalTokens: 15,
    usageStatus: "reported",
  };
  const summary: GlobalModelUsageSummary = {
    byModel: [{
      bucket: bucket({ key: "model-a", label: "Model A" }),
      model: "model-a",
      modelProfileId: "model-a",
      modelProfileName: "Model A",
      projects: [{
        bucket: bucket({ key: "project-a", label: "Alpha" }),
        projectId: "project-a",
        projectName: "Alpha",
        sessions: [{
          bucket: bucket({ key: "session-a", label: "Session A" }),
          runs: [{
            bucket: bucket({ key: "run-a", label: "run-a" }),
            invocations: [invocation],
            runId: "run-a",
          }],
          sessionId: "session-a",
          sessionTitle: "Session A",
        }],
      }],
    }],
    totals: bucket({ key: "global", label: "All models", invocationCount: 1 }),
  };

  const page = renderToStaticMarkup(React.createElement(UsagePage, {
    onOpenSession: () => undefined,
    summary,
  }));
  assert.match(page, /Model usage/);
  assert.match(page, /Model A/);
  assert.match(page, /Alpha/);

  const loading = renderToStaticMarkup(React.createElement(UsagePage, {
    onOpenSession: () => undefined,
    summary: undefined,
  }));
  assert.match(loading, /Loading usage/);
  assert.doesNotMatch(loading, /No usage yet/);

  const empty = renderToStaticMarkup(React.createElement(UsagePage, {
    onOpenSession: () => undefined,
    summary: { byModel: [], totals: bucket({ key: "global", label: "All models", invocationCount: 0 }) },
  }));
  assert.match(empty, /No usage yet/);

  const inline = renderToStaticMarkup(React.createElement(RunUsageInline, {
    run: { bucket: bucket({ unreportedInvocationCount: 1, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null }), runId: "run-abcdef01" },
  }));
  assert.match(inline, /Usage:/);
  assert.match(inline, /input 10/);
  assert.match(inline, /output 5/);
  assert.doesNotMatch(inline, /cache read/);
  assert.doesNotMatch(inline, /cache write/);
  assert.doesNotMatch(inline, /unreported/);
  assert.doesNotMatch(inline, /Latest run usage/);
  assert.equal(renderToStaticMarkup(React.createElement(RunUsageInline, {})), "");

  const table = renderToStaticMarkup(React.createElement(InvocationTable, { invocations: [invocation] }));
  assert.match(table, /<table/);
  assert.match(table, /Cache read/);
  assert.match(table, /Cache write/);
  assert.match(table, /task/);
});
