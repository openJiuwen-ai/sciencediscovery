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

import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

import {
  DOC_MIN_WIDTH,
  LIST_DEFAULT_WIDTH,
  LIST_MIN_WIDTH,
  initialSplit,
  nudgeSplit,
  splitFromDrag,
  type PanelSplit,
} from "./panel-split.js";

/** How far the pointer may travel and still count as a click rather than a
 *  drag. Under this a press on a closed edge is a request to open it, not an
 *  attempt to resize by three pixels. */
const CLICK_SLOP = 3;

/** Everything the list/document divider needs, in the shape the panel takes as
 *  one object. */
export interface PanelSplitHandle {
  /** Whether the document column is closed, which the panel draws around. */
  split: PanelSplit;
  /** Bring the document column back — a click on a row is a request to see the
   *  document, and a closed column would swallow it. */
  openDoc(): void;
  /** Move the divider by `delta` pixels, from where it is now. */
  nudge(delta: number): void;
  /** Put both columns back to their starting share — what the control at a
   *  closed edge does. */
  reset(): void;
  start(event: PointerEvent<HTMLElement>): void;
  /** The body's measured width, or 0 until it has been measured. The rendered
   *  list width is clamped against it — see `listWidth` — because the panel can
   *  be made narrower after the divider was moved. */
  width: number;
}

/**
 * The divider between the list and the document.
 *
 * The width is measured from the panel's own body rather than kept in a
 * constant: the panel itself is resizable, and the point at which the document
 * column is "too narrow" is a share of whatever width it currently has.
 *
 * The pointer moves run on the divider's own listeners with capture, the way
 * the panel's outer splitter does — the pointer leaves the divider's few pixels
 * immediately, and without capture the drag would stop the first time it did.
 */
export function usePanelSplit(body: RefObject<HTMLDivElement | null>): PanelSplitHandle {
  const [split, setSplit] = useState<PanelSplit>(initialSplit);
  // A pointer handler runs outside the render that installed it, so it reads
  // the state it is about to branch on from here.
  const current = useRef(split);
  current.current = split;
  /** The width the list had the last time the document column was open. Closing
   *  the document gives the list the whole panel, and reopening has to put it
   *  back somewhere other than the whole panel — otherwise the document is
   *  handed a zero-width column and looks like it never came back. */
  const lastOpen = useRef(split.list);
  if (!split.docClosed) lastOpen.current = split.list;

  const panelWidth = () => body.current?.getBoundingClientRect().width ?? 0;

  /** The body's width, kept in state so the render can clamp the list against
   *  it: a drag is measured when it happens, but the panel can also be narrowed
   *  afterwards, and the list has to give way then too. */
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = body.current;
    if (node === null) return;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [body]);

  const openDoc = useCallback(() => {
    setSplit((value) => (value.docClosed ? { docClosed: false, list: lastOpen.current } : value));
  }, []);

  const nudge = useCallback(
    (delta: number) => {
      const width = panelWidth();
      if (width > 0) setSplit(nudgeSplit(width, current.current, delta));
    },
    [body],
  );

  const reset = useCallback(() => {
    const width = panelWidth();
    // The panel can be narrower than the default split when this runs; keep the
    // document its minimum rather than handing it a column of nothing.
    const list = width > 0
      ? Math.min(LIST_DEFAULT_WIDTH, Math.max(LIST_MIN_WIDTH, width - DOC_MIN_WIDTH))
      : LIST_DEFAULT_WIDTH;
    setSplit({ docClosed: false, list });
  }, [body]);

  const start = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const width = panelWidth();
      if (width === 0) return;
      const handle = event.currentTarget;
      const startX = event.clientX;
      const from = current.current;
      // A press that never moves is a click. On a closed edge the whole band is
      // the divider, and the control drawn there is a drawing of what a click
      // does rather than a control of its own — so the click has to be read
      // here, where the drag already is.
      let moved = false;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("is-resizing");

      const move = (moveEvent: globalThis.PointerEvent) => {
        if (Math.abs(moveEvent.clientX - startX) > CLICK_SLOP) moved = true;
        setSplit(splitFromDrag(width, from, moveEvent.clientX - startX));
      };
      const end = () => {
        document.body.classList.remove("is-resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        handle.removeEventListener("lostpointercapture", end);
        if (!moved && (from.docClosed || from.list === 0)) reset();
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
      handle.addEventListener("lostpointercapture", end);
    },
    [body, reset],
  );

  return { nudge, openDoc, reset, split, start, width };
}
