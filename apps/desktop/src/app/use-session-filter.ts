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

import { useEffect, useMemo, useRef, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { listArtifactOutputs, listRuns } from "../api/sessions.js";
import type { Session } from "../api/types.js";
import { isActiveRunStatus } from "./run-status.js";
import type { SidebarFilters } from "./sidebar-filters.js";

export interface SessionFilterFacts {
  /** True when one or more of the on-demand reads failed. The sets then hold
   *  only what did arrive, and the column says the filter may be incomplete
   *  instead of presenting the gap as "no data". */
  failed: boolean;
  /** True while an enabled filter is still reading its facts. */
  pending: boolean;
  /** The Sessions with an unfinished run, or `undefined` while unread. */
  running: ReadonlySet<string> | undefined;
  /** The Sessions that already wrote an artifact, or `undefined` while unread. */
  withArtifacts: ReadonlySet<string> | undefined;
}

/**
 * The two facts the Session record does not carry: whether a Session is
 * running, and whether it has produced anything.
 *
 * Both are read per Session only while their filter is on — the normal list
 * adds no requests. The reviews' F3 named this as the client-side source:
 * `Session` has no run status, and only the open Session's runs are read
 * today.
 *
 * `refreshKey` is what makes the facts follow the data: the sidebar passes the
 * open run's state, and the key below includes each Session's `updatedAt`, so
 * a finished run or a new artifact (which moves `updatedAt` when the lists are
 * refreshed) re-reads instead of leaving a stale "running" row behind.
 */
export function useSessionFilterFacts(
  client: ApiClient,
  sessions: readonly Session[],
  filters: SidebarFilters,
  refreshKey?: unknown,
): SessionFilterFacts {
  const [running, setRunning] = useState<ReadonlySet<string>>();
  const [withArtifacts, setWithArtifacts] = useState<ReadonlySet<string>>();
  const [runningFailed, setRunningFailed] = useState(false);
  const [artifactsFailed, setArtifactsFailed] = useState(false);
  // The effects key on this string rather than on the array identity: the
  // sidebar rebuilds the array on every render, and only a changed id or
  // `updatedAt` is new information. The array itself is read through a ref so
  // a same-key re-render cannot re-issue the reads.
  const latest = useRef(sessions);
  latest.current = sessions;
  const key = useMemo(
    () => sessions.map((session) => `${session.id}@${session.updatedAt}`).join("\u0000"),
    [sessions],
  );

  useEffect(() => {
    if (!filters.onlyRunning) {
      setRunning(undefined);
      setRunningFailed(false);
      return;
    }
    let alive = true;
    setRunning(undefined);
    setRunningFailed(false);
    const ids = latest.current.map((session) => session.id);
    void Promise.allSettled(ids.map((id) => listRuns(client, id))).then((settled) => {
      if (!alive) return;
      const active = new Set<string>();
      settled.forEach((result, index) => {
        const id = ids[index];
        if (id !== undefined && result.status === "fulfilled"
          && result.value.some((run) => isActiveRunStatus(run.status))) {
          active.add(id);
        }
      });
      setRunning(active);
      setRunningFailed(settled.some((result) => result.status === "rejected"));
    });
    return () => {
      alive = false;
    };
  }, [client, filters.onlyRunning, key, refreshKey]);

  useEffect(() => {
    if (!filters.hasArtifacts) {
      setWithArtifacts(undefined);
      setArtifactsFailed(false);
      return;
    }
    let alive = true;
    setWithArtifacts(undefined);
    setArtifactsFailed(false);
    const ids = latest.current.map((session) => session.id);
    void Promise.allSettled(ids.map((id) => listArtifactOutputs(client, id))).then((settled) => {
      if (!alive) return;
      const output = new Set<string>();
      settled.forEach((result, index) => {
        const id = ids[index];
        if (id !== undefined && result.status === "fulfilled" && result.value.length > 0) output.add(id);
      });
      setWithArtifacts(output);
      setArtifactsFailed(settled.some((result) => result.status === "rejected"));
    });
    return () => {
      alive = false;
    };
  }, [client, filters.hasArtifacts, key, refreshKey]);

  return {
    failed: (filters.onlyRunning && runningFailed) || (filters.hasArtifacts && artifactsFailed),
    pending: (filters.onlyRunning && running === undefined)
      || (filters.hasArtifacts && withArtifacts === undefined),
    running,
    withArtifacts,
  };
}
