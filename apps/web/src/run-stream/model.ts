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

import type {
  RunStreamEvent,
  SessionRun,
} from "@science-agent/schema";

const STOP_STREAM_GRACE_MS = 5_000;

export interface RunStreamRouting {
  /**
   * Feedback about the run as a whole, shown even when the run's Session is not
   * the one on screen.
   */
  toast?: { detail?: string; title: string; tone: "error" | "info" };
  /**
   * Whether this event may write into the panels shared by whichever Session is
   * rendered — messages, reviews, permission cards, plans, subagents, remote
   * jobs, workspace files and the error banner. The run timeline is *not* one
   * of these: it is kept per Session and always records the event (see
   * `recordSessionTimelineEvent`).
   */
  updatesSessionView: boolean;
}

/**
 * Decide what one stream event is allowed to touch. A run keeps streaming after
 * the user switches Sessions, so shared-panel updates are gated on the run's
 * Session still being displayed — but a terminal event still has to report back,
 * and a displayed cancelled run must still close out its own timeline.
 */
export function routeRunStreamEvent(
  event: RunStreamEvent,
  context: { isDisplayed: boolean; sessionTitle?: string },
): RunStreamRouting {
  const updatesSessionView = context.isDisplayed;
  if (event.type === "run.cancelled") {
    return { toast: { detail: event.reason, title: "Run stopped", tone: "info" }, updatesSessionView };
  }
  // A failure in the displayed Session surfaces through the error banner; a
  // background one would otherwise end in silence, so name the Session in a toast.
  if (event.type === "run.failed" && !context.isDisplayed) {
    return {
      toast: {
        detail: event.error,
        title: context.sessionTitle ? `Run failed · ${context.sessionTitle}` : "Run failed",
        tone: "error",
      },
      updatesSessionView,
    };
  }
  return { updatesSessionView };
}

export interface RunStopOptions {
  cancelRun: (sessionId: string) => Promise<unknown>;
  controllers: Map<string, AbortController>;
  graceMs?: number;
  schedule?: (callback: () => void, delayMs: number) => void;
  sessionId: string;
}

/**
 * Stop one Session's run: ask the server first so the run ends as an explicit
 * user cancellation rather than as a dropped connection, and fall back to
 * aborting the local stream if the server does not close it.
 *
 * The controller is looked up once, here, and captured by the fallback. The
 * Session key is reused by whatever run comes next, so a fallback that resolved
 * the controller when it fired would abort that next run instead of this one.
 */
export async function requestRunStop({
  cancelRun,
  controllers,
  graceMs = STOP_STREAM_GRACE_MS,
  schedule = (callback, delayMs) => { setTimeout(callback, delayMs); },
  sessionId,
}: RunStopOptions): Promise<void> {
  const controller = controllers.get(sessionId);
  try {
    await cancelRun(sessionId);
    schedule(() => controller?.abort(), graceMs);
  } catch {
    // 409 means the run already ended server-side; either way the local abort
    // is what releases the composer.
    controller?.abort();
  }
}

export function shouldApplySessionScopedUpdate(
  sourceSessionId: string | undefined,
  visibleSessionId: string | undefined,
): boolean {
  return Boolean(sourceSessionId && visibleSessionId && sourceSessionId === visibleSessionId);
}

export function isSessionRunning(
  sessionId: string | undefined,
  streamCounts: ReadonlyMap<string, number>,
): boolean {
  return Boolean(sessionId && (streamCounts.get(sessionId) ?? 0) > 0);
}

export function isActiveRunStatus(status: SessionRun["status"]): boolean {
  return status === "running" || status === "blocked";
}

export function isTerminalRunStatus(status: SessionRun["status"]): boolean {
  return status === "cancelled" || status === "completed" || status === "failed" || status === "interrupted";
}

export function queuedCancelToast(status: SessionRun["status"]): { detail?: string; title: string; tone: "error" | "info" } {
  if (status === "cancelled") return { title: "Queued run cancelled", tone: "info" };
  if (isActiveRunStatus(status)) {
    return {
      detail: "The queued run has already started; use Stop to cancel the active run.",
      title: "Run already started",
      tone: "info",
    };
  }
  if (isTerminalRunStatus(status)) return { title: "Run already finished", tone: "info" };
  return { detail: `Current status: ${status}`, title: "Queued run updated", tone: "info" };
}

export function runsRequiringEventReplay(runs: SessionRun[]): SessionRun[] {
  return runs
    .filter((run) => !isTerminalRunStatus(run.status))
    .toSorted((left, right) => left.queueOrder - right.queueOrder || left.createdAt.localeCompare(right.createdAt));
}
