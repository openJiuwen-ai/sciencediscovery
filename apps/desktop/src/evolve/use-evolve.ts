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
 * The evolve runtime and the open Session's searches, kept current.
 *
 * Two polls, not one, because they answer different questions and change at
 * different speeds. The runtime is a property of the deployment and settles
 * once; the run list belongs to the Session and moves while a search is live.
 * Polling the run list only while one is active is what makes an idle session
 * cost nothing — a finished list cannot change until the user starts another
 * search, and that arrives through `refresh`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isEvolveRunActive, type EvolveRun } from "@sciencediscovery/schema";

import type { EvolveStatus } from "../api/evolve.js";
import {
  getEvolveStatus,
  initEvolve,
  listEvolveRuns,
} from "../api/evolve.js";
import type { ApiClient } from "../api/client.js";

/** While a search is expanding, how often its row in the shelf is re-read.
 *  Three seconds is the web dashboard's cadence: fast enough that a card is
 *  never visibly stale, slow enough that a long search does not turn into a
 *  request loop. */
const ACTIVE_POLL_MS = 3_000;

/** While the runtime is not ready it is either installing or waiting for a
 *  person; both change on a human timescale, and the installer reports its own
 *  intermediate state from the same endpoint. */
const STATUS_POLL_MS = 4_000;

const UNREADY: EvolveStatus = { canInitialize: false, state: "not_initialized" };

export interface EvolveHandle {
  /** The current error from the last read or write, already phrased. */
  error?: string;
  /** The runtime install is in flight, including the wait for the server. */
  initializing: boolean;
  /** `POST /api/evolve/init`, then a status read so the state is the server's. */
  initialize: () => Promise<void>;
  /** Re-read the run list now — after opening the panel, or after a write. */
  refresh: () => Promise<void>;
  /** Re-read the runtime status now. */
  refreshStatus: () => Promise<void>;
  runs: EvolveRun[];
  status: EvolveStatus;
}

export function useEvolve(client: ApiClient, sessionId: string | undefined): EvolveHandle {
  const [status, setStatus] = useState<EvolveStatus>(UNREADY);
  const [runs, setRuns] = useState<EvolveRun[]>([]);
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /** Bumped by `refresh`, which re-runs the run-list effect immediately. */
  const [revision, setRevision] = useState(0);
  /** Whether a status read has landed. Before it does, the app does not know
   *  whether a list request is even allowed. */
  const statusRead = useRef(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void getEvolveStatus(client)
        .then((next) => {
          if (!live) return;
          statusRead.current = true;
          setStatus(next);
          if (next.state !== "ready") timer = setTimeout(load, STATUS_POLL_MS);
        })
        .catch(() => {
          if (!live) return;
          statusRead.current = true;
          // A read failure is not "no runtime": saying `error` is what stops
          // the panel from offering an install the server would refuse anyway.
          setStatus({ canInitialize: false, state: "error" });
          timer = setTimeout(load, STATUS_POLL_MS);
        });
    };
    load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, revision]);

  const ready = status.state === "ready";

  useEffect(() => {
    if (!statusRead.current) return;
    if (sessionId === undefined || !ready) {
      setRuns([]);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void listEvolveRuns(client, sessionId)
        .then((next) => {
          if (!live) return;
          setRuns(next);
          setError(undefined);
          // An active run is the only reason the list changes on its own. A
          // terminal one waits for an explicit refresh, which the panel sends
          // when the user starts or stops something.
          if (next.some((run) => isEvolveRunActive(run.status))) {
            timer = setTimeout(load, ACTIVE_POLL_MS);
          }
        })
        .catch((reason: unknown) => {
          if (!live) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    };
    load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, ready, revision, sessionId]);

  const refresh = useCallback(async () => {
    setRevision((value) => value + 1);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getEvolveStatus(client);
      statusRead.current = true;
      setStatus(next);
    } catch (reason) {
      setStatus({ canInitialize: false, state: "error" });
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [client]);

  const initialize = useCallback(async () => {
    setInitializing(true);
    setError(undefined);
    try {
      const next = await initEvolve(client);
      statusRead.current = true;
      setStatus(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      // Whatever the server said, the truth about the runtime is its status
      // endpoint; a failed POST may have been a timeout after a real install.
      await refreshStatus();
    } finally {
      setInitializing(false);
    }
  }, [client, refreshStatus]);

  return { error, initializing, initialize, refresh, refreshStatus, runs, status };
}
