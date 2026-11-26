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

/**
 * What a review actually says, as rows the card can draw.
 *
 * The server stores a review as three different shapes — the checks it ran,
 * the findings it raised, and the delivery verdict — and the card must not
 * print those shapes. Everything here reads them into one flat list in the
 * order a reader wants it: what is wrong first, then what was verified, then
 * what was explicitly not checked.
 *
 * Two properties are load-bearing:
 *
 *  - A green card is only green when delivery was actually confirmed (or the
 *    review is structure-only and claims nothing about delivery). That rule
 *    lives in `unverifiedDelivery`, a port of the server's own
 *    `reviewUnverifiedDelivery`: the desktop cannot import the schema's runtime
 *    (its barrel reaches a JSON property import), and two readings of one rule
 *    are worse than one copy with the server's tests behind it.
 *  - Every string is read from `TEXT` at call time, so a language switch
 *    re-labels a card that is already on screen.
 */

import type { ArtifactReviewRun, ChatMessage, ReviewClaim } from "../../api/types.js";
import { TEXT } from "../../text.js";

export type ReviewTone = "pass" | "warn" | "fail" | "pending" | "neutral";

type CheckpointStatus = NonNullable<ChatMessage["reviewerCheckpoint"]>["status"];

/** One card inside an expanded review. `label` is the small category line the
 *  handoff puts above the claim; `title` is the claim; `body` is the evidence. */
export interface ReviewRow {
  id: string;
  tone: ReviewTone;
  label: string;
  /** What the label means, as a hover hint. "计算" is a category name, not a
   *  sentence: a first-time reader cannot tell whether it checks the numbers or
   *  computes them. The label stays one word; the hint carries the explanation. */
  labelTip: string;
  title: string;
  body?: string;
  /** The badge's word, when it is not simply the tone. */
  badge: string;
}

const DELIVERY_CODES = new Set(["DELIVERABLE_MISSING", "DELIVERABLE_EMPTY"]);

/** Which check a finding came from. The server records a finding's code rather
 *  than its category, and the prefix is the stable part of that code. */
function findingCategory(code: string): "structure" | "citation" | "computation" | "semantics" | undefined {
  if (code.startsWith("DELIVERABLE_")) return undefined;
  if (code.startsWith("CITATION_")) return "citation";
  if (code.startsWith("COMPUTATION_")) return "computation";
  if (code.startsWith("SMART_")) return "semantics";
  if (code.startsWith("ARTIFACT_")) return "structure";
  return undefined;
}

function labelFor(category: string): string {
  return TEXT.reviewer.checkNames[category] ?? TEXT.reviewer.title;
}

/** The hover explanation behind a label. A category the card has no separate
 *  wording for falls back to the general finding sentence rather than to
 *  nothing: a row whose label explains itself is still better than a silent one. */
function labelTipFor(category: string): string {
  // The record's keys are named so the `other` fallback is a known string; the
  // lookup itself stays open because a check name comes off the wire.
  const tips: Record<string, string | undefined> = TEXT.reviewer.labelTips;
  return tips[category] ?? TEXT.reviewer.labelTips.other;
}

/**
 * Whether this review may be presented as a delivery pass.
 *
 * Mirrors `reviewUnverifiedDelivery`: a recorded verdict decides; without one,
 * only a structure-only review is exempt, because it never claimed to look at
 * delivery at all.
 */
export function unverifiedDelivery(review: ArtifactReviewRun): boolean {
  if (review.completeness) return review.completeness.status !== "complete";
  const checks = review.checks ?? [];
  return !(checks.length > 0 && checks.every((check) => check === "structure"));
}

/**
 * A review that ran but declared, itself, that some checks were not performed.
 *
 * Port of the server's `reviewDeclaredGap`. A card whose header says
 * "未发现问题" while its own gap rows say "未检查" contradicts itself: what ran
 * did not raise anything, but part of the claim was never examined, so the
 * verdict is not a pass. The web client counts these separately for the same
 * reason.
 */
export function declaredGap(review: Pick<ArtifactReviewRun, "notChecked">): boolean {
  return (review.notChecked?.length ?? 0) > 0;
}

function deliveryFindings(review: ArtifactReviewRun): ArtifactReviewRun["findings"] {
  return review.findings.filter((finding) => DELIVERY_CODES.has(finding.code));
}

/**
 * A Quick pass that only looked at citation format.
 *
 * It did not check whether the claims are supported, so the card must not let
 * "no issues found" stand for the whole review. The web client has the same
 * rule and states it in the verdict; the desktop card has a note line for it.
 */
export function citationOnlyReview(review: ArtifactReviewRun): boolean {
  return review.reviewLevel === "quick"
    && review.checks?.includes("citation") === true
    && !review.checks.includes("computation")
    && !review.checks.includes("structure");
}

/** The verdict's colour, in one order of precedence.
 *
 *  Red means the artifact has a problem: a critical finding, a source
 *  assessment that contradicts the claim, or a delivery verdict of
 *  `incomplete`. Amber means the verdict itself cannot be taken at face value:
 *  a warning-only finding, the review failed, a source assessment supported
 *  only part of the claim, or the version it answered for is no longer current.
 *  Grey means nothing was found wrong and nothing was claimed either: the
 *  checkpoint was skipped, or the review ran but never verified delivery or
 *  declared a check it did not perform. Green means this level ran its checks,
 *  raised nothing, and delivery was confirmed or never claimed — a statement
 *  about the checks, not about the conclusions.
 *
 *  A warning is not a revision request. Its row is amber and its badge reads
 *  提醒, so a red frame over it would claim a severity the finding itself does
 *  not; the web client's `resultLabel` splits the two the same way. An
 *  unverified delivery or an unperformed check is not a finding, so it does not
 *  paint the card amber either: the rows below say what was not checked, in the
 *  same grey, and the summary says it in words (未验证交付 / 未发现问题，但有
 *  N 项未检查).
 *
 *  A failed review is amber rather than red on purpose: an error is not a
 *  verdict on the artifact. A stale review is amber even when it flagged
 *  something, for the same reason the summary carries 已过期: the finding may
 *  no longer describe the turn. */
export function reviewTone(review: ArtifactReviewRun): ReviewTone {
  if (review.status === "failed") return "warn";
  if (review.decision === "SKIPPED") return "neutral";
  if (review.stale === true) return "warn";
  if (review.completeness?.status === "incomplete") return "fail";
  // A critical finding is a problem; a warning is not. The row below already
  // draws the same distinction (`is-fail` vs `is-warn`).
  if (review.findings.some((finding) => finding.severity === "critical")) return "fail";
  // A source verdict is a result about the claim even when no finding was
  // raised: a contradiction, or a passage that only partly supports what the
  // report says, must not sit under a header that says everything passed.
  const sourceVerdicts = (review.sourceAssessments ?? []).map((record) => record.assessment.assessment);
  if (sourceVerdicts.includes("CONTRADICTED")) return "fail";
  if (review.findings.length > 0) return "warn";
  if (sourceVerdicts.includes("PARTIALLY_SUPPORTED")) return "warn";
  if (unverifiedDelivery(review)) return "neutral";
  // Nothing was found wrong, but part of the claim was never examined. That
  // is an absence of a verdict, not a warning about the artifact.
  if (declaredGap(review)) return "neutral";
  return "pass";
}

export function reviewSummary(review: ArtifactReviewRun): string {
  const summary = ((): string => {
    if (review.status === "failed") return TEXT.reviewer.summaryFailed;
    if (review.decision === "SKIPPED") return TEXT.reviewer.summarySkipped;
    if (review.completeness?.status === "incomplete") return TEXT.reviewer.summaryIncomplete;
    const raised = review.findings.filter((finding) => !DELIVERY_CODES.has(finding.code));
    const critical = raised.filter((finding) => finding.severity === "critical").length;
    const warnings = raised.length - critical;
    if (critical > 0 && warnings > 0) return TEXT.reviewer.summaryFindingsAndWarnings(critical, warnings);
    if (critical > 0) return TEXT.reviewer.summaryFindings(critical);
    if (warnings > 0) return TEXT.reviewer.summaryWarnings(warnings);
    // The header uses the row's own word for a source verdict.
    const verdicts = (review.sourceAssessments ?? []).map((record) => record.assessment.assessment);
    if (verdicts.includes("CONTRADICTED")) return TEXT.reviewer.summaryContradicted;
    if (verdicts.includes("PARTIALLY_SUPPORTED")) return TEXT.reviewer.summaryPartlySupported;
    if (unverifiedDelivery(review)) return TEXT.reviewer.summaryUnverified;
    if (declaredGap(review)) return TEXT.reviewer.summaryPartial(review.notChecked?.length ?? 0);
    return TEXT.reviewer.summaryPass;
  })();
  // A verdict on a version that has since been replaced says what it found and
  // that it is history: the reader must not take it for the current state.
  return review.stale === true && review.status !== "failed" ? `${summary}${TEXT.reviewer.outdated}` : summary;
}

function claimText(claim: ReviewClaim | undefined): string | undefined {
  return claim?.text?.trim() || undefined;
}

/** Where a row sits in the card: problems, then results, then absences. */
const ROW_RANK: Record<ReviewTone, number> = { fail: 0, warn: 1, pass: 2, pending: 2, neutral: 3 };

/**
 * What an unperformed check's row says, in the card's language.
 *
 * A Deep review can still leave the claim-support gap (the source service
 * reached no conclusion, or nothing was there to compare). The Quick pass's
 * sentence on that gap tells the reader to run a Deep review — which is the
 * level they just ran, so it contradicts the pill on the same card. A Deep
 * review says instead what its own attempt produced. The status is written
 * only once the stage runs, so an absent status lands on `noComparison` too:
 * with no stage result, nothing was compared either way.
 */
function gapBody(review: ArtifactReviewRun, gap: NonNullable<ArtifactReviewRun["notChecked"]>[number]): string {
  if (gap.check === "claim_support" && (review.reviewLevel === "deep" || review.reviewLevel === "smart")) {
    return review.smartStatus === "inconclusive"
      ? TEXT.reviewer.deepGapBodies.inconclusive
      : TEXT.reviewer.deepGapBodies.noComparison;
  }
  return TEXT.reviewer.gapBodies[gap.check] ?? (gap.reason || TEXT.reviewer.gapBodyUnknown);
}

/**
 * The rows of one review, in reading order.
 *
 * Findings come first because a problem is what the reader opened the card
 * for. Then the checks that ran: that is the only place the card can say
 * *which* checks ran, and "5 项检查" in the header has to have something
 * behind it. What the review did not do comes last — an unverified delivery,
 * a check it declared it did not perform, a source lookup that reached no
 * conclusion — because those are absences, not results, and a reader who has
 * just read what passed is the one who needs them.
 */
export function reviewRows(review: ArtifactReviewRun): ReviewRow[] {
  const rows: ReviewRow[] = [];
  const covered = new Set<string>();

  for (const finding of review.findings) {
    if (DELIVERY_CODES.has(finding.code)) continue;
    const category = findingCategory(finding.code);
    if (category !== undefined) covered.add(category);
    rows.push({
      id: finding.id,
      tone: finding.severity === "critical" ? "fail" : "warn",
      label: category === "semantics" ? TEXT.reviewer.deepSemantic : category === undefined
        ? TEXT.reviewer.title
        : labelFor(category),
      labelTip: category === "semantics"
        ? TEXT.reviewer.labelTips.semantics
        : labelTipFor(category ?? "other"),
      title: finding.message,
      badge: finding.severity === "critical" ? TEXT.reviewer.finding : TEXT.reviewer.warning,
    });
  }

  const completeness = review.completeness;
  if (completeness !== undefined) {
    covered.add("completeness");
    const text = TEXT.reviewer.completeness;
    const source = completeness.source === "brief"
      ? text.sourceBrief
      : completeness.source === "session-fallback" ? text.sourceSession : text.sourceNone;
    const missing = completeness.required
      .filter((entry) => entry.state !== "present")
      .map((entry) => `${entry.state === "empty" ? text.empty : text.missing}：${entry.path}`);
    rows.push({
      id: `${review.id}:completeness`,
      tone: completeness.status === "complete"
        ? "pass"
        : completeness.status === "incomplete" ? "fail" : "neutral",
      label: labelFor("completeness"),
      labelTip: labelTipFor("completeness"),
      title: completeness.status === "complete"
        ? text.complete
        : completeness.status === "incomplete" ? text.incomplete : text.unconfirmed,
      body: missing.length > 0 ? `${source}\n${missing.join("\n")}` : source,
      badge: completeness.status === "complete"
        ? TEXT.reviewer.summaryPass
        : completeness.status === "incomplete" ? TEXT.reviewer.finding : TEXT.reviewer.badgeUnconfirmed,
    });
  }

  for (const [index, gap] of (review.notChecked ?? []).entries()) {
    rows.push({
      id: `${review.id}:gap:${index}`,
      tone: "neutral",
      label: TEXT.reviewer.gaps,
      labelTip: labelTipFor("gaps"),
      title: TEXT.reviewer.gapChecks[gap.check] ?? gap.check,
      body: gapBody(review, gap),
      badge: TEXT.reviewer.gaps,
    });
  }

  // A Deep stage that ended inconclusive gets no row of its own. `smartStatus`
  // is stage-level: one failed lookup makes it inconclusive even when other
  // claims were verified, so a "semantics: no conclusion" row would contradict
  // the per-claim source rows below and repeat the claim-support gap above.
  // Those two already say what the stage could not do: the gap says the claim
  // check is incomplete, and each source row says which claim reached no
  // verdict. The raw detail (e.g. `Paper Reader timeout`) stays out of the card.

  for (const assessment of review.sourceAssessments ?? []) {
    const verdict = assessment.assessment.assessment;
    // An assessment that reached no conclusion is an absence again, not a
    // warning, and its rationale is the policy's own words — "No issued E3
    // source locator is available for this claim." names an evidence level
    // and a locator, neither of which a reader should have to know. The card
    // says the two facts that matter instead: whether any source text was
    // found, and that it was not enough to check the claim. The raw reason
    // stays in the review record.
    const inconclusive = verdict === "INCONCLUSIVE";
    rows.push({
      id: `${review.id}:source:${assessment.claim.id}`,
      tone: inconclusive
        ? "neutral"
        : verdict === "SUPPORTED" ? "pass" : verdict === "CONTRADICTED" ? "fail" : "warn",
      label: TEXT.reviewer.source,
      labelTip: labelTipFor("source"),
      title: claimText(assessment.claim) ?? TEXT.reviewer.source,
      body: inconclusive
        ? assessment.locators.length > 0
          ? TEXT.reviewer.sourceInconclusiveWith(assessment.locators.length)
          : TEXT.reviewer.sourceInconclusiveNone
        : assessment.locators.length > 0
          ? `${assessment.assessment.rationale}\n${TEXT.reviewer.locators(assessment.locators.length)}`
          : assessment.assessment.rationale,
      badge: TEXT.reviewer.assessments[verdict] ?? verdict,
    });
  }

  // A citation lookup that reached no conclusion is not drawn as a row of its
  // own. The web card keeps these in the review record and prints only what the
  // reader can act on; a row saying "无结论" beside a citation-format pass reads
  // as the card contradicting itself. What the review could not do is still
  // said once, as the `notChecked` gap below (`claim_support` stays there until
  // a lookup actually completed).

  // The passing checks last. A category that raised a finding already has its
  // row above, and repeating it as a pass would contradict the finding.
  for (const check of review.checks ?? []) {
    if (covered.has(check) || check === "completeness") continue;
    rows.push({
      id: `${review.id}:check:${check}`,
      tone: "pass",
      label: labelFor(check),
      labelTip: labelTipFor(check),
      title: TEXT.reviewer.checkPass(labelFor(check)),
      body: TEXT.reviewer.passBody,
      badge: TEXT.reviewer.badgePass,
    });
  }

  // The groups above are built in the order the review records them, which is
  // not the order a reader needs: an absence is read after the results, not
  // between them. The sort is stable, so each group keeps its own order.
  rows.sort((left, right) => ROW_RANK[left.tone] - ROW_RANK[right.tone]);
  return rows;
}

/** The card's own count: everything it can show, so the header never promises
 *  more than expansion reveals. */
export function reviewRowCount(reviews: readonly ArtifactReviewRun[]): number {
  return reviews.reduce((total, review) => total + reviewRows(review).length, 0);
}

/**
 * How a checkpoint's artifacts split, when they disagree.
 *
 * The header reports the worst artifact, so one failing report hides the
 * passing ones behind it. Only a mixed batch gets the extra count: when every
 * artifact agrees, the verdict already says the same thing in one phrase, and
 * repeating it as numbers is noise.
 */
export function mixedOutcomeCounts(reviews: readonly ArtifactReviewRun[]): string | undefined {
  if (reviews.length < 2) return undefined;
  const tones = reviews.map(reviewTone);
  const passed = tones.filter((tone) => tone === "pass").length;
  const attention = tones.filter((tone) => tone === "fail" || tone === "warn").length;
  if (passed === 0 || attention === 0) return undefined;
  return TEXT.reviewer.outcomeCounts(passed, attention);
}

const TONE_RANK: Record<ReviewTone, number> = { fail: 4, warn: 3, pending: 2, pass: 1, neutral: 0 };

/** The worst thing among the artifacts a checkpoint reviewed. One failing
 *  report is not hidden behind three green ones.
 *
 *  A checkpoint that produced no review at all still has a verdict of its own:
 *  the coordinator failed, or deliberately skipped it, and the header must say
 *  which rather than claiming there is nothing to show. */
export function checkpointTone(
  reviews: readonly ArtifactReviewRun[],
  status: CheckpointStatus,
): ReviewTone {
  if (reviews.length === 0) return status === "failed" ? "fail" : "neutral";
  return reviews.reduce<ReviewTone>((worst, review) => {
    const tone = reviewTone(review);
    return TONE_RANK[tone] > TONE_RANK[worst] ? tone : worst;
  }, "neutral");
}

/** Why a checkpoint produced no verdict, in words a reader can act on.
 *
 *  The wire value is an enum; printing it (`specialist_disabled`) tells the
 *  reader nothing about where to turn it back on. */
export function skipReasonText(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return TEXT.reviewer.skipReasons[reason] ?? TEXT.reviewer.skipUnknown;
}

export function checkpointSummary(reviews: readonly ArtifactReviewRun[], status: CheckpointStatus): string {
  if (reviews.length === 0) {
    if (status === "failed") return TEXT.reviewer.summaryFailed;
    if (status === "skipped") return TEXT.reviewer.summarySkipped;
    return TEXT.reviewer.empty;
  }
  const worst = reviews.reduce((chosen, review) =>
    TONE_RANK[reviewTone(review)] > TONE_RANK[reviewTone(chosen)] ? review : chosen);
  return reviewSummary(worst);
}
