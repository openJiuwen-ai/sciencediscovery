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
 * Shell bridge: JiuwenSwarm readiness.
 *
 * The Electron shell (sd-shell) watches the cluster after the UI loads and
 * pushes state over the preload bridge:
 *
 *   window.sdShell.onJiuwenState(cb) — subscription push; returns an
 *                                      unsubscribe function
 *   window.sdShell.getJiuwenState()  — one-shot pull (race guard: the first
 *                                      push can race listener setup)
 *
 * Until the cluster reports ready, callers keep chat disabled (App.tsx gates
 * the composer and shows a banner). The module feature-detects the bridge: in
 * a plain browser (vite dev server) no shell exists and the hook reports
 * `hasShell: false, state: null`, which App translates to "not gated" — the
 * dev workflow never blocks. No Electron import: the app must keep running
 * outside the shell.
 *
 * Fallback: some load paths never start the main-process watch, so no
 * push ever arrives. If nothing arrives within 5s, poll the adapter's
 * /agent/info ourselves — the route is adapter-only (native mode and the dev
 * proxy don't serve it), so failures are expected and just keep polling.
 */
import { useEffect, useState } from "react";

import { TEXT } from "../text.js";

export interface JiuwenReadiness {
  ready: boolean;
  elapsed?: number;
  attempt?: number;
  message?: string;
}

interface SdShellJiuwen {
  onJiuwenState?: (cb: (state: JiuwenReadiness) => void) => () => void;
  getJiuwenState?: () => Promise<JiuwenReadiness | null>;
  /** Takeover marker: the shell already ran its data-directory wizard
   *  and the startup flow before loading this SPA (constant true from the
   *  preload; absent in a plain browser). */
  wizardIntroDone?: boolean;
  /** [mac-direct] The installation-level opt-in, exposed only where it
   *  exists (a darwin shell). A plain browser has no bridge; a win32 shell
   *  answers `available: false` because it hard-sets the env flag this
   *  switch would imply. */
  directExecution?: {
    get: () => Promise<{ available: boolean; enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ available: boolean; enabled: boolean }>;
  };
  /** [U5c] This session's sandbox probe verdict, pulled by the settings
   *  row's status line. `kind: "failed"` carries the failure's
   *  reason/diagnostics plus a structured `detail` (failCode) so the row
   *  can localize the cause; `ok` carries no detail. The bridge never
   *  answers "not-applicable" — the main process normalizes non-darwin
   *  verdicts to null because the row's group is darwin-only (review F14).
   *  Absent in a plain browser and in builds whose preload predates U5c. */
  seatbeltStatus?: () => Promise<SeatbeltStatusPayload | null>;
}

/** [U5c] The normalized verdict the settings row renders from. [F18]
 *  `directActive` is the mode the running stack was spawned with (the
 *  session flag the main process set inside darwinDirectEnv), so the row
 *  describes the live stack even right after a mid-session switch toggle —
 *  the switch shows the desired state, the row the current one. */
export type SeatbeltStatusPayload =
  | { kind: "ok"; platform: "darwin"; directActive: boolean; modeKnown: boolean }
  | {
    kind: "failed";
    platform: "darwin";
    reason: string;
    diagnostics: string[];
    detail: { failCode: "spawn-error" | "signal" | "exit-code"; signal?: string; exitCode?: number; spawnError?: string };
    directActive: boolean;
    modeKnown: boolean;
  };

/**
 * [U5c] The session's sandbox verdict as told by the shell. The hook mirrors
 * useShellDirectExecution's shape: `unknown` (never a thrown promise)
 * whenever there is nothing to say — no shell (plain browser / SSR), a shell
 * whose preload predates U5c, or a bridge hiccup. The settings row renders
 * its status line from the kind; GeneralSettings decides which verdicts are
 * worth a row (see there).
 *
 * Pulled once on mount, not subscribed: the verdict is decided in
 * app.whenReady before any SPA loads and never changes while the app runs.
 */
export function useSeatbeltStatus(): { status: SeatbeltStatusPayload | null } {
  const [status, setStatus] = useState<SeatbeltStatusPayload | null>(null);

  // SSR/tests run this hook where `window` does not exist; a shell bridge is
  // a browser-only concept (same guard shape as wizardIntroHandled below).
  const shell = typeof window === "undefined"
    ? undefined
    : (window as typeof window & { sdShell?: SdShellJiuwen }).sdShell;

  useEffect(() => {
    let cancelled = false;
    if (!shell?.seatbeltStatus) return;
    void shell.seatbeltStatus().then((answer) => {
      // A null answer (bridge hiccup / pre-U5c shell) leaves "unknown": a
      // status row that claims a sandbox verdict the session never gave
      // would state a fact nobody probed.
      if (!cancelled && answer) setStatus(answer);
    }).catch(() => { /* transport hiccup: keep "unknown" */ });
    return () => { cancelled = true; };
    // The preload installs window.sdShell before any app code runs, so its
    // identity is stable for the page lifetime; "shell" is a module-level read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status };
}

/**
 * The [mac-direct] opt-in as a settings-row state machine.
 *
 * `available` is false and stays false in a plain browser and on every shell
 * that does not offer the switch, so the row never renders there. On a shell
 * that does, the value comes back from the main process's re-read of its
 * persisted file — including the bounce-back when a write failed — and a
 * write re-renders from the reply alone (no refetch: the reply IS the
 * post-write truth).
 */
export function useShellDirectExecution(): {
  available: boolean;
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [state, setState] = useState<{ available: boolean; enabled: boolean }>({ available: false, enabled: false });

  // SSR/tests run this hook where `window` does not exist; a shell bridge is a
  // browser-only concept, so report "no switch" there (same guard shape as
  // wizardIntroHandled below).
  const shell = typeof window === "undefined"
    ? undefined
    : (window as typeof window & { sdShell?: SdShellJiuwen }).sdShell;

  useEffect(() => {
    let cancelled = false;
    if (!shell?.directExecution) return;
    void shell.directExecution.get().then((answer) => {
      if (!cancelled) setState(answer);
    }).catch(() => { /* no switch to show: keep available=false */ });
    return () => { cancelled = true; };
    // The preload installs window.sdShell before any app code runs, so its
    // identity is stable for the page lifetime; "shell" is a module-level read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setEnabled = (next: boolean) => {
    void shell?.directExecution?.set(next).then((answer) => setState(answer)).catch(() => {
      // A failed write leaves the row where it was; the re-read on next
      // mount still tells the truth.
    });
  };

  return { available: state.available, enabled: state.enabled, setEnabled };
}

/**
 * True when the shell already handled the first-run intro (workspace choice +
 * backend boot), so the SPA wizard should open at model configuration instead
 * of walking the user through steps that already happened. Always false in a
 * plain browser, where the SPA's full three-step flow stays intact.
 */
export function wizardIntroHandled(): boolean {
  if (typeof window === "undefined") return false;
  const shell = (window as typeof window & { sdShell?: SdShellJiuwen }).sdShell;
  return shell?.wizardIntroDone === true;
}

const POLL_AFTER_MS = 5_000;
const POLL_INTERVAL_MS = 3_000;

async function pollAgentInfo(): Promise<JiuwenReadiness | null> {
  try {
    const res = await fetch("/agent/info");
    if (res.ok) {
      const body = (await res.json()) as { jiuwenswarm?: { reachable?: boolean } };
      if (body.jiuwenswarm?.reachable) return { ready: true };
    }
  } catch {
    // adapter not up yet — keep polling
  }
  return null;
}

/**
 * The gate's core semantics, kept as a pure function so tests can pin it:
 * - no shell at all (plain browser) → never gated;
 * - shell present but no verdict yet → gated (a `?? true` default here would
 *   let messages through into semantic-errors while the cluster boots);
 * - otherwise whatever the shell last said.
 */
export function jwReadyFromBridge(
  hasShell: boolean,
  state: JiuwenReadiness | null,
): boolean {
  if (!hasShell) return true;
  return state?.ready === true;
}

/**
 * Readiness as seen by the shell bridge. `state === null` with a shell
 * present means "watch started, no verdict yet" — callers must treat that as
 * NOT ready (a `?? true` default would let messages through into
 * semantic-errors).
 */
export function useJiuwenReadiness(): { hasShell: boolean; state: JiuwenReadiness | null } {
  const [state, setState] = useState<JiuwenReadiness | null>(null);

  const shell = (window as typeof window & { sdShell?: SdShellJiuwen }).sdShell;
  const hasShell = Boolean(shell?.onJiuwenState);

  useEffect(() => {
    if (!shell?.onJiuwenState) return;
    let cancelled = false;
    let received = false;
    const unsubscribe = shell.onJiuwenState((next) => {
      if (cancelled) return;
      received = true;
      setState(next);
    });
    void shell.getJiuwenState?.().then((pulled) => {
      if (cancelled || !pulled) return;
      received = true;
      setState((prev) => prev ?? pulled);
    });
    const timer = setTimeout(() => {
      if (cancelled || received) return;
      const poll = async () => {
        const next = await pollAgentInfo();
        if (cancelled) return;
        if (next) {
          setState(next);
          return;
        }
        setState((prev) => prev ?? { ready: false, message: TEXT.jiuwen.starting });
        setTimeout(() => void poll(), POLL_INTERVAL_MS);
      };
      void poll();
    }, POLL_AFTER_MS);
    return () => {
      cancelled = true;
      unsubscribe();
      clearTimeout(timer);
    };
    // The preload installs window.sdShell before any app code runs, so its
    // identity is stable for the page lifetime; "shell" is a module-level read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { hasShell, state };
}
