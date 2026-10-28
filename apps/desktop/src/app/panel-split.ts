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
 * The divider between the panel's list column and its document column, kept
 * pure so the two snap points can be tested without a DOM.
 *
 * The list is on the left and the document on the right, so the divider is one
 * number: how much of the panel the list keeps. Dragging it left shrinks the
 * list, dragging right grows it, and a column that would be left narrower than
 * its own minimum is closed instead — squeezing it to 40px would show a sliver
 * of rows that cannot be read, which is a worse answer than not showing them.
 */

/** How wide the list opens, and the width a fresh panel gives it. */
export const LIST_DEFAULT_WIDTH = 240;

/** The narrowest an open list gets before the drag closes it. Below this a row
 *  of the tree can no longer hold a name and its second fact. */
export const LIST_MIN_WIDTH = 160;

/** The narrowest the document column gets while the list is open. Under this a
 *  markdown page has no room for a line of prose, so the drag closes the
 *  document column instead and lets the list take the panel. */
export const DOC_MIN_WIDTH = 240;

/** How far one arrow key moves the divider. */
export const LIST_NUDGE_STEP = 16;

export interface PanelSplit {
  /** The document column is closed and the list has the whole panel. */
  docClosed: boolean;
  /** The list's width, or 0 when it is closed. */
  list: number;
}

export function initialSplit(): PanelSplit {
  return { docClosed: false, list: LIST_DEFAULT_WIDTH };
}

/**
 * The list's rendered width.
 *
 * `list` is what the drag asked for; this is what the panel can show. The
 * panel itself can be made narrower after the divider was moved, and a list
 * wider than the panel would leave the document with no column at all instead
 * of the minimum this promised it.
 */
export function listWidth(split: PanelSplit, panelWidth: number): number {
  if (split.docClosed) return panelWidth;
  return Math.max(0, Math.min(split.list, panelWidth - DOC_MIN_WIDTH));
}

export function isListClosed(split: PanelSplit): boolean {
  return !split.docClosed && split.list === 0;
}

/**
 * The split after the divider is dragged `delta` pixels from where it started.
 *
 * The delta is measured from the start of the drag rather than accumulated, so
 * a pointer that outruns a bound and comes back picks the divider up exactly
 * where it left it.
 */
export function splitFromDrag(panelWidth: number, start: PanelSplit, delta: number): PanelSplit {
  const wanted = listWidth(start, panelWidth) + delta;
  if (wanted <= LIST_MIN_WIDTH) return { docClosed: false, list: 0 };
  if (wanted >= panelWidth - DOC_MIN_WIDTH) return { docClosed: true, list: panelWidth };
  return { docClosed: false, list: wanted };
}

/**
 * The split after one arrow key.
 *
 * A closed column opens at its own minimum on the first step rather than
 * staying shut until the key has been pressed enough times to cross the snap
 * point: from the keyboard there is no pointer position to show progress, so
 * every press has to do something visible.
 */
export function nudgeSplit(panelWidth: number, current: PanelSplit, delta: number): PanelSplit {
  const base = current.docClosed
    ? panelWidth - DOC_MIN_WIDTH
    : current.list === 0
      ? LIST_MIN_WIDTH
      : Math.min(current.list, panelWidth - DOC_MIN_WIDTH);
  const wanted = base + delta;
  if (wanted <= LIST_MIN_WIDTH) return { docClosed: false, list: 0 };
  if (wanted >= panelWidth - DOC_MIN_WIDTH) return { docClosed: true, list: panelWidth };
  return { docClosed: false, list: wanted };
}
