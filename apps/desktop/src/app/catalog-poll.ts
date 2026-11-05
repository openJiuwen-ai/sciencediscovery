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
 * Re-reading one child's catalog record while it runs.
 *
 * The child's own stream is the live path when it exists. This poll is what
 * keeps a continuation visible that was published under a run the panel does
 * not tail — a wake turn's. Each read returns the *whole* record, and a long
 * one is megabytes, so the poll only runs while someone can see the result.
 */

import type { PanelTimers } from "./panel-refresh.js";

/** How often an open, running child's record is re-read. Slower than the
 *  stream's own cadence: enough to watch the record grow, not to hammer a long
 *  one. */
export const CATALOG_POLL_MS = 5000;

/** How many reads in a row may fail before the panel says the record is no
 *  longer being refreshed. One failed read is a blip; three is 15 s of a panel
 *  that looks live while frozen. */
export const CATALOG_FAILURES_BEFORE_STALE = 3;

const TIMERS: PanelTimers = {
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
};

export interface CatalogPoll {
  /** The window was shown or hidden. A hidden window drops the pending read
   *  rather than fetching a whole record into the dark; a window that comes
   *  back reads once immediately, since the record has most likely moved on
   *  while it was away. */
  visibilityChanged(): void;
  /** Stop for good. A read already in flight is not aborted — it is a request
   *  already sent — but it is not followed by another. */
  stop(): void;
}

export function createCatalogPoll(
  read: () => Promise<unknown>,
  options: {
    hidden?: () => boolean;
    intervalMs?: number;
    timers?: PanelTimers;
    /** Called after every read that fails, with the number of failures in a
     *  row. A read that succeeds resets the count silently; the caller sees
     *  recovery through its own read. */
    onFailing?: (consecutive: number) => void;
  } = {},
): CatalogPoll {
  const intervalMs = options.intervalMs ?? CATALOG_POLL_MS;
  const timers = options.timers ?? TIMERS;
  const hidden = options.hidden ?? (() => document.visibilityState === "hidden");
  let timer: unknown;
  let inFlight = false;
  let stopped = false;
  let failures = 0;

  const clearPending = (): void => {
    if (timer === undefined) return;
    timers.cancel(timer);
    timer = undefined;
  };

  /** The next read is scheduled only after the last one has finished, so a
   *  slow response cannot stack requests; and only while the window is shown,
   *  so a minimised panel costs nothing. */
  const settle = (): void => {
    inFlight = false;
    if (stopped || hidden()) return;
    timer = timers.schedule(poll, intervalMs);
  };

  const poll = (): void => {
    timer = undefined;
    if (stopped || hidden()) return;
    inFlight = true;
    void read().then(
      () => {
        failures = 0;
        settle();
      },
      () => {
        failures += 1;
        options.onFailing?.(failures);
        settle();
      },
    );
  };

  poll();

  return {
    stop() {
      stopped = true;
      clearPending();
    },
    visibilityChanged() {
      if (stopped) return;
      if (hidden()) {
        clearPending();
        return;
      }
      // Back, with neither a read in flight nor one waiting: read at once
      // rather than wait out the interval that was cancelled on hide.
      if (!inFlight && timer === undefined) poll();
    },
  };
}
