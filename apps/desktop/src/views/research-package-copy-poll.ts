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

import { ApiRequestError } from "../api/client.js";
import type { CopyOperation } from "../api/research-package.js";

/** The research-copy poll's user-visible transitions, extracted for a regression test. */
export interface CopyPollStep {
  failures: number;
  error: string;
  copy: CopyOperation | undefined;
  /** True when the poll must stop after applying this step (terminal or settled). */
  terminate: boolean;
}

/**
 * One step of the research-copy poll's state machine.
 *
 * Every terminal outcome clears the stale copy and stops the poll, with a
 * localized message: a 404 (`copyMissing`) or the retry limit being reached
 * (`copyPollingFailed`). A retry inside the bound keeps the copy and says
 * nothing transient.
 */
export function copyPollStep(
  copy: CopyOperation,
  failures: number,
  result: { ok: true; copy: CopyOperation } | { ok: false; reason: unknown },
  t: { copyMissing: string; copyPollingFailed: string },
): CopyPollStep {
  if (result.ok) {
    const next = result.copy;
    return { failures: 0, error: "", copy: next, terminate: next.state !== "copying" };
  }
  const reason = result.reason;
  // A missing source session or operation record is a terminal outcome.
  if (reason instanceof ApiRequestError && reason.status === 404) {
    return { failures, error: t.copyMissing, copy: undefined, terminate: true };
  }
  const next = failures + 1;
  if (next >= 5) {
    return { failures: next, error: t.copyPollingFailed, copy: undefined, terminate: true };
  }
  return { failures: next, error: "", copy, terminate: false };
}