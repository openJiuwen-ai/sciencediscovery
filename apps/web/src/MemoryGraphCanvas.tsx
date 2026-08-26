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

import type { MemoryGraphEdgeType, MemoryGraphNodeLabel, MemorySubgraph } from "@sciencediscovery/schema";

/**
 * One colour per node label, drawn from a vivid, high-saturation palette
 * (each hue is pushed bright so the eight categories read at a glance even
 * on a dense graph). Kept in a plain map (not CSS variables) because SVG
 * paints inline and we want the same predictable palette across renders.
 * The palette is purely visual: it does not change any data semantics,
 * only the rendered swatch.
 */
export const NODE_COLORS: Record<MemoryGraphNodeLabel, string> = {
  ResearchGoal: "#F6114A", // vivid red
  Task: "#0AA0BF",         // bright teal (subagent scope)
  ToolCall: "#FCA00C",     // amber (code_execution / literature_search / …)
  Paper: "#F36E98",        // rose pink
  Evidence: "#78B177",     // sage
  Claim: "#F05006",        // burnt orange
  Code: "#9862A2",         // amethyst purple
  Artifact: "#25998F",     // teal green
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
  extracts: "#94a3b8",
  supports: "#94a3b8",
  stated_in: "#94a3b8",
  supersedes: "#94a3b8",
  input: "#94a3b8",
  contains: "#94a3b8",
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
  // Aggregate virtual node (需求3): a folded scope with >1 product of one
  // kind collapses into one ``_group:<scopeId>:<Kind>`` node. Render it as the
  // plural kind name ("Artifacts"/"Papers") so it reads as a stack to expand.
  if (extra.aggregated === true || node.id.startsWith("_group:")) {
    const kind = typeof extra.kind === "string" ? extra.kind : node.label;
    return kind === "Artifact" ? "Artifacts" : kind === "Paper" ? "Papers" : kind;
  }
  const name = node.label === "Artifact" ? pick("path") ?? pick("artifact_id")
    : node.label === "Code" ? pick("tool") ?? pick("code_id")
    : node.label === "Task" ? pick("objective") ?? pick("task_type") ?? pick("task_id")
    : node.label === "ToolCall" ? pick("task_type") ?? pick("tool_type") ?? pick("task_id")
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

/**
 * A folded-state surrogate edge (get_subgraph synthesises one scope→product
 * pair per terminal product). `extra.surrogate === true` is the marker the
 * render pass keys its dashed/light/no-label branch on; `extra.via_child` is
 * the responsible child hop a click jumps to (总方案 §2.2).
 */
export function isSurrogateEdge(edge: { extra?: Record<string, unknown> }): boolean {
  return edge.extra?.surrogate === true;
}

/**
 * A subagent scope is a real ``Task`` node whose `extra.task_type === "subagent"`
 * (the scope carries the ``Task`` label; its child executions carry the
 * ``ToolCall`` label — distinguish a scope by task_type, since the two labels
 * are separate now but the scope is still identified by task_type='subagent'
 * so the predicate stays label-agnostic). The canvas renders scopes with a
 * double ring + ▸N badge so they read as expandable.
 */
export function isScopeNode(node: { extra?: Record<string, unknown>; id: string }): boolean {
  return node.extra?.task_type === "subagent";
}

/**
 * A child of an expanded scope carries `extra.parent_subtask_id`, or its
 * task_id embeds `:exec:` (PR1's child task_id shape
 * `subtask:subagent:<id>:exec:<execId>`). Smaller/lighter on the canvas so
 * the scope↔child hierarchy reads at a glance.
 */
export function isChildNode(node: { extra?: Record<string, unknown>; id: string }): boolean {
  return Boolean(node.extra?.parent_subtask_id) || node.id.includes(":exec:");
}

/**
 * An aggregate virtual node (需求3): a folded scope with >1 product of one
 * kind (Artifact/Paper) collapses into ONE ``_group:<scopeId>:<Kind>`` node
 * synthesised by the backend's ``get_subgraph``. The id prefix + the
 * ``extra.aggregated`` marker both flag it so a renderer can draw it as a
 * stack ("Artifacts"/"Papers") and wire a separate click to expand its
 * members (independent of expanding the owning scope).
 */
export function isAggregateNode(node: { extra?: Record<string, unknown>; id: string }): boolean {
  if (node.extra?.aggregated === true) return true;
  return typeof node.id === "string" && node.id.startsWith("_group:");
}

/**
 * Recover the owning scope's task_id from an aggregate virtual node id
 * (``_group:<scopeId>:<Kind>``). The scope id may itself contain colons (task
 * ids are free-form), so split on the *first* and *last* colon only. Returns
 * ``undefined`` when the id is not an aggregate id.
 */
export function aggregateOwnerScope(groupId: string): string | undefined {
  if (!groupId.startsWith("_group:")) return undefined;
  const body = groupId.slice("_group:".length);
  if (!body.includes(":")) return undefined;
  const scope = body.slice(0, body.lastIndexOf(":"));
  return scope || undefined;
}

/**
 * Resolve a child node's owning scope id — ``extra.parent_subtask_id`` when
 * PR1 wrote it, otherwise the prefix before ``:exec:`` in the task_id. Used
 * by the layout's incremental seed so a newly-expanded child appears near its
 * parent scope's settled position instead of at a random ring slot. Returns
 * ``undefined`` when the node is not a scope child.
 */
function childParentScopeId(id: string, extra?: Record<string, unknown>): string | undefined {
  const explicit = extra?.parent_subtask_id;
  if (typeof explicit === "string" && explicit) return explicit;
  const idx = id.indexOf(":exec:");
  return idx > 0 ? id.slice(0, idx) : undefined;
}

/**
 * A terminal-but-cancelled SubTask/Code (`extra.status === "cancelled"`,
 * PR1's aborted subagent). Drawn grey + solid-outline, distinct from pending
 * (dashed) and completed (borderless full-fill).
 */
export function isCancelledNode(node: { extra?: Record<string, unknown> }): boolean {
  const status = node.extra?.status;
  return typeof status === "string" && status.toLowerCase() === "cancelled";
}

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
  // A subagent scope (extra.task_type === "subagent"): a real SubTask node
  // that owns a child subtree reachable via `contains` edges. A *folded*
  // scope (its child subtree not merged in) is rendered as a stack — the
  // solid disc with 1-2 offset translucent "ghost" discs behind it — so it
  // reads as "holds several nodes inside" without a numeric badge. An
  // *expanded* scope renders as a single disc (stack hidden). Clicking a
  // scope toggles its expansion AND selects it (§3.3).
  isScope?: boolean;
  childCount?: number;
  // True when this scope is folded (isScope && !expanded). Drives the stack
  // ghost discs' visibility (shown folded, hidden expanded) and the hover
  // hint ("单击展开节点" vs "单击收起节点").
  folded?: boolean;
  // A child of an expanded scope (extra.parent_subtask_id set, or task_id
  // carries ":exec:"). Rendered slightly smaller / lighter so the scope↔child
  // hierarchy reads at a glance (doc16 §2.5).
  isChild?: boolean;
  // The owning scope's id, resolved at build time for child nodes (undefined
  // for non-children). The incremental layout seed uses it to place a newly
  // expanded child near its parent scope's settled position.
  parentScopeId?: string;
  // A scope/Code that finished by cancellation (extra.status === "cancelled"):
  // grey solid outline + greyed fill, distinct from pending (dashed) and
  // completed (solid full-fill). PR1 writes cancelled on aborted subagents.
  cancelled?: boolean;
  // True when this scope's children + real edges are merged into the current
  // graph (expandedScopes in the explorer). A folded scope's stack shows;
  // an expanded scope's stack hides so an open scope reads as "open".
  expanded?: boolean;
  // An aggregate virtual node (需求3): a folded scope with >1 product of one
  // kind collapses into ONE ``_group:<scopeId>:<Kind>`` node. Rendered as a
  // dashed double-stacked disc with the plural kind name ("Artifacts"/
  // "Papers") + a "▸ N" badge so it reads as an expandable stack, distinct
  // from a scope (a scope owns a child subtree; an aggregate owns a flat list
  // of same-kind products). Clicking toggles its expansion (onToggleGroup),
  // independent of the owning scope's expand/collapse.
  isAggregate?: boolean;
  aggregateCount?: number;
  aggregateExpanded?: boolean;
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
  // Folded-state surrogate edges (get_subgraph synthesises one scope→product
  // edge per terminal product, carrying `extra.surrogate` + `extra.via_child`)
  // are drawn dashed/light with no label so the collapsed view reads "this
  // scope produced these products" without showing the child subtree. A click
  // on a surrogate jumps to the responsible child via `viaChild` (see §3.3).
  surrogate?: boolean;
  viaChild?: string;
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

  // Style only the *visible* edge line (``.memory-canvas-edge``), never the
  // transparent surrogate hit-line (``.memory-canvas-edge-hit``, inserted as
  // the group's first child). ``select("line")`` would match the hit-line
  // and recolour it slate here, turning the invisible hit area into a solid
  // slate stroke that reads as a real edge. Surrogates keep their own light
  // colour + dasharray set at create time; the adaptation only scales width +
  // opacity on them (the dasharray stays, so they still read as dashed).
  edgeSel.select("line.memory-canvas-edge")
    .attr("stroke-width", strokeWidth)
    .attr("opacity", edgeOpacity);
  edgeSel.select("line.memory-canvas-edge")
    .attr("stroke", (link: SimLink) => link.surrogate ? EDGE_COLOR_LIGHT : edgeColor);
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
  /** Scope task_ids currently expanded (children + real edges merged in).
   * The canvas marks these scopes' rings solid so an expanded scope reads as
   * "open" (▸ flipped to ▾). Pass the live set from the explorer's state. */
  expandedScopes?: ReadonlySet<string>;
  /** True per-scope child counts, built from the raw folded node set (the
   * full session read, children included). The "▸ N" badge reads this so the
   * count is stable across collapse/expand — counting visible ``contains``
   * edges would read 0 while collapsed (the fold hides the spine). Falls back
   * to the visible contains-edge count when absent (legacy callers). */
  scopeChildCounts?: ReadonlyMap<string, number>;
  /** Click on a scope node toggles its expansion rather than only selecting.
   * The explorer fetches getScopeExpansion, merges the child subtree, and
   * drops this scope's surrogate edges (§3.3). Falls back to onSelect when
   * unset (scopes behave as plain nodes — kept for the thumbnail/non-interactive
   * callers). */
  onToggleScope?: (scopeTaskId: string) => void;
  /** Aggregate virtual node ids currently expanded (member products merged in,
   * 需3). The canvas marks these aggregates' rings solid so an open aggregate
   * reads as "open". Pass the live set from the explorer's state. */
  expandedGroups?: ReadonlySet<string>;
  /** Click on an aggregate node (Artifacts/Papers) toggles its expansion
   * rather than only selecting — the explorer fetches getGroupExpansion,
   * merges the member products, and drops the virtual aggregate. Independent
   * of the owning scope's expand/collapse. Falls back to onSelect when unset. */
  onToggleGroup?: (groupId: string) => void;
  /** Click on a surrogate edge (scope→product) jumps to the responsible child
   * (extra.via_child): expand the owning scope + select that child. Falls
   * back to a no-op when unset so the thumbnail canvas stays inert. */
  onEdgeClick?: (edge: { surrogate: boolean; viaChild?: string; source: string; target: string; type: MemoryGraphEdgeType }) => void;
  /** Hover-hint text for a scope node's <title> tooltip. The explorer resolves
   * these from its i18n locale so the canvas stays a pure render layer.
   * ``expand`` shows when the scope is folded, ``collapse`` when expanded. */
  scopeHints?: { expand: string; collapse: string };
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
  // Persistent layers + helpers created once by the mount effect. The data
  // effect joins into these instead of rebuilding the SVG, so an
  // expand/collapse never tears the canvas down.
  zoomLayer: Selection<SVGGElement, unknown, null, undefined> | null;
  edgesLayer: Selection<SVGGElement, unknown, null, undefined> | null;
  nodesLayer: Selection<SVGGElement, unknown, null, undefined> | null;
  dragBehavior: ReturnType<typeof drag<SVGGElement, SimNode>> | null;
  fitAll: ((duration: number) => void) | undefined;
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
  expandedScopes,
  scopeChildCounts,
  onToggleScope,
  expandedGroups,
  onToggleGroup,
  onEdgeClick,
  scopeHints,
}: MemoryGraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // Mirror the toggle/edge-click callbacks into refs so the d3 click
  // handlers (bound once at build time) always call the latest closures
  // without rebinding on every poll-driven re-render.
  const onToggleScopeRef = useRef(onToggleScope);
  onToggleScopeRef.current = onToggleScope;
  const onToggleGroupRef = useRef(onToggleGroup);
  onToggleGroupRef.current = onToggleGroup;
  const onEdgeClickRef = useRef(onEdgeClick);
  onEdgeClickRef.current = onEdgeClick;
  // Mirror scopeHints into a ref so the data effect's update block can read
  // the latest tooltip strings without rebuilding the SVG on a locale change.
  const scopeHintsRef = useRef(scopeHints);
  scopeHintsRef.current = scopeHints;
  const simRef = useRef<SimRef>({
    simulation: null,
    simNodes: [],
    simLinks: [],
    nodeSel: null,
    edgeSel: null,
    zoomBehavior: null,
    svgSel: null,
    zoomLayer: null,
    edgesLayer: null,
    nodesLayer: null,
    dragBehavior: null,
    fitAll: undefined,
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

  // The live simulation + node array for the *current* data effect run. The
  // mount-once drag/click handlers read this ref so they always act on the
  // latest simulation without being rebound on every expand/collapse — the
  // handlers are bound once (mount effect) and the data effect just swaps the
  // ref's contents. Mirrors the onSelectRef/onToggleScopeRef pattern.
  const dataRef = useRef<{ simulation: Simulation<SimNode, SimLink> | null; simNodes: SimNode[]; simLinks: SimLink[] }>({
    simulation: null,
    simNodes: [],
    simLinks: [],
  });

  // --- Mount-once scaffold: defs, zoom layer, edges/nodes layers, zoom +
  // drag/click handlers, resize observer. Runs once so an expand/collapse
  // (which only changes node/edge *data*, not the scaffold) never tears the
  // SVG down and back up — that teardown was the visual "jitter" on every
  // click. Layers persist on simRef for the data effect to join into. ---
  useEffect(() => {
    const host = hostRef.current;
    const svgEl = svgRef.current;
    if (!host || !svgEl) return;

    const width = host.clientWidth || 800;
    const height = host.clientHeight || 600;
    const nodeSize = interactive ? 23 : 6;

    const svgSel = select(svgEl);
    svgSel.selectAll("*").remove();

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

    const zoomLayer = svgSel.append("g").attr("class", "memory-canvas-zoom-layer");
    const edgesLayer = zoomLayer.append("g").attr("class", "memory-canvas-edges");
    const nodesLayer = zoomLayer.append("g").attr("class", "memory-canvas-nodes");

    let zoomBehavior: ReturnType<typeof zoom<SVGSVGElement, unknown>> | undefined;
    if (interactive) {
      zoomBehavior = zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.2, 2.5])
        .filter((event: Event) => {
          if (event.type === "wheel") return true;
          const target = event.target as Element | null;
          return !target?.closest(".memory-canvas-node");
        })
        .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
          zoomLayer.attr("transform", event.transform.toString());
          const ref = simRef.current;
          if (ref.edgeSel) applyZoomAdaptation(event.transform.k, ref.edgeSel, interactive);
        });
      svgSel.call(zoomBehavior);
    } else {
      // Thumbnail: no zoom behaviour, just land the layer at origin so nodes
      // are visible. The data effect's fit path translates the layer.
      zoomLayer.attr("transform", "translate(0, 0)");
    }

    // The click handler reads dataRef so the *current* simNodes drive the
    // toggle — bound once here, never rebound on expand/collapse.
    //   - Non-scope nodes (ToolCall/Artifact/Paper/…): a single click selects
    //     immediately (zero latency). An aggregate (Artifacts/Papers) also
    //     toggles its group expansion on the same click.
    //   - A scope (Task, isScope): a SINGLE click selects after a ~250ms
    //     double-click window; a DOUBLE click toggles expansion (and selects).
    //     The window is the browser's unavoidable click/dblclick disambiguation
    //     — a dblclick is two clicks, so the first click's select must wait to
    //     see whether a second lands. The hover <title> hints "双击展开/收起节点".
    // A pending single-click select is kept here so a second click cancels it.
    let pendingScopeSelect: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
    const DBLCLICK_WINDOW_MS = 250;
    const fireSelect = (id: string) => { onSelectRef.current?.(id); };
    nodesLayer.on("click", (event: MouseEvent) => {
      const g = (event.target as Element | null)?.closest(".memory-canvas-node") as SVGGElement | null;
      if (!g) return;
      const node = select(g).datum() as SimNode;
      event.stopPropagation();
      // Aggregate expansion (需求3) is independent of scope expansion — a
      // click on an Artifacts/Papers node unpacks that aggregate's members
      // only, NOT the owning scope's child subtree. Selects immediately too.
      if (node.isAggregate && onToggleGroupRef.current) {
        if (pendingScopeSelect) { clearTimeout(pendingScopeSelect.timer); pendingScopeSelect = null; }
        fireSelect(node.id);
        onToggleGroupRef.current(node.id);
        return;
      }
      if (node.isScope) {
        // A scope uses dblclick to toggle. If a single-click select is
        // already pending for THIS scope, this is the second click → cancel
        // the pending select, toggle expansion, and select now (the dblclick
        // is confirmed, no need to keep waiting).
        if (pendingScopeSelect && pendingScopeSelect.id === node.id) {
          clearTimeout(pendingScopeSelect.timer);
          pendingScopeSelect = null;
          fireSelect(node.id);
          onToggleScopeRef.current?.(node.id);
          return;
        }
        // A click on a *different* scope while another's select is pending:
        // commit the previous pending select immediately, then start this
        // scope's dblclick window.
        if (pendingScopeSelect) { clearTimeout(pendingScopeSelect.timer); fireSelect(pendingScopeSelect.id); pendingScopeSelect = null; }
        const id = node.id;
        pendingScopeSelect = {
          id,
          timer: setTimeout(() => {
            // Window expired with no second click → a real single click.
            pendingScopeSelect = null;
            fireSelect(id);
          }, DBLCLICK_WINDOW_MS),
        };
        return;
      }
      // Plain node: select immediately. Cancel any pending scope select so a
      // quick scope-click-then-elsewhere does not leave a stale select firing.
      if (pendingScopeSelect) { clearTimeout(pendingScopeSelect.timer); fireSelect(pendingScopeSelect.id); pendingScopeSelect = null; }
      fireSelect(node.id);
    });
    // Drag: read the current simulation via dataRef so a drag started after a
    // recent expand controls the latest sim (the old sim is stopped + swapped).
    if (interactive) {
      const dragBehavior = drag<SVGGElement, SimNode>()
        .filter((event: Event) => !(event as MouseEvent).button)
        .on("start", (event: D3DragEvent<SVGGElement, SimNode, SimNode>, node: SimNode) => {
          const sim = dataRef.current.simulation;
          if (!sim) return;
          if (!event.active) sim.alphaTarget(0.3).restart();
          for (const other of dataRef.current.simNodes) {
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
        .on("end", (event: D3DragEvent<SVGGElement, SimNode, SimNode>) => {
          const sim = dataRef.current.simulation;
          if (sim && !event.active) sim.alphaTarget(0);
        });
      // Delegate drag binding to the data effect's nodeSel (the join target),
      // but the behaviour object is owned here so it survives rebuilds.
      simRef.current.dragBehavior = dragBehavior;
    }

    // Re-fit whenever the box actually changes size. Lives here (mount-once)
    // so the observer isn't torn down/recreated on every expand.
    let observer: ResizeObserver | undefined;
    const fitAllFromRef = (duration: number) => {
      const ref = simRef.current;
      if (!ref.zoomBehavior || !ref.svgSel) {
        zoomLayer.attr("transform", "translate(0, 0)");
        return;
      }
      const positions: Array<[number, number]> = [];
      for (const node of dataRef.current.simNodes) {
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
        (ref.width - padding * 2) / (bboxW + nodeSize * 2),
        (ref.height - padding * 2) / (bboxH + nodeSize * 2),
        interactive ? 1.5 : 1.1,
      );
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const transform = zoomIdentity
        .translate(ref.width / 2 - centerX * scale, ref.height / 2 - centerY * scale)
        .scale(scale);
      ref.svgSel.transition().duration(duration).call(ref.zoomBehavior.transform, transform);
    };
    simRef.current.fitAll = fitAllFromRef;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        const ref = simRef.current;
        if (!ref.width || !ref.height) return;
        ref.width = host.clientWidth || ref.width;
        ref.height = host.clientHeight || ref.height;
        if (interactive) fitAllFromRef(160);
      });
      observer.observe(host);
    }

    simRef.current = {
      ...simRef.current,
      svgSel,
      zoomLayer,
      edgesLayer,
      nodesLayer,
      edgeSel: null,
      nodeSel: null,
      zoomBehavior: zoomBehavior ?? null,
      width,
      height,
      nodeSize,
      simulation: null,
      simNodes: [],
      simLinks: [],
      positionsReady: false,
    };

    return () => {
      observer?.disconnect();
      simRef.current.dragBehavior = null;
      simRef.current.fitAll = undefined;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  // --- Data effect: join nodes/edges into the persistent layers, build the
  // simulation, preserve positions across rebuilds. Runs on signature change
  // (a scope expand/collapse changes the merged graph's content) but never
  // tears the SVG down — the layers survive, so only enter/update/exit
  // touches the DOM and the user's pan/zoom stays put. ---
  useEffect(() => {
    const host = hostRef.current;
    const svgEl = svgRef.current;
    const ref = simRef.current;
    if (!host || !svgEl || !ref.edgesLayer || !ref.nodesLayer) return;

    // Whether the previous build had a settled layout — i.e. this is an
    // incremental rebuild (a scope was just expanded/collapsed) rather than a
    // fresh canvas. An incremental rebuild preserves existing node positions
    // and only nudges the sim with a low alpha so the graph does not fling
    // itself around on every click; a fresh build seeds positions on a circle
    // and fits the whole canvas once the sim settles.
    const prev = simRef.current;
    const prevPositions = new Map<string, SimNode>();
    if (prev?.simNodes) for (const n of prev.simNodes) prevPositions.set(n.id, n);

    const width = host.clientWidth || 800;
    const height = host.clientHeight || 600;
    // Radius (the previous Cytoscape code used diameter for `width`/`height`).
    const nodeSize = interactive ? 23 : 6;
    const done = DONE_STATUSES;

    const displayNames = graphNodeDisplayNames(subgraph.nodes);
    const known = new Set(subgraph.nodes.map((node) => node.id));
    // Count contains edges per source so a scope node can advertise how many
    // children it owns (the "▸ N" badge). Folded subgraphs carry the contains
    // spine (PR2), so this counts real children even before expansion.
    const containsOut = new Map<string, number>();
    for (const edge of subgraph.edges) {
      if (edge.type === "contains" && known.has(edge.source)) {
        containsOut.set(edge.source, (containsOut.get(edge.source) ?? 0) + 1);
      }
    }
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
      // A subagent scope is a real ``Task`` whose extra.task_type ===
      // "subagent" (scope carries the ``Task`` label; its child executions
      // carry the ``ToolCall`` label — distinguish a scope by task_type). A
      // child hangs off a scope via contains (first child only — 需求1) or is
      // reached via the scope-internal next chain: it carries
      // extra.parent_subtask_id, or its task_id embeds ":exec:". cancelled is a
      // terminal status PR1 writes on aborted subagents — neither pending
      // (unfinished) nor completed (succeeded/…), so it gets its own branch.
      const isScope = isScopeNode(node);
      const isChild = isChildNode(node);
      const cancelled = isCancelledNode(node);
      const expanded = isScope ? expandedScopes?.has(node.id) === true : false;
      // A folded scope = scope not currently expanded. Drives the stack ghost
      // discs (shown folded) and the hover hint ("单击展开节点"/"单击收起节点").
      const folded = isScope ? !expanded : false;
      // Aggregate virtual node (需求3): a folded scope's >1 same-kind products
      // collapsed into one ``_group:…`` node. Read the member count from
      // ``extra.count`` (set by the backend synthesis) so the "▸ N" badge shows
      // how many products are inside. aggregateExpanded mirrors expandedGroups
      // so the badge flips ▸→▾ when the aggregate is open.
      const isAggregate = isAggregateNode(node);
      const aggregateCount = typeof node.extra?.count === "number" ? node.extra.count : 0;
      const aggregateExpanded = isAggregate ? expandedGroups?.has(node.id) === true : false;
      // Resolve this child's owning scope up front so the incremental seed
      // (below) can place a newly-expanded child near its parent scope's
      // settled position without re-parsing the id/extra at seed time.
      const parentScopeId = isChild ? childParentScopeId(node.id, node.extra) : undefined;
      return {
        id: node.id,
        label: node.label,
        name: displayNames.get(node.id) ?? graphNodeName(node),
        pending,
        collapsed,
        collapsedCount,
        isScope,
        // Prefer the pre-computed true child count from the raw folded node
        // set (stable across collapse/expand) over the visible contains-edge
        // count, which reads 0 while the scope is collapsed (the fold hides
        // the spine). Falls back to the visible-edge count for callers that
        // don't supply scopeChildCounts (e.g. the chain mini-view).
        childCount: isScope ? (scopeChildCounts?.get(node.id) ?? containsOut.get(node.id) ?? 0) : 0,
        folded,
        isChild,
        parentScopeId,
        cancelled,
        expanded,
        isAggregate,
        aggregateCount,
        aggregateExpanded,
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
        // Carry the surrogate marker + via_child hop so the render pass can
        // dash the line and a click can jump to the responsible child (§3.3).
        surrogate: isSurrogateEdge(edge),
        viaChild: typeof edge.extra?.via_child === "string" ? edge.extra.via_child : undefined,
      }));

    const componentCenters = computeComponentCenters(
      simNodes.map((node) => node.id),
      simLinks,
      width,
      height,
    );

    // A rebuild is "incremental" only when the previous layout settled *and*
    // at least one current node already had a position to keep — i.e. there
    // is real overlap with the previous node set. A brand-new graph (a
    // different session, a fresh chain view) shares no ids with the previous
    // set, so it must go through a full-alpha settle + fit instead of the
    // low-alpha nudge an incremental toggle uses. This keeps scope
    // expand/collapse gentle while not starving a genuinely new graph of
    // layout energy.
    const isIncremental = prev?.positionsReady === true
      && simNodes.some((node) => prevPositions.has(node.id));

    // Seed initial positions. Survivors (already settled on a previous run)
    // keep their x/y/vx/vy; new nodes are seeded by BFS layer so a freshly
    // expanded child subtree grows *out of* its parent scope in connected
    // layers (children ring the scope, their products ring each child) rather
    // than landing in one clump on a single diagonal ray. The previous seed
    // stacked every new child at parent + (off, off) on the *same* y=x ray,
    // and a too-cold incremental alpha (0.3) couldn't separate them — that
    // is the "clump" on expand.
    const seeded = new Set<string>();
    const posById = new Map<string, { x: number; y: number }>();
    // 1. Survivors first — reuse their settled position + velocity.
    simNodes.forEach((node) => {
      const prev = prevPositions.get(node.id);
      if (prev && typeof prev.x === "number" && typeof prev.y === "number") {
        node.x = prev.x;
        node.y = prev.y;
        node.vx = prev.vx;
        node.vy = prev.vy;
        seeded.add(node.id);
        posById.set(node.id, { x: prev.x, y: prev.y });
      }
    });
    // 2. New nodes by BFS along the (filtered) edges, layer by layer. Each
    //    new node seeds on a ring around its already-placed source so
    //    children ring their scope, products ring each child, etc. The ring
    //    radius EQUALS the link force's equilibrium distance so the link
    //    spring is ~0 at the seed (no long pull-in). An earlier version seeded
    //    at 2.2x equilibrium and started at alpha 0.8: the long spring + hot
    //    alpha overshot and the new subtree flung far then snapped back into a
    //    clump. Seeding at equilibrium + a low incremental alpha means the sim
    //    has no long-distance work to do, so nothing flings and nothing
    //    snaps back.
    //
    //    On an incremental expand the survivors are pinned (fx/fy below) so
    //    the collide force cannot shove them aside. To avoid overlap we bias
    //    each new child's seed angle onto the half-arc of its parent's ring
    //    that faces away from the parent's nearest surviving neighbour: the
    //    new subtree grows into open canvas rather than into the existing
    //    graph. Products (next BFS layer) inherit their child's outward
    //    direction the same way.
    const adjacency = new Map<string, string[]>();
    for (const link of simLinks) {
      const s = typeof link.source === "object" ? link.source.id : link.source;
      const t = typeof link.target === "object" ? link.target.id : link.target;
      const arr = adjacency.get(s);
      if (arr) arr.push(t); else adjacency.set(s, [t]);
    }
    const ringRadius = nodeSize * 4.5;
    // Direction from a parent position toward open canvas: the vector from
    // the parent's nearest surviving neighbour back to the parent. When the
    // parent has no surviving neighbour (fresh graph, or the parent itself
    // is brand-new) fall back to a deterministic angle so the seed is stable
    // across polls. `selfKey` lets the nearest-search skip the parent itself.
    const outwardAngle = (parentPos: { x: number; y: number }, selfKey: string): number => {
      let nearest: { x: number; y: number } | null = null;
      let nearestDist = Infinity;
      for (const [id, p] of posById) {
        if (id === selfKey) continue;
        const dx = p.x - parentPos.x;
        const dy = p.y - parentPos.y;
        const d = dx * dx + dy * dy;
        if (d < nearestDist) { nearestDist = d; nearest = p; }
      }
      if (!nearest) return -Math.PI / 4;
      return Math.atan2(parentPos.y - nearest.y, parentPos.x - nearest.x);
    };
    let frontier = [...seeded];
    while (frontier.length > 0) {
      const nextFrontier: string[] = [];
      for (const parentId of frontier) {
        const parentPos = posById.get(parentId);
        if (!parentPos) continue;
        const children = (adjacency.get(parentId) ?? []).filter((id) => !seeded.has(id));
        if (!children.length) continue;
        // Spread children across a half-arc (pi wide) centred on the outward
        // direction so they fan into open canvas. A full 2pi ring would land
        // half of them on top of the existing graph.
        const baseAngle = outwardAngle(parentPos, parentId);
        const halfArc = Math.PI / 2;
        children.forEach((childId, i) => {
          const node = simNodes.find((n) => n.id === childId);
          if (!node) return;
          const t = children.length === 1 ? 0.5 : i / (children.length - 1);
          const angle = baseAngle - halfArc + t * (2 * halfArc);
          node.x = parentPos.x + Math.cos(angle) * ringRadius;
          node.y = parentPos.y + Math.sin(angle) * ringRadius;
          node.vx = 0;
          node.vy = 0;
          seeded.add(childId);
          posById.set(childId, { x: node.x ?? 0, y: node.y ?? 0 });
          nextFrontier.push(childId);
        });
      }
      frontier = nextFrontier;
    }
    // 3. Any remaining orphans (no edge to a placed node, e.g. a fresh graph)
    //    fall back to the usual seed ring around the canvas centre.
    simNodes.forEach((node, index) => {
      if (seeded.has(node.id)) return;
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
      .force("collide", forceCollide<SimNode>().radius(nodeSize + 8))
      .force("x", forceX<SimNode>((node: SimNode) => componentCenters.get(node.id)?.cx ?? width / 2).strength(0.05))
      .force("y", forceY<SimNode>((node: SimNode) => componentCenters.get(node.id)?.cy ?? height / 2).strength(0.05))
      // A fresh canvas starts at full alpha so the layout finds a settled
      // shape. An incremental rebuild (a scope expanded/collapsed) pins the
      // surviving nodes (fx/fy below) and starts at a low alpha (0.3): the
      // new child subtree is seeded at the link force's equilibrium distance
      // on the outward half-arc, so the sim has almost no long-distance work
      // to do. A higher alpha overshot the spring (seed-at-2.2x + 0.8 flung
      // far then snapped back into a clump). Low alpha + equilibrium seed =
      // the subtree settles in place with no fling, no snap-back, no jitter.
      // Survivors stay pinned for the whole sim so they never drift.
      .alpha(isIncremental ? 0.3 : 1)
      // Stronger decay than the d3 default so layout settles within a couple
      // of seconds rather than the long, dreamy tail the default produces.
      .alphaDecay(0.05);

    // Keep the mount-once drag handler pointed at the latest sim. The drag
    // behaviour was bound in the mount effect and survives rebuilds; only
    // the simulation it drives changes.
    dataRef.current = { simulation, simNodes, simLinks };

    // --- Edges: join into the persistent edges layer. enter creates the line
    // + label + hit-line; update re-applies the stroke/dash/marker (an edge
    // can flip surrogate↔real when its scope toggles) and the label text;
    // exit removes. The layer itself is never torn down. ---
    const edgeSel = ref.edgesLayer.selectAll<SVGGElement, SimLink>("g")
      .data(simLinks, (link: SimLink) => link.id)
      .join(
        (enter: Selection<EnterElement, SimLink, SVGGElement, undefined>) => {
          const g = enter.append("g").attr("class", "memory-canvas-edge-group");
          g.append("line")
            .attr("class", "memory-canvas-edge")
            .attr("data-id", (link: SimLink) => link.id)
            .attr("stroke", (link: SimLink) => link.surrogate ? EDGE_COLOR_LIGHT : (EDGE_COLORS[link.type] ?? EDGE_COLOR_LIGHT))
            .attr("stroke-width", interactive ? 1.8 : 1.0)
            .attr("stroke-dasharray", (link: SimLink) => link.surrogate ? "4 3" : null)
            .attr("marker-end", (link: SimLink) => link.surrogate ? null : `url(#memory-canvas-arrow-${link.type})`);
          g.append("text")
            .attr("class", "memory-canvas-edge-label")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", 7)
            .attr("font-weight", 600)
            .attr("fill", "#475569");
          if (interactive) {
            // Widened transparent hit-line for surrogate edges: the visible
            // line is pointer-events:none, so clicks land on this instead.
            g.filter((link: SimLink) => link.surrogate === true)
              .insert("line", ":first-child")
              .attr("class", "memory-canvas-edge-hit")
              .attr("stroke", "transparent")
              .attr("stroke-width", 12)
              .style("pointer-events", "all")
              .style("cursor", "pointer")
              .on("click", function (event: MouseEvent, link: SimLink) {
                event.stopPropagation();
                onEdgeClickRef.current?.({
                  surrogate: true,
                  viaChild: link.viaChild,
                  source: typeof link.source === "object" ? link.source.id : link.source,
                  target: typeof link.target === "object" ? link.target.id : link.target,
                  type: link.type,
                });
              });
          }
          return g;
        },
        (update: Selection<SVGGElement, SimLink, SVGGElement, unknown>) => update,
      );

    // Re-apply per-edge dynamic attrs on enter+update (a toggle can flip an
    // edge's surrogate flag, so the stroke/dash/marker/label must follow).
    edgeSel.select("line.memory-canvas-edge")
      .attr("stroke", (link: SimLink) => link.surrogate ? EDGE_COLOR_LIGHT : (EDGE_COLORS[link.type] ?? EDGE_COLOR_LIGHT))
      .attr("stroke-dasharray", (link: SimLink) => link.surrogate ? "4 3" : null)
      .attr("marker-end", (link: SimLink) => link.surrogate ? null : `url(#memory-canvas-arrow-${link.type})`);
    edgeSel.select("text.memory-canvas-edge-label")
      .text((link: SimLink) => link.surrogate ? "" : link.type)
      .attr("opacity", (link: SimLink) => link.surrogate ? 0 : 1);

    // --- Nodes: join into the persistent nodes layer. enter builds the full
    // node (halo, disc, scope ring, label, badge); update re-applies the
    // dynamic bits whose value can change across a toggle (the scope badge
    // text ▸/▾ + count, the disc stroke/fill for status changes); exit
    // removes. ---
    const nodeSel = ref.nodesLayer.selectAll<SVGGElement, SimNode>("g")
      .data(simNodes, (node: SimNode) => node.id)
      .join(
        (enter: Selection<EnterElement, SimNode, SVGGElement, undefined>) => {
          const g = enter.append("g").attr("class", "memory-canvas-node");

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

          // A folded subagent scope reads as "holds several nodes inside" by
          // its blue ring + the hover hint alone — no stack ghost discs behind
          // it (the earlier translucent offset circles read as stray halos).
          g.append("circle")
            .attr("r", nodeSize)
            .attr("stroke", (node: SimNode) => {
              if (node.collapsed) return "#64748b";
              if (node.isScope) return "#3b82f6";
              if (node.isAggregate) return "#d97706";
              if (node.cancelled) return "#94a3b8";
              return node.pending ? (NODE_COLORS[node.label] ?? "#64748b") : "none";
            })
            .attr("stroke-width", (node: SimNode) => {
              if (node.collapsed) return interactive ? 2 : 1.4;
              if (node.isScope) return interactive ? 2.5 : 1.6;
              if (node.isAggregate) return interactive ? 2.5 : 1.6;
              if (node.cancelled) return interactive ? 2 : 1.4;
              return node.pending ? (interactive ? 2.5 : 1.6) : 0;
            })
            .attr("fill", (node: SimNode) => {
              if (node.collapsed) return "#e2e8f0";
              if (node.cancelled) return "#cbd5e1";
              if (node.isAggregate) return "#fbbf24";
              return NODE_COLORS[node.label] ?? "#64748b";
            })
            .attr("fill-opacity", (node: SimNode) => {
              if (node.cancelled) return 0.5;
              if (node.isAggregate) return 0.35;
              return node.pending ? 0.18 : 1;
            })
            .attr("stroke-dasharray", (node: SimNode) => {
              if (node.collapsed) return interactive ? "4 3" : "2 2";
              if (node.isAggregate) return interactive ? "4 3" : "2 2";
              return node.pending ? "3 2" : null;
            });
          if (interactive) {
            // The outer ring marks an expandable *aggregate* virtual node
            // only (需求3): amber ring so it reads as a distinct "stack of
            // products" vs a scope's blue stack-of-children. A scope no longer
            // carries the ring or the ▸N badge — its folded state is shown by
            // the stack ghost discs above instead.
            g.filter((node: SimNode) => node.isAggregate === true).append("circle")
              .attr("class", "memory-canvas-scope-ring")
              .attr("r", nodeSize + 4)
              .attr("fill", "none")
              .attr("stroke", "#d97706")
              .attr("stroke-width", 1.2)
              .attr("stroke-opacity", 0.45)
              .attr("pointer-events", "none");
            g.append("text")
              .attr("class", "memory-canvas-node-label")
              .attr("text-anchor", "middle")
              .attr("dy", "0.35em")
              .attr("fill", (node: SimNode) => node.collapsed ? "#475569" : "#ffffff")
              .attr("font-size", (node: SimNode) => node.collapsed ? 9 : 8)
              .attr("font-weight", 600);
            // Native SVG <title> hover tooltip for a scope: "单击展开节点"
            // when folded, "单击收起节点" when expanded. Zero-JS, browser-
            // rendered. The text is re-bound in the update block below as the
            // toggle flips the folded state.
            g.filter((node: SimNode) => node.isScope === true).append("title")
              .attr("class", "memory-canvas-scope-title");
            // The ▸N badge is aggregate-only now (a scope's folded state is
            // shown by the stack discs, not a numeric badge).
            g.filter((node: SimNode) => node.isAggregate === true).append("text")
              .attr("class", "memory-canvas-scope-badge")
              .attr("text-anchor", "start")
              .attr("x", nodeSize * 0.7)
              .attr("y", -nodeSize * 0.7)
              .attr("font-size", 7)
              .attr("font-weight", 700)
              .attr("fill", "#d97706")
              .attr("pointer-events", "none");
            // Bind the mount-once drag behaviour (created in the mount
            // effect, survives rebuilds) to the new node group.
            if (ref.dragBehavior) g.call(ref.dragBehavior);
          }
          return g;
        },
        (update: Selection<SVGGElement, SimNode, SVGGElement, unknown>) => update,
      );

    // Re-apply dynamic node attrs on enter+update. The disc's stroke/fill
    // can change with status (pending→completed), the label with name. The
    // stack ghost discs' visibility flips with the scope's folded state
    // (shown folded, hidden expanded), and the <title> tooltip text flips
    // with it too. The scope badge is aggregate-only now.
    nodeSel.select("circle:not(.memory-canvas-selected-ring):not(.memory-canvas-scope-ring)")
      .attr("stroke", (node: SimNode) => {
        if (node.collapsed) return "#64748b";
        if (node.isScope) return "#3b82f6";
        if (node.isAggregate) return "#d97706";
        if (node.cancelled) return "#94a3b8";
        return node.pending ? (NODE_COLORS[node.label] ?? "#64748b") : "none";
      })
      .attr("stroke-width", (node: SimNode) => {
        if (node.collapsed) return interactive ? 2 : 1.4;
        if (node.isScope) return interactive ? 2.5 : 1.6;
        if (node.isAggregate) return interactive ? 2.5 : 1.6;
        if (node.cancelled) return interactive ? 2 : 1.4;
        return node.pending ? (interactive ? 2.5 : 1.6) : 0;
      })
      .attr("fill", (node: SimNode) => {
        if (node.collapsed) return "#e2e8f0";
        if (node.cancelled) return "#cbd5e1";
        if (node.isAggregate) return "#fbbf24";
        return NODE_COLORS[node.label] ?? "#64748b";
      })
      .attr("fill-opacity", (node: SimNode) => {
        if (node.cancelled) return 0.5;
        if (node.isAggregate) return 0.35;
        return node.pending ? 0.18 : 1;
      })
      .attr("stroke-dasharray", (node: SimNode) => {
        if (node.collapsed) return interactive ? "4 3" : "2 2";
        if (node.isAggregate) return interactive ? "4 3" : "2 2";
        return node.pending ? "3 2" : null;
      });
    nodeSel.select("text.memory-canvas-node-label")
      .text((node: SimNode) => {
        if (node.collapsed) return `+${node.collapsedCount}`;
        return truncateLabel(node.name, NODE_LABEL_MAX_CHARS);
      })
      .attr("fill", (node: SimNode) => node.collapsed ? "#475569" : "#ffffff")
      .attr("font-size", (node: SimNode) => node.collapsed ? 9 : 8);
    nodeSel.select("text.memory-canvas-scope-badge")
      .text((node: SimNode) => node.isAggregate
        ? `${node.aggregateExpanded ? "▾" : "▸"} ${node.aggregateCount ?? 0}`
        : "");
    // The aggregate's amber ring solidifies when expanded. A scope no longer
    // has a ring (its folded state is shown by the stack discs).
    nodeSel.select("circle.memory-canvas-scope-ring")
      .attr("stroke", "#d97706")
      .attr("stroke-opacity", (node: SimNode) =>
        node.isAggregate && node.aggregateExpanded ? 0.8 : 0.45);
    // Hover tooltip: only on a scope that actually has expandable children
    // (a subagent with no ToolCall children has nothing to expand — the hover
    // hint would be misleading). Folded → "双击展开节点"; expanded → "双击收起节点".
    nodeSel.select("title.memory-canvas-scope-title")
      .text((node: SimNode) => {
        if (!node.isScope) return null;
        if (!node.childCount) return null;
        const hints = scopeHintsRef.current;
        return node.folded ? (hints?.expand ?? "Click to expand") : (hints?.collapse ?? "Click to collapse");
      });

    // On an incremental rebuild, pin every surviving node to its settled
    // position (fx/fy) for the whole sim so the survivors never drift (the
    // previous jitter complaint). The new child subtree is seeded at the link
    // force's equilibrium distance on the outward half-arc, so a low alpha
    // (0.3) is enough to settle it in place — no long pull-in to overshoot.
    // The pins stay for the life of this sim; d3-force still cools alpha to
    // alphaMin and fires "end" (pinning freezes position, it does not keep
    // alpha alive), so the fit/end logic is unaffected. The next data effect
    // run re-pins from the fresh positions.
    if (isIncremental) {
      for (const node of simNodes) {
        if (prevPositions.has(node.id) && typeof node.x === "number" && typeof node.y === "number") {
          node.fx = node.x;
          node.fy = node.y;
        }
      }
    }

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
        // Update *every* line in the edge group — the visible
        // ``.memory-canvas-edge`` and, when present, the transparent
        // ``.memory-canvas-edge-hit`` that widens the surrogate's click
        // target.
        g.selectAll("line")
          .attr("x1", sourceEdge.x)
          .attr("y1", sourceEdge.y)
          .attr("x2", targetEdge.x)
          .attr("y2", targetEdge.y);
        g.select("text")
          .attr("transform", `translate(${labelX}, ${labelY}) rotate(${rot})`);
      });
      nodeSel.attr("transform", (node: SimNode) => `translate(${node.x ?? 0}, ${node.y ?? 0})`);
    });

    // Keep the initial zoom adaptation in step with the current edge set
    // (the mount effect ran it once on the empty layer).
    if (interactive) applyZoomAdaptation(1, edgeSel, interactive);

    simRef.current = {
      ...simRef.current,
      simulation,
      simNodes,
      simLinks,
      nodeSel,
      edgeSel,
      width,
      height,
      nodeSize,
      positionsReady: true,
    };

    // Fit once positions are settled, but ONLY on the first build (fresh
    // canvas or a content change that isn't a mere scope toggle). An
    // incremental expand/collapse keeps the user's pan/zoom so clicking a
    // scope doesn't yank the viewport back to "fit all".
    let didFit = false;
    const onEnd = () => {
      if (didFit) return;
      didFit = true;
      if (isIncremental) return;
      simRef.current.fitAll?.(260);
    };
    simulation.on("end", onEnd);
    const fitTimer = setTimeout(onEnd, 600);

    return () => {
      clearTimeout(fitTimer);
      simulation.stop();
      // Do NOT clear simNodes/positionsReady here — the next data effect run
      // reads them to preserve positions across an incremental rebuild.
      // Clearing them (the old cleanup) is what made positionsReady always
      // read false and forced a full re-layout on every click.
      simRef.current = {
        ...simRef.current,
        simulation: null,
        nodeSel: null,
        edgeSel: null,
        positionsReady: true,
      };
      dataRef.current.simulation = null;
    };
  }, [interactive, signature, expandedScopes]);

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