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
  deliveryNote,
  mixedOutcomeCounts,
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
  onReview,
  reviews,
  running,
}: {
  checkpoint: Checkpoint;
  onReview?: () => void;
  reviews: readonly ArtifactReviewRun[];
  /** The coordinator has this checkpoint queued or running. */
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  // An in-run checkpoint has no audit task, so the queue alone never says it
  // is running; its own message does. Without this the card read "no review"
  // for the whole review.
  const pending = (running || checkpoint.status === "running") && reviews.length === 0;

  // While the review runs there is nothing to fold out: the reference reduces
  // it to a transparent status line, and so does this.
  if (pending) {
    const progress = checkpoint.progress;
    // A Deep review spends most of its time after the quick checks, waiting
    // for one source at a time. The phase is the only thing that separates
    // "working" from "stuck"; finished-over-total is the only thing that says
    // how much of it is left.
    const phase = progress?.phase === undefined ? undefined : TEXT.reviewer.phase[progress.phase];
    // A Quick run counts artifacts and leaves the check counters at zero, so the
    // progress has to come from whichever counter is actually moving.
    const checksTotal = progress?.total ?? 0;
    const counted = progress !== undefined && checksTotal > 0
      ? { done: progress.completed + progress.failed, total: checksTotal }
      : { done: progress?.artifactCompleted ?? 0, total: progress?.artifactTotal ?? 0 };
    const queued = progress?.queued ?? 0;
    return (
      <div aria-live="polite" className="review-running" data-testid="review-card-running" role="status">
        <div className="review-running-line">
          <span className="review-mark is-pending">
            <ShieldGlyph />
          </span>
          <span className="review-title">{TEXT.reviewer.title}</span>
          <span className="review-sep">·</span>
          <span className="review-summary">{phase ?? TEXT.reviewer.running}</span>
          {progress === undefined ? null : (
            <>
              <span className="review-sep">·</span>
              <span className="review-progress">
                {progress.artifactLogicalName}
                {counted.total > 0 ? ` ${TEXT.reviewer.progress(counted.done, counted.total)}` : ""}
              </span>
            </>
          )}
          {queued > 0 ? (
            <>
              <span className="review-sep">·</span>
              <span className="review-progress">{TEXT.reviewer.queued(queued)}</span>
            </>
          ) : null}
          <span aria-hidden="true" className="review-dots">
            <i />
            <i />
            <i />
          </span>
        </div>
        {/* The counts above say the same thing; the bar is the same progress
            read at a glance. It is hidden from assistive tech for that reason. */}
        {counted.total > 0 ? (
          <div aria-hidden="true" className="review-progress-track">
            <i style={{ width: `${Math.round((counted.done / counted.total) * 100)}%` }} />
          </div>
        ) : null}
      </div>
    );
  }

  const tone = checkpointTone(reviews, checkpoint.status);
  const count = reviewRowCount(reviews);
  const outcomes = mixedOutcomeCounts(reviews);

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
        {/* The summary reports the worst artifact; when they disagree, the
            clean ones would otherwise be invisible until expansion. */}
        {outcomes === undefined ? null : (
          <>
            <span className="review-sep">·</span>
            <span className="review-count">{outcomes}</span>
          </>
        )}
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
              onRerun={onReview}
              review={review}
              showName
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
    <section
      className={`review-artifact${showName ? " is-framed" : ""} is-${tone}`}
      data-testid="review-artifact"
    >
      {/* The name is the only thing that says which file this verdict answers
          for: the card's own header reports the worst of several, so a passing
          file behind a failing one would have no name anywhere. The web card
          titles every artifact section, one artifact or five, and so does this. */}
      {showName ? (
        <div className="review-artifact-head">
          <span className="review-artifact-name" title={review.artifactLogicalName}>
            {review.artifactLogicalName}
          </span>
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
          {/* A stale failed review already offers the re-run above. */}
          {review.stale ? null : rerun}
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
          <article className="review-item" key={row.id}>
            {/* One shape for every row: what was checked, what it concluded,
                then one sentence saying what that means. */}
            <header className="review-item-head">
              <span className="review-item-category" title={row.categoryTip}>{row.category}</span>
              <span className={`review-badge is-${row.tone}`}>{row.badge}</span>
            </header>
            <p className="review-item-text">{row.body}</p>
            <div className="review-item-foot">
              <span
                className="review-pill"
                title={TEXT.reviewer.levelTip(review.reviewLevel ?? "quick")}
              >
                {TEXT.reviewer.levelPill(review.reviewLevel ?? "quick")}
              </span>
            </div>
          </article>
        ))}
      </div>

      {/* Delivery is not a check result when the task named no files: it is
          one line saying what was not checked, under the rows. */}
      {deliveryNote(review) === undefined ? null : (
        <p className="review-note">{deliveryNote(review)}</p>
      )}

      {/* A failed review that produced no rows still needs a way back. */}
      {rows.length === 0 && review.status !== "failed" && deliveryNote(review) === undefined ? (
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
