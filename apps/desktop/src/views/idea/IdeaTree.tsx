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

import { useEffect, useRef, useState } from "react";

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
  /** The column is narrow and a tree grows sideways: shrink the drawing to the
   *  column while it stays readable, and let it scroll past that point rather
   *  than render text nobody can read. */
  useEffect(() => {
    const element = box.current;
    if (element === null) return undefined;
    const fit = () => {
      const width = element.clientWidth - 10;
      if (!Number.isFinite(width) || width <= 0) return;
      setScale(Math.max(MIN_SCALE, Math.min(1, width / layout.width)));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout.width]);
  if (!layout.nodes.length) return <p className="idea-tree-empty">{t.empty}</p>;
  return (
    <div className="idea-tree" aria-label={t.tree} ref={box} role="group">
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
