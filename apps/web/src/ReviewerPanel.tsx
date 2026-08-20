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
  return (
    <span aria-label="Reviewer Specialist" className="reviewer-specialist-avatar" role="img">
      <svg aria-hidden="true" fill="none" viewBox="0 0 40 40">
        <path d="M20 4 32 9v9c0 8.2-4.8 14.5-12 18-7.2-3.5-12-9.8-12-18V9z" fill="currentColor" opacity=".14" />
        <path d="M20 4 32 9v9c0 8.2-4.8 14.5-12 18-7.2-3.5-12-9.8-12-18V9z" stroke="currentColor" strokeWidth="2" />
        <path d="m13.5 20.3 4.2 4.2 9-9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.8" />
      </svg>
    </span>
  );
}

function resultLabel(review: ArtifactReviewRun): { label: string; tone: string } {
  if (review.status === "failed") return { label: "Review failed", tone: "failed" };
  if (review.findings.some((finding) => finding.severity === "critical")) return { label: "Revision required", tone: "critical" };
  if (review.findings.length) return { label: "Warnings found", tone: "warning" };
  if (review.decision === "ACCEPT_AND_PROCEED") {
    return { label: review.smartStatus === "inconclusive" ? "Quick checks passed" : `${levelLabel(review)} review passed`, tone: "passed" };
  }
  if (review.decision === "SKIPPED") return { label: "No applicable checks", tone: "skipped" };
  return { label: "Revision required", tone: "warning" };
}

function findingType(code: string): string {
  const labels: Record<string, string> = {
    CITATION_CLAIM_NOT_SUPPORTED: "Citation claim unsupported",
    CITATION_EVIDENCE_ALIAS_UNRESOLVED: "Evidence reference missing",
    CITATION_IDENTIFIER_MISSING: "Citation identifier missing",
    CITATION_MARKER_MISSING: "Citation marker missing",
    CITATION_REFERENCE_MISSING: "Citation reference missing",
    CITATION_SOURCE_UNAVAILABLE: "Citation source unavailable",
    ARTIFACT_JSON_INVALID: "Invalid JSON",
    COMPUTATION_EVIDENCE_INSUFFICIENT: "Evidence content unavailable",
    COMPUTATION_EVIDENCE_INTERPRETATION_OVERREACH: "Evidence interpretation overreaches",
    COMPUTATION_EVIDENCE_SCOPE_MISMATCH: "Evidence scope mismatch",
    COMPUTATION_EVIDENCE_VALUE_MISMATCH: "Evidence value mismatch",
  };
  return labels[code] ?? code.toLowerCase().replace(/_/gu, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function levelLabel(review: ArtifactReviewRun): string {
  const level = review.reviewLevel === "smart" ? "deep" : review.reviewLevel ?? "quick";
  return level[0]!.toUpperCase() + level.slice(1);
}

function configuredLevelLabel(level: "quick" | "smart" | "deep" | undefined): string {
  const normalized = level === "smart" ? "deep" : level ?? "quick";
  return normalized[0]!.toUpperCase() + normalized.slice(1);
}

function CompletedReview({ review }: { review: ArtifactReviewRun }) {
  const presentation = resultLabel(review);
  return (
    <details className={`reviewer-specialist-card ${presentation.tone}`}>
      <summary className="reviewer-specialist-card-heading">
        <span aria-hidden="true" className="reviewer-specialist-card-chevron">›</span>
        <span className="reviewer-specialist-card-title">
          <strong>{review.artifactLogicalName}</strong>
          <small>Version {review.artifactVersionId.slice(0, 8)} · {levelLabel(review)}</small>
        </span>
        <i>{presentation.label}</i>
      </summary>
      <div className="reviewer-specialist-card-body">
        {review.findings.length ? (
          <ul className="reviewer-finding-list">
            {review.findings.map((finding) => (
              <li className={finding.severity} key={finding.id}>
                <b>{findingType(finding.code)}</b>
                <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!review.findings.length ? (
          <p>{review.decision === "SKIPPED"
            ? "This locked Artifact contains no additional applicable checks."
            : (review.reviewLevel === "deep" || review.reviewLevel === "smart") && review.smartStatus !== "inconclusive"
              ? "Citation identity, claim support, numeric Evidence, and Quick checks passed."
              : review.checks?.includes("structure")
                ? "The JSON structure and applicable Artifact provenance checks passed."
                : "The applicable citation format and Artifact provenance checks passed."}</p>
        ) : null}
        <footer>
          <span>{review.reusedFromReviewId ? "Unchanged result reused" : `${levelLabel(review)} review`} · Locked Artifact</span>
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
  const failed = status === "failed";
  const completed = status === "completed";
  return (
    <details className={`reviewer-specialist-card ${failed ? "failed" : completed ? "skipped" : "running"}`}>
      <summary className="reviewer-specialist-card-heading">
        <span aria-hidden="true" className="reviewer-specialist-card-chevron">›</span>
        <span className="reviewer-specialist-card-title">
          <strong>{failed ? "Review incomplete" : completed ? "Review completed" : "Reviewing Artifacts"}</strong>
          <small>{configuredLevelLabel(reviewLevel)} · {failed ? "Failed" : completed ? "Completed" : "Running"}</small>
        </span>
        <i>{status === "running" ? <><span className="reviewer-live-dot" />Running</> : failed ? "Review failed" : "No applicable checks"}</i>
      </summary>
      <div className="reviewer-specialist-card-body">
        {progress ? <ReviewProgress progress={progress} /> : <p>{failed
          ? error ?? "Reviewer Specialist could not complete this review."
          : completed
            ? "No Artifact required an additional review result."
            : reviewLevel === "smart" || reviewLevel === "deep"
              ? "Checking citation identity, Evidence support, and Artifact provenance integrity…"
              : "Checking citation format and Artifact provenance integrity…"}</p>}
      </div>
    </details>
  );
}

function ReviewProgress({ progress }: { progress: ReviewerProgress }) {
  const processed = progress.completed + progress.failed;
  const artifactProgress = progress.artifactTotal
    ? `${progress.artifactCompleted ?? 0}/${progress.artifactTotal} Artifacts reviewed`
    : undefined;
  const phaseLabel = progress.phase === "citation"
    ? `Deep Citation queue · ${processed}/${progress.total} references processed`
    : progress.phase === "computation"
      ? "Deep Computation · Comparing numeric Evidence"
      : progress.phase === "quick"
        ? "Quick review · Checking local integrity"
        : "Deep review · Preparing locked Artifact";
  const percent = progress.total ? Math.min(100, Math.round((processed / progress.total) * 100)) : undefined;
  return (
    <div className="reviewer-progress-card">
      <strong>{phaseLabel}</strong>
      <small>{artifactProgress ? `${artifactProgress} · ` : ""}{progress.artifactLogicalName}</small>
      <p><span className="reviewer-rainbow-dot" /> {progress.running ?? "Reviewing Artifact"}</p>
      <div aria-label="Review progress" className={`reviewer-progress-track${percent === undefined ? " indeterminate" : ""}`}>
        <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </div>
      {progress.total ? <footer><span>{progress.completed} completed</span><span>{progress.failed} inconclusive</span><span>{progress.queued} queued</span></footer> : null}
    </div>
  );
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
  const scopedReviews = reviews.filter((review) => review.toolCallId === toolCallId);
  const [expanded, setExpanded] = useState(checkpointStatus === "running");
  useEffect(() => {
    if (checkpointStatus === "running") setExpanded(true);
    else setExpanded(false);
  }, [checkpointStatus, toolCallId]);
  if (!scopedReviews.length && !checkpointStatus) return null;
  return (
    <details
      aria-label="Reviewer Specialist activity"
      aria-live="polite"
      className={`reviewer-specialist-panel${checkpointStatus === "running" ? " running" : ""}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      open={expanded}
    >
      <summary className="reviewer-specialist-panel-heading">
        <ReviewerSpecialistAvatar />
        <span>
          <strong>Reviewer Specialist</strong>
          <small>Built-in Specialist</small>
        </span>
        {checkpointStatus === "running" ? <span className="reviewer-panel-live-status"><span className="reviewer-rainbow-dot" />Reviewing</span> : null}
        <em>READ ONLY</em>
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
