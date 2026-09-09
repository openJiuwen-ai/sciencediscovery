// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";

import type { IdeaTreeGraph, IdeaTreeNode } from "@sciencediscovery/schema";

const NODE_WIDTH = 244;
const NODE_HEIGHT = 108;
const HORIZONTAL_LEVEL_GAP = 92;
const HORIZONTAL_SIBLING_GAP = 18;
const VERTICAL_LEVEL_GAP = 64;
const VERTICAL_SIBLING_GAP = 24;
const VIEWPORT_PADDING_X = 48;
const VIEWPORT_PADDING_Y = 42;
const MAX_AUTO_ZOOM = 1.45;
const MIN_READABLE_ZOOM = 0.38;

export const IDEA_TREE_STATUS_COLORS: Record<IdeaTreeNode["status"], string> = {
  done: "#6f9275",
  failed: "#b8756d",
  needs_retry: "#a58d75",
  pending: "#9aa1ad",
  running: "#668eb4",
};

export interface IdeaTreePosition {
  x: number;
  y: number;
}

export type IdeaTreeOrientation = "left-right" | "top-down";

interface CanvasSize {
  height: number;
  width: number;
}

interface LayoutBounds {
  height: number;
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
  width: number;
}

/** Pure, deterministic tree layout used only by the Idea Tree product. */
export function layoutIdeaTree(
  graph: IdeaTreeGraph,
  orientation: IdeaTreeOrientation = "top-down",
): Map<string, IdeaTreePosition> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const positions = new Map<string, IdeaTreePosition>();
  let leafIndex = 0;
  const visiting = new Set<string>();
  const crossStep = orientation === "left-right"
    ? NODE_HEIGHT + HORIZONTAL_SIBLING_GAP
    : NODE_WIDTH + VERTICAL_SIBLING_GAP;
  const levelStep = orientation === "left-right"
    ? NODE_WIDTH + HORIZONTAL_LEVEL_GAP
    : NODE_HEIGHT + VERTICAL_LEVEL_GAP;

  const place = (nodeId: string): number => {
    const existing = positions.get(nodeId);
    if (existing) return orientation === "left-right" ? existing.y : existing.x;
    const node = nodes.get(nodeId);
    if (!node || visiting.has(nodeId)) {
      const cross = leafIndex++ * crossStep;
      positions.set(nodeId, orientation === "left-right"
        ? { x: (node?.depth ?? 0) * levelStep, y: cross }
        : { x: cross, y: (node?.depth ?? 0) * levelStep });
      return cross;
    }
    visiting.add(nodeId);
    const childCrosses = node.childrenIds.filter((childId) => nodes.has(childId)).map(place);
    const cross = childCrosses.length
      ? (childCrosses[0]! + childCrosses.at(-1)!) / 2
      : leafIndex++ * crossStep;
    positions.set(nodeId, orientation === "left-right"
      ? { x: node.depth * levelStep, y: cross }
      : { x: cross, y: node.depth * levelStep });
    visiting.delete(nodeId);
    return cross;
  };

  place("ROOT");
  for (const node of graph.nodes) place(node.id);
  const values = [...positions.values()];
  const crossValues = values.map((position) => orientation === "left-right" ? position.y : position.x);
  const center = crossValues.length ? (Math.min(...crossValues) + Math.max(...crossValues)) / 2 : 0;
  for (const [id, position] of positions) positions.set(id, orientation === "left-right"
    ? { ...position, y: position.y - center }
    : { ...position, x: position.x - center });
  return positions;
}

function layoutBounds(positions: ReadonlyMap<string, IdeaTreePosition>): LayoutBounds {
  const values = [...positions.values()];
  if (!values.length) return { height: NODE_HEIGHT, maxX: NODE_WIDTH / 2, maxY: NODE_HEIGHT / 2, minX: -NODE_WIDTH / 2, minY: -NODE_HEIGHT / 2, width: NODE_WIDTH };
  const minX = Math.min(...values.map(({ x }) => x)) - NODE_WIDTH / 2;
  const maxX = Math.max(...values.map(({ x }) => x)) + NODE_WIDTH / 2;
  const minY = Math.min(...values.map(({ y }) => y)) - NODE_HEIGHT / 2;
  const maxY = Math.max(...values.map(({ y }) => y)) + NODE_HEIGHT / 2;
  return { height: maxY - minY, maxX, maxY, minX, minY, width: maxX - minX };
}

function layoutFitScale(positions: ReadonlyMap<string, IdeaTreePosition>, size: CanvasSize): number {
  const bounds = layoutBounds(positions);
  return Math.min(
    (size.width - VIEWPORT_PADDING_X * 2) / Math.max(bounds.width, 1),
    (size.height - VIEWPORT_PADDING_Y * 2) / Math.max(bounds.height, 1),
  );
}

/** Selects the direction that keeps nodes largest for the available canvas. */
export function chooseIdeaTreeOrientation(graph: IdeaTreeGraph, size: CanvasSize): IdeaTreeOrientation {
  const topDown = layoutIdeaTree(graph, "top-down");
  const leftRight = layoutIdeaTree(graph, "left-right");
  return layoutFitScale(leftRight, size) > layoutFitScale(topDown, size) ? "left-right" : "top-down";
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface PointerState {
  lastX: number;
  lastY: number;
  pointerId: number;
}

export function IdeaTreeCanvas({
  graph,
  onSelect,
  query = "",
  selectedId,
  visibleStatuses,
}: {
  graph: IdeaTreeGraph;
  onSelect: (nodeId: string) => void;
  query?: string;
  selectedId?: string;
  visibleStatuses?: ReadonlySet<IdeaTreeNode["status"]>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<PointerState | undefined>(undefined);
  const [size, setSize] = useState({ height: 640, width: 900 });
  const [viewport, setViewport] = useState<Viewport>({ x: 450, y: 70, zoom: 1 });
  const orientation = useMemo(() => chooseIdeaTreeOrientation(graph, size), [graph, size]);
  const positions = useMemo(() => layoutIdeaTree(graph, orientation), [graph, orientation]);
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setSize({ height: Math.max(host.clientHeight, 320), width: Math.max(host.clientWidth, 420) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const bounds = layoutBounds(positions);
    const zoom = Math.max(MIN_READABLE_ZOOM, Math.min(MAX_AUTO_ZOOM, layoutFitScale(positions, size)));
    setViewport({
      x: size.width / 2 - ((bounds.minX + bounds.maxX) / 2) * zoom,
      y: size.height / 2 - ((bounds.minY + bounds.maxY) / 2) * zoom,
      zoom,
    });
  }, [graph.treeId, orientation, positions, size.height, size.width]);

  const position = (nodeId: string) => positions.get(nodeId) ?? { x: 0, y: 0 };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { lastX: event.clientX, lastY: event.clientY, pointerId: event.pointerId };
  };

  const onNodePointerDown = (event: ReactPointerEvent<SVGGElement>, nodeId: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelect(nodeId);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const active = pointerRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.lastX;
    const dy = event.clientY - active.lastY;
    active.lastX = event.clientX;
    active.lastY = event.clientY;
    setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pointerRef.current = undefined;
  };

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const mouseX = event.clientX - bounds.left;
    const mouseY = event.clientY - bounds.top;
    setViewport((current) => {
      const nextZoom = Math.max(0.25, Math.min(2.5, current.zoom * Math.exp(-event.deltaY * 0.001)));
      const ratio = nextZoom / current.zoom;
      return {
        x: mouseX - (mouseX - current.x) * ratio,
        y: mouseY - (mouseY - current.y) * ratio,
        zoom: nextZoom,
      };
    });
  };

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  return <div className="idea-tree-canvas" ref={hostRef}>
    <svg
      aria-label={`Idea Tree ${graph.treeId}`}
      height={size.height}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      role="img"
      viewBox={`0 0 ${size.width} ${size.height}`}
      width={size.width}
    >
      <defs>
        <marker id={`idea-tree-arrow-${graph.treeId}`} markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4" viewBox="0 0 8 8">
          <path d="M0 0 L8 4 L0 8 z" />
        </marker>
      </defs>
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
        {graph.edges.map((edge) => {
          const source = position(edge.source);
          const target = position(edge.target);
          const sourceVisible = !visibleStatuses || visibleStatuses.has(nodeById.get(edge.source)?.status ?? "pending");
          const targetVisible = !visibleStatuses || visibleStatuses.has(nodeById.get(edge.target)?.status ?? "pending");
          if (!sourceVisible || !targetVisible) return null;
          const path = orientation === "left-right"
            ? (() => {
              const startX = source.x + NODE_WIDTH / 2;
              const endX = target.x - NODE_WIDTH / 2;
              const middleX = (startX + endX) / 2;
              return `M ${startX} ${source.y} C ${middleX} ${source.y}, ${middleX} ${target.y}, ${endX} ${target.y}`;
            })()
            : (() => {
              const startY = source.y + NODE_HEIGHT / 2;
              const endY = target.y - NODE_HEIGHT / 2;
              const middleY = (startY + endY) / 2;
              return `M ${source.x} ${startY} C ${source.x} ${middleY}, ${target.x} ${middleY}, ${target.x} ${endY}`;
            })();
          return <path
            className="idea-tree-edge"
            d={path}
            key={`${edge.source}:${edge.target}`}
            markerEnd={`url(#idea-tree-arrow-${graph.treeId})`}
          />;
        })}
        {graph.nodes.map((node) => {
          if (visibleStatuses && !visibleStatuses.has(node.status)) return null;
          const { x, y } = position(node.id);
          const matches = !normalizedQuery || `${node.id} ${node.hypothesis} ${node.insight ?? ""}`.toLowerCase().includes(normalizedQuery);
          return <g
            aria-label={`${node.id}: ${node.hypothesis}`}
            className={`idea-tree-node${selectedId === node.id ? " selected" : ""}${matches ? "" : " dimmed"}`}
            key={node.id}
            onPointerDown={(event) => onNodePointerDown(event, node.id)}
            role="button"
            tabIndex={0}
            transform={`translate(${x - NODE_WIDTH / 2} ${y - NODE_HEIGHT / 2})`}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(node.id); }}
          >
            <rect height={NODE_HEIGHT} rx="13" width={NODE_WIDTH} />
            <rect className="idea-tree-node-accent" fill={IDEA_TREE_STATUS_COLORS[node.status]} height={NODE_HEIGHT - 12} rx="3" width="5" x="7" y="6" />
            <text className="idea-tree-node-id" x="20" y="25">{node.id}</text>
            <rect
              className="idea-tree-node-status-bg"
              fill={IDEA_TREE_STATUS_COLORS[node.status]}
              height="21"
              rx="10.5"
              width="78"
              x={NODE_WIDTH - 91}
              y="10"
            />
            <text className="idea-tree-node-status" fill={IDEA_TREE_STATUS_COLORS[node.status]} textAnchor="middle" x={NODE_WIDTH - 52} y="24">{node.status.replace("_", " ")}</text>
            <foreignObject height="40" width={NODE_WIDTH - 40} x="20" y="38">
              <div className="idea-tree-node-title" title={node.hypothesis}>{node.hypothesis}</div>
            </foreignObject>
            <text className="idea-tree-node-meta" x="20" y="94">Depth {node.depth}{node.score === null ? "" : ` · Score ${node.score}`}</text>
          </g>;
        })}
      </g>
    </svg>
  </div>;
}
