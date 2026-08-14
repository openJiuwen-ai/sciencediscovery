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
 * A Session reads as "running" for two independent reasons: this client holds
 * an open run event stream, or the server reports an active (running/blocked)
 * run. The stream count answers "is a subscription already open?" for resume
 * decisions, so only real streams may ever raise it; the run-activity flag
 * only feeds the running indicator. Folding the flag into the count made a
 * refreshed page skip its resubscription: the activity sync marked the
 * Session as counted before any stream existed, and the blocked run's later
 * events never reached the page.
 */
export interface SessionActivity {
  /** Number of run event streams this client actually holds open. */
  streamCount(sessionId: string): number;
  addStream(sessionId: string): void;
  /** Returns the count that remains after removal. */
  removeStream(sessionId: string): number;
  /** Server-reported active-run indicator; never affects streamCount. */
  setRunActivity(sessionId: string, active: boolean): void;
  /** Sessions that should render as running: open streams ∪ active runs. */
  runningSessionIds(): ReadonlySet<string>;
}

export function createSessionActivity(): SessionActivity {
  const streamCounts = new Map<string, number>();
  const activeRunSessions = new Set<string>();
  return {
    streamCount: (sessionId) => streamCounts.get(sessionId) ?? 0,
    addStream(sessionId) {
      streamCounts.set(sessionId, (streamCounts.get(sessionId) ?? 0) + 1);
    },
    removeStream(sessionId) {
      const count = Math.max(0, (streamCounts.get(sessionId) ?? 0) - 1);
      if (count) streamCounts.set(sessionId, count);
      else streamCounts.delete(sessionId);
      return count;
    },
    setRunActivity(sessionId, active) {
      if (active) activeRunSessions.add(sessionId);
      else activeRunSessions.delete(sessionId);
    },
    runningSessionIds: () => new Set([...streamCounts.keys(), ...activeRunSessions]),
  };
}
