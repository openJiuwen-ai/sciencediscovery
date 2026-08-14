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

import type {
  ArtifactCandidate,
  ArtifactJob,
  ArtifactPlan,
  McpInvocation,
  PermissionRequest,
  RemoteJob,
  SessionPlan,
  SessionRun,
  Subagent,
  WorkspaceFile,
} from "@science-agent/schema";

import { isArtifactPreviewFile } from "../src/App.js";
import {
  activityCardId,
  collectRunChangedPaths,
  groupRunActivity,
  setActivityCardExpanded,
  type RunActivityItems,
} from "../src/session/run-activity.js";

test("isArtifactPreviewFile accepts any markdown plus the chart/summary pair", () => {
  const at = (path: string, previewKind?: WorkspaceFile["previewKind"]) =>
    ({ modifiedAt: "", path, ...(previewKind ? { previewKind } : {}), size: 1 }) as WorkspaceFile;
  assert.equal(isArtifactPreviewFile(at("analysis_chart.svg", "figure")), true);
  assert.equal(isArtifactPreviewFile(at("analysis_summary.csv", "dataset")), true);
  assert.equal(isArtifactPreviewFile(at("findings.md", "markdown")), true);
  assert.equal(isArtifactPreviewFile(at("notes/deep.markdown", "markdown")), true);
  assert.equal(isArtifactPreviewFile(at("plain-write.md", "markdown")), true);
  assert.equal(isArtifactPreviewFile(at("data.csv", "dataset")), false);
  assert.equal(isArtifactPreviewFile(at("script.py")), false);
});

/** Only the fields groupRunActivity reads are populated; the rest is cast. */
function buildRun(overrides: Partial<SessionRun> & { id: string }): SessionRun {
  return {
    createdAt: "2026-07-15T00:00:00.000Z",
    status: "completed",
    ...overrides,
  } as SessionRun;
}

function emptyItems(): RunActivityItems {
  return {
    downloadCandidates: [],
    downloadJobs: [],
    downloadPlans: [],
    permissionRequests: [],
    plans: [],
    previewFiles: [],
    remoteJobs: [],
    subagents: [],
  };
}

test("attributes governed downloads through MCP invocations, including subagent turns", () => {
  const items = emptyItems();
  items.subagents = [{ createdAt: "2026-07-15T00:02:00.000Z", id: "subagent-1", parentTurnId: "run-1" } as Subagent];
  items.downloadCandidates = [{
    candidate: { id: "candidate-1", logicalName: "paper.pdf" } as ArtifactCandidate,
    invocationId: "invocation-child",
  }];
  items.downloadPlans = [{
    createdAt: "2026-07-15T00:06:00.000Z",
    id: "download-plan-1",
    mcpInvocationId: "invocation-main",
  } as ArtifactPlan];
  items.downloadJobs = [{
    createdAt: "2026-07-15T00:06:30.000Z",
    id: "download-job-1",
    planId: "download-plan-1",
  } as ArtifactJob];
  const invocations = [
    { id: "invocation-child", turnId: "subagent-1" } as McpInvocation,
    { id: "invocation-main", turnId: "run-2" } as McpInvocation,
  ];

  const groups = groupRunActivity([RUN_ONE, RUN_TWO], items, {}, invocations);

  assert.deepEqual(groups[0]?.downloadCandidates.map((item) => item.candidate.id), ["candidate-1"]);
  assert.deepEqual(groups[1]?.downloadPlans.map((plan) => plan.id), ["download-plan-1"]);
  assert.deepEqual(groups[1]?.downloadJobs.map((job) => job.id), ["download-job-1"]);
});

const RUN_ONE = buildRun({
  assistantMessageId: "assistant-1",
  id: "run-1",
  startedAt: "2026-07-15T00:01:00.000Z",
  userMessageId: "user-1",
});
const RUN_TWO = buildRun({
  assistantMessageId: "assistant-2",
  id: "run-2",
  startedAt: "2026-07-15T00:05:00.000Z",
  userMessageId: "user-2",
});

test("attributes items to the run that was active when they were created", () => {
  const items = emptyItems();
  items.plans = [
    { createdAt: "2026-07-15T00:02:00.000Z", id: "plan-1" } as SessionPlan,
    { createdAt: "2026-07-15T00:06:00.000Z", id: "plan-2" } as SessionPlan,
  ];
  items.subagents = [
    { createdAt: "2026-07-15T00:03:00.000Z", id: "subagent-1" } as Subagent,
    { createdAt: "2026-07-15T00:07:00.000Z", id: "subagent-2" } as Subagent,
  ];
  items.remoteJobs = [{ createdAt: "2026-07-15T00:06:30.000Z", id: "job-1" } as RemoteJob];
  items.permissionRequests = [{ createdAt: "2026-07-15T00:02:30.000Z", id: "request-1" } as PermissionRequest];
  items.previewFiles = [
    { modifiedAt: "2026-07-15T00:03:30.000Z", path: "analysis_chart.svg", previewKind: "figure", size: 10 } as WorkspaceFile,
  ];

  const groups = groupRunActivity([RUN_TWO, RUN_ONE], items);

  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.runId, "run-1");
  assert.equal(groups[0]?.anchorMessageId, "assistant-1");
  assert.deepEqual(groups[0]?.plans.map((plan) => plan.id), ["plan-1"]);
  assert.deepEqual(groups[0]?.subagents.map((subagent) => subagent.id), ["subagent-1"]);
  assert.deepEqual(groups[0]?.permissionRequests.map((request) => request.id), ["request-1"]);
  assert.deepEqual(groups[0]?.previewFiles.map((file) => file.path), ["analysis_chart.svg"]);
  assert.equal(groups[1]?.runId, "run-2");
  assert.equal(groups[1]?.anchorMessageId, "assistant-2");
  assert.deepEqual(groups[1]?.plans.map((plan) => plan.id), ["plan-2"]);
  assert.deepEqual(groups[1]?.subagents.map((subagent) => subagent.id), ["subagent-2"]);
  assert.deepEqual(groups[1]?.remoteJobs.map((job) => job.id), ["job-1"]);
});

test("queued runs that never started are not attribution targets", () => {
  const queued = buildRun({ createdAt: "2026-07-15T00:04:00.000Z", id: "run-queued", status: "queued" });
  const items = emptyItems();
  items.subagents = [{ createdAt: "2026-07-15T00:04:30.000Z", id: "subagent-1" } as Subagent];

  const groups = groupRunActivity([RUN_ONE, queued], items);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.runId, "run-1");
  assert.deepEqual(groups[0]?.subagents.map((subagent) => subagent.id), ["subagent-1"]);
});

test("items older than the first started run fall into the unattributed tail group", () => {
  const items = emptyItems();
  items.plans = [{ createdAt: "2026-07-14T23:00:00.000Z", id: "plan-legacy" } as SessionPlan];
  items.subagents = [{ createdAt: "2026-07-15T00:02:00.000Z", id: "subagent-1" } as Subagent];

  const groups = groupRunActivity([RUN_ONE], items);

  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.runId, "run-1");
  assert.deepEqual(groups[0]?.subagents.map((subagent) => subagent.id), ["subagent-1"]);
  const tail = groups[1]!;
  assert.equal(tail.runId, undefined);
  assert.equal(tail.anchorMessageId, undefined);
  assert.deepEqual(tail.plans.map((plan) => plan.id), ["plan-legacy"]);
});

test("falls back to the user message when a run has no assistant message", () => {
  const failedRun = buildRun({ id: "run-failed", startedAt: "2026-07-15T00:01:00.000Z", status: "failed", userMessageId: "user-9" });
  const items = emptyItems();
  items.subagents = [{ createdAt: "2026-07-15T00:02:00.000Z", id: "subagent-1" } as Subagent];

  const groups = groupRunActivity([failedRun], items);

  assert.equal(groups[0]?.anchorMessageId, "user-9");
});

test("empty attribution yields no groups", () => {
  assert.deepEqual(groupRunActivity([RUN_ONE], emptyItems()), []);
  assert.deepEqual(groupRunActivity([], emptyItems()), []);
});

test("collectRunChangedPaths unions the changed paths of workspace.changed events", () => {
  const paths = collectRunChangedPaths([
    { changedPaths: ["a.md", "b.md"], files: [], type: "workspace.changed" },
    { content: "x", type: "assistant.delta" },
    { changedPaths: ["b.md", "c/chart.svg"], files: [], type: "workspace.changed" },
  ]);
  assert.deepEqual(paths.toSorted(), ["a.md", "b.md", "c/chart.svg"]);
});

test("preview files appear in every run that changed them and keep timestamp fallback", () => {
  const items = emptyItems();
  items.previewFiles = [
    // Rewritten in both rounds: both groups keep a card for it.
    { modifiedAt: "2026-07-15T00:06:00.000Z", path: "report.md", previewKind: "markdown", size: 10 } as WorkspaceFile,
    // Only round 1 touched it, but a legacy sibling has no change records.
    { modifiedAt: "2026-07-15T00:03:00.000Z", path: "notes.md", previewKind: "markdown", size: 10 } as WorkspaceFile,
    { modifiedAt: "2026-07-15T00:02:30.000Z", path: "legacy.md", previewKind: "markdown", size: 10 } as WorkspaceFile,
  ];
  const changedPaths = {
    "run-1": ["report.md", "notes.md"],
    "run-2": ["report.md"],
  };

  const groups = groupRunActivity([RUN_ONE, RUN_TWO], items, changedPaths);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.previewFiles.map((file) => file.path).toSorted(), ["legacy.md", "notes.md", "report.md"]);
  assert.deepEqual(groups[1]?.previewFiles.map((file) => file.path), ["report.md"]);
});

test("different markdown paths from different runs land in their own groups", () => {
  const items = emptyItems();
  items.previewFiles = [
    { modifiedAt: "2026-07-15T00:02:00.000Z", path: "findings-a.md", previewKind: "markdown", size: 10 } as WorkspaceFile,
    { modifiedAt: "2026-07-15T00:06:00.000Z", path: "findings-b.md", previewKind: "markdown", size: 10 } as WorkspaceFile,
  ];

  const groups = groupRunActivity([RUN_ONE, RUN_TWO], items);

  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.runId, "run-1");
  assert.deepEqual(groups[0]?.previewFiles.map((file) => file.path), ["findings-a.md"]);
  assert.equal(groups[1]?.runId, "run-2");
  assert.deepEqual(groups[1]?.previewFiles.map((file) => file.path), ["findings-b.md"]);
});

test("setActivityCardExpanded toggles one card and no-ops on an unchanged value", () => {
  const empty = {};
  const opened = setActivityCardExpanded(empty, "subagent:sub-1", true);
  assert.equal(opened["subagent:sub-1"], true);
  assert.equal(setActivityCardExpanded(opened, "subagent:sub-1", true), opened);

  const closed = setActivityCardExpanded(opened, "subagent:sub-1", false);
  assert.equal(closed["subagent:sub-1"], false);
  // Other cards are untouched.
  const both = setActivityCardExpanded(opened, "plan:plan-1", true);
  assert.equal(both["subagent:sub-1"], true);
  assert.equal(both["plan:plan-1"], true);
});

test("an explicit collapse lands for a card whose default is expanded", () => {
  // Cross-seam: the RemoteJobsPanel read pattern (`?? awaiting_approval`)
  // composed with the App-layer write, starting from a pristine expansion map.
  const cardId = activityCardId("remote-job", "job-1");
  const awaitingApproval = true;
  const readExpanded = (expansion: Record<string, boolean>) =>
    expansion[cardId] ?? awaitingApproval;

  const beforeClick = {};
  assert.equal(readExpanded(beforeClick), true);

  const afterClick = setActivityCardExpanded(beforeClick, cardId, !readExpanded(beforeClick));
  assert.equal(afterClick[cardId], false);
  assert.equal(readExpanded(afterClick), false);

  // Writing the default value explicitly is now recorded too; only an
  // identical recorded value no-ops.
  const plainId = activityCardId("plan", "plan-1");
  const recorded = setActivityCardExpanded({}, plainId, false);
  assert.equal(recorded[plainId], false);
  assert.equal(setActivityCardExpanded(recorded, plainId, false), recorded);
});

test("expansion keyed by card id survives a group moving from tail to conversation block", () => {
  // Round 1 finishes and its cards sit in the tail group (current run); the
  // user expands the subagent card there.
  const items = emptyItems();
  items.subagents = [{ createdAt: "2026-07-15T00:02:00.000Z", id: "subagent-1" } as Subagent];
  const whileCurrent = groupRunActivity([RUN_ONE], items);
  assert.equal(whileCurrent[0]?.runId, "run-1");
  const cardId = activityCardId("subagent", whileCurrent[0]!.subagents[0]!.id);
  const expansion = setActivityCardExpanded({}, cardId, true);

  // Round 2 starts: the same subagent now belongs to a historical run whose
  // group renders after its replayed timeline block. The card id — and
  // therefore the lifted expansion state — is identical in both placements.
  const afterNextRun = groupRunActivity([RUN_ONE, RUN_TWO], items);
  assert.equal(afterNextRun[0]?.runId, "run-1");
  assert.equal(afterNextRun[0]?.anchorMessageId, "assistant-1");
  assert.equal(activityCardId("subagent", afterNextRun[0]!.subagents[0]!.id), cardId);
  assert.equal(expansion[cardId], true);
});
