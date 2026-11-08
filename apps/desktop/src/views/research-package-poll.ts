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

import { ApiRequestError, isLegacyUnavailableError } from "../api/client.js";
import type { ExportOperation } from "../api/research-package.js";

/** The export poll's user-visible transitions, extracted so they have a regression test. */
export interface ExportPollStep {
  failures: number;
  error: string;
  task: { project: string; task: ExportOperation };
  /** True when the poll must stop after applying this step (terminal or settled). */
  terminate: boolean;
}

/**
 * One step of the export poll's state machine.
 *
 * Every terminal outcome — a missing task (`exportMissing`) or the retry limit
 * being reached (`exportPollingFailed`) — settles the task as `failed` so the
 * status row stops pretending work is in flight, and clears the transient
 * banner so a "retrying…" claim never survives the stop. A retry within the
 * bound keeps the task and, for the legacy backend, shows the transient
 * `legacyUnavailable` message.
 */
export function exportPollStep(
  project: string,
  task: ExportOperation,
  failures: number,
  result: { ok: true; task: ExportOperation } | { ok: false; reason: unknown },
  t: { exportMissing: string; exportPollingFailed: string; legacyUnavailable: string },
): ExportPollStep {
  if (result.ok) {
    const next = result.task;
    return {
      failures: 0,
      error: "",
      task: { project, task: next },
      terminate: !["queued", "running"].includes(next.status),
    };
  }
  const reason = result.reason;
  // A deleted export is a terminal outcome: settle and clear the stale task.
  if (reason instanceof ApiRequestError && reason.status === 404) {
    return { failures, error: "", task: { project, task: { ...task, status: "failed", error: t.exportMissing } }, terminate: true };
  }
  const next = failures + 1;
  if (next >= 5) {
    // Both bounded-retry failure kinds settle the task as failed with a
    // terminal message; never leave a live spinner or a "retrying" banner.
    return { failures: next, error: "", task: { project, task: { ...task, status: "failed", error: t.exportPollingFailed } }, terminate: true };
  }
  // Still inside the bound: a transient legacy outage tells the user it will retry.
  return {
    failures: next,
    error: isLegacyUnavailableError(reason) ? t.legacyUnavailable : "",
    task: { project, task },
    terminate: false,
  };
}