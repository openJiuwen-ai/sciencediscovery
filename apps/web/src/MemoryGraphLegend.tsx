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

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { MemoryGraphEdgeType, MemoryGraphNodeLabel } from "@sciencediscovery/schema";
import type { MessageKey } from "./i18n/messages.js";

/**
 * Meaning bubble for a node-label or edge-type filter chip (doc16 §1.5 A).
 *
 * Hovering a colour chip shows the one-line meaning; leaving hides it. The
 * canvas is NOT animated (no highlight/dim) — this is a passive lookup, unlike
 * the dropped "pulse the graph" idea.
 *
 * The meanings mirror the live graph's real edge directions
 * (Task→Paper, Paper→Evidence, Evidence→Claim, Claim→Artifact) and the 8
 * node labels — not the design doc's 7-node simplification. ``supersedes`` is
 * not drawn on the canvas so it never has a chip and never reaches here.
 *
 * Positioning is JS-driven: the parent passes the anchor chip's bounding rect
 * (captured on hover); the bubble floats below-centred, clamped into the
 * viewport so a chip near an edge never overflows. A reposition effect runs on
 * viewport scroll/resize so the bubble stays pinned to its anchor.
 */

/** Which filter row a meaning is for — drives the i18n key prefix. */
export type LegendKind = "node" | "edge";

/** The id carried for each kind: a node label or an edge type. */
export type LegendId = MemoryGraphNodeLabel | MemoryGraphEdgeType;

/** Build the i18n key for a meaning: ``legend.node.<label>`` / ``legend.edge.<type>``. */
export function legendKey(kind: LegendKind, id: string): MessageKey {
  return (kind === "node" ? `legend.node.${id}` : `legend.edge.${id}`) as MessageKey;
}

// The translate fn's shape — mirrors LocaleProvider's t() without importing
// the provider (keeps this module decoupled; no circular import risk).
export type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

interface MeaningBubbleProps {
  /** Which filter row (node label / edge type). */
  kind: LegendKind;
  /** The label or edge type whose meaning to show. */
  id: LegendId;
  /** The anchor chip's bounding rect (captured on hover by the parent).
   *  Null while the anchor is unmeasured → bubble hides. */
  anchorRect: DOMRect | null;
  /** i18n translate fn from useLocale(). */
  t: Translate;
}

export function MeaningBubble({ kind, id, anchorRect, t }: MeaningBubbleProps) {
  // The bubble is centred under the anchor (the chips row). Position is refined
  // twice: first with a width estimate (so it paints roughly right), then once
  // painted the real width is measured and the centre recalculated so it lines
  // up exactly under the chips' midpoint — regardless of how long the text is.
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Live bubble size; null until measured. Starts at the estimate so the first
  // paint is close, then the measure effect overwrites it with the real size.
  const [size, setSize] = useState<{ w: number; h: number } | null>({ w: 260, h: 80 });
  useEffect(() => {
    if (!anchorRect) return;
    const { w, h } = size ?? { w: 260, h: 80 };
    const place = () => {
      // Centre the bubble on the anchor's midpoint, then clamp into the viewport.
      const idealLeft = anchorRect.left + anchorRect.width / 2 - w / 2;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, idealLeft));
      // Float below the anchor with an 8px gap; flip above if it would clip.
      const belowTop = anchorRect.bottom + 8;
      const top = belowTop + h > window.innerHeight
        ? Math.max(8, anchorRect.top - 8 - h)
        : belowTop;
      // Only setState when the numbers actually moved — React uses reference
      // equality, so a fresh {left, top} with the same values still triggers a
      // re-render. Together with the measure effect below that would loop
      // indefinitely: place→setPos→measure→setSize→place→… and stall the page.
      setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
    };
    place();
    // Re-place on viewport scroll/resize so the bubble stays pinned to the anchor.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRect, size]);
  // Measure the real bubble box once painted; update size so the next layout
  // recentres precisely (and the place effect above re-runs on the size change).
  useEffect(() => {
    if (!bubbleRef.current) return;
    const r = bubbleRef.current.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      // Same reference-equality guard as in `place`: only setSize when w/h
      // changed, otherwise this feeds the place effect a fresh object every
      // render and the two effects ping-pong forever.
      setSize((prev) => (prev && prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    }
  }, [pos]);

  if (!anchorRect || !pos) return null;
  const meaning = t(legendKey(kind, id));
  // Portal to document.body so the bubble escapes the explorer backdrop's
  // backdrop-filter — that filter makes the backdrop a containing block for
  // fixed-positioned descendants, so `position: fixed` would otherwise anchor
  // to the (DevTools-squeezed) backdrop instead of the viewport, and the
  // reposition math drifts out of sync with the anchor's getBoundingClientRect.
  return createPortal(
    <div
      ref={bubbleRef}
      className="memory-meaning-bubble"
      role="tooltip"
      style={{ left: pos.left, top: pos.top, position: "fixed" }}
    >
      <div className="memory-meaning-bubble-body">{meaning}</div>
    </div>,
    document.body,
  );
}
