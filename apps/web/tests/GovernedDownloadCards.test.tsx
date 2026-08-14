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

import type { ArtifactCandidate, ArtifactJob, ArtifactPlan } from "@science-agent/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GovernedDownloadCards } from "../src/GovernedDownloadCards.js";

function job(state: ArtifactJob["state"]): ArtifactJob {
  return {
    attempts: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    error: state === "failed" ? { code: "download_failed", message: "Source unavailable", retryable: true } : undefined,
    id: `job-${state}`,
    maxAttempts: 3,
    permissionAuthorizationId: "authorization-1",
    planId: "plan-1",
    progress: { bytesDownloaded: 1_024, filesCompleted: 0, filesTotal: 1, percent: 25 },
    projectId: "project-1",
    sessionId: "session-1",
    sourceId: "arxiv",
    sourceRecordId: "2501.00001",
    state,
    updatedAt: "2026-08-05T00:01:00.000Z",
  };
}

const common = {
  expandedCards: {},
  groupId: "run-1",
  onAction: async () => undefined,
  onPrepare: async () => undefined,
  onToggleCard: () => undefined,
};

test("renders an actionable candidate in one expanded timeline card", () => {
  const html = renderToStaticMarkup(createElement(GovernedDownloadCards, {
    ...common,
    candidates: [{ candidate: {
      expectedBytes: 2_048,
      format: "pdf",
      id: "candidate-1",
      logicalName: "paper.pdf",
      sourceId: "arxiv",
    } as ArtifactCandidate, invocationId: "invocation-1" }],
    jobs: [],
    plans: [],
  }));

  assert.match(html, /aria-label="Governed downloads"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /paper\.pdf/);
  assert.match(html, />Prepare download<\/button>/);
});

test("keeps a failed result and Retry inside the governed download card", () => {
  const html = renderToStaticMarkup(createElement(GovernedDownloadCards, {
    ...common,
    candidates: [],
    jobs: [job("failed")],
    plans: [{ candidates: [], id: "plan-1", state: "approved" } as unknown as ArtifactPlan],
  }));

  assert.match(html, /Source unavailable/);
  assert.match(html, />Retry<\/button>/);
  assert.doesNotMatch(html, />Cancel<\/button>/);
});

test("collapses a completed historical download by default", () => {
  const html = renderToStaticMarkup(createElement(GovernedDownloadCards, {
    ...common,
    candidates: [],
    jobs: [job("completed")],
    plans: [{ candidates: [], id: "plan-1", state: "approved" } as unknown as ArtifactPlan],
  }));

  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /governed-downloads-body/);
  assert.match(html, /1 completed/);
});
