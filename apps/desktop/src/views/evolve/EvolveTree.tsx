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
 * The search, as the shape it actually had.
 *
 * A run is not a list of candidates in index order: it is a tree, and the
 * interesting fact about a node is usually where it came from. Laying siblings
 * out side by side and putting each parent over the middle of its children is
 * what makes "this branch kept improving, that one died" legible at a glance.
 *
 * The handoff's four node tones carry the same four readings as the chart:
 * the best node is solid blue and badged, a gate-measured node is light blue,
 * a rollout-only node is quiet grey, and a candidate that never ran is pink.
 * Selecting one opens the drawer; the node list is the same selection read as
 * rows. The viewport drags and the wheel zooms about the cursor, because a
 * tree that grew past its column is exactly the one worth exploring.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { EvolveCandidateView } from "../../evolve/model.js";
import { formatScore } from "../../evolve/model.js";
import { TEXT } from "../../text.js";
import { CrownGlyph } from "./glyphs.js";

/** Node geometry, in the drawing's own units. The canvas is scaled to the
 *  column when it first appears, so these are ratios rather than pixels. */
const RADIUS = 32;
const COLUMN = 82;
const ROW = 200;
const PAD = 44;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.4;
/** Hand zooming goes further than the automatic fit: the fit is the starting
 *  point, not the limit, once the reader is the one choosing the scale. */
const WHEEL_MAX = 3;
/** One line of wheel travel, as a multiplicative step. Small enough that a
 *  trackpad's stream of tiny deltas still feels smooth. */
const WHEEL_SPEED = 0.0015;
/** How much of the drawing stays on screen when it is dragged to an edge. */
const PAN_MARGIN = 48;

export interface EvolveTreeProps {
  bestIndex?: number;
  candidates: EvolveCandidateView[];
  onSelect: (index: number) => void;
  selectedIndex?: number;
}

interface PlacedNode {
  candidate: EvolveCandidateView;
  depth: number;
  x: number;
}

interface TreeLayout {
  edges: Array<{ from: PlacedNode; to: PlacedNode }>;
  height: number;
  nodes: PlacedNode[];
  width: number;
}

/** Pure, and exported so the fan-out is testable without a DOM. */
export function layoutTree(candidates: readonly EvolveCandidateView[]): TreeLayout {
  const byIndex = new Map(candidates.map((candidate) => [candidate.nodeIndex, candidate]));
  const children = new Map<number, EvolveCandidateView[]>();
  const roots: EvolveCandidateView[] = [];
  for (const candidate of candidates) {
    const parent = candidate.parentIndex === null ? undefined : byIndex.get(candidate.parentIndex);
    if (parent === undefined) {
      roots.push(candidate);
      continue;
    }
    const list = children.get(parent.nodeIndex);
    if (list === undefined) children.set(parent.nodeIndex, [candidate]);
    else list.push(candidate);
  }
  const order = (left: EvolveCandidateView, right: EvolveCandidateView) =>
    left.nodeIndex - right.nodeIndex;
  roots.sort(order);
  for (const list of children.values()) list.sort(order);

  const placed = new Map<number, PlacedNode>();
  let nextSlot = 0;
  let maxDepth = 0;
  const place = (candidate: EvolveCandidateView, depth: number): number => {
    const kids = children.get(candidate.nodeIndex) ?? [];
    let slot: number;
    if (kids.length === 0) {
      slot = nextSlot;
      nextSlot += 1;
    } else {
      const slots = kids.map((kid) => place(kid, depth + 1));
      slot = (Math.min(...slots) + Math.max(...slots)) / 2;
    }
    placed.set(candidate.nodeIndex, { candidate, depth, x: slot });
    maxDepth = Math.max(maxDepth, depth);
    return slot;
  };
  for (const root of roots) place(root, 0);

  const nodes = [...placed.values()];
  const edges: Array<{ from: PlacedNode; to: PlacedNode }> = [];
  for (const node of nodes) {
    if (node.candidate.parentIndex === null) continue;
    const from = placed.get(node.candidate.parentIndex);
    if (from !== undefined) edges.push({ from, to: node });
  }

  const columns = Math.max(1, nextSlot);
  return {
    edges,
    height: PAD * 2 + RADIUS * 2 + maxDepth * ROW,
    nodes,
    width: PAD * 2 + RADIUS * 2 + (columns - 1) * COLUMN,
  };
}

/** Where the drawing sits: its offset from the canvas's resting position, in
 *  screen pixels, and the scale it is drawn at. */
export interface TreeView {
  pan: { x: number; y: number };
  zoom: number;
}

interface Extent {
  height: number;
  width: number;
}

interface PanBounds {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
}

/** Where the canvas rests before any pan. The flex container centres it
 *  horizontally while it fits and collapses to flush left once it outgrows
 *  the column (auto margins take no negative space); vertically it is flush
 *  with the top, so a shallow tree does not float halfway down the canvas. */
function baseOffset(viewport: Extent, content: Extent): { x: number; y: number } {
  return { x: Math.max(0, (viewport.width - content.width) / 2), y: 0 };
}

/** Keep at least PAN_MARGIN of the drawing inside the viewport, so neither a
 *  drag nor a zoom can leave an empty box with no way back. */
function panBounds(viewport: Extent, content: Extent): PanBounds {
  const base = baseOffset(viewport, content);
  return {
    maxX: viewport.width - PAN_MARGIN - base.x,
    maxY: viewport.height - PAN_MARGIN - base.y,
    minX: PAN_MARGIN - content.width - base.x,
    minY: PAN_MARGIN - content.height - base.y,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** One wheel step zooms about the cursor. The point under the pointer is the
 *  one being examined, so it has to stay put while the rest of the drawing
 *  grows around it: read the drawing coordinate under the cursor, then place
 *  the rescaled canvas so that same coordinate lands under the cursor again.
 *  Pure, and exported so the arithmetic is testable without a DOM. */
export function zoomToward(
  view: TreeView,
  cursor: { x: number; y: number },
  factor: number,
  viewport: Extent,
  content: Extent,
): TreeView {
  const zoom = clamp(view.zoom * factor, ZOOM_MIN, WHEEL_MAX);
  if (zoom === view.zoom) return view;
  const now = baseOffset(viewport, {
    height: content.height * view.zoom,
    width: content.width * view.zoom,
  });
  // The anchor, in the drawing's own units.
  const anchorX = (cursor.x - now.x - view.pan.x) / view.zoom;
  const anchorY = (cursor.y - now.y - view.pan.y) / view.zoom;
  const scaled = { height: content.height * zoom, width: content.width * zoom };
  const next = baseOffset(viewport, scaled);
  const bounds = panBounds(viewport, scaled);
  return {
    pan: {
      x: clamp(cursor.x - next.x - anchorX * zoom, bounds.minX, bounds.maxX),
      y: clamp(cursor.y - next.y - anchorY * zoom, bounds.minY, bounds.maxY),
    },
    zoom,
  };
}

export function EvolveTree({ bestIndex, candidates, onSelect, selectedIndex }: EvolveTreeProps) {
  const layout = layoutTree(candidates);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<TreeView>({ pan: { x: 0, y: 0 }, zoom: 0.6 });
  const { pan, zoom } = view;
  /** Once the scale is chosen by hand, a resize must not take it back. New
   *  data is a new drawing, so it carries a fresh fit. */
  const manual = useRef(false);
  const [dragging, setDragging] = useState(false);
  /** One drag starts from wherever the last one left the canvas. */
  const drag = useRef<{ panX: number; panY: number; pointerId: number; x: number; y: number } | null>(null);
  /** A drag that moved must not also count as a click on the node under it. */
  const moved = useRef(false);

  const fit = useCallback((force = false) => {
    if (!force && manual.current) return;
    const element = box.current;
    if (element === null) return;
    const width = element.clientWidth - 32;
    const height = element.clientHeight - 32;
    if (width <= 0 || height <= 0 || layout.width <= 0 || layout.height <= 0) return;
    // Both axes: fitting the width alone crops the deepest generation, which
    // is exactly the row a reader scrolls to the tree to see.
    const scale = Math.min(width / layout.width, height / layout.height);
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
    setView((current) => ({ ...current, zoom: next }));
  }, [layout.height, layout.width]);

  useEffect(() => {
    manual.current = false;
    setView((current) => ({ ...current, pan: { x: 0, y: 0 } }));
    fit(true);
  }, [fit]);

  useEffect(() => {
    const element = box.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      if (candidates.length === 0) return;
      // The wheel belongs to the tree here, not to the panel behind it.
      event.preventDefault();
      // Deltas arrive in pixels, lines or pages depending on the device.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const factor = Math.exp(-event.deltaY * unit * WHEEL_SPEED);
      if (factor === 1) return;
      const rect = element.getBoundingClientRect();
      manual.current = true;
      setView((current) => zoomToward(
        current,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        factor,
        { height: element.clientHeight, width: element.clientWidth },
        { height: layout.height, width: layout.width },
      ));
    };
    // React's wheel listener is passive, so preventing the panel scroll has
    // to go through a native one.
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [candidates.length, layout.height, layout.width]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || candidates.length === 0) return;
    drag.current = { panX: pan.x, panY: pan.y, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    moved.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const element = box.current;
    if (current === null || element === null || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!moved.current && Math.hypot(dx, dy) < 4) return;
    moved.current = true;
    const bounds = panBounds(
      { height: element.clientHeight, width: element.clientWidth },
      { height: layout.height * zoom, width: layout.width * zoom },
    );
    setView((view) => ({
      ...view,
      pan: {
        x: clamp(current.panX + dx, bounds.minX, bounds.maxX),
        y: clamp(current.panY + dy, bounds.minY, bounds.maxY),
      },
    }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const x = (slot: number) => PAD + RADIUS + slot * COLUMN;
  const y = (depth: number) => PAD + RADIUS + depth * ROW;

  return <div
    aria-label={TEXT.evolve.detail.treeAria(candidates.length)}
    className="evolve-tree"
    role="group"
  >
    <div
      className={`evolve-tree-viewport${dragging ? " is-dragging" : ""}`}
      onClickCapture={(event) => {
        // The pointer-up that ends a drag still produces a click on the node
        // underneath it; swallow that one so panning never changes the
        // selection.
        if (!moved.current) return;
        moved.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      ref={box}
    >
      {candidates.length === 0
        ? <p className="evolve-tree-empty">{TEXT.evolve.detail.treeEmpty}</p>
        : <div
          className="evolve-tree-canvas"
          style={{
            height: layout.height * zoom,
            transform: `translate(${pan.x}px, ${pan.y}px)`,
            width: layout.width * zoom,
          }}
        >
          <svg
            height={layout.height * zoom}
            role="img"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={layout.width * zoom}
          >
          <defs>
            <marker
              id="evolve-tree-arrow"
              markerHeight="6"
              markerUnits="userSpaceOnUse"
              markerWidth="6"
              orient="auto"
              refX="5"
              refY="3"
              viewBox="0 0 6 6"
            >
              <path className="evolve-tree-arrowhead" d="M0 0 6 3 0 6Z" />
            </marker>
          </defs>

          {layout.edges.map(({ from, to }) => {
            const x1 = x(from.x);
            const y1 = y(from.depth) + RADIUS;
            const x2 = x(to.x);
            const y2 = y(to.depth) - RADIUS - 2;
            return <line
              className="evolve-tree-edge"
              key={`${from.candidate.nodeIndex}-${to.candidate.nodeIndex}`}
              markerEnd="url(#evolve-tree-arrow)"
              x1={x1}
              x2={x2}
              y1={y1}
              y2={y2}
            />;
          })}

          {layout.nodes.map((node) => {
            const { candidate } = node;
            const score = candidate.gateScore ?? candidate.score;
            const tone = !candidate.valid
              ? "failed"
              : candidate.nodeIndex === bestIndex
                ? "best"
                : candidate.gateScore === undefined ? "quiet" : "significant";
            const selected = candidate.nodeIndex === selectedIndex;
            const cx = x(node.x);
            const cy = y(node.depth);
            return <g
              aria-label={`${TEXT.evolve.detail.nodeTitle(candidate.nodeIndex)} ${formatScore(score)}`}
              aria-pressed={selected}
              className={`evolve-tree-node is-${tone}${selected ? " is-selected" : ""}`}
              key={candidate.nodeIndex}
              onClick={() => onSelect(candidate.nodeIndex)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onSelect(candidate.nodeIndex);
              }}
              role="button"
              tabIndex={0}
              transform={`translate(${cx} ${cy})`}
            >
              <circle className="evolve-tree-ring" r={RADIUS + 4} />
              <circle className="evolve-tree-disc" r={RADIUS} />
              {tone === "best" ? <g className="evolve-tree-badge" transform="translate(20 -20)">
                <circle r={8.5} />
                <g transform="translate(-7 -7)"><CrownGlyph size={14} /></g>
              </g> : null}
              <text className="evolve-tree-id" textAnchor="middle" y={-4}>
                #{candidate.nodeIndex}
              </text>
              <text className="evolve-tree-score" textAnchor="middle" y={12}>
                {candidate.valid ? formatScore(score) : "-"}
              </text>
            </g>;
          })}
        </svg>
        </div>}
    </div>
  </div>;
}
