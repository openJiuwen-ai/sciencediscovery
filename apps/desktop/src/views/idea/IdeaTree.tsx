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
 * The research tree and one node's detail.
 *
 * The tree is drawn as the shape the research actually grew: one row per depth,
 * siblings side by side, each parent centred over its children, and an arrow per
 * branch. Direction and candidate differ by shape and tint because the engine
 * treats them differently; a pruned branch is drawn dashed, because pruning is
 * how a branch ends.
 *
 * Field names come from `IdeaTreeNode` as it exists: a node has no `design` or
 * `assessments` fields — those live in `stages` (stage id → `{ text, score? }`) — and a
 * legacy node has no `kind` at all. Everything the engine did not report is rendered as
 * unavailable, never as `0` or as a success:
 *
 * - `score === null` is "no score", not 0;
 * - a stage the node has not reached is missing, not empty text;
 * - `pruneReason === null` means "not pruned", which is not the same as "no reason".
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import type { IdeaTreeNode, IdeaTreeGraph } from "@sciencediscovery/schema";
import { TEXT } from "../../text.js";

const t = TEXT.ideaTree.detail;

export interface IdeaNodeStages {
  design: { text: string; score?: number } | undefined;
  aggregate: { text: string; score?: number } | undefined;
  /** Every stage that is neither `design` nor `aggregate`, in insertion order. */
  assessments: Array<{ stage: string; text: string; score?: number }>;
}

export function ideaNodeStages(node: IdeaTreeNode): IdeaNodeStages {
  const stages = node.stages ?? {};
  const assessments: IdeaNodeStages["assessments"] = [];
  for (const [stage, value] of Object.entries(stages)) {
    if (stage === "design" || stage === "aggregate") continue;
    if (value && typeof value.text === "string") assessments.push({ stage, text: value.text, ...(typeof value.score === "number" ? { score: value.score } : {}) });
  }
  return {
    design: stages.design,
    aggregate: stages.aggregate,
    assessments,
  };
}

export function ideaScoreText(score: number | null): string {
  return score === null ? t.unavailable : String(score);
}

/** Depth-first order, parents before children, so the tree reads top-down. */
export function ideaTreeRows(graph: IdeaTreeGraph): Array<{ node: IdeaTreeNode; depth: number }> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const roots = graph.nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
  const rows: Array<{ node: IdeaTreeNode; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (node: IdeaTreeNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    rows.push({ node, depth });
    for (const childId of node.childrenIds) {
      const child = byId.get(childId);
      if (child) walk(child, depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  // A node its parent forgot to list is still a node: render it rather than lose it.
  for (const node of graph.nodes) if (!seen.has(node.id)) rows.push({ node, depth: 0 });
  return rows;
}

// Geometry, in the drawing's own pixels. A node is a small card rather than a
// bare circle because an Idea Tree node's identity is its hypothesis, and a
// direction and a candidate have to be told apart at a glance.
const NODE_W = 176;
const NODE_H = 70;
const GAP_X = 22;
const GAP_Y = 58;
const PAD = 18;
/** Below this the text stops being readable: past it the drawing scrolls instead. */
const MIN_SCALE = 0.6;
/** How far the reader can zoom by hand. The automatic fit stays inside the
 *  narrower readable range above and never grows past 1; a hand zoom is the
 *  only way past the column's width, and the fit control brings it back.
 *  The lower end, 0.4, is deliberately below `MIN_SCALE`: that is the scale
 *  text stops being readable at, and shrinking past it is the reader's own
 *  choice to see the shape of a wide drawing, not something the fit does. */
export const IDEA_TREE_ZOOM_MIN = 0.4;
export const IDEA_TREE_ZOOM_MAX = 2;
const ZOOM_STEP = 1.2;
/** A double-click moves further than one button press, so it is a gesture of
 *  its own rather than a slower way to press ＋ twice. */
const DOUBLE_CLICK_STEP = 1.5;
const WHEEL_STEP = 0.0015;
/** A press only becomes a drag after the pointer has moved this far, so a
 *  click on a node is still that node's click. */
const DRAG_THRESHOLD = 4;

/** The scale that fits the drawing into the column, kept readable and never
 *  magnified. Pure, so the arithmetic is testable without a DOM. */
export function ideaTreeFitScale(layoutWidth: number, available: number): number {
  return Math.max(MIN_SCALE, Math.min(1, (available - 10) / layoutWidth));
}

/** One zoom step, kept inside the hand-zoom range. */
export function ideaTreeZoomScale(scale: number, factor: number): number {
  return Math.min(IDEA_TREE_ZOOM_MAX, Math.max(IDEA_TREE_ZOOM_MIN, scale * factor));
}

/** The scale one wheel event asks for. Deltas arrive in pixels, lines or pages
 *  depending on the device, so the unit is resolved here; the clamped result is
 *  what lets the listener tell a wheel that still zooms from one at the end of
 *  the range, which must be left to the panel instead of being swallowed. Pure. */
export function ideaTreeWheelScale(scale: number, deltaY: number, deltaMode: number, viewportHeight: number): number {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? viewportHeight : 1;
  return ideaTreeZoomScale(scale, Math.exp(-deltaY * unit * WHEEL_STEP));
}

/** What an automatic fit may do to the scale. `undefined` means "leave the
 *  reader's scale alone": once the scale is set by hand, new data and a resize
 *  must not take it back, or a tree that is still growing cannot be zoomed. */
export function ideaTreeAutoFit(manual: boolean, fitted: number | undefined): number | undefined {
  if (manual) return undefined;
  return fitted;
}

/** A point inside the viewport, in its own pixels from the top-left corner. */
export interface IdeaTreeAnchor { x: number; y: number; }

/** The scroll that keeps one point of the drawing under the same viewport
 *  point after the scale changes by `ratio`: without it the drawing would grow
 *  away from whatever the reader was looking at. The default anchor is the
 *  middle of the viewport, which is what the buttons and the keyboard use; the
 *  wheel and a double click pass the pointer, as `EvolveTree` does, so the part
 *  of the drawing under the cursor stays under the cursor. */
export function ideaTreeScrollAfterZoom(
  scroll: { left: number; top: number },
  area: { height: number; width: number },
  ratio: number,
  anchor?: IdeaTreeAnchor,
): { left: number; top: number } {
  const x = anchor?.x ?? area.width / 2;
  const y = anchor?.y ?? area.height / 2;
  return {
    left: Math.max(0, (scroll.left + x) * ratio - x),
    top: Math.max(0, (scroll.top + y) * ratio - y),
  };
}

export interface IdeaPlacedNode {
  node: IdeaTreeNode;
  depth: number;
  /** The leaf column the node sits over; a parent takes its children's middle. */
  slot: number;
  x: number;
  y: number;
}

export interface IdeaTreeLayout {
  edges: Array<{ from: IdeaPlacedNode; to: IdeaPlacedNode }>;
  height: number;
  nodes: IdeaPlacedNode[];
  width: number;
}

/**
 * The tree the research actually grew, as positions.
 *
 * Leaves are laid out side by side in reading order and every parent is centred
 * over its children, which is what makes "this branch kept growing, that one was
 * pruned" legible without reading a node list. `childrenIds` is the engine's own
 * edge list; a node whose `parentId` names a parent that forgot to list it is
 * still a child, and a node with no resolvable parent is still a root — the same
 * rule `ideaTreeRows` applies, so nothing is dropped from the drawing.
 *
 * Pure, and exported so the fan-out is testable without a DOM.
 */
export function ideaTreeLayout(graph: IdeaTreeGraph): IdeaTreeLayout {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = new Map<string, IdeaTreeNode[]>();
  const add = (parentId: string, child: IdeaTreeNode) => {
    const list = children.get(parentId);
    if (list === undefined) children.set(parentId, [child]);
    else if (!list.includes(child)) list.push(child);
  };
  for (const node of graph.nodes) {
    if (node.parentId && byId.has(node.parentId)) add(node.parentId, node);
    for (const childId of node.childrenIds) {
      const child = byId.get(childId);
      if (child !== undefined && child.parentId !== node.id) add(node.id, child);
    }
  }
  const roots = graph.nodes.filter((node) => !node.parentId || !byId.has(node.parentId));

  const placed = new Map<string, IdeaPlacedNode>();
  let nextSlot = 0;
  let maxDepth = 0;
  const place = (node: IdeaTreeNode, depth: number, seen: Set<string>): number => {
    const kids = (children.get(node.id) ?? []).filter((kid) => !seen.has(kid.id));
    let slot: number;
    if (kids.length === 0) {
      slot = nextSlot;
      nextSlot += 1;
    } else {
      const guarded = new Set(seen).add(node.id);
      const slots = kids.map((kid) => place(kid, depth + 1, guarded));
      slot = (Math.min(...slots) + Math.max(...slots)) / 2;
    }
    placed.set(node.id, {
      depth,
      node,
      slot,
      x: PAD + NODE_W / 2 + slot * (NODE_W + GAP_X),
      y: PAD + NODE_H / 2 + depth * (NODE_H + GAP_Y),
    });
    maxDepth = Math.max(maxDepth, depth);
    return slot;
  };
  for (const root of roots) place(root, 0, new Set());
  // A node its parent forgot to list is still a node: draw it rather than lose it.
  for (const node of graph.nodes) if (!placed.has(node.id)) place(node, 0, new Set(placed.keys()));

  const nodes = [...placed.values()];
  const edges: IdeaTreeLayout["edges"] = [];
  for (const node of nodes) {
    const from = node.node.parentId ? placed.get(node.node.parentId) : undefined;
    if (from !== undefined && from !== node) edges.push({ from, to: node });
  }
  const columns = Math.max(1, nextSlot);
  return {
    edges,
    height: PAD * 2 + NODE_H + maxDepth * (NODE_H + GAP_Y),
    nodes,
    width: PAD * 2 + NODE_W + (columns - 1) * (NODE_W + GAP_X),
  };
}

export function IdeaTreeView({ graph, selectedId, onSelect }: { graph: IdeaTreeGraph; selectedId?: string; onSelect?: (node: IdeaTreeNode) => void }) {
  const layout = ideaTreeLayout(graph);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  /** The scale the next zoom step multiplies, read by the wheel listener and
   *  the buttons, which are attached once and must not close over a stale one. */
  const scaleRef = useRef(1);
  /** Once the reader sets the scale by hand, neither new data nor a resize
   *  takes it back; a new tree and the fit control do. */
  const manual = useRef(false);
  /** A zoom changes the scale and the scroll in the same breath, but the scroll
   *  range only exists after the new size is laid out. */
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  /** A drag pans by scrolling; the press position and the scroll it started
   *  from are what make the drag follow the pointer exactly. */
  const drag = useRef<{ left: number; pointerId: number; top: number; x: number; y: number } | null>(null);
  /** Only a pointer that actually moved is a pan; a click on a node stays that
   *  node's click. The flag also swallows the click a finished drag produces. */
  const moved = useRef(false);
  const [dragging, setDragging] = useState(false);
  /** The drawing is only draggable when it is bigger than the column: the grab
   *  cursor says so, and nothing pretends to move when everything already fits. */
  const [pannable, setPannable] = useState(false);

  const fitScale = (): number | undefined => {
    const element = box.current;
    if (element === null) return undefined;
    const width = element.clientWidth;
    if (!Number.isFinite(width) || width <= 0) return undefined;
    return ideaTreeFitScale(layout.width, width);
  };

  const applyScale = useCallback((next: number, anchor?: IdeaTreeAnchor) => {
    const element = box.current;
    const current = scaleRef.current;
    if (next === current) return;
    manual.current = true;
    if (element !== null) {
      const area = { height: element.clientHeight, width: element.clientWidth };
      // A burst of wheel events can arrive before the scroll set by the first
      // one is painted; composing onto the pending target keeps the anchor
      // where the reader put it instead of drifting with each event.
      const base = pendingScroll.current ?? { left: element.scrollLeft, top: element.scrollTop };
      pendingScroll.current = ideaTreeScrollAfterZoom(base, area, next / current, anchor);
    }
    scaleRef.current = next;
    setScale(next);
  }, []);

  /** Where the pointer sits inside the viewport. `undefined` when the event
   *  carries no coordinates (a keyboard-driven zoom, or a test), which falls
   *  back to the viewport's middle. */
  const anchorOf = (clientX?: number, clientY?: number): IdeaTreeAnchor | undefined => {
    const element = box.current;
    if (element === null || typeof clientX !== "number" || typeof clientY !== "number") return undefined;
    const rect = element.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const fit = (): void => {
    manual.current = false;
    pendingScroll.current = null;
    // With no measurable column (a closed panel, or a test without a DOM) the
    // drawing's own size is the fit.
    const next = fitScale() ?? 1;
    scaleRef.current = next;
    setScale(next);
  };

  // A new tree is a new drawing: it opens at the fit rather than at whatever
  // scale the previous one was left at.
  useEffect(() => {
    manual.current = false;
    const next = fitScale();
    if (next !== undefined) {
      scaleRef.current = next;
      setScale(next);
    } else {
      scaleRef.current = 1;
      setScale(1);
    }
  }, [graph.treeId]);

  /** The column is narrow and a tree grows sideways: shrink the drawing to the
   *  column while it stays readable, and let it scroll past that point rather
   *  than render text nobody can read. */
  useEffect(() => {
    const element = box.current;
    if (element === null) return undefined;
    const update = () => {
      const next = ideaTreeAutoFit(manual.current, ideaTreeFitScale(layout.width, element.clientWidth));
      if (next === undefined || !Number.isFinite(next)) return;
      scaleRef.current = next;
      setScale(next);
    };
    if (element.clientWidth > 0) update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout.width]);

  useLayoutEffect(() => {
    const element = box.current;
    const target = pendingScroll.current;
    pendingScroll.current = null;
    if (element === null || target === null) return;
    element.scrollLeft = target.left;
    element.scrollTop = target.top;
  }, [scale]);

  useEffect(() => {
    const element = box.current;
    if (element === null) return undefined;
    const onWheel = (event: WheelEvent) => {
      const next = ideaTreeWheelScale(scaleRef.current, event.deltaY, event.deltaMode, element.clientHeight);
      // At the end of the range the wheel asks for no change: leave it to the
      // panel rather than swallowing a gesture that would do nothing here.
      if (next === scaleRef.current) return;
      // The wheel zooms this drawing; React's wheel listener is passive, so the
      // panel behind the tree has to be kept from scrolling by a native one.
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      applyScale(next, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [applyScale]);

  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    setPannable(layout.width * scale > element.clientWidth + 1 || layout.height * scale > element.clientHeight + 1);
  }, [layout.height, layout.width, scale]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const element = box.current;
    if (element === null) return;
    drag.current = {
      left: element.scrollLeft,
      pointerId: event.pointerId,
      top: element.scrollTop,
      x: event.clientX,
      y: event.clientY,
    };
    moved.current = false;
    // The press itself does not capture the pointer: capturing here retargets
    // the click to the viewport, so the node under the pointer would never be
    // selected. The first real move takes the capture instead.
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const element = box.current;
    if (current === null || element === null || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!moved.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!moved.current) element.setPointerCapture(event.pointerId);
    moved.current = true;
    element.scrollLeft = Math.max(0, current.left - dx);
    element.scrollTop = Math.max(0, current.top - dy);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = box.current;
    drag.current = null;
    if (element !== null && element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    setDragging(false);
  };

  const cancelDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    // A cancelled pointer never produces a click, so nothing is left to swallow.
    moved.current = false;
    endDrag(event);
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".idea-tree-node-button") !== null) return;
    // Zoomed in? Back to the column's fit. At the fit? One step closer.
    const fitted = fitScale() ?? 1;
    if (scaleRef.current > fitted + 1e-6) {
      fit();
      return;
    }
    applyScale(ideaTreeZoomScale(scaleRef.current, DOUBLE_CLICK_STEP), anchorOf(event.clientX, event.clientY));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys pressed inside a node button are that button's.
    if (event.target !== event.currentTarget) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      applyScale(ideaTreeZoomScale(scaleRef.current, ZOOM_STEP));
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      applyScale(ideaTreeZoomScale(scaleRef.current, 1 / ZOOM_STEP));
    } else if (event.key === "0") {
      event.preventDefault();
      fit();
    }
  };

  if (!layout.nodes.length) return <p className="idea-tree-empty">{t.empty}</p>;
  return (
    <div className="idea-tree-shell">
      {/* The bar is a sibling of the scroll container, in the shell's own
          header: inside `.idea-tree` a sticky bar would be pinned vertically
          but would scroll away sideways with the drawing. */}
      <div className="idea-tree-head">
        <div className="idea-tree-zoom" role="group" aria-label={t.zoom.aria}>
          <button
            aria-label={t.zoom.out}
            className="idea-tree-zoom-button"
            disabled={scale <= IDEA_TREE_ZOOM_MIN}
            onClick={() => applyScale(ideaTreeZoomScale(scale, 1 / ZOOM_STEP))}
            title={t.zoom.out}
            type="button"
          >−</button>
          <output aria-live="off" className="idea-tree-zoom-level">{Math.round(scale * 100)}%</output>
          <button
            aria-label={t.zoom.in}
            className="idea-tree-zoom-button"
            disabled={scale >= IDEA_TREE_ZOOM_MAX}
            onClick={() => applyScale(ideaTreeZoomScale(scale, ZOOM_STEP))}
            title={t.zoom.in}
            type="button"
          >＋</button>
          <button className="idea-tree-zoom-fit" onClick={fit} title={t.zoom.fit} type="button">{t.zoom.fit}</button>
        </div>
      </div>
      <div
        aria-keyshortcuts="+ - 0"
        aria-label={t.tree}
        className={`idea-tree${dragging ? " is-dragging" : ""}${pannable ? " is-pannable" : ""}`}
        onClickCapture={(event) => {
          // The pointer-up that ends a drag still produces a click on whatever
          // is underneath it; swallow that one so panning never selects a node.
          if (!moved.current) return;
          moved.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onPointerCancel={cancelDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        ref={box}
        role="group"
        tabIndex={0}
      >
        {/* The fit box takes the scaled size, so the scrollbars follow what is
            drawn; the plane inside keeps the layout's own coordinates. */}
        <div className="idea-tree-fit" style={{ height: layout.height * scale, width: layout.width * scale }}>
          <div
            className="idea-tree-plane"
            style={{ height: layout.height, transform: `scale(${scale})`, width: layout.width }}
          >
            {/* The edges are drawn first and the nodes sit over them, so a
                selection ring is never cut by a line that arrives at the same
                corner. */}
            <svg aria-hidden="true" className="idea-tree-edges" height={layout.height} width={layout.width}>
              <defs>
                <marker id="idea-tree-arrow" markerHeight="6" markerUnits="userSpaceOnUse" markerWidth="6" orient="auto" refX="5" refY="3" viewBox="0 0 6 6">
                  <path className="idea-tree-arrowhead" d="M0 0 6 3 0 6Z" />
                </marker>
              </defs>
              {layout.edges.map(({ from, to }) => {
                const x1 = from.x;
                const y1 = from.y + NODE_H / 2;
                const x2 = to.x;
                const y2 = to.y - NODE_H / 2 - 3;
                // A pruned branch is a branch the engine stopped following: the
                // line says so before the node's own badge does.
                const pruned = to.node.searchStatus === "pruned";
                return (
                  <path
                    className={`idea-tree-edge${pruned ? " is-pruned" : ""}`}
                    d={`M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`}
                    key={`${from.node.id}-${to.node.id}`}
                    markerEnd="url(#idea-tree-arrow)"
                  />
                );
              })}
            </svg>
            {layout.nodes.map((placed) => {
              const current = placed.node;
              const kind = current.kind ? (t.kind[current.kind] ?? current.kind) : undefined;
              const live = current.status === "running";
              const classes = [
                "idea-tree-node",
                "idea-tree-node-button",
                `is-${current.status}`,
                `is-search-${current.searchStatus}`,
                current.kind ? `is-kind-${current.kind}` : "",
                selectedId === current.id ? "is-selected" : "",
              ].filter(Boolean).join(" ");
              return (
                <button
                  aria-pressed={selectedId === current.id}
                  className={classes}
                  key={current.id}
                  onClick={() => onSelect?.(current)}
                  style={{ height: NODE_H, left: placed.x - NODE_W / 2, top: placed.y - NODE_H / 2, width: NODE_W }}
                  title={current.hypothesis}
                  type="button"
                >
                  <span className="idea-tree-node-head">
                    {kind ? <span className="idea-tree-kind">{kind}</span> : null}
                    {current.searchStatus === "pruned" ? <span className="idea-tree-pruned">{t.search.pruned}</span> : null}
                  </span>
                  <span className="idea-tree-hypothesis">{current.hypothesis}</span>
                  <span className="idea-tree-node-foot">
                    <span className={`idea-tree-dot${live ? " is-live" : ""}`} />
                    <span>{t.status[current.status] ?? current.status}</span>
                    <span className="idea-tree-node-score">{ideaScoreText(current.score)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function IdeaNodeDetail({ node }: { node: IdeaTreeNode }) {
  const stages = ideaNodeStages(node);
  return (
    <section className="idea-node-detail" aria-label={t.title}>
      <h3>{t.title}</h3>
      <p className="idea-node-hypothesis">{node.hypothesis}</p>
      <dl>
        <dt>{t.statusLabel}</dt>
        <dd>{t.status[node.status] ?? node.status}</dd>
        <dt>{t.searchLabel}</dt>
        <dd>{t.search[node.searchStatus] ?? node.searchStatus}</dd>
        <dt>{t.score}</dt>
        <dd>{ideaScoreText(node.score)}</dd>
        <dt>{t.priority}</dt>
        <dd>{String(node.priority)}</dd>
        <dt>{t.design}</dt>
        <dd>{stages.design?.text ?? t.unavailable}</dd>
        <dt>{t.aggregate}</dt>
        <dd>{stages.aggregate ? `${stages.aggregate.text} · ${ideaScoreText(stages.aggregate.score ?? null)}` : t.unavailable}</dd>
        <dt>{t.assessments}</dt>
        <dd>
          {stages.assessments.length
            ? <ul>{stages.assessments.map((entry) => <li key={entry.stage}>{entry.stage}: {entry.text} · {ideaScoreText(entry.score ?? null)}</li>)}</ul>
            : t.unavailable}
        </dd>
        <dt>{t.insight}</dt>
        <dd>{node.insight ?? t.unavailable}</dd>
        <dt>{t.pruneReason}</dt>
        <dd>{node.pruneReason ?? t.notPruned}</dd>
        <dt>{t.artifacts}</dt>
        <dd>{node.artifactRefs.length ? node.artifactRefs.join(", ") : t.unavailable}</dd>
      </dl>
    </section>
  );
}
