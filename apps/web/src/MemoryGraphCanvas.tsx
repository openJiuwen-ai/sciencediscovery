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

import { useEffect, useMemo, useRef } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import { drag, type D3DragEvent } from "d3-drag";
import { select, type EnterElement, type Selection } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomTransform } from "d3-zoom";

import type { MemoryGraphEdgeType, MemoryGraphNodeLabel, MemorySubgraph } from "@science-agent/schema";

/**
 * One colour per node label, drawn from a Morandi palette (low-saturation,
 * dusty tones — every channel sits between 0.55 and 0.75 so the seven hues
 * never compete). Kept in a plain map (not CSS variables) because SVG paints
 * inline and we want the same predictable palette the previous Cytoscape
 * canvas used. The Morandi palette is purely visual: it does not change any
 * data semantics, only the rendered swatch.
 */
export const NODE_COLORS: Record<MemoryGraphNodeLabel, string> = {
  ResearchGoal: "#a89bb0", // dusty lavender
  SubTask: "#9bafc0",      // powder blue
  Paper: "#c09a8a",        // dusty terracotta
  Evidence: "#9aab97",     // sage
  Claim: "#c0b08a",        // warm beige
  Code: "#bf9aa8",         // dusty rose
  Artifact: "#9aab85",     // muted moss
};

/**
 * Every edge is the same soft slate. The relationship *type* is no longer
 * encoded by colour — each line now carries an inline label on its midpoint,
 * so the swatch here is purely a fallback (and the colour for the matching
 * arrowhead marker). Kept in the same shape so the filter chip swatch in
 * `MemoryGraphExplorer` still reads the keys without change.
 */
export const EDGE_COLORS: Record<MemoryGraphEdgeType, string> = {
  produces: "#94a3b8",
  next: "#94a3b8",
  extracted_from: "#94a3b8",
  cites: "#94a3b8",
  states: "#94a3b8",
  supersedes: "#94a3b8",
  input: "#94a3b8",
};

/** Lighter slate used when the canvas is zoomed out, so edges recede. */
const EDGE_COLOR_LIGHT = "#cbd5e1";

/** Short, human-facing name for a node — mirrors MemoryGraphView's picking rules. */
export function graphNodeName(node: { label: MemoryGraphNodeLabel; id: string; extra?: Record<string, unknown> }): string {
  const extra = node.extra ?? {};
  const pick = (key: string): string | undefined => {
    const value = extra[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const name = node.label === "Artifact" ? pick("path") ?? pick("artifact_id")
    : node.label === "Code" ? pick("tool") ?? pick("code_id")
    : node.label === "SubTask" ? pick("task_type") ?? pick("task_id")
    : node.label === "Paper" ? pick("title") ?? pick("link")
    : node.label === "ResearchGoal" ? pick("core_objective") ?? pick("goal_id")
    : pick("title") ?? pick("name");
  const resolved = name ?? node.id;
  // Long paths/URLs read better from the tail (basename) than the head.
  const compact = resolved.length > 28 && resolved.includes("/") ? resolved.slice(resolved.lastIndexOf("/") + 1) : resolved;
  return compact.length > 30 ? `${compact.slice(0, 29)}…` : compact;
}

/**
 * Display names for a whole graph. A run of six `run_python` dots is
 * unreadable — every one of them says the same thing — so repeated names get a
 * `#n` suffix in graph order. Unique names are left exactly as they are.
 */
export function graphNodeDisplayNames(
  nodes: Array<{ label: MemoryGraphNodeLabel; id: string; extra?: Record<string, unknown> }>,
): Map<string, string> {
  const totals = new Map<string, number>();
  for (const node of nodes) {
    const name = graphNodeName(node);
    totals.set(name, (totals.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const display = new Map<string, string>();
  for (const node of nodes) {
    const name = graphNodeName(node);
    if ((totals.get(name) ?? 0) < 2) { display.set(node.id, name); continue; }
    const index = (seen.get(name) ?? 0) + 1;
    seen.set(name, index);
    display.set(node.id, `${name} #${index}`);
  }
  return display;
}

/**
 * Statuses that mark a SubTask/Code node as finished. Statusless nodes
 * (Artifacts, Papers, …) are facts, not "incomplete", so they never appear as
 * pending. Mirrors the same set MemoryGraphView uses for its done-badge.
 */
const DONE_STATUSES = new Set(["succeeded", "success", "completed", "done", "ok"]);

interface SimNode {
  id: string;
  label: MemoryGraphNodeLabel;
  name: string;
  pending: boolean;
  // Set true when the executor in MemoryGraphExplorer synthesised this node
  // to represent a run of intermediate SubTasks that the user can expand.
  // The canvas reads it to render a dashed outline + "+N" caption instead of
  // the regular disc + truncated name.
  collapsed?: boolean;
  collapsedCount?: number;
  // Fields set/read by d3-force during simulation. Declared on our type so we
  // don't have to extend `SimulationNodeDatum` (whose x/y are optional and
  // whose other fields confuse the d3-selection generic callbacks).
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  index?: number;
}

interface SimLink {
  id: string;
  type: MemoryGraphEdgeType;
  // d3-force replaces string source/target with the resolved node reference
  // once the link force is initialised.
  source: string | SimNode;
  target: string | SimNode;
  index?: number;
}

/**
 * Project the line from `from` toward `to` so it stops at the edge of a
 * circle of `radius` around `to`. Used to draw edges from circle edge to
 * circle edge — letting the arrowhead sit exactly at the target's border
 * instead of being buried inside the target's fill. Distances smaller than
 * the radius collapse to the centre point so a co-located pair never
 * produces a NaN.
 */
function truncateToEdge(from: SimNode, to: SimNode, radius: number): { x: number; y: number } {
  const fx = from.x ?? 0;
  const fy = from.y ?? 0;
  const tx = to.x ?? 0;
  const ty = to.y ?? 0;
  const dx = tx - fx;
  const dy = ty - fy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Leave a small gap between the edge and the node so the arrow doesn't
  // sit right on the disc edge — visually the line "lands" on the disc
  // instead of being tangled in it.
  const gap = 3;
  if (dist <= radius + gap) return { x: tx, y: ty };
  const ratio = (dist - radius - gap) / dist;
  return { x: fx + dx * ratio, y: fy + dy * ratio };
}

/**
 * Truncate a node's display name so it fits inside the disc. The disc has
 * radius `nodeSize = 23` (interactive mode) and the label sits at font-size 8;
 * that gives about 8 characters of room measured against a typical
 * sans-serif glyph. Long names get the last character replaced by an
 * ellipsis so the caption always reads as a single line.
 */
function truncateLabel(name: string, maxChars: number): string {
  return name.length <= maxChars ? name : `${name.slice(0, maxChars - 1)}…`;
}

const NODE_LABEL_MAX_CHARS = 9;

/**
 * Scale edges (and fade their labels) when the user is viewing the full graph.
 * Below scale 0.3 the edges are almost invisible; above scale 1.0 they reach
 * full width and full opacity. The midpoint maps 1:1 to the default fit. Edge
 * labels only start to appear once the user zooms in past half-scale —
 * otherwise the midpoint stack overwhelms the canvas.
 */
function applyZoomAdaptation(
  scale: number,
  edgeSel: Selection<SVGGElement, SimLink, SVGGElement, unknown> | null,
  interactive: boolean,
): void {
  if (!edgeSel) return;
  // t = 0 at scale 0.3, t = 1 at scale 1.0 (clamped).
  const t = Math.max(0, Math.min(1, (scale - 0.3) / 0.7));
  const baseWidth = interactive ? 1.8 : 1.0;
  const strokeWidth = baseWidth * (0.4 + 0.6 * t);
  const edgeOpacity = 0.35 + 0.65 * t;
  const edgeColor = t < 0.5 ? EDGE_COLOR_LIGHT : EDGE_COLORS.next;
  const labelOpacity = Math.max(0, (t - 0.55) * 2.2); // 0 below 0.55, 1 above 1.0

  edgeSel.select("line")
    .attr("stroke-width", strokeWidth)
    .attr("opacity", edgeOpacity)
    .attr("stroke", edgeColor);
  edgeSel.select("text")
    .attr("opacity", labelOpacity);
}

/**
 * For the disjoint pinning strategy (matching the Observable reference): find
 * every connected component of the graph and assign each one a target center
 * on a k-cell grid. forceX/forceY then softly pull each node toward its
 * component's centre, so isolated sub-graphs don't pile up on the canvas
 * centre when the run-graph only has one big component.
 */
function computeComponentCenters(
  nodeIds: string[],
  links: SimLink[],
  width: number,
  height: number,
): Map<string, { cx: number; cy: number }> {
  const adjacency = new Map<string, Set<string>>();
  for (const id of nodeIds) adjacency.set(id, new Set());
  for (const link of links) {
    const sourceId = typeof link.source === "object" ? link.source.id : link.source;
    const targetId = typeof link.target === "object" ? link.target.id : link.target;
    if (adjacency.has(sourceId) && adjacency.has(targetId)) {
      adjacency.get(sourceId)!.add(targetId);
      adjacency.get(targetId)!.add(sourceId);
    }
  }
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of nodeIds) {
    if (visited.has(id)) continue;
    const queue = [id];
    const component: string[] = [];
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const next of adjacency.get(current) ?? []) queue.push(next);
    }
    components.push(component);
  }
  const k = components.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(k)));
  const rows = Math.max(1, Math.ceil(k / cols));
  const cellW = width / cols;
  const cellH = height / rows;
  const centers = new Map<string, { cx: number; cy: number }>();
  components.forEach((component, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cx = cellW * (col + 0.5);
    const cy = cellH * (row + 0.5);
    for (const id of component) centers.set(id, { cx, cy });
  });
  return centers;
}

interface MemoryGraphCanvasProps {
  /** Node labels to show. Undefined = show all. */
  visibleLabels?: ReadonlySet<MemoryGraphNodeLabel>;
  /** Edge types to show. Undefined = show all. */
  visibleEdgeTypes?: ReadonlySet<MemoryGraphEdgeType>;
  /** Search hits. When defined, non-matching nodes are dimmed and hits glow. */
  matchIds?: ReadonlySet<string>;
  /** Thumbnail mode locks interaction and hides text; full mode is explorable. */
  interactive: boolean;
  onSelect?: (nodeId: string) => void;
  selectedId?: string;
  subgraph: MemorySubgraph;
}

/**
 * Refs that the build effect populates and the filter/selection effects read.
 * A single shared object keeps the cross-effect plumbing local to this hook.
 */
interface SimRef {
  simulation: Simulation<SimNode, SimLink> | null;
  simNodes: SimNode[];
  simLinks: SimLink[];
  nodeSel: Selection<SVGGElement, SimNode, SVGGElement, unknown> | null;
  edgeSel: Selection<SVGGElement, SimLink, SVGGElement, unknown> | null;
  zoomBehavior: ReturnType<typeof zoom<SVGSVGElement, unknown>> | null;
  svgSel: Selection<SVGSVGElement, unknown, null, undefined> | null;
  width: number;
  height: number;
  nodeSize: number;
  /** True once the simulation has produced node coordinates; used to gate fit. */
  positionsReady: boolean;
}

export function MemoryGraphCanvas({
  interactive,
  matchIds,
  onSelect,
  selectedId,
  subgraph,
  visibleEdgeTypes,
  visibleLabels,
}: MemoryGraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const simRef = useRef<SimRef>({
    simulation: null,
    simNodes: [],
    simLinks: [],
    nodeSel: null,
    edgeSel: null,
    zoomBehavior: null,
    svgSel: null,
    width: 0,
    height: 0,
    nodeSize: 0,
    positionsReady: false,
  });
  // The parent re-polls on a timer and hands us a fresh object each time. Key
  // the rebuild on the graph's *content* so an unchanged graph never re-runs
  // layout — otherwise the user's pan, zoom and selection reset every poll.
  const signature = useMemo(() => JSON.stringify([
    subgraph.nodes.map((node) => `${node.id}:${node.label}:${String(node.extra?.status ?? "")}`).sort(),
    subgraph.edges.map((edge) => `${edge.source}>${edge.target}:${edge.type}`).sort(),
  ]), [subgraph]);

  // Skip the first selection-triggered pan/zoom so it doesn't fight the layout
  // fit. Mirrors the Cytoscape-era didInitialSelectionRef pattern.
  const didInitialSelectionRef = useRef(false);
  useEffect(() => { didInitialSelectionRef.current = false; }, [signature]);

  // Build/rebuild the simulation only when the data itself changes. Filtering
  // and selection are applied separately below so the layout never jumps.
  useEffect(() => {
    const host = hostRef.current;
    const svgEl = svgRef.current;
    if (!host || !svgEl) return;

    const width = host.clientWidth || 800;
    const height = host.clientHeight || 600;
    // Radius (the previous Cytoscape code used diameter for `width`/`height`).
    const nodeSize = interactive ? 23 : 6;
    const done = DONE_STATUSES;

    const displayNames = graphNodeDisplayNames(subgraph.nodes);
    const known = new Set(subgraph.nodes.map((node) => node.id));
    const simNodes: SimNode[] = subgraph.nodes.map((node) => {
      const status = typeof node.extra?.status === "string" ? node.extra.status.toLowerCase() : "";
      // Only work that reports an unfinished status is drawn as pending.
      // Statusless nodes (artifacts, papers, …) are facts, not "incomplete".
      const pending = Boolean(status) && !done.has(status);
      // The paper-chain view in MemoryGraphExplorer injects a synthetic node
      // with `extra.collapsed=true` to summarise a run of intermediate
      // SubTasks. Carry that flag across so the canvas can render it as a
      // dashed disc with a "+N" caption rather than a regular SubTask.
      const collapsed = node.extra?.collapsed === true;
      const collapsedCount = typeof node.extra?.count === "number" ? node.extra.count : 0;
      return {
        id: node.id,
        label: node.label,
        name: displayNames.get(node.id) ?? graphNodeName(node),
        pending,
        collapsed,
        collapsedCount,
      };
    });
    // `supersedes` (Artifact version → previous version) is written to the
    // graph but not drawn here — version history is out of scope for the
    // chain/canvas view. Dropped before layout so it never claims rank
    // space, and absent from the Relationships filter list upstream.
    const simLinks: SimLink[] = subgraph.edges
      .filter((edge) => edge.type !== "supersedes" && known.has(edge.source) && known.has(edge.target))
      .map((edge, index) => ({
        id: `e${index}`,
        source: edge.source,
        target: edge.target,
        type: edge.type,
      }));

    const componentCenters = computeComponentCenters(
      simNodes.map((node) => node.id),
      simLinks,
      width,
      height,
    );

    const svgSel = select(svgEl);
    svgSel.selectAll("*").remove();

    // One arrow marker per edge type, coloured from EDGE_COLORS so each
    // arrowhead matches its line. Tailored small enough that at full zoom
    // they sit cleanly on the disc edge instead of drowning it.
    const defs = svgSel.append("defs");
    for (const [type, color] of Object.entries(EDGE_COLORS)) {
      defs.append("marker")
        .attr("id", `memory-canvas-arrow-${type}`)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 8)
        .attr("refY", 0)
        .attr("markerWidth", interactive ? 5 : 3)
        .attr("markerHeight", interactive ? 5 : 3)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", color);
    }

    // The zoom transform lives on this inner group so pan/zoom doesn't fight
    // the outer SVG's coordinate system.
    const zoomLayer = svgSel.append("g").attr("class", "memory-canvas-zoom-layer");
    const edgesLayer = zoomLayer.append("g").attr("class", "memory-canvas-edges");
    const nodesLayer = zoomLayer.append("g").attr("class", "memory-canvas-nodes");

    // Seed initial positions so the bbox has something to fit on the very
    // first tick — without these, nodes start at (NaN, NaN) and the layout
    // flashes empty until the first tick fires.
    simNodes.forEach((node, index) => {
      const angle = (index / Math.max(simNodes.length, 1)) * Math.PI * 2;
      node.x = width / 2 + Math.cos(angle) * 80;
      node.y = height / 2 + Math.sin(angle) * 80;
    });

    const simulation = forceSimulation<SimNode>(simNodes)
      // Longer link distance + slightly stronger repulsion so dragging a node
      // doesn't feel like the edges are pulling it back. 3.4×nodeSize was
      // visually tight — neighbours sat close enough that the link spring
      // fought the drag gesture. 4.5× / -9 keeps the graph airy enough to
      // rearrange itself with one hand.
      .force("link", forceLink<SimNode, SimLink>(simLinks).id((node: SimNode) => node.id).distance(nodeSize * 4.5))
      .force("charge", forceManyBody().strength(-nodeSize * 9))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide<SimNode>().radius(nodeSize + 6))
      .force("x", forceX<SimNode>((node: SimNode) => componentCenters.get(node.id)?.cx ?? width / 2).strength(0.05))
      .force("y", forceY<SimNode>((node: SimNode) => componentCenters.get(node.id)?.cy ?? height / 2).strength(0.05))
      .alpha(1)
      // Stronger decay than the d3 default so layout settles within a couple
      // of seconds rather than the long, dreamy tail the default produces.
      .alphaDecay(0.05);

    const edgeSel = edgesLayer.selectAll<SVGGElement, SimLink>("g")
      .data(simLinks, (link: SimLink) => link.id)
      .join("g")
      .attr("class", "memory-canvas-edge-group");

    edgeSel.append("line")
      .attr("class", "memory-canvas-edge")
      .attr("data-id", (link: SimLink) => link.id)
      .attr("stroke", (link: SimLink) => EDGE_COLORS[link.type] ?? EDGE_COLOR_LIGHT)
      .attr("stroke-width", interactive ? 1.8 : 1.0)
      .attr("marker-end", (link: SimLink) => `url(#memory-canvas-arrow-${link.type})`);

    // Edge type label: a small text positioned next to the arrow and rotated
    // to run parallel to the edge. Slightly smaller than the node caption so
    // it reads as a quiet annotation; no white halo so the glyph silhouette
    // stays clean against the line.
    edgeSel.append("text")
      .attr("class", "memory-canvas-edge-label")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("font-size", 7)
      .attr("font-weight", 600)
      .attr("fill", "#475569")
      .text((link: SimLink) => link.type);

    const nodeSel = nodesLayer.selectAll<SVGGElement, SimNode>("g")
      .data(simNodes, (node: SimNode) => node.id)
      .join((enter: Selection<EnterElement, SimNode, SVGGElement, undefined>) => {
        const g = enter.append("g").attr("class", "memory-canvas-node");

        // Selected-node halo: two concentric rings with SMIL animations, each
        // pulsing r and stroke-opacity. The second ring is offset by half the
        // duration so the user sees a continuous wave rather than a single
        // blink. CSS keeps the rings hidden until the group gets the
        // `selected-node` class (see memory-graph.css).
        if (interactive) {
          const ring1 = g.append("circle")
            .attr("class", "memory-canvas-selected-ring")
            .attr("r", nodeSize)
            .attr("fill", "none")
            .attr("stroke", "#3b82f6")
            .attr("stroke-width", 2.5)
            .attr("pointer-events", "none");
          ring1.append("animate")
            .attr("attributeName", "r")
            .attr("values", `${nodeSize};${nodeSize * 1.55};${nodeSize}`)
            .attr("dur", "1.8s")
            .attr("repeatCount", "indefinite");
          ring1.append("animate")
            .attr("attributeName", "stroke-opacity")
            .attr("values", "0.85;0;0.85")
            .attr("dur", "1.8s")
            .attr("repeatCount", "indefinite");

          const ring2 = g.append("circle")
            .attr("class", "memory-canvas-selected-ring")
            .attr("r", nodeSize)
            .attr("fill", "none")
            .attr("stroke", "#60a5fa")
            .attr("stroke-width", 2)
            .attr("pointer-events", "none");
          ring2.append("animate")
            .attr("attributeName", "r")
            .attr("values", `${nodeSize};${nodeSize * 1.55};${nodeSize}`)
            .attr("dur", "1.8s")
            .attr("begin", "0.9s")
            .attr("repeatCount", "indefinite");
          ring2.append("animate")
            .attr("attributeName", "stroke-opacity")
            .attr("values", "0.7;0;0.7")
            .attr("dur", "1.8s")
            .attr("begin", "0.9s")
            .attr("repeatCount", "indefinite");
        }

        g.append("circle")
          .attr("r", nodeSize)
          // Pending nodes keep a coloured dashed outline as a "in progress"
          // marker; settled nodes are borderless so the disc reads as a flat
          // Morandi swatch without the previous white separator ring. The
          // synthetic collapsed node (used by the paper chain view) gets a
          // dashed slate ring so it reads as "summary, click to expand".
          .attr("stroke", (node: SimNode) => {
            if (node.collapsed) return "#64748b";
            return node.pending ? (NODE_COLORS[node.label] ?? "#64748b") : "none";
          })
          .attr("stroke-width", (node: SimNode) => {
            if (node.collapsed) return interactive ? 2 : 1.4;
            return node.pending ? (interactive ? 2.5 : 1.6) : 0;
          })
          .attr("fill", (node: SimNode) => node.collapsed ? "#e2e8f0" : (NODE_COLORS[node.label] ?? "#64748b"))
          .attr("fill-opacity", (node: SimNode) => node.pending ? 0.18 : 1)
          .attr("stroke-dasharray", (node: SimNode) => {
            if (node.collapsed) return interactive ? "4 3" : "2 2";
            return node.pending ? "3 2" : null;
          });
        if (interactive) {
          // Neo4j Browser writes the caption inside the disc. Doing the same
          // frees the space between nodes, which is what previously forced
          // the layout wide enough to keep outside labels from colliding.
          // Truncate with an ellipsis so long names never overflow the disc.
          // Collapsed summary nodes show "+N" instead of a name to advertise
          // that there are N items behind the click.
          g.append("text")
            .attr("class", "memory-canvas-node-label")
            .attr("text-anchor", "middle")
            .attr("dy", "0.35em")
            .attr("fill", (node: SimNode) => node.collapsed ? "#475569" : "#ffffff")
            .attr("font-size", (node: SimNode) => node.collapsed ? 9 : 8)
            .attr("font-weight", 600)
            .text((node: SimNode) => {
              if (node.collapsed) return `+${node.collapsedCount}`;
              return truncateLabel(node.name, NODE_LABEL_MAX_CHARS);
            });
        }
        return g;
      });

    simulation.on("tick", () => {
      edgeSel.each(function(link: SimLink) {
        const source = link.source;
        const target = link.target;
        if (typeof source === "string" || typeof target === "string") return;
        const sourceEdge = truncateToEdge(target, source, nodeSize);
        const targetEdge = truncateToEdge(source, target, nodeSize);
        const dx = targetEdge.x - sourceEdge.x;
        const dy = targetEdge.y - sourceEdge.y;
        const angle = Math.atan2(dy, dx);
        // Normalise the rotation so we never write the caption upside down:
        // when the edge runs leftward we fold the angle back by 180° so the
        // text reads right-side up, and pick the matching perpendicular side.
        let rot = angle * 180 / Math.PI;
        const flipped = rot > 90 || rot <= -90;
        if (rot > 90) rot -= 180;
        if (rot <= -90) rot += 180;
        // Position the label at the midpoint of the edge, offset by a small
        // perpendicular gap so it sits *next to* the line rather than on it.
        const perpSign = flipped ? -1 : 1;
        const perpAngle = angle - Math.PI / 2;
        const labelOffset = 5;
        const midX = (sourceEdge.x + targetEdge.x) / 2;
        const midY = (sourceEdge.y + targetEdge.y) / 2;
        const labelX = midX + Math.cos(perpAngle) * labelOffset * perpSign;
        const labelY = midY + Math.sin(perpAngle) * labelOffset * perpSign;
        const g = select(this);
        g.select("line")
          .attr("x1", sourceEdge.x)
          .attr("y1", sourceEdge.y)
          .attr("x2", targetEdge.x)
          .attr("y2", targetEdge.y);
        g.select("text")
          .attr("transform", `translate(${labelX}, ${labelY}) rotate(${rot})`);
      });
      nodeSel.attr("transform", (node: SimNode) => `translate(${node.x ?? 0}, ${node.y ?? 0})`);
    });

    let zoomBehavior: ReturnType<typeof zoom<SVGSVGElement, unknown>> | undefined;
    if (interactive) {
      zoomBehavior = zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.2, 2.5])
        // Block zoom/pan that starts on a node — the node drag owns the gesture.
        .filter((event: Event) => {
          if (event.type === "wheel") return true;
          const target = event.target as Element | null;
          return !target?.closest(".memory-canvas-node");
        })
        .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
          zoomLayer.attr("transform", event.transform.toString());
          applyZoomAdaptation(event.transform.k, edgeSel, interactive);
        });
      svgSel.call(zoomBehavior);
      // Apply the initial adaptation so a small fit-scale still gets the
      // thinned-edge look before the user touches the wheel.
      applyZoomAdaptation(1, edgeSel, interactive);

      nodeSel.call(
        drag<SVGGElement, SimNode>()
          .filter((event: Event) => !(event as MouseEvent).button)
          .on("start", (event: D3DragEvent<SVGGElement, SimNode, SimNode>, node: SimNode) => {
            // Restart the sim while a drag is happening so the rest of the
            // graph follows along instead of freezing mid-position.
            if (!event.active) simulation.alphaTarget(0.3).restart();
            // Release any previously dragged nodes so the simulation can
            // reflow them around the new drag target. d3-force treats a
            // node with `fx`/`fy` set as fixed, so a node dropped in a
            // prior drag would otherwise stay pinned at its drop position
            // and the rest of the graph never re-flows around the new
            // gesture. The just-dropped node keeps its fx/fy below so it
            // stays where the user released it.
            for (const other of simNodes) {
              if (other === node) continue;
              if (other.fx != null) other.fx = null;
              if (other.fy != null) other.fy = null;
            }
            node.fx = node.x;
            node.fy = node.y;
          })
          .on("drag", (event: D3DragEvent<SVGGElement, SimNode, SimNode>, node: SimNode) => {
            node.fx = event.x;
            node.fy = event.y;
          })
          .on("end", (event: D3DragEvent<SVGGElement, SimNode, SimNode>, node: SimNode) => {
            if (!event.active) simulation.alphaTarget(0);
            // Keep `fx`/`fy` set so the dropped node stays where the user
            // released it. The drag handler already updated them to the drop
            // coordinates; resetting them to null would let the simulation
            // pull the node back to its free position on the next tick.
          }),
      );

      // Click to select. D3's drag handler swallows clicks within the drag
      // threshold, so this fires only on real clicks, not on drags.
      nodeSel.on("click", (event: MouseEvent, node: SimNode) => {
        event.stopPropagation();
        onSelectRef.current?.(node.id);
      });
    }

    // Compute the bbox of all node positions and apply a transform that
    // centres it in the viewport. Called after layout settles, after filters
    // narrow the view, and after the container resizes.
    const fitAll = (duration: number) => {
      const ref = simRef.current;
      if (!ref.svgSel || !ref.zoomBehavior) {
        // Thumbnail mode: just translate the zoom layer so the nodes land
        // somewhere visible without scaling.
        zoomLayer.attr("transform", `translate(0, 0)`);
        return;
      }
      const positions: Array<[number, number]> = [];
      for (const node of simNodes) {
        if (typeof node.x === "number" && typeof node.y === "number") positions.push([node.x, node.y]);
      }
      if (positions.length < 2) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of positions) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const bboxW = (maxX - minX) || 1;
      const bboxH = (maxY - minY) || 1;
      const padding = interactive ? 30 : 8;
      const scale = Math.min(
        (width - padding * 2) / (bboxW + nodeSize * 2),
        (height - padding * 2) / (bboxH + nodeSize * 2),
        interactive ? 1.5 : 1.1,
      );
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const transform = zoomIdentity
        .translate(width / 2 - centerX * scale, height / 2 - centerY * scale)
        .scale(scale);
      svgSel.transition().duration(duration).call(ref.zoomBehavior.transform, transform);
    };

    simRef.current = {
      simulation,
      simNodes,
      simLinks,
      nodeSel,
      edgeSel,
      zoomBehavior: zoomBehavior ?? null,
      svgSel,
      width,
      height,
      nodeSize,
      positionsReady: true,
    };

    // Fit once positions are settled. The simulation emits "end" when alpha
    // drops below alphaMin; a safety timer caps the wait in case the sim
    // oscillates between alphaMin and a tiny bump (it shouldn't with our
    // forces, but be defensive).
    let didFit = false;
    const onEnd = () => {
      if (didFit) return;
      didFit = true;
      fitAll(260);
    };
    simulation.on("end", onEnd);
    const fitTimer = setTimeout(onEnd, 600);

    // The container is often still animating (modal open) or zero-sized when
    // the SVG first measures it, which leaves the graph crammed in a corner.
    // Re-fit whenever the box actually changes size.
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        const ref = simRef.current;
        if (!ref.width || !ref.height) return;
        ref.width = host.clientWidth || ref.width;
        ref.height = host.clientHeight || ref.height;
        fitAll(160);
      });
      observer.observe(host);
    }

    return () => {
      clearTimeout(fitTimer);
      observer?.disconnect();
      simulation.stop();
      simRef.current = {
        simulation: null,
        simNodes: [],
        simLinks: [],
        nodeSel: null,
        edgeSel: null,
        zoomBehavior: null,
        svgSel: null,
        width: 0,
        height: 0,
        nodeSize: 0,
        positionsReady: false,
      };
    };
  }, [interactive, signature]);

  // Filtering: dim rather than remove, so the layout stays stable and the user
  // keeps their spatial bearings while toggling categories.
  useEffect(() => {
    const ref = simRef.current;
    if (!ref.nodeSel || !ref.edgeSel) return;
    const categoryFiltered = Boolean(visibleLabels || visibleEdgeTypes);
    const typePicked = (type: MemoryGraphEdgeType): boolean =>
      !visibleEdgeTypes || visibleEdgeTypes.has(type);
    // Picking an edge type is a statement about the relationship, so the two
    // nodes it connects come along with it. Node and edge filters therefore
    // union: a node survives if its own label was picked *or* it is an
    // endpoint of a picked relationship.
    const pulledIn = new Set<string>();
    if (visibleEdgeTypes) {
      for (const link of ref.simLinks) {
        if (!visibleEdgeTypes.has(link.type)) continue;
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        pulledIn.add(sourceId);
        pulledIn.add(targetId);
      }
    }
    const nodeDimmed = new Map<string, boolean>();
    ref.nodeSel.each((node: SimNode) => {
      const byLabel = visibleLabels ? visibleLabels.has(node.label) : false;
      const kept = !categoryFiltered || byLabel || pulledIn.has(node.id);
      // A search narrows on top of the category filters: both must pass.
      const searchHidden = matchIds ? !matchIds.has(node.id) : false;
      nodeDimmed.set(node.id, !kept || searchHidden);
    });
    ref.nodeSel
      .classed("dimmed", (node: SimNode) => nodeDimmed.get(node.id) ?? false)
      .classed("search-hit", (node: SimNode) => !!matchIds && matchIds.has(node.id));
    ref.edgeSel.classed("dimmed", (link: SimLink) => {
      const sourceId = typeof link.source === "object" ? link.source.id : link.source;
      const targetId = typeof link.target === "object" ? link.target.id : link.target;
      // An edge is only meaningful when both endpoints are still visible.
      const endpointHidden = Boolean(nodeDimmed.get(sourceId)) || Boolean(nodeDimmed.get(targetId));
      return !typePicked(link.type) || endpointHidden;
    });
  }, [matchIds, signature, visibleEdgeTypes, visibleLabels]);

  // Dimming alone leaves the surviving nodes as a small island in a mostly
  // greyed-out canvas. Zoom to what survived the filter, and zoom back out
  // when the filter is cleared, so narrowing actually reads as narrowing.
  useEffect(() => {
    const ref = simRef.current;
    if (!ref.zoomBehavior || !ref.svgSel || !interactive) return;
    const filtered = Boolean(visibleLabels || visibleEdgeTypes || matchIds);
    if (!filtered) return; // keep the current view
    // Mirror the filter effect's "kept" rule: a node survives when its label
    // is picked, or when an edge type it participates in is picked.
    const pulledIn = new Set<string>();
    if (visibleEdgeTypes) {
      for (const link of ref.simLinks) {
        if (!visibleEdgeTypes.has(link.type)) continue;
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        pulledIn.add(sourceId);
        pulledIn.add(targetId);
      }
    }
    const survivors: Array<[number, number]> = [];
    for (const node of ref.simNodes) {
      if (typeof node.x !== "number" || typeof node.y !== "number") continue;
      const byLabel = visibleLabels ? visibleLabels.has(node.label) : false;
      const kept = byLabel || pulledIn.has(node.id);
      const searchHidden = matchIds ? !matchIds.has(node.id) : false;
      if (!kept || searchHidden) continue;
      survivors.push([node.x, node.y]);
    }
    // Everything filtered out: keep the current view rather than fitting to nothing.
    if (survivors.length < 2) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of survivors) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const bboxW = (maxX - minX) || 1;
    const bboxH = (maxY - minY) || 1;
    const padding = 60;
    const scale = Math.min(
      (ref.width - padding * 2) / (bboxW + ref.nodeSize * 2),
      (ref.height - padding * 2) / (bboxH + ref.nodeSize * 2),
      1.5,
    );
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const transform = zoomIdentity
      .translate(ref.width / 2 - centerX * scale, ref.height / 2 - centerY * scale)
      .scale(scale);
    ref.svgSel.transition().duration(260).call(ref.zoomBehavior.transform, transform);
  }, [interactive, matchIds, signature, visibleEdgeTypes, visibleLabels]);

  // Highlight the selected node, and on subsequent selections (after the
  // initial layout fit) pan/zoom the canvas so the node is centered and
  // visible. The first selection after a graph rebuild is skipped so it
  // doesn't fight the freshly-run layout fit; manual taps land on already
  // visible nodes and the pan is a gentle re-center rather than a jump.
  useEffect(() => {
    const ref = simRef.current;
    if (!ref.nodeSel) return;
    ref.nodeSel.classed("selected-node", (node: SimNode) => node.id === selectedId);
    if (!selectedId || !ref.zoomBehavior || !ref.svgSel || !interactive) return;
    const target = ref.simNodes.find((node) => node.id === selectedId);
    if (!target || typeof target.x !== "number" || typeof target.y !== "number") return;
    if (!didInitialSelectionRef.current) {
      didInitialSelectionRef.current = true;
      return;
    }
    // Don't zoom out below a comfortable reading level when the user has
    // panned far out; bump the zoom floor rather than forcing a fixed zoom.
    // d3-zoom stores its current transform on the bound element as `__zoom`.
    const svgNode = ref.svgSel.node() as (SVGSVGElement & { __zoom?: ZoomTransform }) | null;
    const currentZoom = svgNode?.__zoom?.k ?? 1;
    const targetZoom = Math.max(currentZoom, 0.8);
    const transform = zoomIdentity
      .translate(ref.width / 2 - target.x * targetZoom, ref.height / 2 - target.y * targetZoom)
      .scale(targetZoom);
    ref.svgSel.transition().duration(260).call(ref.zoomBehavior.transform, transform);
  }, [interactive, selectedId, signature]);

  return (
    <div className={interactive ? "memory-canvas" : "memory-canvas memory-canvas-thumb"} ref={hostRef}>
      <svg ref={svgRef} />
    </div>
  );
}