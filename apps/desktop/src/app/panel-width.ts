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
 * What the panel costs the window besides its own width.
 *
 * The shell is the flex row in `design.css` — rail, middle column, panel — not
 * the three-column grid still written down in `shell.css`: `index.css` loads
 * that older partial first, so its `grid-template-columns` never applies and
 * the flex row below is what the panel actually sits in. `--d-rail` in
 * `tokens.css` defines the rail's width; `design.css` repeats it as two
 * literals (`width: 64px` and `flex: 0 0 64px`) that have to match it.
 * `.main-area` and `.workspace-panel` each keep a 6px left margin
 * (`margin: 6px 0 6px 6px`), so 64 + 6 + 6 = 76px of the window is spent on
 * everything that is not the panel.
 *
 * There is deliberately no sidebar column in that sum. While the panel is open
 * `App` does not render the sidebar at all (`taskSidebar = sidebarOpen &&
 * !panelOpen`), so the two never share a width budget: the panel takes the
 * sidebar's place rather than squeezing in beside it. The old 360 matches the
 * rail plus the 296px `.sidebar` of `design.css`, but that column is not in the
 * row at all while the panel is open.
 *
 * These are mirrored here rather than measured because the ceiling has to be
 * knowable on the first render, before anything is laid out — the panel must
 * not open wider than the window can afford and then snap back on the next
 * frame. The test reads the token, the live `.rail` literals and the two
 * margins back, and fails if any of them drifts away from these numbers.
 */
export const PANEL_RAIL_WIDTH = 64;
/** The gap `.main-area` and `.workspace-panel` each keep on their left. */
export const PANEL_SHELL_GUTTER = 6;
/** Rail plus both gutters: everything in the row that is not the panel. */
export const PANEL_SHELL_RESERVE = PANEL_RAIL_WIDTH + 2 * PANEL_SHELL_GUTTER;
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
 * The panel shares the row with the rail and the two gutters, and the middle
 * column keeps `PANEL_MIN_CHAT_WIDTH` for the conversation; whatever is left
 * over is the panel's ceiling.
 *
 * A window too narrow for the floor keeps the floor. The panel is not on
 * screen that narrow anyway: `shell.css` hides it at 1100px and below with
 * `display: none !important`, which no later `design.css` rule can override
 * (`design.css` also hides it, with the sidebar, at 820px). So this is only
 * ever reached on the way down, and a panel that is briefly wider than its
 * column beats one that collapses to nothing while the window is being resized.
 *
 * This is applied to what is rendered, not to what is remembered. A window that
 * is narrowed and widened again has to give the panel back, and a width that had
 * been overwritten by the ceiling would not come back; see `use-panel-width.ts`.
 */
export function clampPanelWidth(width: number, viewportWidth: number): number {
  const ceiling = Math.min(
    PANEL_MAX_WIDTH,
    viewportWidth - PANEL_SHELL_RESERVE - PANEL_MIN_CHAT_WIDTH,
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
