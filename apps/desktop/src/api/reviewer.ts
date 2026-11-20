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
 * The Reviewer Specialist's routes, one function each.
 *
 * Reading is what this window does: reviews are written by the service — a
 * checkpoint tool call during a run, or the audit coordinator's own quiet
 * window afterwards — and the desktop only ever asks what exists. The writes
 * here are the session's own preferences, which the server accepts on their
 * own just like the approval mode. The system-wide switch is read and not
 * written: the desktop always has its reviewer, so it never turns it off.
 */

import type { ApiClient } from "./client.js";
import type {
  ArtifactReviewRun,
  ReviewerAuditTask,
  ReviewerSpecialistLevel,
  ReviewerSpecialistSettings,
  SessionReviewerSpecialistSettings,
} from "./types.js";

const base = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`;

/** The system-wide switch. Off means no Reviewer anywhere, including the
 *  automatic audits a session would otherwise get; the desktop reads it so a
 *  session whose reviewer another client turned off can say why it is idle. */
export function getReviewerSettings(client: ApiClient): Promise<ReviewerSpecialistSettings> {
  return client.request<ReviewerSpecialistSettings>("/api/reviewer-specialist/settings");
}

/** The open session's layer: whether it reviews automatically, and at which
 *  level. Both fields are sent on every write because the route replaces the
 *  record rather than patching it. */
export function getSessionReviewerSettings(
  client: ApiClient,
  sessionId: string,
): Promise<SessionReviewerSpecialistSettings> {
  return client.request<SessionReviewerSpecialistSettings>(`${base(sessionId)}/reviewer-specialist/settings`);
}

export function updateSessionReviewerSettings(
  client: ApiClient,
  sessionId: string,
  settings: SessionReviewerSpecialistSettings,
): Promise<SessionReviewerSpecialistSettings> {
  return client.request<SessionReviewerSpecialistSettings>(`${base(sessionId)}/reviewer-specialist/settings`, {
    body: JSON.stringify({ automaticReviewEnabled: settings.automaticReviewEnabled, level: settings.level }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

/** Every review of the session's report-shaped versions, newest first, with
 *  `stale` computed by the server against the current catalog. */
export function listArtifactReviews(client: ApiClient, sessionId: string): Promise<ArtifactReviewRun[]> {
  return client.request<ArtifactReviewRun[]>(`${base(sessionId)}/artifact-reviews`);
}

/** The durable audit queue: what the coordinator has queued, is running, or
 *  finished. It is also the only place a checkpoint message id can be found
 *  without reading the transcript. */
export function listReviewerAuditTasks(client: ApiClient, sessionId: string): Promise<ReviewerAuditTask[]> {
  return client.request<ReviewerAuditTask[]>(`${base(sessionId)}/reviewer-audit-tasks`);
}

/** Ask for a review of the artifacts behind one checkpoint message. The route
 *  answers 202 with the queued task; the reviews themselves arrive later. */
export function requestReview(
  client: ApiClient,
  sessionId: string,
  messageId: string,
): Promise<{ task: ReviewerAuditTask }> {
  return client.request<{ task: ReviewerAuditTask }>(`${base(sessionId)}/reviewer-specialist/review`, {
    body: JSON.stringify({ messageId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

/** Stop whatever the coordinator is running for this session. */
export function cancelReview(client: ApiClient, sessionId: string): Promise<{ cancelled: boolean }> {
  return client.request<{ cancelled: boolean }>(`${base(sessionId)}/reviewer-specialist/cancel`, {
    method: "POST",
  });
}

/** The levels a session can choose between, in the order the flyout lists
 *  them: the cheap deterministic pass first. */
export const REVIEWER_LEVELS: readonly ReviewerSpecialistLevel[] = ["quick", "deep"];
