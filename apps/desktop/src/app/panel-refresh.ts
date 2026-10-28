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
 * When the run stream changes what the right panel lists, and how often that
 * list may be read while it does.
 */

/**
 * The events that can put something new in 产物 or the workspace tree.
 *
 * Both are written by the run itself: an artifact version is published, or a
 * file lands in the workspace. Everything else the panel shows — tabs, an open
 * document — belongs to the reader, and a run does not change it.
 */
export function changesPanel(type: string): boolean {
  return type === "artifact.upserted" || type === "workspace.changed";
}

/** One read per window, however many events announce it. A tool call writes
 *  several files in a row and a run may publish a handful of artifacts, and a
 *  request per event would be a request per line of output. */
export const PANEL_REFRESH_MS = 1200;

export interface PanelTimers {
  cancel(handle: unknown): void;
  schedule(callback: () => void, delayMs: number): unknown;
}

const TIMERS: PanelTimers = {
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
};

export interface PanelRefresh {
  /** Drop a read that is waiting for its window to close. The next `request`
   *  starts a fresh one. */
  cancel(): void;
  /** Re-read the panel, at once if the last window has closed. */
  request(): void;
}

/**
 * A leading-and-trailing throttle rather than a debounce.
 *
 * The first event of a quiet run reads immediately, so an artifact appears
 * while the run is still writing rather than after the burst; further events
 * inside the window collapse into one read when it closes, so a run that keeps
 * writing is still followed at one read per window. A debounce would hold the
 * first artifact back until the run went quiet for a whole window, which for a
 * long tool call is exactly when the user is waiting for it.
 */
export function createPanelRefresh(
  run: () => void,
  options: { intervalMs?: number; timers?: PanelTimers } = {},
): PanelRefresh {
  const intervalMs = options.intervalMs ?? PANEL_REFRESH_MS;
  const timers = options.timers ?? TIMERS;
  let cooldown: unknown;
  let trailing = false;

  /** Close the current window, and read once more if anything arrived inside
   *  it. The trailing read opens the next window, so a burst that never pauses
   *  still reads one per window rather than one per event. */
  const scheduleCooldown = (): void => {
    cooldown = timers.schedule(() => {
      cooldown = undefined;
      if (!trailing) return;
      trailing = false;
      scheduleCooldown();
      run();
    }, intervalMs);
  };

  return {
    cancel() {
      if (cooldown !== undefined) timers.cancel(cooldown);
      cooldown = undefined;
      trailing = false;
    },
    request() {
      if (cooldown === undefined) {
        scheduleCooldown();
        run();
        return;
      }
      trailing = true;
    },
  };
}
