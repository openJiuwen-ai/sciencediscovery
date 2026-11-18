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
 * The session's Idea Tree researches, for the card and the panel entry point.
 *
 * Reading is all this does: it lists the session's researches and, while any of them is
 * still live, re-lists on a slow timer so a reopened session catches up even when no
 * stream is attached. It never creates a research — starting one is the agent command's
 * job — and a 503 from the Evolve sidecar is reported as a prerequisite instead of an
 * empty list, so the card can say what to do.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { IdeaResearchView } from "@sciencediscovery/schema";
import type { ApiClient } from "../api/client.js";
import { ApiRequestError } from "../api/client.js";
import { listIdeaResearches } from "../api/idea-tree.js";

const LIVE_POLL_MS = 5_000;

function isLive(status: string | undefined): boolean {
  return status === "running" || status === "pausing";
}

export interface IdeaResearchListState {
  views: IdeaResearchView[];
  loading: boolean;
  unavailable: boolean;
  error?: string;
  reload: () => void;
}

export function useIdeaResearches(client: ApiClient, sessionId: string | undefined): IdeaResearchListState {
  const [views, setViews] = useState<IdeaResearchView[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const next = await listIdeaResearches(client, sessionId);
        if (!active) return;
        setViews(next);
        setUnavailable(false);
        setError(undefined);
      } catch (reason: unknown) {
        if (!active) return;
        if (reason instanceof ApiRequestError && reason.status === 503) setUnavailable(true);
        else setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (active) setLoading(false);
      }
    };
    loadRef.current = load;
    void load();
    return () => { active = false; };
  }, [client, sessionId, tick]);

  // A live research keeps the list fresh while no stream is attached; the timer is
  // cleared the moment nothing is live, so an idle session makes no requests.
  const anyLive = views.some((view) => isLive(view.research.status));
  useEffect(() => {
    if (!sessionId || !anyLive) return;
    const timer = setInterval(() => { void loadRef.current(); }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [anyLive, sessionId]);

  return { views, loading, unavailable, ...(error ? { error } : {}), reload };
}
