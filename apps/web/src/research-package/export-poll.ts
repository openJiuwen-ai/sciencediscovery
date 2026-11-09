// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * One step of the background export poll's state machine.
 *
 * The web monitor used to swallow every failure and retry every two seconds
 * forever: a task the server had already pruned stayed in the list, kept being
 * requested, and never told the user anything — the same defect #981 fixed on
 * the desktop. This is the same shape as the desktop's `exportPollStep`, kept
 * pure so the outcomes are testable without a timer or a fetch.
 */

export type ExportPollResult =
  | { ok: true; status: "queued" | "running" | "completed" | "failed" | "canceled"; error?: string }
  | { ok: false; reason: unknown };

export interface ExportPollOutcome {
  /** Consecutive transport/interim failures for this task. */
  failures: number;
  /** True when this task must be dropped from the tracked list. */
  drop: boolean;
  /** A message worth showing the user, or undefined to stay quiet. */
  notice?: { tone: "error" | "info"; title: string; detail?: string };
}

/** How many consecutive transient failures before the task is given up. */
export const EXPORT_POLL_FAILURE_LIMIT = 5;

/** The failure kinds this poll can tell apart. */
export interface ExportPollText {
  exportFailed: string;
  exportMissing: string;
  exportPollingFailed: string;
  exportCanceled: string;
  legacyUnavailable: string;
  retryBackgroundExport: string;
}

function statusOf(reason: unknown): number | undefined {
  const status = (reason as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** The adapter's 502 `legacy_unavailable` is a transient service outage. */
function legacyUnavailable(reason: unknown): boolean {
  return reason instanceof Error && reason.message === "legacy_unavailable";
}

export function exportPollStep(
  failures: number,
  result: ExportPollResult,
  t: ExportPollText,
  limit = EXPORT_POLL_FAILURE_LIMIT,
): ExportPollOutcome {
  if (result.ok) {
    // A reachable task resets the count: one bad minute must not accumulate
    // across hours of otherwise healthy polling.
    if (result.status === "queued" || result.status === "running") return { drop: false, failures: 0 };
    if (result.status === "failed") {
      return {
        drop: true,
        failures: 0,
        notice: { detail: result.error ?? t.retryBackgroundExport, title: t.exportFailed, tone: "error" },
      };
    }
    if (result.status === "canceled") {
      return { drop: true, failures: 0, notice: { title: t.exportCanceled, tone: "info" } };
    }
    // `completed` is handled by the caller, which has to fetch and save the
    // archive; the poll itself only stops tracking it.
    return { drop: true, failures: 0 };
  }
  // A pruned task is terminal: nothing will bring it back, and retrying it
  // forever is the churn this change removes.
  if (statusOf(result.reason) === 404) {
    return { drop: true, failures: 0, notice: { title: t.exportMissing, tone: "error" } };
  }
  const next = failures + 1;
  if (next >= limit) {
    return {
      drop: true,
      failures: next,
      notice: { detail: t.retryBackgroundExport, title: t.exportPollingFailed, tone: "error" },
    };
  }
  // Say it once per outage. A notice every two seconds is noise, and the point
  // is that the user learns why the task has not finished.
  return {
    drop: false,
    failures: next,
    ...(legacyUnavailable(result.reason) && next === 1
      ? { notice: { title: t.legacyUnavailable, tone: "info" as const } }
      : {}),
  };
}