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

import { useState } from "react";

import type { ArtifactReviewRun, ChatMessage } from "../../api/types.js";
import { TEXT } from "../../text.js";
import {
  checkpointSummary,
  checkpointTone,
  citationOnlyReview,
  reviewRowCount,
  reviewRows,
  reviewSummary,
  reviewTone,
  skipReasonText,
} from "./presentation.js";

type Checkpoint = NonNullable<ChatMessage["reviewerCheckpoint"]>;

/**
 * The Reviewer's verdict, where it happened.
 *
 * A checkpoint message is written into the transcript when artifacts are
 * submitted for review, so the card is anchored to the turn that produced
 * them — the same place the reference puts it. The header is the whole card
 * while it is folded: shield, verdict, and how many checks are behind it.
 *
 * One checkpoint can cover several artifacts, and each gets its own section
 * with its own verdict. The header therefore reports the worst of them: a
 * failing report is not averaged away by two passing ones.
 */
export function ReviewCard({
  checkpoint,
  messageId,
  onReview,
  reviews,
  running,
}: {
  checkpoint: Checkpoint;
  /** The transcript message this card stands for; a re-run names it. */
  messageId: string;
  onReview?: (messageId: string) => void;
  reviews: readonly ArtifactReviewRun[];
  /** The coordinator has this checkpoint queued or running. */
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pending = running && reviews.length === 0;

  // While the review runs there is nothing to fold out: the reference reduces
  // it to a transparent status line, and so does this.
  if (pending) {
    const progress = checkpoint.progress;
    return (
      <div aria-live="polite" className="review-running" data-testid="review-card-running" role="status">
        <span className="review-mark is-pending">
          <ShieldGlyph />
        </span>
        <span className="review-title">{TEXT.reviewer.title}</span>
        <span className="review-sep">·</span>
        <span className="review-summary">{TEXT.reviewer.running}</span>
        {progress === undefined ? null : (
          <>
            <span className="review-sep">·</span>
            <span className="review-progress">
              {progress.artifactLogicalName}
              {progress.total > 0 ? ` ${TEXT.reviewer.progress(progress.completed, progress.total)}` : ""}
            </span>
          </>
        )}
        <span aria-hidden="true" className="review-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    );
  }

  const tone = checkpointTone(reviews, checkpoint.status);
  const count = reviewRowCount(reviews);

  return (
    <div className={`review-card is-${tone}`} data-testid="review-card">
      <button
        aria-expanded={open}
        className="review-head"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className={`review-mark is-${tone}`}>
          <ShieldGlyph />
        </span>
        <span className="review-title">{TEXT.reviewer.title}</span>
        <span className="review-sep">·</span>
        <span className="review-summary">{checkpointSummary(reviews, checkpoint.status)}</span>
        {count > 0 ? (
          <>
            <span className="review-sep">·</span>
            <span className="review-count">{TEXT.reviewer.checks(count)}</span>
          </>
        ) : null}
        {/* A re-run keeps the old verdict readable; the line says another one
            is on the way rather than pretending the old one is current. */}
        {running ? (
          <>
            <span className="review-sep">·</span>
            <span className="review-progress">{TEXT.reviewer.running}</span>
          </>
        ) : null}
        <span aria-hidden="true" className="review-chev">
          ›
        </span>
      </button>

      {open ? (
        <div className="review-body">
          {reviews.length === 0 ? (
            <p className="review-empty">{checkpoint.error ?? skipReasonText(checkpoint.skipReason) ?? TEXT.reviewer.empty}</p>
          ) : null}
          {reviews.map((review) => (
            <ReviewArtifactBody
              key={review.id}
              onRerun={onReview === undefined ? undefined : () => onReview(messageId)}
              review={review}
              showName={reviews.length > 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One artifact's verdict, as the expanded card draws it.
 *
 * Exported because the artifact dialog's Review tab shows the same thing for
 * one version: the two must not drift into two readings of one review.
 */
export function ReviewArtifactBody({
  onRerun,
  review,
  showName,
}: {
  onRerun?: () => void;
  review: ArtifactReviewRun;
  showName: boolean;
}) {
  const rows = reviewRows(review);
  const tone = reviewTone(review);
  const rerun = onRerun === undefined ? null : (
    <button className="review-rerun" onClick={onRerun} type="button">
      {TEXT.reviewer.rerun}
    </button>
  );

  return (
    <section className="review-artifact" data-testid="review-artifact">
      {showName ? (
        <div className="review-artifact-head">
          <span className="review-artifact-name">{review.artifactLogicalName}</span>
          <span className={`review-artifact-verdict is-${tone}`}>{reviewSummary(review)}</span>
        </div>
      ) : null}

      {/* A review answers for one version. Once a newer one exists the card
          stays readable as history, and the re-run is the way forward. */}
      {review.stale ? (
        <div className="review-banner is-stale">
          <span>{TEXT.reviewer.stale}</span>
          {rerun}
        </div>
      ) : null}

      {review.status === "failed" ? (
        <div className="review-banner is-fail">
          <span>{TEXT.reviewer.failedDetail}</span>
          {rerun}
        </div>
      ) : null}

      {review.reusedFromReviewId === undefined ? null : (
        <p className="review-note">{TEXT.reviewer.reused}</p>
      )}

      {/* A citation-format pass did not look at whether the claims hold, and
          the header must not be the only thing the reader sees. */}
      {citationOnlyReview(review) && review.status !== "failed" && !review.stale ? (
        <p className="review-note">{TEXT.reviewer.citationOnlyNote}</p>
      ) : null}

      <div className="review-items">
        {rows.map((row) => (
          <article className={`review-item is-${row.tone}`} key={row.id}>
            <div className="review-item-label">{row.label}</div>
            <div className="review-item-head">
              <span className="review-badge">{row.badge}</span>
              <span className="review-item-title">{row.title}</span>
            </div>
            {row.body ? <p className="review-item-body">{row.body}</p> : null}
            <div className="review-item-foot">
              <span className="review-pill">{TEXT.reviewer.levelPill(review.reviewLevel ?? "quick")}</span>
            </div>
          </article>
        ))}
      </div>

      {/* A failed review that produced no rows still needs a way back. */}
      {rows.length === 0 && review.status !== "failed" ? (
        <p className="review-empty">{TEXT.reviewer.empty}</p>
      ) : null}
    </section>
  );
}

function ShieldGlyph() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M12 3.4 5.2 6.4v5.1c0 4.2 2.8 7.1 6.8 8.7 4-1.6 6.8-4.5 6.8-8.7V6.4z" />
      <path d="m9.2 11.9 2 2.1 3.8-3.9" />
    </svg>
  );
}
