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
import { ReviewArtifactBody, ReviewCard } from "../src/views/reviewer/ReviewCard.js";
import {
  checkpointSummary,
  checkpointTone,
  declaredGap,
  mixedOutcomeCounts,
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

  it("is grey when delivery was never verified: nothing was found, nothing was claimed", () => {
    const unconfirmed = review({
      completeness: undefined,
      checks: ["structure", "citation"],
    });
    assert.equal(unverifiedDelivery(unconfirmed), true);
    assert.equal(reviewTone(unconfirmed), "neutral");
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

  it("keeps a warning amber and reserves red for a critical finding", () => {
    const finding = (severity: "warning" | "critical", id: string) => ({
      code: "CITATION_FORMAT_INVALID",
      evidenceRefs: [],
      id,
      message: "[3] is not listed",
      severity,
      status: "open" as const,
    });
    // The row for a warning is amber and its badge says 提醒. A red frame and
    // "1 个问题" over that row would claim more than the finding does.
    const warning = review({ decision: "REVISE_AND_RETRY", findings: [finding("warning", "finding-warning")] });
    assert.equal(reviewTone(warning), "warn");
    assert.equal(reviewSummary(warning), TEXT.reviewer.summaryWarnings(1));

    const critical = review({ decision: "REVISE_AND_RETRY", findings: [finding("critical", "finding-critical")] });
    assert.equal(reviewTone(critical), "fail");
    assert.equal(reviewSummary(critical), TEXT.reviewer.summaryFindings(1));

    const mixed = review({
      decision: "REVISE_AND_RETRY",
      findings: [finding("critical", "finding-critical"), finding("warning", "finding-warning")],
    });
    assert.equal(reviewTone(mixed), "fail");
    assert.equal(reviewSummary(mixed), TEXT.reviewer.summaryFindingsAndWarnings(1, 1));
  });

  it("does not call it a pass when the review itself says a check was not run", () => {
    const gapped = review({ notChecked: [{ check: "claim_support", reason: "no source text" }] });
    assert.equal(declaredGap(gapped), true);
    // Nothing was raised, and delivery was confirmed: green would tell the
    // reader the whole claim was examined, which the card's own gap row denies.
    // It is not a finding either, so the card does not wear the warning tone.
    assert.equal(unverifiedDelivery(gapped), false);
    assert.equal(reviewTone(gapped), "neutral");
    assert.equal(reviewSummary(gapped), TEXT.reviewer.summaryPartial(1));
  });

  it("stays green when every check it names actually ran", () => {
    assert.equal(declaredGap(review()), false);
    assert.equal(reviewTone(review()), "pass");
  });

  it("lets a source verdict decide the header even when no finding was raised", () => {
    const assessment = (verdict: string): ArtifactReviewRun["sourceAssessments"] => [{
      assessment: { assessment: verdict as never, claimId: "claim-1", locatorIds: [], policyVersion: "1", rationale: "Only part." },
      claim: {
        artifactVersionId: "version-2",
        citationKeys: [],
        id: "claim-1",
        kind: "citation",
        requiredEvidenceLevel: "E3",
        text: "Claim",
      },
      locators: [],
      snapshots: [],
    }];
    const partial = review({ sourceAssessments: assessment("PARTIALLY_SUPPORTED") });
    // No findings, complete delivery, no gap: the only result is the source
    // verdict, and a green header over its row would contradict the card.
    assert.equal(reviewTone(partial), "warn");
    assert.equal(reviewSummary(partial), TEXT.reviewer.summaryPartlySupported);

    const contradicted = review({ sourceAssessments: assessment("CONTRADICTED") });
    assert.equal(reviewTone(contradicted), "fail");
    assert.equal(reviewSummary(contradicted), TEXT.reviewer.summaryContradicted);
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

  it("leaves a citation lookup that reached no conclusion out of the card", () => {
    // The web card keeps these in the record: a row saying "无结论" under a
    // citation-format pass reads as the card contradicting itself. What the
    // review could not do is said once, as the gap it declared.
    const unreachable = review({
      citationTasks: [{
        attempts: 1,
        findings: [],
        key: "doi:10.1001/jamaoncol.2023.6944",
        label: "DOI: 10.1001/jamaoncol.2023.6944",
        message: "No governed literature search returned a usable source record.",
        status: "inconclusive",
      }],
      notChecked: [{ check: "claim_support", reason: "No source was read to confirm the claims." }],
    });
    const rows = reviewRows(unreachable);
    assert.equal(rows.some((row) => row.label === "引文任务"), false);
    assert.ok(rows.some((row) => row.id === "review-1:gap:0"));
  });

  it("names an unperformed check instead of silently passing it", () => {
    const gapped = review({ notChecked: [{ check: "claim_support", reason: "no source text" }] });
    const row = reviewRows(gapped).find((candidate) => candidate.id === "review-1:gap:0");
    assert.ok(row);
    assert.equal(row.label, TEXT.reviewer.gaps);
    // The card's own words, not the server's English template, with the raw
    // reason kept only for a check the map does not know.
    assert.equal(row.body, TEXT.reviewer.gapBodies.claim_support);
    // An absence is not a warning about the artifact, and it is not a pass.
    assert.equal(row.tone, "neutral");
  });

  it("does not tell a Deep review to run a Deep review", () => {
    // The gap survives a Deep review that could not compare anything, but the
    // Quick pass's sentence ("use Deep review") contradicts the level pill on
    // the same card. The row says what the Deep attempt itself produced.
    const inconclusive = review({
      notChecked: [{ check: "claim_support", reason: "Quick review parses citation format only." }],
      reviewLevel: "deep",
      smartStatus: "inconclusive",
    });
    const inconclusiveRow = reviewRows(inconclusive).find((row) => row.id === "review-1:gap:0");
    assert.ok(inconclusiveRow);
    assert.equal(inconclusiveRow.body, TEXT.reviewer.deepGapBodies.inconclusive);
    assert.notEqual(inconclusiveRow.body, TEXT.reviewer.gapBodies.claim_support);

    const noComparison = review({
      notChecked: [{ check: "claim_support", reason: "Quick review parses citation format only." }],
      reviewLevel: "deep",
      smartStatus: "completed",
    });
    const noComparisonRow = reviewRows(noComparison).find((row) => row.id === "review-1:gap:0");
    assert.ok(noComparisonRow);
    assert.equal(noComparisonRow.body, TEXT.reviewer.deepGapBodies.noComparison);

    // The producer writes only `completed` or `inconclusive` once the stage
    // runs; a record with neither has no Deep result attached. "Nothing was
    // compared" is still the truthful outcome there, and the alternative — the
    // Quick pass's sentence — is the contradiction this row exists to remove.
    const unstaged = review({
      notChecked: [{ check: "claim_support", reason: "Quick review parses citation format only." }],
      reviewLevel: "deep",
    });
    assert.equal(
      reviewRows(unstaged).find((row) => row.id === "review-1:gap:0")?.body,
      TEXT.reviewer.deepGapBodies.noComparison,
    );

    // Only the claim-support gap changes; a gap the Deep stage did not touch
    // keeps the wording that says which check was skipped.
    const computation = review({
      notChecked: [{ check: "computation", reason: "The memory graph is disabled." }],
      reviewLevel: "deep",
      smartStatus: "inconclusive",
    });
    const computationRow = reviewRows(computation).find((row) => row.id === "review-1:gap:0");
    assert.ok(computationRow);
    assert.equal(computationRow.body, TEXT.reviewer.gapBodies.computation);
  });

  it("does not summarise a whole Deep stage as a row above the per-claim results", () => {
    // `smartStatus` is stage-level: one failed lookup makes the stage
    // inconclusive even when another claim was verified. A single
    // "semantics: no conclusion" row would then sit above a source row that
    // did conclude, and repeat the claim-support gap besides. The stage says
    // what it could not do through the gap and through each claim's own row.
    const stage = review({
      notChecked: [{ check: "claim_support", reason: "One lookup timed out." }],
      reviewLevel: "deep",
      smartDetail: { code: "SMART_CITATION_INCONCLUSIVE", message: "Paper Reader timeout" },
      smartStatus: "inconclusive",
      sourceAssessments: [{
        assessment: {
          assessment: "SUPPORTED",
          claimId: "claim-1",
          locatorIds: ["locator-1"],
          policyVersion: "1",
          rationale: "The full text states the figure.",
        },
        claim: {
          artifactVersionId: "version-2",
          citationKeys: ["doi:10.1000/example"],
          id: "claim-1",
          kind: "citation",
          requiredEvidenceLevel: "E2",
          text: "代表工作 1",
        },
        locators: [{
          excerpt: "the figure appears in section 3",
          excerptHash: "abc",
          id: "locator-1",
          locator: { paragraph: 2 },
          snapshotId: "snapshot-1",
        }],
        snapshots: [],
      }],
    });
    const rows = reviewRows(stage);
    assert.equal(rows.some((row) => row.id === "review-1:smart"), false);
    assert.ok(rows.some((row) => row.id === "review-1:gap:0"));
    assert.ok(rows.some((row) => row.id === "review-1:source:claim-1"));
    // The stage's raw error text stays in the review record.
    assert.equal(rows.some((row) => `${row.title}${row.body ?? ""}`.includes("timeout")), false);
  });

  it("draws an unconfirmed delivery in grey, not as a warning", () => {
    const unconfirmed = review({
      checks: ["structure", "citation"],
      completeness: { required: [], source: "none", status: "unconfirmed" },
    });
    const row = reviewRows(unconfirmed).find((candidate) => candidate.id.endsWith(":completeness"));
    assert.ok(row);
    assert.equal(row.tone, "neutral");
    assert.equal(row.badge, TEXT.reviewer.badgeUnconfirmed);
    assert.equal(row.title, TEXT.reviewer.completeness.unconfirmed);
  });

  it("says an inconclusive source check in plain words, not in evidence levels", () => {
    const checked = review({
      sourceAssessments: [{
        assessment: {
          assessment: "INCONCLUSIVE",
          claimId: "claim-1",
          locatorIds: [],
          policyVersion: "1",
          rationale: "No issued E3 source locator is available for this claim.",
        },
        claim: {
          artifactVersionId: "version-2",
          citationKeys: ["doi:10.1000/example"],
          id: "claim-1",
          kind: "citation",
          requiredEvidenceLevel: "E3",
          text: "代表工作 1",
        },
        locators: [{
          excerpt: "an abstract sentence",
          excerptHash: "abc",
          id: "locator-1",
          locator: { paragraph: 2 },
          snapshotId: "snapshot-1",
        }],
        snapshots: [],
      }],
    });
    const row = reviewRows(checked).find((candidate) => candidate.id === "review-1:source:claim-1");
    assert.ok(row);
    // Found one passage, not enough to check the claim: that is the whole
    // message. "E3" and "locator" are the policy's words, not the reader's.
    assert.equal(row.tone, "neutral");
    assert.equal(row.body, TEXT.reviewer.sourceInconclusiveWith(1));
    assert.ok(!(row.body ?? "").includes("E3"));
    assert.ok(!/locator/u.test(row.body ?? ""));
    assert.equal(row.badge, TEXT.reviewer.assessments.INCONCLUSIVE);
  });

  it("says so when an inconclusive source check found nothing at all", () => {
    const checked = review({
      sourceAssessments: [{
        assessment: {
          assessment: "INCONCLUSIVE",
          claimId: "claim-1",
          locatorIds: [],
          policyVersion: "1",
          rationale: "The public source could not be reached.",
        },
        claim: {
          artifactVersionId: "version-2",
          citationKeys: [],
          id: "claim-1",
          kind: "citation",
          requiredEvidenceLevel: "E3",
          text: "代表工作 2",
        },
        locators: [],
        snapshots: [],
      }],
    });
    const row = reviewRows(checked).find((candidate) => candidate.id === "review-1:source:claim-1");
    assert.equal(row?.body, TEXT.reviewer.sourceInconclusiveNone);
    assert.equal(row?.tone, "neutral");
  });

  it("puts the checks that ran above what the review never looked at", () => {
    const partial = review({
      checks: ["citation"],
      completeness: undefined,
      notChecked: [{ check: "claim_support", reason: "No source was read." }],
    });
    const rows = reviewRows(partial);
    // The citation check ran and passed; the claim check did not run at all.
    assert.equal(rows[0]?.tone, "pass");
    assert.equal(rows[0]?.label, TEXT.reviewer.checkNames.citation);
    assert.equal(rows.at(-1)?.id, "review-1:gap:0");
    assert.equal(rows.at(-1)?.tone, "neutral");
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

describe("the hint behind a label", () => {
  it("explains each row's category, so a one-word label is readable", () => {
    const rows = reviewRows(review());
    for (const row of rows) assert.ok(row.labelTip.length > 0, `no hint for ${row.label}`);
    const structure = rows.find((row) => row.label === TEXT.reviewer.checkNames.structure);
    assert.equal(structure?.labelTip, TEXT.reviewer.labelTips.structure);
  });

  it("explains a finding the card has no category for", () => {
    const generic = review({
      findings: [{
        code: "SOMETHING_NEW",
        evidenceRefs: [],
        id: "finding-x",
        message: "unclassified",
        severity: "warning",
        status: "open",
      }],
    });
    assert.equal(reviewRows(generic)[0]?.labelTip, TEXT.reviewer.labelTips.other);
  });

  it("draws the explanation as a hover title, on the label and on the level pill", () => {
    const markup = renderToStaticMarkup(
      <ReviewArtifactBody review={review()} showName={false} />,
    );
    assert.ok(markup.includes(`title="${TEXT.reviewer.labelTips.structure}"`));
    assert.ok(markup.includes(`title="${TEXT.reviewer.levelTip("quick")}"`));
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
    assert.equal(checkpointTone([review(), flagged], "completed"), "warn");
    assert.equal(checkpointSummary([review(), flagged], "completed"), TEXT.reviewer.summaryWarnings(1));
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

  it("titles each artifact section with the file it answers for", () => {
    // The card's own header reports the worst of several artifacts, so without
    // a heading the name of the file in hand has nowhere else to appear. One
    // artifact gets one too — the web card titles a lone artifact as well.
    const markup = renderToStaticMarkup(<ReviewArtifactBody review={review()} showName />);
    assert.ok(markup.includes("report.md"));
    assert.ok(markup.includes("review-artifact is-framed is-pass"));
    assert.ok(markup.includes("review-artifact-verdict is-pass"));
  });

  it("counts the artifacts that passed behind one that needs attention", () => {
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
    assert.equal(mixedOutcomeCounts([review(), flagged]), TEXT.reviewer.outcomeCounts(1, 1));
    // Agreement is already said once, by the verdict; numbers would repeat it.
    assert.equal(mixedOutcomeCounts([review()]), undefined);
    assert.equal(mixedOutcomeCounts([review(), review({ id: "review-3" })]), undefined);

    const markup = card([review(), flagged]);
    assert.ok(markup.includes(TEXT.reviewer.outcomeCounts(1, 1)));
    assert.ok(!card([review(), review({ id: "review-3" })]).includes(TEXT.reviewer.outcomeCounts(2, 0)));
  });

  it("names the phase and counts the queue while a run is in flight", () => {
    const markup = renderToStaticMarkup(
      <ReviewCard
        checkpoint={checkpoint({
          progress: {
            artifactLogicalName: "report.md",
            completed: 2,
            failed: 1,
            phase: "citation",
            queued: 3,
            total: 8,
          },
          status: "running",
        })}
        messageId="message-1"
        reviews={[]}
        running
      />,
    );
    // The phase is what separates a long Deep review from a stuck one.
    assert.ok(markup.includes(TEXT.reviewer.phase.citation));
    assert.ok(!markup.includes(TEXT.reviewer.running));
    // Failed counts as done: the bar is how much is left, not how much worked.
    assert.ok(markup.includes(TEXT.reviewer.progress(3, 8)));
    assert.ok(markup.includes(TEXT.reviewer.queued(3)));
    assert.ok(markup.includes('style="width:38%"'));
  });

  it("counts artifacts when the checks have not started counting", () => {
    // What a Quick run reports: the check counters stay at zero while the
    // artifact counter is the one that moves.
    const markup = renderToStaticMarkup(
      <ReviewCard
        checkpoint={checkpoint({
          progress: {
            artifactCompleted: 10,
            artifactLogicalName: "work/sensitivity_summary.md",
            artifactTotal: 11,
            completed: 0,
            failed: 0,
            phase: "quick",
            queued: 0,
            total: 0,
          },
          status: "running",
        })}
        messageId="message-1"
        reviews={[]}
        running
      />,
    );
    assert.ok(markup.includes(TEXT.reviewer.progress(10, 11)));
    assert.ok(markup.includes('style="width:91%"'));
    assert.ok(!markup.includes(TEXT.reviewer.progress(0, 0)));
  });

  it("draws no bar when the coordinator has not said how much there is", () => {
    const markup = renderToStaticMarkup(
      <ReviewCard
        checkpoint={checkpoint({
          progress: {
            artifactLogicalName: "report.md",
            completed: 0,
            failed: 0,
            queued: 0,
            total: 0,
          },
          status: "running",
        })}
        messageId="message-1"
        reviews={[]}
        running
      />,
    );
    assert.ok(!markup.includes("review-progress-track"));
    // No phase and no total: the generic line is the honest one.
    assert.ok(markup.includes(TEXT.reviewer.running));
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
