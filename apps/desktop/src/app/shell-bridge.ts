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
 *   window.sdShell.onJiuwenState(cb) — subscription push
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
  onJiuwenState?: (cb: (state: JiuwenReadiness) => void) => void;
  getJiuwenState?: () => Promise<JiuwenReadiness | null>;
  /** Takeover marker: the shell already ran its data-directory wizard
   *  and the startup flow before loading this SPA (constant true from the
   *  preload; absent in a plain browser). */
  wizardIntroDone?: boolean;
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
    shell.onJiuwenState((next) => {
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
      clearTimeout(timer);
    };
    // The preload installs window.sdShell before any app code runs, so its
    // identity is stable for the page lifetime; "shell" is a module-level read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { hasShell, state };
}
