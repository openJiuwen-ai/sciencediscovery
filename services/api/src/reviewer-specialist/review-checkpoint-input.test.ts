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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { reviewerCheckpointPromptContent, runReviewerCheckpoint } from "@sciencediscovery/provenance";
import { reviewUnverifiedDelivery } from "@sciencediscovery/schema";
import type {
  ArtifactReviewRun,
  ScientificArtifact,
  ScientificArtifactVersion,
  Subagent,
} from "@sciencediscovery/schema";
import type { CasStore } from "@sciencediscovery/cas";

import type { SessionStore } from "../store.js";
import { reviewCheckpointInput, sessionRequiredDeliverables } from "./required-deliverables.js";

/**
 * The two entry points (`http/index.ts` and `runs/index.ts`) hand their checkpoint
 * options to `runReviewerCheckpoint` through `reviewCheckpointInput`. That assembly
 * is where the delivery gate broke twice — a synthetic tool-call id used as a run
 * id, then a per-report resolver replaced by a batch-wide set — so it is covered
 * here directly rather than only through a caller that cannot be exercised.
 *
 * The shape below is the merged batch the coordinator produces: run-a completed and
 * produced `output/cl3/predictions.npy`; run-b was cancelled, so its own Brief may
 * not be enforced and no other run's file may stand in for it.
 */
function mergedBatchFixture() {
  const reportContent = Buffer.from("The study reports a result [1].\n[1] Study. arXiv:1706.03762");
  const report = (id: string): ScientificArtifact => ({
    createdAt: "2026-10-27T00:00:00.000Z",
    createdInSessionId: "session-1",
    createdInSessionTitle: "Session 1",
    currentVersion: 1,
    id,
    kind: "markdown",
    logicalName: `${id}.md`,
    name: `${id}.md`,
    origin: "llm_declared",
    projectId: "project-1",
    sessionId: "session-1",
    updatedAt: "2026-10-27T00:00:00.000Z",
  });
  const reportVersion = (artifactId: string, turnId: string, createdAt: string): ScientificArtifactVersion => ({
    artifactId,
    content: { hash: `${artifactId}-hash`, size: reportContent.length },
    createdAt,
    executionRunIds: [],
    id: `${artifactId}-v1`,
    inputArtifactVersionIds: [],
    mediaType: "text/markdown",
    projectId: "project-1",
    sessionId: "session-1",
    turnId,
    version: 1,
  });
  const artifacts: ScientificArtifact[] = [report("report-a"), report("report-b")];
  const versions: ScientificArtifactVersion[] = [
    reportVersion("report-a", "run-a", "2026-10-27T00:00:00.000Z"),
    reportVersion("report-b", "run-b", "2026-10-27T00:01:00.000Z"),
  ];
  // run-a's declared deliverable: present.
  artifacts.push({
    ...report("cl3"),
    kind: "dataset",
    logicalName: "predictions.npy",
    name: "predictions.npy",
  });
  versions.push({
    artifactId: "cl3",
    content: { hash: "cl3-hash", size: 32 },
    createdAt: "2026-10-27T00:00:05.000Z",
    executionRunIds: [],
    id: "cl3-v1",
    inputArtifactVersionIds: [],
    mediaType: "application/octet-stream",
    projectId: "project-1",
    sessionId: "session-1",
    sourcePath: "output/cl3/predictions.npy",
    turnId: "run-a",
    version: 1,
  });
  const subagent = (id: string, parentTurnId: string, requirement: string, status: Subagent["status"]): Subagent => ({
    createdAt: "2026-10-27T00:00:00.000Z",
    id,
    input: { brief: {
      collaborationRules: [],
      constraints: [],
      goal: "Reproduce the paper",
      outputRequirements: [requirement],
    }, description: "Reproduce", prompt: "Reproduce the paper" },
    maxTurns: 10,
    parentTurnId,
    sessionId: "session-1",
    status,
    steps: [],
  } as unknown as Subagent);
  const subagents = [
    subagent("sub-a", "run-a", "output/cl3/predictions.npy", "completed"),
    // Declared a file it never produced, then stopped: its Brief is not usable.
    subagent("sub-b", "run-b", "output/cl5/predictions.npy", "cancelled"),
  ];
  const saved: ArtifactReviewRun[] = [];
  const store = {
    appendArtifactReview: async (review: ArtifactReviewRun) => { saved.push(review); },
    getArtifact: (_sessionId: string, artifactId: string) => artifacts.find((entry) => entry.id === artifactId),
    getArtifactVersion: (_sessionId: string, versionId: string) => versions.find((entry) => entry.id === versionId),
    listArtifactReviews: async () => saved,
    listArtifacts: () => artifacts,
    listArtifactVersions: (_sessionId: string, artifactId: string) => versions.filter((entry) => entry.artifactId === artifactId),
    listSubagents: () => subagents,
  } as unknown as SessionStore;
  const cas = { read: async () => reportContent, verify: async () => true } as unknown as CasStore;
  return { cas, saved, store };
}

test("the audit entry hands the checkpoint a per-report resolver, never one batch-wide set", async () => {
  const { cas, saved, store } = mergedBatchFixture();
  const input = reviewCheckpointInput(store, {
    artifactVersionIds: ["report-a-v1", "report-b-v1"],
    sessionId: "session-1",
    toolCallId: "automatic-review:task-1",
  });

  // Removing this resolver is the regression: there is no batch-wide set behind it
  // to hide the loss, and the assertions below depend on an answer per report.
  assert.equal(typeof input.requiredDeliverablesFor, "function");
  assert.equal("requiredDeliverables" in input, false, "a batch-wide set is the fallback this entry must not pass");
  assert.deepEqual(input.requiredDeliverablesFor({ turnId: "run-a" })?.paths, ["output/cl3/predictions.npy"]);
  assert.equal(input.requiredDeliverablesFor({ turnId: "run-b" }), undefined, "a cancelled run may not borrow another run's list");
  // The newest reviewed run, for the one-run APIs that still take a single id.
  assert.equal(input.parentRunId, "run-b");

  const result = await runReviewerCheckpoint({
    ...input,
    cas,
    reason: "Merged automatic audit",
    sessionId: "session-1",
    store,
  });

  const runA = saved.find((review) => review.artifactLogicalName === "report-a.md")!;
  const runB = saved.find((review) => review.artifactLogicalName === "report-b.md")!;
  assert.equal(runA.completeness?.status, "complete", "run-a's own deliverable is present");
  assert.equal(runA.decision, "ACCEPT_AND_PROCEED");
  assert.equal(runB.completeness?.status, "unconfirmed", "run-b's delivery is unverified, not certified with run-a's file");
  assert.ok(!runB.findings.some((finding) => finding.message.includes("output/cl3/predictions.npy")),
    "run-b must not be revised for a file another run declared");
  assert.doesNotMatch(reviewerCheckpointPromptContent(result.reviews), /^Status: PASSED$/mu);
});

test("a batch-wide set in place of the resolver certifies the cancelled run", async () => {
  // Documents the exact shape of the regression the per-report resolver fixes: the
  // union of the batch's declarations finds run-a's file, so run-b's report comes
  // out as complete delivery. The entry above must never assemble this.
  const { cas, saved, store } = mergedBatchFixture();
  const batchWide = sessionRequiredDeliverables(store, "session-1", ["run-a", "run-b"]);

  await runReviewerCheckpoint({
    artifactVersionIds: ["report-a-v1", "report-b-v1"],
    cas,
    parentRunId: "run-b",
    reason: "Merged automatic audit",
    sessionId: "session-1",
    store,
    ...(batchWide ? { requiredDeliverables: batchWide } : {}),
  });

  const runB = saved.find((review) => review.artifactLogicalName === "report-b.md")!;
  assert.equal(runB.completeness?.status, "complete", "the union finds run-a's file and clears run-b's report");
});

test("the same requirement set written two ways still reuses one verdict", async () => {
  // The requirement fingerprint is what tells "the Brief changed" from "the same
  // Brief, written again": `./output/cl3/x.npy` and `output/cl3/x.npy` are the same
  // declaration, and listing two files in another order is not an edit. If they
  // hashed differently, every audit would look like a changed Brief.
  const { cas, saved, store } = mergedBatchFixture();
  const run = (paths: string[]) => runReviewerCheckpoint({
    artifactVersionIds: ["report-a-v1"],
    cas,
    parentRunId: "run-a",
    reason: "Quick review",
    requiredDeliverables: { paths, scope: "run", source: "brief" },
    sessionId: "session-1",
    store,
  });

  await run(["./output/cl3/predictions.npy", "report-a.md"]);
  await run(["report-a.md", "output/cl3/predictions.npy"]);

  assert.equal(saved.length, 2);
  assert.equal(saved[1]?.reusedFromReviewId, saved[0]?.id, "the two writings are one requirement set");
  assert.equal(saved[1]?.completeness?.status, "complete");
});

test("the panel and the main-Agent record answer delivery verification the same way", () => {
  // One predicate, two readers: the Reviewer panel labels a review and the feedback
  // summarizes it. Reading the same record two ways is how a card can say "passed"
  // while the record says the scope was limited (#435).
  const withoutVerdict: ArtifactReviewRun = {
    artifactContentHash: "hash",
    artifactId: "artifact-1",
    artifactLogicalName: "REPORT.md",
    artifactVersionId: "version-1",
    checkpointId: "checkpoint-1",
    checks: ["citation"],
    createdAt: "2026-10-27T00:00:00.000Z",
    decision: "ACCEPT_AND_PROCEED",
    findings: [],
    finishedAt: "2026-10-27T00:00:01.000Z",
    id: "review-1",
    reviewLevel: "quick",
    reviewerSpecialistVersion: "quick",
    sessionId: "session-1",
    status: "completed",
  };
  const verified: ArtifactReviewRun = {
    ...withoutVerdict,
    checks: ["citation", "completeness"],
    completeness: { required: [{ path: "REPORT.md", state: "present" }], scope: "run", source: "brief", status: "complete" },
    id: "review-2",
  };

  assert.equal(reviewUnverifiedDelivery(withoutVerdict), true, "no verdict is unverified");
  assert.equal(reviewUnverifiedDelivery(verified), false, "a complete verdict is verified");

  const unverifiedRecord = reviewerCheckpointPromptContent([withoutVerdict]);
  assert.match(unverifiedRecord, /^Status: SCOPE_LIMITED$/mu);
  assert.doesNotMatch(unverifiedRecord, /^Status: PASSED$/mu);
  const verifiedRecord = reviewerCheckpointPromptContent([verified]);
  assert.match(verifiedRecord, /^Status: PASSED$/mu);
});
