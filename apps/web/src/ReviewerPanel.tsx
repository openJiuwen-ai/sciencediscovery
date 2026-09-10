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

import type { ArtifactReviewRun } from "@sciencediscovery/schema";
import React, { useEffect, useState } from "react";

import { useLocale, type MessageKey } from "./i18n/index.js";

type ReviewerProgress = {
  artifactLogicalName: string;
  artifactCompleted?: number;
  artifactTotal?: number;
  completed: number;
  failed: number;
  phase?: "quick" | "preparing" | "computation" | "citation";
  queued: number;
  running?: string;
  total: number;
};

export function ReviewerSpecialistAvatar() {
  const specialistName = useLocale().t("specialist.reviewerName");
  return (
    <span aria-label={specialistName} className="reviewer-specialist-avatar" role="img">
      <svg aria-hidden="true" fill="none" viewBox="0 0 40 40">
        <path d="M20 4 32 9v9c0 8.2-4.8 14.5-12 18-7.2-3.5-12-9.8-12-18V9z" fill="currentColor" opacity=".14" />
        <path d="M20 4 32 9v9c0 8.2-4.8 14.5-12 18-7.2-3.5-12-9.8-12-18V9z" stroke="currentColor" strokeWidth="2" />
        <path d="m13.5 20.3 4.2 4.2 9-9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.8" />
      </svg>
    </span>
  );
}

type Translate = ReturnType<typeof useLocale>["t"];

function resultLabel(review: ArtifactReviewRun, t: Translate): { label: string; tone: string } {
  if (review.status === "failed") return { label: t("reviewer.result.failed"), tone: "failed" };
  if (review.findings.some((finding) => finding.severity === "critical")) return { label: t("reviewer.result.revisionRequired"), tone: "critical" };
  if (review.findings.length) return { label: t("reviewer.result.warnings"), tone: "warning" };
  if (review.decision === "ACCEPT_AND_PROCEED") {
    return {
      label: review.smartStatus === "inconclusive"
        ? t("reviewer.result.quickPassed")
        : t("reviewer.result.levelPassed", { level: levelLabel(review, t) }),
      tone: "passed",
    };
  }
  if (review.decision === "SKIPPED") return { label: t("reviewer.result.noChecks"), tone: "skipped" };
  return { label: t("reviewer.result.revisionRequired"), tone: "warning" };
}

const FINDING_KEYS: Record<string, MessageKey> = {
  CITATION_CLAIM_NOT_SUPPORTED: "reviewer.finding.claimUnsupported",
  CITATION_EVIDENCE_ALIAS_UNRESOLVED: "reviewer.finding.evidenceRefMissing",
  CITATION_IDENTIFIER_MISSING: "reviewer.finding.identifierMissing",
  CITATION_MARKER_MISSING: "reviewer.finding.markerMissing",
  CITATION_REFERENCE_MISSING: "reviewer.finding.referenceMissing",
  CITATION_SOURCE_UNAVAILABLE: "reviewer.finding.sourceUnavailable",
  ARTIFACT_JSON_INVALID: "reviewer.finding.invalidJson",
  COMPUTATION_EVIDENCE_INSUFFICIENT: "reviewer.finding.evidenceUnavailable",
  COMPUTATION_EVIDENCE_INTERPRETATION_OVERREACH: "reviewer.finding.overreach",
  COMPUTATION_EVIDENCE_SCOPE_MISMATCH: "reviewer.finding.scopeMismatch",
  COMPUTATION_EVIDENCE_VALUE_MISMATCH: "reviewer.finding.valueMismatch",
};

function findingType(code: string, t: Translate): string {
  const key = FINDING_KEYS[code];
  // An unmapped code (a newer backend than this build) degrades to its own
  // humanised form rather than showing a raw SCREAMING_CASE identifier.
  if (key) return t(key);
  return code.toLowerCase().replace(/_/gu, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function levelLabel(review: ArtifactReviewRun, t: Translate): string {
  return configuredLevelLabel(review.reviewLevel, t);
}

function configuredLevelLabel(level: "quick" | "smart" | "deep" | undefined, t: Translate): string {
  return t(level === "smart" || level === "deep" ? "reviewer.levelDeep" : "reviewer.levelQuick");
}

function CompletedReview({ review }: { review: ArtifactReviewRun }) {
  const { t } = useLocale();
  const presentation = resultLabel(review, t);
  return (
    <details className={`reviewer-specialist-card ${presentation.tone}`}>
      <summary className="reviewer-specialist-card-heading">
        <span aria-hidden="true" className="reviewer-specialist-card-chevron">›</span>
        <span className="reviewer-specialist-card-title">
          <strong>{review.artifactLogicalName}</strong>
          <small>{t("reviewer.versionLine", { level: levelLabel(review, t), version: review.artifactVersionId.slice(0, 8) })}</small>
        </span>
        <i>{presentation.label}</i>
      </summary>
      <div className="reviewer-specialist-card-body">
        {review.findings.length ? (
          <ul className="reviewer-finding-list">
            {review.findings.map((finding) => (
              <li className={finding.severity} key={finding.id}>
                <b>{findingType(finding.code, t)}</b>
                <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!review.findings.length ? (
          <p>{review.decision === "SKIPPED"
            ? t("reviewer.summary.skipped")
            : (review.reviewLevel === "deep" || review.reviewLevel === "smart") && review.smartStatus !== "inconclusive"
              ? t("reviewer.summary.deepPassed")
              : review.checks?.includes("structure")
                ? t("reviewer.summary.structurePassed")
                : t("reviewer.summary.citationPassed")}</p>
        ) : null}
        <footer>
          <span>{t("reviewer.footer", { detail: review.reusedFromReviewId ? t("reviewer.reused") : t("reviewer.levelReview", { level: levelLabel(review, t) }) })}</span>
          <code>{review.artifactContentHash.slice(0, 12)}</code>
        </footer>
      </div>
    </details>
  );
}

function CheckpointOnlyReview({
  error,
  progress,
  reviewLevel,
  status,
}: {
  error?: string;
  progress?: ReviewerProgress;
  reviewLevel?: "quick" | "smart" | "deep";
  status: "completed" | "failed" | "running";
}) {
  const { t } = useLocale();
  const failed = status === "failed";
  const completed = status === "completed";
  const artifactCount = progress?.artifactTotal;
  const runningTitle = artifactCount
    ? t(artifactCount === 1 ? "reviewer.reviewingCountOne" : "reviewer.reviewingCount", { count: artifactCount })
    : t("reviewer.reviewingArtifacts");
  return (
    <details className={`reviewer-specialist-card ${failed ? "failed" : completed ? "skipped" : "running"}`}>
      <summary className="reviewer-specialist-card-heading">
        <span aria-hidden="true" className="reviewer-specialist-card-chevron">›</span>
        <span className="reviewer-specialist-card-title">
          <strong>{failed ? t("reviewer.incomplete") : completed ? t("reviewer.completed") : runningTitle}</strong>
          <small>{configuredLevelLabel(reviewLevel, t)} · {failed ? t("reviewer.statusFailed") : completed ? t("reviewer.statusCompleted") : t("reviewer.statusRunning")}</small>
        </span>
        <i>{status === "running" ? <><span className="reviewer-live-dot" />{t("reviewer.statusRunning")}</> : failed ? t("reviewer.result.failed") : t("reviewer.result.noChecks")}</i>
      </summary>
      <div className="reviewer-specialist-card-body">
        {progress ? <ReviewProgress progress={progress} /> : <p>{failed
          ? error ?? t("reviewer.couldNotComplete")
          : completed
            ? t("reviewer.noArtifactNeeded")
            : reviewLevel === "smart" || reviewLevel === "deep"
              ? t("reviewer.checkingDeep")
              : t("reviewer.checkingQuick")}</p>}
      </div>
    </details>
  );
}

function ReviewProgress({ progress }: { progress: ReviewerProgress }) {
  const { t } = useLocale();
  const processed = progress.completed + progress.failed;
  const artifactProgress = progress.artifactTotal
    ? t("reviewer.artifactsReviewed", { completed: progress.artifactCompleted ?? 0, total: progress.artifactTotal })
    : undefined;
  const phaseLabel = progress.phase === "citation"
    ? t("reviewer.phaseCitation", { processed, total: progress.total })
    : progress.phase === "computation"
      ? t("reviewer.phaseComputation")
      : progress.phase === "quick"
        ? t("reviewer.phaseQuick")
        : t("reviewer.phaseDeep");
  const percent = progress.total ? Math.min(100, Math.round((processed / progress.total) * 100)) : undefined;
  return (
    <div className="reviewer-progress-card">
      <strong>{phaseLabel}</strong>
      <small>{artifactProgress ? `${artifactProgress} · ` : ""}{progress.artifactLogicalName}</small>
      <p><span className="reviewer-rainbow-dot" /> {progress.running ?? t("reviewer.reviewingArtifact")}</p>
      <div aria-label={t("reviewer.progressAria")} className={`reviewer-progress-track${percent === undefined ? " indeterminate" : ""}`}>
        <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </div>
      {progress.total ? <footer><span>{t("reviewer.countCompleted", { count: progress.completed })}</span><span>{t("reviewer.countInconclusive", { count: progress.failed })}</span><span>{t("reviewer.countQueued", { count: progress.queued })}</span></footer> : null}
    </div>
  );
}

function batchSummary(
  reviews: ArtifactReviewRun[],
  status: "completed" | "failed" | "running" | undefined,
  progress: ReviewerProgress | undefined,
  t: Translate,
): string {
  const artifactCount = progress?.artifactTotal ?? reviews.length;
  if (status === "running") {
    return artifactCount
      ? t(artifactCount === 1 ? "reviewer.reviewingCountOne" : "reviewer.reviewingCount", { count: artifactCount })
      : t("reviewer.reviewingCount", { count: "…" });
  }
  if (!reviews.length) return t("reviewer.builtInSpecialist");
  const passed = reviews.filter((review) => review.status !== "failed" && review.decision === "ACCEPT_AND_PROCEED" && !review.findings.length).length;
  const warning = reviews.filter((review) => review.status !== "failed" && review.findings.some((finding) => finding.severity === "warning")).length;
  const revision = reviews.filter((review) => review.status === "failed" || review.findings.some((finding) => finding.severity === "critical")).length;
  const parts = [
    t(reviews.length === 1 ? "reviewer.artifactCountOne" : "reviewer.artifactCount", { count: reviews.length }),
    passed ? t("reviewer.passedCount", { count: passed }) : undefined,
    warning ? t(warning === 1 ? "reviewer.warningCountOne" : "reviewer.warningCount", { count: warning }) : undefined,
    revision ? t("reviewer.revisionCount", { count: revision }) : undefined,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function ReviewerPanel({
  checkpointError,
  checkpointProgress,
  checkpointStatus,
  reviewLevel,
  reviews,
  toolCallId,
}: {
  checkpointError?: string;
  checkpointProgress?: ReviewerProgress;
  checkpointStatus?: "completed" | "failed" | "running";
  reviewLevel?: "quick" | "smart" | "deep";
  reviews: ArtifactReviewRun[];
  toolCallId: string;
}) {
  const { t } = useLocale();
  const scopedReviews = reviews.filter((review) => review.toolCallId === toolCallId);
  const summary = batchSummary(scopedReviews, checkpointStatus, checkpointProgress, t);
  const [expanded, setExpanded] = useState(checkpointStatus === "running");
  useEffect(() => {
    if (checkpointStatus === "running") setExpanded(true);
    else setExpanded(false);
  }, [checkpointStatus, toolCallId]);
  if (!scopedReviews.length && !checkpointStatus) return null;
  // Automatic work is non-intrusive. A stale/deleted Artifact from an older
  // task must never leave a red failure card in the research conversation.
  if (!scopedReviews.length && toolCallId.startsWith("automatic-review:") && checkpointStatus !== "running") return null;
  // Older versions could create checkpoints for code/data Artifacts. The API
  // now omits those records; suppress their empty completed shell as well so a
  // researcher only sees report-quality review activity.
  if (!scopedReviews.length && checkpointStatus === "completed") return null;
  return (
    <details
      aria-label={t("reviewer.panelAria")}
      aria-live="polite"
      className={`reviewer-specialist-panel${checkpointStatus === "running" ? " running" : ""}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      open={expanded}
    >
      <summary className="reviewer-specialist-panel-heading">
        <ReviewerSpecialistAvatar />
        <span>
          <strong>{t("specialist.reviewerName")}</strong>
          <small>{summary}</small>
        </span>
        {checkpointStatus === "running" ? <span className="reviewer-panel-live-status"><span className="reviewer-rainbow-dot" />{t("reviewer.reviewing")}</span> : null}
        <em>{t("reviewer.readOnly")}</em>
        <span aria-hidden="true" className="reviewer-specialist-panel-chevron">›</span>
      </summary>
      <div className="reviewer-specialist-results">
        {checkpointStatus === "running" && scopedReviews.length > 0 && checkpointProgress
          ? <ReviewProgress progress={checkpointProgress} />
          : null}
        {checkpointStatus === "failed" || (!scopedReviews.length && checkpointStatus)
          ? <CheckpointOnlyReview error={checkpointError} progress={checkpointProgress} reviewLevel={reviewLevel} status={checkpointStatus} />
          : null}
        {scopedReviews.map((review) => <CompletedReview key={review.id} review={review} />)}
      </div>
    </details>
  );
}
