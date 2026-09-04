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
 * Where each candidate sits, what it looks like, and what changed since last
 * frame — all as pure functions, so the canvas component is a thin host.
 *
 * **The layout is computed here rather than by a layout engine, and that is the
 * central decision of this view.** The memory graph's canvas runs dagre over the
 * whole graph; re-running that on every expansion would re-order the picture
 * under the user's cursor mid-search. A search tree does not need a solver: a
 * candidate's depth is known and its position among its siblings is its
 * insertion order, so coordinates are a formula. That makes appending a node
 * O(1), leaves every existing node exactly where it was, and keeps pan, zoom and
 * selection untouched.
 *
 * The second half of the same decision: a property change (`visits`, a score, a
 * new best) must never move anything. It is a data patch, and the styling reads
 * the patched data. See `diffGraph`.
 */

import type { EvolveCandidateView, EvolveRunView } from "./model.js";

/** Cytoscape paints to a canvas and cannot resolve `var(--x)`, so the palette
 *  lives here rather than in the stylesheet — the same reason `NODE_COLORS`
 *  does in the memory-graph canvas. */
export const SEARCH_COLORS = {
  /** Ramp from worst-ranked to best-ranked. Exploitation in PUCT is a *rank*,
   *  not a value, so the fill follows rank too: a metric's units never change
   *  what the picture means. */
  rank: ["#e2e8f0", "#bfdbfe", "#93c5fd", "#60a5fa", "#3b82f6", "#2563eb"],
  /** openevolve: one colour per island, cycled. */
  island: ["#2563eb", "#7c3aed", "#0891b2", "#ca8a04", "#db2777", "#16a34a"],
  edge: "#cbd5e1",
  inspires: "#e2e8f0",
  elected: "#f59e0b",
  invalid: "#94a3b8",
  refused: "#b45309",
} as const;

export interface PositionedNode {
  /** Set when a scorecard constraint refused this candidate, so the canvas can
   *  mark it apart from a candidate the statistical gate merely did not accept. */
  refused: boolean;
  color: string;
  elected: boolean;
  id: string;
  label: string;
  nodeIndex: number;
  /** 0 (worst) to 1 (best) among valid candidates; 0.5 when alone. */
  rank: number;
  size: number;
  title: string;
  valid: boolean;
  x: number;
  y: number;
}

export interface PositionedEdge {
  id: string;
  source: string;
  target: string;
  type: "expands" | "inspires";
}

/** A label rendered as a Cytoscape node, used for island band headers. */
export interface PositionedLabel {
  color: string;
  id: string;
  text: string;
  x: number;
  y: number;
}

export interface SearchGraphLayout {
  edges: PositionedEdge[];
  /** How many candidates were left out by the scale cap; 0 when all are drawn. */
  hidden: number;
  /** OpenEvolve only: one label per island band, placed at the left edge. */
  labels: PositionedLabel[];
  nodes: PositionedNode[];
}

/** Beyond this the picture stops being readable and starts being expensive. */
export const MAX_DRAWN_NODES = 200;

const COLUMN = 80;
const ROW = 48;
const BASE_SIZE = 34;

export function nodeId(nodeIndex: number): string {
  return `n${nodeIndex}`;
}

/**
 * Rank of each valid candidate in `[0, 1]`, worst to best.
 *
 * Failed candidates have no score and therefore no rank; they are drawn dimmed
 * at the bottom of the ramp. A lone candidate is 0.5 — the same convention the
 * engine's selection policy uses, so the picture and the algorithm agree about
 * what "middling" looks like.
 */
export function rankScores(candidates: readonly EvolveCandidateView[]): Map<number, number> {
  const scored = candidates
    .filter((candidate) => candidate.valid && candidate.score !== null)
    .sort((left, right) => (left.score ?? 0) - (right.score ?? 0));
  const ranks = new Map<number, number>();
  if (scored.length === 1) {
    ranks.set(scored[0]!.nodeIndex, 0.5);
    return ranks;
  }
  scored.forEach((candidate, position) => {
    ranks.set(candidate.nodeIndex, position / (scored.length - 1));
  });
  return ranks;
}

/**
 * Position every candidate.
 *
 * PUCT: `x` is depth (tree level), `y` is the candidate's order among the
 * nodes at that depth. The picture is a tree growing left-to-right.
 *
 * OpenEvolve: `x` is the iteration number (search timeline), so candidates
 * appear from left to right in the order the search produced them. Each island
 * gets its own horizontal band — candidates on island 0 are in the top band,
 * island 1 in the middle, island 2 at the bottom. Parent-child edges that
 * cross bands are migrations or cross-island mutations, which is exactly what
 * the user wants to see: within-island edges are short and horizontal;
 * cross-island edges are diagonal and show diversity flow.
 */
export function layoutSearchGraph(view: EvolveRunView, maxNodes = MAX_DRAWN_NODES): SearchGraphLayout {
  const drawn = selectDrawable(view, maxNodes);
  const ranks = rankScores(view.candidates);
  const byIsland = view.algorithm === "openevolve";
  const islands = [...new Set(drawn.map((candidate) => candidate.island ?? 0))].sort((a, b) => a - b);
  const rowCursor = new Map<string, number>();

  const nodes = drawn.map((candidate) => {
    const island = candidate.island ?? 0;
    const band = byIsland ? islands.indexOf(island) : 0;
    // OpenEvolve: x = iteration (timeline); PUCT: x = depth (tree level)
    const xValue = byIsland ? candidate.nodeIndex : candidate.depth;
    const key = `${band}:${xValue}`;
    const row = rowCursor.get(key) ?? 0;
    rowCursor.set(key, row + 1);
    const rank = ranks.get(candidate.nodeIndex) ?? 0;
    return {
      color: nodeColor(candidate, rank, byIsland),
      elected: view.bestNodeIndex === candidate.nodeIndex,
      id: nodeId(candidate.nodeIndex),
      label: nodeLabel(candidate),
      nodeIndex: candidate.nodeIndex,
      rank,
      refused: candidate.accepted === false && candidate.category === "constraint-violated",
      size: BASE_SIZE + Math.min(candidate.visits, 8) * 3,
      title: nodeTitle(candidate, rank, byIsland),
      valid: candidate.valid,
      x: xValue * COLUMN,
      y: band * (ROW * 6) + row * ROW,
    };
  });

  const present = new Set(drawn.map((candidate) => candidate.nodeIndex));
  const edges: PositionedEdge[] = [];
  for (const candidate of drawn) {
    if (candidate.parentIndex === null || !present.has(candidate.parentIndex)) continue;
    edges.push({
      id: `e${candidate.parentIndex}-${candidate.nodeIndex}`,
      source: nodeId(candidate.parentIndex),
      target: nodeId(candidate.nodeIndex),
      type: "expands",
    });
  }

  // OpenEvolve: add inspiration edges (dotted) from the inspiration program
  // to the candidate it inspired.
  if (byIsland) {
    for (const candidate of drawn) {
      if (candidate.inspirationIndex === undefined || candidate.inspirationIndex === null) continue;
      if (!present.has(candidate.inspirationIndex)) continue;
      edges.push({
        id: `i${candidate.inspirationIndex}-${candidate.nodeIndex}`,
        source: nodeId(candidate.inspirationIndex),
        target: nodeId(candidate.nodeIndex),
        type: "inspires",
      });
    }
  }

  // OpenEvolve: one label per island band, placed at the left edge so the
  // user sees "Island 0", "Island 1", "Island 2" as row headers.
  const labels: PositionedLabel[] = byIsland
    ? islands.map((island) => ({
        color: SEARCH_COLORS.island[island % SEARCH_COLORS.island.length]!,
        id: `label-island-${island}`,
        text: `Island ${island}`,
        x: -60,
        y: (islands.indexOf(island) ?? 0) * (ROW * 6),
      }))
    : [];

  return { edges, hidden: view.candidates.length - drawn.length, labels, nodes };
}

/**
 * Which candidates to draw when there are too many.
 *
 * Keep the elected candidate's whole ancestor chain — the story of how the best
 * program came about — plus the highest-ranked of the rest. Truncation is
 * reported rather than silent: a picture that quietly shows 200 of 900 nodes
 * reads as "this is the search", which is worse than saying so.
 */
export function selectDrawable(view: EvolveRunView, maxNodes = MAX_DRAWN_NODES): EvolveCandidateView[] {
  if (view.candidates.length <= maxNodes) return view.candidates;

  const byIndex = new Map(view.candidates.map((candidate) => [candidate.nodeIndex, candidate]));
  const keep = new Set<number>();
  let cursor = view.bestNodeIndex;
  while (cursor !== undefined && cursor !== null && !keep.has(cursor)) {
    keep.add(cursor);
    cursor = byIndex.get(cursor)?.parentIndex ?? undefined;
  }

  const ranked = [...view.candidates]
    .filter((candidate) => !keep.has(candidate.nodeIndex))
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
  for (const candidate of ranked) {
    if (keep.size >= maxNodes) break;
    keep.add(candidate.nodeIndex);
  }
  return view.candidates.filter((candidate) => keep.has(candidate.nodeIndex));
}

export interface GraphDiff {
  /** Nodes and edges that did not exist last frame. */
  added: { edges: PositionedEdge[]; nodes: PositionedNode[] };
  /** Nodes whose *appearance* changed but whose position did not. */
  patched: PositionedNode[];
  /** True when something was dropped by the scale cap and must be re-drawn. */
  rebuild: boolean;
}

/**
 * What changed between two layouts.
 *
 * The split is the whole point: `added` is appended, `patched` is a data update,
 * and neither re-runs a layout. A node keeps its coordinates for the life of the
 * search, so a score arriving for candidate #3 cannot shift candidate #40 under
 * the user's cursor.
 *
 * `rebuild` is the one case where that is not enough: when the scale cap changes
 * which candidates are drawn, positions are recomputed for a different set and
 * the canvas has to start over.
 */
export function diffGraph(previous: SearchGraphLayout | undefined, next: SearchGraphLayout): GraphDiff {
  if (!previous) return { added: { edges: next.edges, nodes: next.nodes }, patched: [], rebuild: false };

  const before = new Map(previous.nodes.map((node) => [node.id, node]));
  const added: PositionedNode[] = [];
  const patched: PositionedNode[] = [];
  let moved = false;

  for (const node of next.nodes) {
    const old = before.get(node.id);
    if (!old) {
      added.push(node);
      continue;
    }
    if (old.x !== node.x || old.y !== node.y) moved = true;
    if (
      old.color !== node.color || old.size !== node.size || old.label !== node.label
      || old.elected !== node.elected || old.valid !== node.valid || old.refused !== node.refused
      || old.title !== node.title
    ) {
      patched.push(node);
    }
  }

  const knownEdges = new Set(previous.edges.map((edge) => edge.id));
  const addedEdges = next.edges.filter((edge) => !knownEdges.has(edge.id));
  // A node that disappeared, or one that moved, means the drawn set changed —
  // only the scale cap can do that, and it needs a fresh canvas.
  const removed = previous.nodes.length > next.nodes.length;
  return { added: { edges: addedEdges, nodes: added }, patched, rebuild: moved || removed };
}

function nodeColor(candidate: EvolveCandidateView, rank: number, byIsland: boolean): string {
  if (!candidate.valid) return SEARCH_COLORS.invalid;
  if (byIsland) {
    const palette = SEARCH_COLORS.island;
    return palette[(candidate.island ?? 0) % palette.length]!;
  }
  const ramp = SEARCH_COLORS.rank;
  return ramp[Math.min(ramp.length - 1, Math.round(rank * (ramp.length - 1)))]!;
}

function nodeLabel(candidate: EvolveCandidateView): string {
  const score = candidate.score === null ? "×" : candidate.score.toFixed(3);
  return `#${candidate.nodeIndex}\n${score}`;
}

function nodeTitle(candidate: EvolveCandidateView, rank: number, byIsland: boolean = false): string {
  const parts = [
    `#${candidate.nodeIndex}`,
    candidate.score === null ? "failed" : `score ${candidate.score.toFixed(4)}`,
    `rank ${(rank * 100).toFixed(0)}%`,
    `visits ${candidate.visits}`,
  ];
  if (byIsland) {
    parts.push(`island ${candidate.island ?? 0}`);
    if (candidate.migratedToIsland !== undefined) parts.push(`migrated→${candidate.migratedToIsland}`);
    if (candidate.inspirationIndex !== undefined) parts.push(`inspired by #${candidate.inspirationIndex}`);
    if (candidate.cellVia === "migration") parts.push("via migration");
  } else {
    parts.push(`depth ${candidate.depth}`);
  }
  if (candidate.accepted === false) parts.push(candidate.rejectedBy ?? candidate.category ?? "refused");
  return parts.join(" · ");
}
