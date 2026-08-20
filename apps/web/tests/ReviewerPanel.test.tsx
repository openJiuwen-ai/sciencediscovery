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

import type { ArtifactReviewRun } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReviewerPanel } from "../src/ReviewerPanel.js";

function review(overrides: Partial<ArtifactReviewRun> = {}): ArtifactReviewRun {
  return {
    artifactContentHash: "a".repeat(64),
    artifactId: "artifact-1",
    artifactLogicalName: "report.md",
    artifactVersionId: "version-123456789",
    checkpointId: "checkpoint-1",
    createdAt: "2026-07-30T00:00:00.000Z",
    decision: "ACCEPT_AND_PROCEED",
    findings: [],
    finishedAt: "2026-07-30T00:00:01.000Z",
    id: "review-1",
    reviewerSpecialistVersion: "1.0.0-offline-mvp",
    sessionId: "session-1",
    status: "completed",
    toolCallId: "review-call",
    ...overrides,
  };
}

test("ReviewerPanel shows the built-in Quick review identity", () => {
  const html = renderToStaticMarkup(createElement(ReviewerPanel, {
    reviews: [review({ checks: ["citation", "computation"], reviewLevel: "quick" })],
    toolCallId: "review-call",
  }));

  assert.match(html, /Reviewer Specialist/);
  assert.match(html, /Built-in Specialist/);
  assert.match(html, /Version version- · Quick/);
  assert.match(html, /Quick review passed/);
  assert.match(html, /Artifact provenance checks passed/);
  assert.match(html, /<details class="reviewer-specialist-card passed">/);
  assert.match(html, /<summary class="reviewer-specialist-card-heading">/);
  assert.doesNotMatch(html, /class="reviewer-specialist-panel" open/);
  assert.doesNotMatch(html, /<details class="reviewer-specialist-card passed"[^>]*\sopen(?:=|\s|>)/);
  assert.doesNotMatch(html, /Citation verified/);
});

test("ReviewerPanel shows missing citation identifiers", () => {
  const finding = {
    code: "CITATION_IDENTIFIER_MISSING",
    evidenceRefs: ["artifact:version-1"],
    id: "finding-1",
    message: "No recognizable citation identifier was found.",
    severity: "warning" as const,
    status: "open" as const,
  };
  const html = renderToStaticMarkup(createElement(ReviewerPanel, {
    reviews: [review({ decision: "REVISE_AND_RETRY", findings: [finding] })],
    toolCallId: "review-call",
  }));

  assert.match(html, /Warnings found/);
  assert.match(html, /Citation identifier missing/);
  assert.match(html, /reviewer-specialist-card warning/);
  assert.match(html, /class="warning"/);
});

test("ReviewerPanel keeps only actionable findings and hides Deep operational incompleteness", () => {
  const finding = {
    code: "COMPUTATION_EVIDENCE_VALUE_MISMATCH",
    evidenceRefs: ["artifact:version-1"],
    id: "finding-1",
    message: "The reported value conflicts with the locked Evidence.",
    severity: "warning" as const,
    status: "open" as const,
  };
  const html = renderToStaticMarkup(createElement(ReviewerPanel, {
    reviews: [review({
      decision: "REVISE_AND_RETRY",
      findings: [finding],
      reviewLevel: "deep",
      smartDetail: {
        code: "SMART_EXECUTION_FAILED",
        message: "The Deep Citation review could not complete: gateway turn exceeded 90000 ms.",
      },
      smartStatus: "inconclusive",
    })],
    toolCallId: "review-call",
  }));

  assert.match(html, /Evidence value mismatch/);
  assert.doesNotMatch(html, /Review execution incomplete/);
  assert.doesNotMatch(html, /gateway turn exceeded 90000 ms/);
});

test("ReviewerPanel reserves red for critical findings", () => {
  const finding = {
    code: "CITATION_CLAIM_NOT_SUPPORTED",
    evidenceRefs: ["artifact:version-1"],
    id: "finding-critical",
    message: "The source contradicts the reported value.",
    severity: "critical" as const,
    status: "open" as const,
  };
  const html = renderToStaticMarkup(createElement(ReviewerPanel, {
    reviews: [review({ decision: "REVISE_AND_RETRY", findings: [finding] })],
    toolCallId: "review-call",
  }));

  assert.match(html, /Revision required/);
  assert.match(html, /reviewer-specialist-card critical/);
  assert.match(html, /class="critical"/);
});

test("ReviewerPanel shows a short running state at the tool position", () => {
  const html = renderToStaticMarkup(createElement(ReviewerPanel, {
    checkpointStatus: "running",
    reviews: [],
    toolCallId: "review-call",
  }));

  assert.match(html, /Reviewing Artifacts/);
  assert.match(html, /Quick · Running/);
  assert.doesNotMatch(html, /Citation \+ Computation/);
  assert.match(html, /class="reviewer-specialist-panel running" open/);
  assert.match(html, /reviewer-rainbow-dot/);
  assert.match(html, /<details class="reviewer-specialist-card running">/);
  assert.doesNotMatch(html, /<details class="reviewer-specialist-card running"[^>]*\sopen(?:=|\s|>)/);
});

test("ReviewerPanel shows persisted stage and queue progress while Deep review runs", () => {
  const html = renderToStaticMarkup(createElement(ReviewerPanel, {
    checkpointProgress: {
      artifactCompleted: 1,
      artifactLogicalName: "evidence_brief.md",
      artifactTotal: 3,
      completed: 2,
      failed: 0,
      phase: "citation",
      queued: 3,
      running: "PMCID: PMC13210248",
      total: 5,
    },
    checkpointStatus: "running",
    reviews: [review()],
    toolCallId: "review-call",
  }));

  assert.match(html, /Deep Citation queue · 2\/5 references processed/);
  assert.match(html, /1\/3 Artifacts reviewed/);
  assert.match(html, /PMCID: PMC13210248/);
  assert.match(html, /Reviewing/);
});

test("ReviewerPanel collapses a completed multi-Artifact group by default", () => {
  const html = renderToStaticMarkup(createElement(ReviewerPanel, {
    checkpointStatus: "completed",
    reviews: [
      review(),
      review({
        artifactId: "artifact-2",
        artifactLogicalName: "chart.png",
        artifactVersionId: "version-2",
        id: "review-2",
      }),
    ],
    toolCallId: "review-call",
  }));

  assert.match(html, /class="reviewer-specialist-panel"/);
  assert.doesNotMatch(html, /class="reviewer-specialist-panel" open/);
  assert.match(html, /report\.md/);
  assert.match(html, /chart\.png/);
});

test("ReviewerPanel retains a failed manual review with its error", () => {
  const html = renderToStaticMarkup(createElement(ReviewerPanel, {
    checkpointError: "No Artifacts to review",
    checkpointStatus: "failed",
    reviews: [],
    toolCallId: "manual-review:1",
  }));

  assert.match(html, /Reviewer Specialist/);
  assert.match(html, /Review failed/);
  assert.match(html, /No Artifacts to review/);
  assert.doesNotMatch(html, /class="reviewer-specialist-panel" open/);
});

test("ReviewerPanel retains a completed manual review without findings", () => {
  const html = renderToStaticMarkup(createElement(ReviewerPanel, {
    checkpointStatus: "completed",
    reviews: [],
    toolCallId: "manual-review:1",
  }));

  assert.match(html, /Reviewer Specialist/);
  assert.match(html, /No applicable checks/);
});

test("ReviewerPanel keeps a checkpoint failure beside partial Artifact results", () => {
  const html = renderToStaticMarkup(createElement(ReviewerPanel, {
    checkpointError: "Second Artifact could not be read",
    checkpointStatus: "failed",
    reviews: [review()],
    toolCallId: "review-call",
  }));

  assert.match(html, /Review failed/);
  assert.match(html, /Second Artifact could not be read/);
  assert.match(html, /Quick review passed/);
});
