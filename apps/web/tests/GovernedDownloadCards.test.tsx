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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import type { ArtifactCandidate, ArtifactJob, ArtifactPlan, PermissionRequest } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GovernedDownloadCards } from "../src/GovernedDownloadCards.js";
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";

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
  onDecision: async () => undefined,
  onPrepare: async () => undefined,
  onToggleCard: () => undefined,
  permissionRequests: [],
};

function approvalRequest(state: PermissionRequest["state"]): PermissionRequest {
  return {
    action: "artifact_download",
    createdAt: "2026-08-05T00:00:00.000Z",
    id: "permission-1",
    resource: "artifact:arxiv:candidate-1:workspace:downloads/paper.pdf",
    sessionId: "session-1",
    state,
    summary: "Download paper.pdf to workspace path downloads/paper.pdf",
  };
}

function awaitingApprovalPlan(): ArtifactPlan {
  return {
    candidates: [{ id: "candidate-1", kind: "paper", logicalName: "paper.pdf", sourceId: "arxiv", sourceRecordId: "2501.00001", sourceUrl: "https://arxiv.org/pdf/2501.00001" }] as ArtifactCandidate[],
    createdAt: "2026-08-05T00:00:00.000Z",
    destination: { path: "downloads/paper.pdf", type: "workspace" },
    id: "plan-1",
    mcpInvocationId: "invocation-1",
    permissionRequestId: "permission-1",
    selectedCandidateId: "candidate-1",
    sessionId: "session-1",
    sourceId: "arxiv",
    sourceRecordId: "2501.00001",
    state: "awaiting_approval",
  } as ArtifactPlan;
}

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

test("keeps a failed result and Retry inside the expanded governed download record", () => {
  const html = renderToStaticMarkup(createElement(GovernedDownloadCards, {
    ...common,
    expandedCards: { "governed-downloads:run-1": true },
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

test("offers the pending download's own approval decisions beside the file it covers", () => {
  const html = renderToStaticMarkup(createElement(GovernedDownloadCards, {
    ...common,
    candidates: [],
    jobs: [],
    permissionRequests: [approvalRequest("pending")],
    plans: [awaitingApprovalPlan()],
  }));

  // The card must name who decides and what the permission covers, not say it
  // is "waiting" for an approval nobody can locate.
  assert.match(html, /You must approve this download: paper\.pdf → downloads\/paper\.pdf/);
  assert.match(html, />Allow once<\/button>/);
  assert.match(html, />Allow same type<\/button>/);
  assert.match(html, />Deny<\/button>/);
  assert.doesNotMatch(html, /Waiting for approval/);
});

test("localizes the manual download approval for a Chinese Session", () => {
  const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" },
    createElement(GovernedDownloadCards, {
      ...common,
      candidates: [],
      jobs: [],
      permissionRequests: [approvalRequest("pending")],
      plans: [awaitingApprovalPlan()],
    })));

  assert.match(html, /需要你批准此下载：paper\.pdf → downloads\/paper\.pdf/);
  assert.doesNotMatch(html, /等待审批/);
});

test("reports a decided download instead of an approval that will never arrive", () => {
  for (const [state, expected] of [["denied", "Denied — nothing was downloaded"], ["allowed", "Approved — the download is starting"]] as const) {
    const html = renderToStaticMarkup(createElement(GovernedDownloadCards, {
      ...common,
      candidates: [],
      expandedCards: { "governed-downloads:run-1": true },
      jobs: [],
      permissionRequests: [approvalRequest(state)],
      plans: [awaitingApprovalPlan()],
    }));

    assert.match(html, new RegExp(expected.replaceAll(/[—.]/g, (match) => `\\${match}`)));
    assert.doesNotMatch(html, /Waiting for approval/, `a ${state} download must not keep waiting for approval`);
    assert.doesNotMatch(html, />Deny<\/button>/, `a ${state} download must not still offer a decision`);
  }
});

test("keeps a decided download out of the actions-needed count", () => {
  const html = renderToStaticMarkup(createElement(GovernedDownloadCards, {
    ...common,
    candidates: [],
    jobs: [job("completed")],
    permissionRequests: [approvalRequest("denied")],
    plans: [awaitingApprovalPlan()],
  }));

  assert.match(html, /aria-expanded="false"/, "a resolved approval is history, not work in progress");
  assert.doesNotMatch(html, /actions needed|action needed/);
});
