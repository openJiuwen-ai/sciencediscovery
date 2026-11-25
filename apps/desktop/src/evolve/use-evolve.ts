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
 * different speeds. The runtime is a separate process that a window can
 * outlive, so its readiness is watched at two speeds: quickly while it is not
 * ready, and slowly once it is; the run list belongs to the Session and moves
 * while a search is live. Polling the run list only while one is active is
 * what makes an idle session cost nothing — a finished list cannot change
 * until the user starts another search, and that arrives through `refresh`.
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

/** While a search is expanding, how often its run card is re-read.
 *  Three seconds is the web dashboard's cadence: fast enough that a card is
 *  never visibly stale, slow enough that a long search does not turn into a
 *  request loop. */
const ACTIVE_POLL_MS = 3_000;

/** While the runtime is not ready it is either installing or waiting for a
 *  person; both change on a human timescale, and the installer reports its own
 *  intermediate state from the same endpoint. */
const STATUS_POLL_MS = 4_000;

/** How often a runtime that *is* ready is re-read.
 *
 *  Readiness is neither permanent nor the deployment's: the sidecar is a
 *  process beside the window and can die while the window stays open. Reading
 *  the status once and stopping at `ready` is what let a dead runtime keep
 *  showing 就绪 — the "runtime cannot run the search" banner gone, and 开始设计
 *  ready to spend a design turn on a sidecar that could not run it. So a ready
 *  runtime is re-read, slowly: one request a minute for an idle window, and at
 *  most that long before an open dialog learns the sidecar fell over. */
const READY_POLL_MS = 45_000;

/** How many status reads in a row may fail before a runtime stops being shown
 *  as ready. One is a blip — a restarting server, a proxy hiccup — and turning
 *  a working setup into an error over it would be its own lie; a ready runtime
 *  survives it. Two in a row is an endpoint that is not answering, and the
 *  dialog must not keep offering a design it cannot run. Any success resets
 *  the count, so an unavailable runtime returns to `ready` the moment it
 *  answers again. */
const STATUS_FAILURE_LIMIT = 2;

/** What one status read answered, for the callers that asked for it directly.
 *  `message` is present only on a failure, so an explicit refresh can report
 *  it without the background poll turning every blip into a banner. */
type StatusRead = { message?: string; ok: boolean };

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
  /** The status poll's own reader. `refreshStatus` and the timer share it so
   *  the form can never start a second read beside the one already on the
   *  wire: at most one status request is in flight, and a caller that asks
   *  during one gets that answer. It is unset only between mount and the
   *  effect's first run, where the read it is about to make covers the request
   *  anyway. */
  const readStatus = useRef<(() => Promise<StatusRead>) | undefined>(undefined);
  /** The last list read that succeeded: which session it was for, and whether
   *  it saw an active search. A failed read answers nothing about the search
   *  itself — a restarted server, a proxy hiccup or a dropped request is not a
   *  search that ended — so the poll keeps the cadence the last *answer*
   *  established instead of stopping for good with a card frozen on a run that
   *  is still going.
   *
   *  The session is part of it because the cadence belongs to a list: a read
   *  that fails for a session the last good read never covered is not a search
   *  to keep polling, and the transcript must not keep showing one session's
   *  runs under another's answer. */
  const lastRead = useRef<{ active: boolean; sessionId?: string }>({ active: false });

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Failed reads since the last success. */
    let failures = 0;
    /** The read already in flight, if any. The timer, `refreshStatus` and the
     *  visibility handler all come through `read`, so without this a form
     *  opened during a poll would put a second GET beside it — and whichever
     *  answered last would win. A dead sidecar's `error` could then be
     *  overwritten by an older `ready` and stay on screen for another slow
     *  interval, which is exactly the stale readiness this poll removes. */
    let pending: Promise<StatusRead> | undefined;

    const clear = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    /** A hidden window has nobody reading the status, so the poll stops instead
     *  of asking every few seconds for a banner no one can see. Coming back
     *  reads once, which is also when the state is worth knowing again. */
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

    const arm = (delay: number) => {
      clear();
      if (!live || hidden()) return;
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, delay);
    };

    const start = async (): Promise<StatusRead> => {
      try {
        const next = await getEvolveStatus(client);
        if (!live) return { ok: false };
        failures = 0;
        setStatus(next);
        // Ready is watched too, just slowly: the sidecar can stop being ready
        // with no request of ours to notice it, and a status read once was
        // exactly why the dialog kept showing 就绪 over a dead runtime.
        arm(next.state === "ready" ? READY_POLL_MS : STATUS_POLL_MS);
        return { ok: true };
      } catch (reason: unknown) {
        if (!live) return { ok: false };
        failures += 1;
        // A read failure is not "no runtime". A ready runtime that missed one
        // poll is still ready, so the state the last good read established
        // stays — but only for so long: consecutive failures mean an endpoint
        // that is not answering, and keeping 就绪 then offers a design the
        // runtime cannot run. `installing` is left alone because it is the
        // server's own answer and the poll will read it again.
        if (failures >= STATUS_FAILURE_LIMIT) {
          setStatus((current) => (current.state === "installing"
            ? current
            : { canInitialize: false, state: "error" }));
        }
        arm(STATUS_POLL_MS);
        return { message: reason instanceof Error ? reason.message : String(reason), ok: false };
      } finally {
        pending = undefined;
      }
    };

    const read = (): Promise<StatusRead> => {
      // Reading cancels the poll it interrupts, and joins the one already
      // running instead of starting a rival: only the read that owns `pending`
      // applies its answer and arms the next poll, so an older answer can never
      // land after a newer one.
      clear();
      pending ??= start();
      return pending;
    };

    readStatus.current = read;
    void read();

    const onVisibility = () => {
      if (hidden()) clear();
      else void read();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      clear();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      if (readStatus.current === read) readStatus.current = undefined;
    };
  }, [client]);

  useEffect(() => {
    // The list is this session's own record on disk: unlike starting a search it
    // does not need the runtime to be initialized, which is what lets a session
    // restored from a research package show its cards before Init Evolve.
    // `status.state` is deliberately absent from this condition and from the
    // dependencies below — readiness gates new work, not reading what happened.
    if (sessionId === undefined) {
      lastRead.current = { active: false, sessionId };
      setRuns([]);
      return;
    }
    // The cards are this session's list. Rows read for another session are not
    // this session's to show, and the cadence that read established is not
    // this session's to keep.
    if (lastRead.current.sessionId !== sessionId) {
      lastRead.current = { active: false };
      setRuns([]);
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
          lastRead.current = {
            active: next.some((run) => isEvolveRunActive(run.status)),
            sessionId,
          };
          if (lastRead.current.active) {
            timer = setTimeout(load, ACTIVE_POLL_MS);
          }
        })
        .catch((reason: unknown) => {
          if (!live) return;
          setError(reason instanceof Error ? reason.message : String(reason));
          // One failed read used to end the poll: the effect's dependencies do
          // not change on a rejection, so nothing scheduled another `load` and
          // a live search's cards stayed frozen on whatever the last good read
          // said — including "running" for a search that had finished. The
          // cadence is the last good read's to set; the failure only decides
          // whether there was a cadence to keep.
          if (lastRead.current.active && lastRead.current.sessionId === sessionId) {
            timer = setTimeout(load, ACTIVE_POLL_MS);
          }
        });
    };
    load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, revision, sessionId]);

  const refresh = useCallback(async () => {
    setRevision((value) => value + 1);
  }, []);

  const refreshStatus = useCallback(async () => {
    // The poll's own read — the pending one if a poll is already on the wire,
    // so this cannot start a second chain. The form calls this when it opens:
    // the status it was handed may have been read minutes ago, and a sidecar
    // that died since then must not still be offered as 就绪. Awaiting it
    // means the caller sees the answer it asked for.
    const read = readStatus.current;
    if (read === undefined) return;
    const result = await read();
    if (!result.ok && result.message !== undefined) setError(result.message);
  }, []);

  const initialize = useCallback(async () => {
    setInitializing(true);
    setError(undefined);
    try {
      const next = await initEvolve(client);
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
