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
 * away. There is no timer: a page left open asks again when the reader presses
 * 重新检查, rather than every twenty seconds in the background.
 */

import { useEffect, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { getHealth } from "../api/models.js";
import { TEXT } from "../text.js";

/** The five readings the line can show. Named apart from the component below:
 *  a type alias and a function may share a name in TypeScript, but the mirror's
 *  CodeCheck reads that as a redeclaration (`MemoryStatus` is already defined). */
export type MemoryState = "checking" | "degraded" | "healthy" | "needs-password" | "unknown";

/** The control plane's words, or this app's when the route did not say. */
function statusOf(value: string | undefined): MemoryState {
  switch (value) {
    case "healthy": return "healthy";
    case "degraded": return "degraded";
    case "needs-password": return "needs-password";
    default: return "unknown";
  }
}

function labelOf(status: MemoryState): string {
  const text = TEXT.memory.status;
  switch (status) {
    case "healthy": return text.healthy;
    case "degraded": return text.degraded;
    case "needs-password": return text.needsPassword;
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
  /** Bumped by 重新检查, which is the only way a second read happens. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setStatus("checking");
    getHealth(client).then(
      (report) => {
        if (alive) setStatus(statusOf(report.memoryGraph));
      },
      () => {
        if (alive) setStatus("unknown");
      },
    );
    return () => {
      alive = false;
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
