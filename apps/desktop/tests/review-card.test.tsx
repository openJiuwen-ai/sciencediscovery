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
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ArtifactReviewRun, ChatMessage } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { ReviewCard } from "../src/views/reviewer/ReviewCard.js";
import {
  checkpointSummary,
  checkpointTone,
  reviewRowCount,
  reviewRows,
  reviewSummary,
  reviewTone,
  unverifiedDelivery,
} from "../src/views/reviewer/presentation.js";

/** A review with nothing wrong with it: structure checked, delivery confirmed. */
function review(over: Partial<ArtifactReviewRun> = {}): ArtifactReviewRun {
  return {
    artifactContentHash: "hash",
    artifactId: "artifact-1",
    artifactLogicalName: "report.md",
    artifactVersionId: "version-2",
    checkpointId: "checkpoint-1",
    checks: ["structure", "citation", "completeness"],
    completeness: { required: [{ path: "output/report.md", state: "present" }], source: "brief", status: "complete" },
    createdAt: "2026-01-01T00:00:00.000Z",
    decision: "ACCEPT_AND_PROCEED",
    findings: [],
    finishedAt: "2026-01-01T00:00:10.000Z",
    id: "review-1",
    reviewLevel: "quick",
    reviewerSpecialistVersion: "1",
    sessionId: "session-1",
    status: "completed",
    toolCallId: "call-1",
    ...over,
  };
}

function checkpoint(over: Partial<NonNullable<ChatMessage["reviewerCheckpoint"]>> = {}) {
  return { status: "completed" as const, toolCallId: "call-1", ...over };
}

function card(reviews: readonly ArtifactReviewRun[], status: NonNullable<ChatMessage["reviewerCheckpoint"]>["status"] = "completed") {
  return renderToStaticMarkup(
    <ReviewCard checkpoint={checkpoint({ status })} messageId="message-1" reviews={reviews} running={false} />,
  );
}

describe("a review's verdict", () => {
  it("is green only when delivery was confirmed", () => {
    assert.equal(reviewTone(review()), "pass");
    assert.equal(reviewSummary(review()), TEXT.reviewer.summaryPass);
    assert.equal(unverifiedDelivery(review()), false);
  });

  it("treats a structure-only review as claiming nothing about delivery", () => {
    const parsed = review({ checks: ["structure"], completeness: undefined });
    assert.equal(unverifiedDelivery(parsed), false);
    assert.equal(reviewTone(parsed), "pass");
  });

  it("is amber when delivery was never verified", () => {
    const unconfirmed = review({
      completeness: undefined,
      checks: ["structure", "citation"],
    });
    assert.equal(unverifiedDelivery(unconfirmed), true);
    assert.equal(reviewTone(unconfirmed), "warn");
    assert.equal(reviewSummary(unconfirmed), TEXT.reviewer.summaryUnverified);
  });

  it("is red when a declared deliverable is missing", () => {
    const incomplete = review({
      completeness: {
        required: [{ path: "output/predictions.npy", state: "missing" }],
        source: "brief",
        status: "incomplete",
      },
      decision: "REVISE_AND_RETRY",
      findings: [{
        code: "DELIVERABLE_MISSING",
        evidenceRefs: [],
        id: "finding-delivery",
        message: "output/predictions.npy is required",
        severity: "critical",
        status: "open",
      }],
    });
    assert.equal(reviewTone(incomplete), "fail");
    assert.equal(reviewSummary(incomplete), TEXT.reviewer.summaryIncomplete);
  });

  it("says a skipped review skipped, not that it passed", () => {
    const skipped = review({ decision: "SKIPPED" });
    assert.equal(reviewTone(skipped), "neutral");
    assert.equal(reviewSummary(skipped), TEXT.reviewer.summarySkipped);
  });

  it("turns red on any finding: the artifact itself needs a fix", () => {
    const flagged = review({
      decision: "REVISE_AND_RETRY",
      findings: [{
        code: "CITATION_FORMAT_INVALID",
        evidenceRefs: [],
        id: "finding-1",
        message: "[3] is not listed",
        severity: "warning",
        status: "open",
      }],
    });
    assert.equal(reviewTone(flagged), "fail");
    assert.equal(reviewSummary(flagged), TEXT.reviewer.summaryFindings(1));
  });

  it("keeps a failed review amber: an error is not a verdict on the artifact", () => {
    const broken = review({ status: "failed" });
    assert.equal(reviewTone(broken), "warn");
    assert.equal(reviewSummary(broken), TEXT.reviewer.summaryFailed);
  });

  it("marks a verdict on a replaced version as history, and says so", () => {
    const stale = review({ stale: true });
    assert.equal(reviewTone(stale), "warn");
    assert.equal(reviewSummary(stale), `${TEXT.reviewer.summaryPass}${TEXT.reviewer.outdated}`);
  });
});

describe("a review's rows", () => {
  it("puts findings above the checks that passed", () => {
    const found = review({
      findings: [{
        code: "CITATION_FORMAT_INVALID",
        evidenceRefs: [],
        id: "finding-1",
        message: "[3] is not listed",
        severity: "warning",
        status: "open",
      }],
    });
    const rows = reviewRows(found);
    assert.equal(rows[0]?.id, "finding-1");
    assert.equal(rows[0]?.tone, "warn");
    // The category that raised a finding is not repeated as a pass below it.
    assert.equal(rows.filter((row) => row.label === TEXT.reviewer.checkNames.citation).length, 1);
  });

  it("lets the completeness card answer for the delivery finding", () => {
    const incomplete = review({
      completeness: {
        required: [{ path: "output/predictions.npy", state: "missing" }],
        source: "brief",
        status: "incomplete",
      },
      findings: [{
        code: "DELIVERABLE_MISSING",
        evidenceRefs: [],
        id: "finding-delivery",
        message: "output/predictions.npy is required",
        severity: "critical",
        status: "open",
      }],
    });
    const rows = reviewRows(incomplete);
    assert.deepEqual(rows.map((row) => row.id), [
      "review-1:completeness",
      "review-1:check:structure",
      "review-1:check:citation",
    ]);
    assert.ok(rows[0]?.body?.includes("output/predictions.npy"));
  });

  it("names an unperformed check instead of silently passing it", () => {
    const gapped = review({ notChecked: [{ check: "claim_support", reason: "no source text" }] });
    const row = reviewRows(gapped).find((candidate) => candidate.id === "review-1:gap:0");
    assert.ok(row);
    assert.equal(row.label, TEXT.reviewer.gaps);
    assert.equal(row.body, "no source text");
  });

  it("keeps the header's count honest about what expansion reveals", () => {
    const found = review({
      findings: [{
        code: "CITATION_UNCITED_CLAIM",
        evidenceRefs: [],
        id: "finding-1",
        message: "§2 has no citation",
        severity: "warning",
        status: "open",
      }],
    });
    assert.equal(reviewRowCount([found]), reviewRows(found).length);
    assert.ok(reviewRowCount([found]) > 0);
  });
});

describe("a checkpoint's card", () => {
  it("reports the worst artifact, not the average", () => {
    const flagged = review({
      findings: [{
        code: "CITATION_UNCITED_CLAIM",
        evidenceRefs: [],
        id: "finding-1",
        message: "§2 has no citation",
        severity: "warning",
        status: "open",
      }],
      id: "review-2",
    });
    assert.equal(checkpointTone([review(), flagged], "completed"), "fail");
    assert.equal(checkpointSummary([review(), flagged], "completed"), TEXT.reviewer.summaryFindings(1));
  });

  it("draws a one-line header that folds out into the items", () => {
    const markup = card([review()]);
    assert.ok(markup.includes(TEXT.reviewer.title));
    assert.ok(markup.includes(TEXT.reviewer.summaryPass));
    assert.ok(markup.includes(TEXT.reviewer.checks(reviewRowCount([review()]))));
    // Folded by default: no item cards until the header is clicked.
    assert.ok(!markup.includes("review-item "));
  });

  it("says a skipped checkpoint skipped when nothing was reviewed", () => {
    const markup = card([], "skipped");
    assert.ok(markup.includes(TEXT.reviewer.summarySkipped));
    assert.ok(!markup.includes(TEXT.reviewer.empty));
  });

  it("says a failed checkpoint failed when nothing was reviewed", () => {
    const markup = card([], "failed");
    assert.ok(markup.includes(TEXT.reviewer.summaryFailed));
  });

  it("draws a running line, with progress, while nothing exists yet", () => {
    const markup = renderToStaticMarkup(
      <ReviewCard
        checkpoint={checkpoint({
          progress: {
            artifactLogicalName: "report.md",
            completed: 2,
            failed: 0,
            queued: 0,
            total: 5,
          },
          status: "running",
        })}
        messageId="message-1"
        reviews={[]}
        running
      />,
    );
    assert.ok(markup.includes(TEXT.reviewer.running));
    assert.ok(markup.includes(TEXT.reviewer.progress(2, 5)));
    assert.ok(!markup.includes("review-head"));
  });
});
