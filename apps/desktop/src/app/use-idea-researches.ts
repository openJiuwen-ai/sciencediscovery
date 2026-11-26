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
  /** Take a fresher snapshot of one research — a whole view, as every write and
   *  every stream frame is — and put it in the list. The panel produces one when
   *  the reader presses 继续, and the card at the transcript's foot reads the same
   *  research from this list: neither a resume nor a pause creates a research, so
   *  nothing else would make the shell read the list again, and the card would
   *  keep the status it had before the control for the rest of the session.
   *  A snapshot that says the research is running also makes it live, which is
   *  what restarts the poll the list stopped when it last read `interrupted`.
   *  `fromSession` is the session the answer came from: a panel that outlived a
   *  session switch must not write into the list that is on screen now. */
  apply: (view: IdeaResearchView, fromSession?: string) => void;
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
      // A read answers with the list as it was when the request left, and a control
      // can answer while it is in flight: the resume's `running` must not be put
      // back to `interrupted` by a read that started before it (that would also
      // switch the poll off again). Snapshots taken after this read started win.
      const startedAt = Date.now();
      try {
        const next = await listIdeaResearches(client, sessionId);
        if (!active) return;
        const settled = next.map((item) => {
          const kept = applied.current.get(item.research.id);
          return kept !== undefined && kept.at > startedAt ? kept.view : item;
        });
        // Anything this read is newer than is the read's to decide from now on.
        for (const [id, kept] of applied.current) if (kept.at <= startedAt) applied.current.delete(id);
        setViews(settled);
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

  /** The snapshots a reader's own action produced, with the moment they were
   *  taken, so a list read that started earlier cannot undo them. */
  const applied = useRef(new Map<string, { view: IdeaResearchView; at: number }>());

  // One research replaced by a snapshot the reader has already seen elsewhere. Only
  // a research this list already holds is replaced: the panel reports answers that
  // can arrive after the reader has moved to another session, and a research that
  // session's list does not contain must not be added to it — the list is that
  // session's set of researches, and a foreign card would outlive the switch.
  const apply = useCallback((view: IdeaResearchView, fromSession?: string) => {
    // A panel that outlived a session switch still finishes its requests; its
    // answer belongs to the session it was opened in, not to the one on screen.
    if (fromSession !== undefined && fromSession !== loadedFor.current) return;
    applied.current.set(view.research.id, { view, at: Date.now() });
    setViews((current) => {
      const index = current.findIndex((item) => item.research.id === view.research.id);
      if (index < 0) return current;
      const next = current.slice();
      next[index] = view;
      return next;
    });
  }, []);

  return { views, loading, unavailable, ...(error ? { error } : {}), loads, reload, apply };
}
