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
import { EN } from "../../text/en.js";

/** The review card is English, as the web client's is: the reviewer writes
 *  English, and a card that switches language while its sentences do not mixes
 *  two languages in one line. Settings and menus stay localized. */
const CARD = EN.reviewer;

export type ReviewTone = "pass" | "warn" | "fail" | "pending" | "neutral";

type CheckpointStatus = NonNullable<ChatMessage["reviewerCheckpoint"]>["status"];

/** One card inside an expanded review, in the one shape every row shares:
 *  which check it is (`category`), what it concluded (`badge`), and one
 *  sentence saying what that means (`body`). Anything longer — the reviewer's
 *  own account, the passages it read — is folded under it.
 *
 *  The shape is fixed on purpose: a reader learns it once. Nothing here may
 *  add a second heading or a differently coloured block. */
export interface ReviewRow {
  id: string;
  tone: ReviewTone;
  /** 结构 / 引用 / 计算 / 完整性 / 来源 …, in the same slot on every row. */
  category: string;
  /** What the category means, as a hover hint. "计算" is a category name, not
   *  a sentence: a first-time reader cannot tell whether it checks the numbers
   *  or computes them. */
  categoryTip: string;
  /** The badge's word, the only coloured part of the row. */
  badge: string;
  /** One sentence: what the check found, or could not do. Always present.
   *  For a source verdict it is the reviewer's own account of what the source
   *  said — the same slot a finding uses for its message. */
  body: string;
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
  return CARD.checkNames[category] ?? CARD.title;
}

/** The hover explanation behind a label. A category the card has no separate
 *  wording for falls back to the general finding sentence rather than to
 *  nothing: a row whose label explains itself is still better than a silent one. */
function labelTipFor(category: string): string {
  // The record's keys are named so the `other` fallback is a known string; the
  // lookup itself stays open because a check name comes off the wire.
  const tips: Record<string, string | undefined> = CARD.labelTips;
  return tips[category] ?? CARD.labelTips.other;
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
/**
 * What the card says about delivery when there is no verdict to show.
 *
 * A task written the way people write tasks ("生成一篇报告") names no files,
 * so the completeness check has nothing to verify against. That is a
 * property of the request, not a result, and it must not turn the whole card
 * into "unconfirmed": the reviewer still checked what it could. The note
 * under the rows says what was not checked, in one line. A structure-only
 * review never claimed delivery at all, so it gets no note.
 */
export function deliveryNote(review: ArtifactReviewRun): string | undefined {
  if (review.completeness?.status === "unconfirmed") return CARD.completeness.unconfirmedNote;
  if (review.completeness === undefined && unverifiedDelivery(review)) return CARD.completeness.notCheckedNote;
  return undefined;
}

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
 *  Red means the artifact has a problem: any finding, or a delivery verdict of
 *  `incomplete`. Amber means the verdict itself cannot be taken at face value:
 *  the review failed, or the version it answered for is no longer current.
 *  Grey means nothing was found wrong and nothing was claimed either: the
 *  checkpoint was skipped, the review declared a check it did not perform, or
 *  a source lookup reached no conclusion. Green means this level ran its
 *  checks, raised nothing, and delivery was confirmed or never claimed — a
 *  statement about the checks, not about the conclusions.
 *
 *  An unperformed check is not a finding, so it does not paint the card
 *  amber; the rows below say what was not checked, in the same grey, and the
 *  header counts them (N 项未检查). A delivery the task never named is not a
 *  colour at all: it is a note under the rows (`deliveryNote`), because it is a
 *  property of the request rather than a result. Amber stays for "this verdict
 *  is about something else" — a failure, history, or a source check that could
 *  not support the claim.
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
  // A problem is a critical finding. A warning is something to look at, not a
  // failure, and the row for it says 提醒; colouring the card red while its
  // own rows say 提醒 made the card contradict itself.
  if (review.findings.some((finding) => finding.severity === "critical")) return "fail";
  if (review.findings.length > 0) return "warn";
  // A source check is a result about the claim even when it raised no finding:
  // a contradiction, or a passage that only partly supports what the report
  // says, is what the reader opened the card for. Without this the card could
  // sit grey while the row inside it was amber.
  const verdicts = (review.sourceAssessments ?? []).map((record) => record.assessment.assessment);
  if (verdicts.includes("CONTRADICTED")) return "fail";
  if (verdicts.includes("PARTIALLY_SUPPORTED")) return "warn";
  // A source lookup that never concluded is an absence: it must not let the
  // header say the review found nothing to worry about.
  if (review.smartStatus === "inconclusive") return "neutral";
  // Nothing was found wrong, but part of the claim was never examined. That
  // is an absence of a verdict, not a warning about the artifact.
  if (declaredGap(review)) return "neutral";
  return "pass";
}

export function reviewSummary(review: ArtifactReviewRun): string {
  const summary = ((): string => {
    if (review.status === "failed") return CARD.summaryFailed;
    if (review.decision === "SKIPPED") return CARD.summarySkipped;
    if (review.completeness?.status === "incomplete") return CARD.summaryIncomplete;
    // Say what the rows say: 问题 for a critical finding, 提醒 for a warning.
    // Counting both as 问题 promised a problem the reader could not find.
    const raised = review.findings.filter((finding) => !DELIVERY_CODES.has(finding.code));
    const problems = raised.filter((finding) => finding.severity === "critical").length;
    const warnings = raised.length - problems;
    if (problems > 0 && warnings > 0) return CARD.summaryMixed(problems, warnings);
    if (problems > 0) return CARD.summaryProblems(problems);
    if (warnings > 0) return CARD.summaryWarnings(warnings);
    // A source verdict is a result even when no finding was raised, and the
    // header has to name it: the card is amber because of it.
    const verdicts = (review.sourceAssessments ?? []).map((record) => record.assessment.assessment);
    const contradicted = verdicts.filter((verdict) => verdict === "CONTRADICTED").length;
    // The header uses the row's own word, not a sentence about the row.
    if (contradicted > 0) return CARD.summaryContradicted;
    if (verdicts.includes("PARTIALLY_SUPPORTED")) return CARD.summaryPartlySupported;
    if (review.smartStatus === "inconclusive") return CARD.summaryInconclusive;
    if (declaredGap(review)) return CARD.summaryPartial(review.notChecked?.length ?? 0);
    return CARD.summaryPass;
  })();
  // A verdict on a version that has since been replaced says what it found and
  // that it is history: the reader must not take it for the current state.
  return review.stale === true && review.status !== "failed" ? `${summary}${CARD.outdated}` : summary;
}

/** Where a row sits in the card: problems, then results, then absences. */
const ROW_RANK: Record<ReviewTone, number> = { fail: 0, warn: 1, pass: 2, pending: 2, neutral: 3 };

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
      category: category === "semantics" ? CARD.deepSemantic : category === undefined
        ? CARD.title
        : labelFor(category),
      categoryTip: category === "semantics"
        ? CARD.labelTips.semantics
        : labelTipFor(category ?? "other"),
      badge: finding.severity === "critical" ? CARD.finding : CARD.warning,
      // The reviewer's own sentence, as written — the web card shows it the
      // same way; the badge above already says which check it came from.
      body: finding.message,
    });
  }

  const completeness = review.completeness;
  if (completeness !== undefined) {
    covered.add("completeness");
    const text = CARD.completeness;
    const source = completeness.source === "brief"
      ? text.sourceBrief
      : completeness.source === "session-fallback" ? text.sourceSession : text.sourceNone;
    const missing = completeness.required
      .filter((entry) => entry.state !== "present")
      .map((entry) => `${entry.state === "empty" ? text.empty : text.missing}：${entry.path}`);
    // Only a verdict the check actually reached is a row. "Unconfirmed"
    // means the task never named the files it should produce, which is how
    // people normally write a task — it is a fact about the request, not a
    // result of the check, so it is a note under the row list instead (see
    // `deliveryNote`).
    if (completeness.status !== "unconfirmed") {
      rows.push({
        id: `${review.id}:completeness`,
        tone: completeness.status === "complete" ? "pass" : "fail",
        category: labelFor("completeness"),
        categoryTip: labelTipFor("completeness"),
        badge: completeness.status === "complete" ? CARD.badgePass : CARD.finding,
        body: completeness.status === "complete"
          ? `${text.complete}. ${source}`
          : `${text.incomplete}. ${missing.length > 0 ? missing.join("; ") : source}`,
      });
    }
  }

  for (const [index, gap] of (review.notChecked ?? []).entries()) {
    rows.push({
      id: `${review.id}:gap:${index}`,
      tone: "neutral",
      // The category is the check that was skipped; the badge says it did not
      // run. The server's own `gap.reason` is an English template and stays in
      // the record; the card says the same thing in one sentence.
      category: CARD.gapChecks[gap.check] ?? gap.check,
      categoryTip: labelTipFor("gaps"),
      badge: CARD.gaps,
      body: gap.reason?.trim() !== undefined && gap.reason.trim() !== ""
        ? gap.reason
        : CARD.gapBodies[gap.check] ?? CARD.gapBodyUnknown,
    });
  }

  if (review.smartStatus === "inconclusive" && review.smartDetail !== undefined) {
    covered.add("semantics");
    // The detail is the source service's own failure text (`Paper Reader
    // timeout`). It is not a finding about the report, so it is not printed as
    // one: the row says the source check reached no conclusion, and the raw
    // message stays out of the card.
    rows.push({
      id: `${review.id}:smart`,
      tone: "neutral",
      category: CARD.deepSemantic,
      categoryTip: labelTipFor("semantics"),
      badge: CARD.badgeUnconfirmed,
      body: CARD.inconclusiveBody,
    });
  }

  for (const assessment of review.sourceAssessments ?? []) {
    const verdict = assessment.assessment.assessment;
    const snapshots = new Map((assessment.snapshots ?? []).map((snapshot) => [snapshot.id, snapshot]));
    // An assessment that reached no conclusion is an absence again, not a
    // warning, and its rationale is the policy's own words — "No issued E3
    // source locator is available for this claim." names an evidence level
    // and a locator, neither of which a reader should have to know. The card
    // says the two facts that matter instead: whether any source text was
    // found, and that it was not enough to check the claim. The raw reason
    // stays in the review record.
    const inconclusive = verdict === "INCONCLUSIVE";
    // The sentence is the result, like a finding's: the reviewer's own account
    // of what the source said ("the abstract supports the gravimetric part but
    // not the stronger claim"). The policy's own words for an inconclusive
    // lookup are replaced: they name evidence levels and locators, and what a
    // reader needs is whether any source text existed and at what depth.
    const secondaryOnly = assessment.locators.length > 0
      && assessment.locators.every((locator) => {
        const type = snapshots.get(locator.snapshotId)?.sourceType;
        return type === "abstract" || type === "paper_metadata";
      });
    const rationale = assessment.assessment.rationale?.trim();
    // The reviewer's own account, as written. The web card shows model text the
    // same way; the badge says the verdict, and the fallback only covers a
    // record with no account at all.
    const body = rationale !== undefined && rationale !== ""
      ? rationale
      : inconclusive
        ? assessment.locators.length === 0
          ? CARD.sourceInconclusiveNone
          : secondaryOnly ? CARD.sourceInconclusiveAbstract : CARD.sourceInconclusiveSome
        : verdict === "CONTRADICTED"
          ? CARD.sourceContradicted
          : verdict === "SUPPORTED" ? CARD.sourceSupported : CARD.sourcePartly;
    rows.push({
      id: `${review.id}:source:${assessment.claim.id}`,
      tone: inconclusive
        ? "neutral"
        : verdict === "SUPPORTED" ? "pass" : verdict === "CONTRADICTED" ? "fail" : "warn",
      category: CARD.source,
      categoryTip: labelTipFor("source"),
      badge: CARD.assessments[verdict] ?? verdict,
      body,
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
      category: labelFor(check),
      categoryTip: labelTipFor(check),
      badge: CARD.badgePass,
      body: `${CARD.checkPass(labelFor(check))}. ${CARD.passBody}`,
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
  return CARD.outcomeCounts(passed, attention);
}

/* A review that could not confirm something outranks one that passed: the
 * header must not say "passed" for a card whose own row says 未确认. */
const TONE_RANK: Record<ReviewTone, number> = { fail: 4, warn: 3, neutral: 2, pass: 1, pending: 0 };

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
  }, "pass");
}

/** Why a checkpoint produced no verdict, in words a reader can act on.
 *
 *  The wire value is an enum; printing it (`specialist_disabled`) tells the
 *  reader nothing about where to turn it back on. */
export function skipReasonText(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return CARD.skipReasons[reason] ?? CARD.skipUnknown;
}

export function checkpointSummary(reviews: readonly ArtifactReviewRun[], status: CheckpointStatus): string {
  if (reviews.length === 0) {
    if (status === "failed") return CARD.summaryFailed;
    if (status === "skipped") return CARD.summarySkipped;
    return CARD.empty;
  }
  const worst = reviews.reduce((chosen, review) =>
    TONE_RANK[reviewTone(review)] > TONE_RANK[reviewTone(chosen)] ? review : chosen);
  return reviewSummary(worst);
}
