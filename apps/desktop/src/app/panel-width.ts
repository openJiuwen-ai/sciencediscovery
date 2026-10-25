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
 * How wide the workspace panel is allowed to be, and what a drag does to it.
 *
 * Kept apart from the hook that applies it for the same reason `paths.ts` is
 * apart from the views: this is arithmetic with a right answer, and the test for
 * it should not need a DOM to run.
 */

/** The panel's starting width, and the width a fresh install gets. */
export const PANEL_DEFAULT_WIDTH = 720;

/**
 * Neither bound is a taste decision. Below the minimum the file tree's names,
 * sizes and ages stop fitting on one row; above the maximum a panel that used to
 * be a side column has become the main column, and the transcript it was opened
 * to comment on is the thing being squeezed.
 */
export const PANEL_MIN_WIDTH = 480;
export const PANEL_MAX_WIDTH = 1100;

/**
 * The two columns the panel shares the window with, mirrored from the grid in
 * `shell.css` (`256px minmax(0, 1fr) var(--panel-width)`). They are repeated
 * here rather than measured because the ceiling has to be knowable on the first
 * render, before anything is laid out — the panel must not open wider than the
 * window can afford and then snap back on the next frame.
 */
export const PANEL_SIDEBAR_WIDTH = 360;
/** The narrowest the conversation column may be squeezed to by a drag. */
export const PANEL_MIN_CHAT_WIDTH = 512;

/** How far one arrow key moves the splitter; four times that with `Shift`. */
export const PANEL_NUDGE_STEP = 16;
export const PANEL_NUDGE_STRIDE = 4 * PANEL_NUDGE_STEP;

/**
 * The next width while the panel's left edge is being dragged.
 *
 * The panel is on the right, so its edge moves the other way from the pointer:
 * dragging right makes it narrower. A drag that outruns the bounds is not
 * clamped here — the pointer can keep going, and `clampPanelWidth` folds the
 * overshoot away — so the edge picks up exactly where the pointer is when it
 * comes back.
 */
export function panelWidthFromDrag(startWidth: number, startX: number, clientX: number): number {
  return startWidth - (clientX - startX);
}

/** Fold a width into the panel's own two bounds, and nothing else. This is what
 *  the user asked for; `clampPanelWidth` is what they get. */
export function boundedPanelWidth(width: number): number {
  return Math.max(PANEL_MIN_WIDTH, Math.min(width, PANEL_MAX_WIDTH));
}

/**
 * Fold a width into what the current window can actually show.
 *
 * A window too narrow for the floor keeps the floor: the media query in
 * `shell.css` hides the panel altogether below 1100px, so this is only ever
 * reached on the way down, and a panel that is briefly wider than its column
 * beats one that collapses to nothing while the window is being resized.
 *
 * This is applied to what is rendered, not to what is remembered. A window that
 * is narrowed and widened again has to give the panel back, and a width that had
 * been overwritten by the ceiling would not come back; see `use-panel-width.ts`.
 */
export function clampPanelWidth(width: number, viewportWidth: number): number {
  const ceiling = Math.min(
    PANEL_MAX_WIDTH,
    viewportWidth - PANEL_SIDEBAR_WIDTH - PANEL_MIN_CHAT_WIDTH,
  );
  return Math.max(PANEL_MIN_WIDTH, Math.min(boundedPanelWidth(width), ceiling));
}

/**
 * A width read back from storage, which is only trusted as far as its type.
 *
 * Anything else — a string from an older shape, a `null`, a formatter's
 * `NaN` — is indistinguishable from "never set", and the default is a better
 * answer than a guess at what the number meant.
 */
export function storedPanelWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return PANEL_DEFAULT_WIDTH;
  return value;
}
