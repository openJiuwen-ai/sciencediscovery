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
 * 科学记忆's state, read beside the switch that decides it.
 *
 * This used to be a capsule in the task header, polling `/api/health` every
 * twenty seconds whether or not memory was on. The header is where a page says
 * what it is about, and a question about storage does not belong there: the
 * reader who cares is the one looking at the switch. So the reading lives next
 * to that switch, and it is read only when there is something to read —
 * turning memory on is what starts a check, and turning it off takes the line
 * away.
 *
 * While the line is on screen it re-reads on its own every
 * MEMORY_STATUS_POLL_MS. A service that was down when the pane opened is the
 * case this line exists for, and a reading that changes only when the reader
 * presses 重新检查 cannot show it come back: whoever restarted the memory
 * service would keep being told it is still broken. The timer stays gated by
 * `enabled`, the next read is scheduled only once the previous one has
 * answered (so a slow service cannot stack requests), and it is cleared when
 * the line goes away. A background read leaves the last answer on screen until
 * the new one arrives; only the first read and a press show 检查中.
 */

import { useEffect, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { getHealth } from "../api/models.js";
import { TEXT } from "../text.js";

/** The four readings the line can show. Named apart from the component below:
 *  a type alias and a function may share a name in TypeScript, but the mirror's
 *  CodeCheck reads that as a redeclaration (`MemoryStatus` is already defined).
 *
 *  `needs-password` is deliberately not one of them. A Neo4j deployment that
 *  has not been given its credential is the memory service's own configuration
 *  — where the graph is stored is not asked for, or answered, in this window —
 *  so naming it would point the reader at a step they cannot take from here.
 *  It reads as any other service that is not working: `degraded`. */
export type MemoryState = "checking" | "degraded" | "healthy" | "unknown";

/** How often a line left on screen asks `/api/health` again. Slower than the
 *  polls that follow a running job: the memory service answers within seconds
 *  of its restart, and 15 s is short enough to notice that without turning a
 *  settings pane into a busy poller. */
export const MEMORY_STATUS_POLL_MS = 15_000;

/** The control plane's words, or this app's when the route did not say. */
function statusOf(value: string | undefined): MemoryState {
  switch (value) {
    case "healthy": return "healthy";
    case "degraded":
    case "needs-password": return "degraded";
    default: return "unknown";
  }
}

function labelOf(status: MemoryState): string {
  const text = TEXT.memory.status;
  switch (status) {
    case "healthy": return text.healthy;
    case "degraded": return text.degraded;
    case "checking": return text.checking;
    default: return text.unknown;
  }
}

interface Props {
  client: ApiClient;
  /** The switch's value. Off draws nothing and asks nothing — the switch beside
   *  this line already says memory is off. */
  enabled: boolean;
}

export function MemoryStatus({ client, enabled }: Props) {
  const [status, setStatus] = useState<MemoryState>("checking");
  /** Bumped by 重新检查, which reads again at once rather than waiting for the
   *  timer's next turn. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // One read at a time: the next one is scheduled by this one's answer, so a
    // service slower than the interval cannot pile up requests behind itself.
    const read = async (): Promise<void> => {
      try {
        const report = await getHealth(client);
        if (!cancelled) setStatus(statusOf(report.memoryGraph));
      } catch {
        if (!cancelled) setStatus("unknown");
      }
      if (cancelled) return;
      timer = setTimeout(() => void read(), MEMORY_STATUS_POLL_MS);
    };

    // Turning the switch on, or a press, is a fresh question and says so. A
    // background re-read is not: the previous answer stays until the next one
    // arrives, so the line does not blink 检查中 every interval.
    setStatus("checking");
    void read();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [attempt, client, enabled]);

  if (!enabled) return null;
  return (
    <span className={`memory-status is-${status}`} role="status">
      <span aria-hidden="true" className="memory-status-dot" />
      <span>{labelOf(status)}</span>
      {status === "checking" ? null : (
        <button
          className="memory-status-recheck"
          onClick={() => setAttempt((value) => value + 1)}
          type="button"
        >
          {TEXT.memory.status.recheck}
        </button>
      )}
    </span>
  );
}
