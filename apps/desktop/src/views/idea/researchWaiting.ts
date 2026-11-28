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
 * What a `pausing` research is waiting for.
 *
 * Pause and end are observed by the engine only between steps, while a model
 * request blocks a worker thread. The SSE stream keeps the connection alive with
 * comments but writes no frame during that call, so an elapsed value driven by
 * frames would freeze; these helpers keep a local 1 s clock instead and read the
 * activity the engine already reports.
 */

import { useEffect, useState } from "react";
import type { IdeaResearchActivity, IdeaResearchState } from "@sciencediscovery/schema";

/** The model call the engine is blocked on. Activities run one at a time, so the
 *  last one still marked `running` is the call a stop waits for. */
export function inFlightActivity(research: IdeaResearchState): IdeaResearchActivity | undefined {
  const activities = research.activities ?? [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index]!.status === "running") return activities[index];
  }
  return undefined;
}

/** Whole seconds since `startedAt`; an unreadable timestamp counts as 0 rather
 *  than as a guessed wait. */
export function elapsedSeconds(startedAt: string, now: number): number {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}

/** A clock that ticks once a second while `waiting`, and not at all otherwise:
 *  the panel keeps counting without a stream frame, and a stopped research does
 *  not re-render every second. The interval is cleared on unmount and whenever
 *  the wait ends. */
export function useElapsedClock(waiting: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);
  return now;
}
