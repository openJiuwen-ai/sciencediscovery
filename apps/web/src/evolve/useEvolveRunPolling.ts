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

import { useEffect } from "react";
import { isEvolveRunActive, type EvolveRun } from "@sciencediscovery/schema";
import type { EvolveApiClient } from "../api/evolve.js";

/** Refresh active cards only while their owned service and session are available. */
export function useEvolveRunPolling(
  client: Pick<EvolveApiClient, "listEvolveRuns">,
  sessionId: string | undefined,
  ready: boolean,
  refreshKey: number,
  onRuns: (runs: EvolveRun[]) => void,
) {
  useEffect(() => {
    if (!sessionId || !ready) { onRuns([]); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void client.listEvolveRuns(sessionId).then(runs => {
        if (!live) return;
        onRuns(runs);
        if (runs.some(run => isEvolveRunActive(run.status))) timer = setTimeout(load, 3_000);
      }).catch(() => { if (live) onRuns([]); });
    };
    load();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [sessionId, client, refreshKey, ready, onRuns]);
}
