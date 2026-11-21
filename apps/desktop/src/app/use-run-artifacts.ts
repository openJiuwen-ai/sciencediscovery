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

import { useEffect, useMemo, useState } from "react";
import { groupArtifactOutputsByRun, type Subagent } from "@sciencediscovery/schema";

import type { ApiClient } from "../api/client.js";
import { listSubagents } from "../api/sessions.js";
import type { SessionArtifactOutput, SessionRun } from "../api/types.js";

const NO_SUBAGENTS: readonly Subagent[] = [];

/** Group the active Session's versions. The catalog supplies lineage even
 * when a subagent's snapshots are absent from the replay log. */
export function useRunArtifactOutputs(
  client: ApiClient,
  sessionId: string | undefined,
  outputs: readonly SessionArtifactOutput[],
  terminalRuns: readonly SessionRun[],
  liveRunId: string | undefined,
): ReadonlyMap<string, readonly SessionArtifactOutput[]> {
  const sessionOutputs = useMemo(
    () => sessionId ? outputs.filter(({ version }) => version.sessionId === sessionId) : [],
    [outputs, sessionId],
  );
  const runs = useMemo(
    () => liveRunId ? [...terminalRuns, { id: liveRunId }] : terminalRuns,
    [liveRunId, terminalRuns],
  );
  // A main-agent output needs no catalog read. Reuse a successful catalog for
  // the same origins; a failed read retries on the next outputs refresh.
  const unresolvedOrigins = useMemo(() => {
    const runIds = new Set(runs.map(({ id }) => id));
    return [...new Set(sessionOutputs.flatMap(({ version }) =>
      version.turnId && !runIds.has(version.turnId) ? [version.turnId] : []
    ))].sort().join("\n");
  }, [runs, sessionOutputs]);
  const [catalog, setCatalog] = useState<{
    client: ApiClient;
    sessionId: string;
    origins: string;
    subagents: Subagent[];
  }>();
  useEffect(() => {
    if (!sessionId || !unresolvedOrigins) return;
    if (catalog?.client === client && catalog.sessionId === sessionId && catalog.origins === unresolvedOrigins) return;
    let current = true;
    void listSubagents(client, sessionId).then((subagents) => {
      if (current) setCatalog({ client, sessionId, origins: unresolvedOrigins, subagents });
    }).catch(() => {
      // Direct outputs still have their exact attribution.
    });
    return () => { current = false; };
  }, [catalog, client, sessionId, sessionOutputs, unresolvedOrigins]);
  const subagents = catalog?.client === client && catalog.sessionId === sessionId ? catalog.subagents : NO_SUBAGENTS;
  return useMemo(
    () => groupArtifactOutputsByRun(sessionOutputs, runs, subagents),
    [runs, sessionOutputs, subagents],
  );
}
