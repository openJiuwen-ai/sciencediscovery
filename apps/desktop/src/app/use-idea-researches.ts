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
  /** How many list reads have completed, oldest first. An id can only be new
   *  relative to a read that finished after the command that asked for it. */
  loads: number;
  reload: () => void;
}

export function useIdeaResearches(client: ApiClient, sessionId: string | undefined): IdeaResearchListState {
  const [views, setViews] = useState<IdeaResearchView[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string>();
  const [loads, setLoads] = useState(0);
  const [tick, setTick] = useState(0);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  /** The session the state above belongs to. A list is only ever this session's:
   *  until its own read lands, the previous session's cards must not be on
   *  screen (and must not seed a command's baseline), and a read that answers for
   *  a session that is no longer current is dropped. */
  const loadedFor = useRef<string | undefined>(undefined);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!sessionId) {
      loadedFor.current = undefined;
      setViews([]);
      setLoads(0);
      setUnavailable(false);
      setError(undefined);
      setLoading(false);
      return;
    }
    let active = true;
    if (loadedFor.current !== sessionId) {
      loadedFor.current = sessionId;
      // A new session starts from nothing: no views, no completed reads (which is
      // what puts the auto-open baseline on its safe path), no inherited notice.
      setViews([]);
      setLoads(0);
      setUnavailable(false);
      setError(undefined);
    }
    const load = async () => {
      setLoading(true);
      try {
        const next = await listIdeaResearches(client, sessionId);
        if (!active) return;
        setViews(next);
        setLoads((count) => count + 1);
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

  return { views, loading, unavailable, ...(error ? { error } : {}), loads, reload };
}
