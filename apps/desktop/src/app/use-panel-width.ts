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

import { useCallback, useEffect, useRef, useState } from "react";

import { PANEL_WIDTH_STORAGE_KEY, readStoredJson, writeStoredJson } from "../state/storage.js";
import {
  PANEL_DEFAULT_WIDTH,
  boundedPanelWidth,
  clampPanelWidth,
  panelWidthFromDrag,
  storedPanelWidth,
} from "./panel-width.js";

/** Everything the splitter needs, in the shape the panel takes as one prop. */
export interface PanelResize {
  /** Move the panel by `delta` pixels, from where it is now. */
  nudge(delta: number): void;
  start(event: React.PointerEvent<HTMLElement>): void;
  /** The width to lay the panel out at — the remembered one, as far as this
   *  window can show it. */
  width: number;
}

/** What the user last asked for, folded into the panel's own bounds. The window
 *  is deliberately not consulted: a width chosen on a large screen is still the
 *  width the user chose when they come back to a small one. */
function desiredWidth(): number {
  return boundedPanelWidth(
    storedPanelWidth(readStoredJson<unknown>(localStorage, PANEL_WIDTH_STORAGE_KEY, PANEL_DEFAULT_WIDTH)),
  );
}

/**
 * The workspace panel's width, and the drag that changes it.
 *
 * The width lives in the shell's grid rather than in the panel, and the drag
 * runs on the splitter's own pointer moves, so both belong to the component
 * that owns the layout — this hook is called once, by `App`, and handed down to
 * the splitter as one object.
 *
 * There are two widths here on purpose. `desired` is what the user asked for and
 * is the one written to storage; `width` is that folded into what the window can
 * currently show, and is the one rendered. Clamping the remembered value instead
 * would make a narrow window destructive: shrink the window, and the ceiling
 * would be written down in place of the width, so widening the window again
 * would leave the panel as narrow as the smallest window it had ever been seen
 * in.
 *
 * Only the ends of an interaction are written to storage. A drag sets state on
 * every pointer move, and serializing the width sixty times a second to a
 * synchronous store would be the one part of the drag that could stutter; the
 * width the drag stops at is the only one worth remembering anyway.
 */
export function usePanelWidth(): PanelResize {
  const [desired, setDesired] = useState(desiredWidth);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const width = clampPanelWidth(desired, viewport);
  // The pointer-down handler runs outside React's render, so it reads the
  // current width from here rather than from a stale closure.
  const current = useRef(width);
  current.current = width;
  const drag = useRef<{ last: number; startWidth: number; startX: number } | null>(null);

  // A window that shrinks under a wide panel would leave the conversation
  // column squeezed below its floor. Re-measuring is what keeps the rendered
  // width in step; what the user asked for is left alone.
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const nudge = useCallback((delta: number) => {
    const next = clampPanelWidth(current.current + delta, window.innerWidth);
    setDesired(next);
    writeStoredJson(localStorage, PANEL_WIDTH_STORAGE_KEY, next);
  }, []);

  const start = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const handle = event.currentTarget;
    drag.current = { last: current.current, startWidth: current.current, startX: event.clientX };
    // Capture keeps the moves coming to the splitter after the pointer has left
    // its six pixels — which it does immediately, since the panel grows out
    // from under the cursor.
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing");

    const move = (moveEvent: PointerEvent) => {
      const active = drag.current;
      if (active === null) return;
      // Bounds only, not the ceiling: a drag that the window cuts short still
      // means the width the user was reaching for.
      const next = boundedPanelWidth(
        panelWidthFromDrag(active.startWidth, active.startX, moveEvent.clientX),
      );
      // Remembered here as well as in state: `pointerup` can arrive in the same
      // batch as the last move, and what gets stored has to be the width the
      // user actually stopped at, not the one before it.
      active.last = next;
      setDesired(next);
    };
    const end = () => {
      const stopped = drag.current?.last ?? current.current;
      drag.current = null;
      document.body.classList.remove("is-resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      writeStoredJson(localStorage, PANEL_WIDTH_STORAGE_KEY, stopped);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  }, []);

  return { nudge, start, width };
}
