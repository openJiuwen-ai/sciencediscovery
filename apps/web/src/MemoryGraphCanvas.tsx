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
import { zoom, zoomIdentity, zoomTransform, type D3ZoomEvent } from "d3-zoom";

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
 * Every edge is the same colour (#818790). The relationship *type* is not
 * encoded by colour; each line carries an inline label on its midpoint, so
 * this swatch is purely the line + arrowhead colour (and the filter chip
 * swatch in `MemoryGraphExplorer` reads the keys without change).
 */
export const EDGE_COLORS: Record<MemoryGraphEdgeType, string> = {
  produces: "#818790",
  next: "#818790",
  extracts: "#818790",
  supports: "#818790",
  stated_in: "#818790",
  supersedes: "#818790",
  input: "#818790",
  contains: "#818790",
};

/**
 * Does `link` belong to the active chain highlight overlay? `chainEdgeKeys`
 * is a Set of `source>target:type` strings (built by Explorer from
 * `chain.graph.edges` filtered to the active button's edge-type slice). The
 * link's source/target may be a string id or the resolved SimNode object
 * (d3-force swaps it post-init), so normalise both sides to an id.
 */
function isChainEdge(
  link: { source: string | SimNode; target: string | SimNode; type: string },
  chainEdgeKeys?: ReadonlySet<string>,
): boolean {
  if (!chainEdgeKeys || chainEdgeKeys.size === 0) return false;
  const sourceId = typeof link.source === "string" ? link.source : link.source.id;
  const targetId = typeof link.target === "string" ? link.target : link.target.id;
  return chainEdgeKeys.has(`${sourceId}>${targetId}:${link.type}`);
}

/** Lighter tint of the edge grey used when the canvas is zoomed out, so edges
 *  recede. The low-scale band softens to this tint; the full grey takes over
 *  past t=0.5. */
const EDGE_COLOR_LIGHT = "#a8aeb6";

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
  // hint ("双击展开节点" vs "双击收起节点").
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
  // produces 成员折叠（规则3，「谁展开谁折叠」）：一个非 scope/aggregate
  // 节点是否曾亲手展开过子节点（expandedNodeMap 名下有非空子集）。驱动
  // tooltip 文案（折叠→"双击展开节点"，展开→"双击收起节点"），与 scope 的
  // folded/expanded 字段同语义但独立。dblclick handler 读 onToggleProduces。
  producesExpanded?: boolean;
  // 该节点**当前已折叠（不可见）的** produces/citation 相邻成员数（可见性
  // 感知，由 explorer 的 foldedProducesCounts 传入）。tooltip 用它判定节点
  // 是否可展开：=0 时不显示"双击展开节点"，避免对「相邻成员都已可见」
  // （如 sub_analysis2.txt Artifact）或「本就无 produces 成员」
  // （如 ResearchGoal）的节点给误导提示。投影后的边表会砍掉折叠成员的
  // produces 边，所以这个 count 必须由 explorer 传入而非现场数边。
  producesCount?: number;
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
 * A single shared off-DOM canvas used to measure text width for the
 * multi-line caption fit below. One 2D context, font set per measure.
 * Created lazily so SSR / non-DOM environments don't blow up.
 */
const measureCanvas: { ctx: CanvasRenderingContext2D | null } = { ctx: null };
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (!measureCanvas.ctx && typeof document !== "undefined") {
    const c = document.createElement("canvas");
    measureCanvas.ctx = c.getContext("2d");
  }
  return measureCanvas.ctx;
}

/**
 * Roughly the max text length a disc of `radius` can hold at `fontSize`,
 * as an area ratio. Used to pre-trim very long names before the per-line
 * word-fit so the fit loop stays cheap.
 */
function maxCaptionChars(radius: number, fontSize: number): number {
  return Math.floor((radius * radius * Math.PI) / (fontSize * fontSize));
}

/**
 * Width of `text` at `fontSize`, measured via the canvas context (we cache
 * inline with a plain object — the measure set is small and stable across
 * polls). Returns 0 when no canvas context is available (SSR), in which case
 * the caller falls back to char counts.
 */
const textWidthCache = new Map<string, number>();
function measureText(text: string, fontSize: number): number {
  const key = `${fontSize}|${text}`;
  const hit = textWidthCache.get(key);
  if (hit !== undefined) return hit;
  const ctx = getMeasureCtx();
  let w = 0;
  if (ctx) {
    ctx.font = `normal normal 600 ${fontSize}px/normal sans-serif`;
    w = ctx.measureText(text).width;
  } else {
    w = text.length * fontSize * 0.6; // rough fallback
  }
  if (textWidthCache.size > 10000) textWidthCache.clear();
  textWidthCache.set(key, w);
  return w;
}

/**
 * The width of a horizontal chord through a disc of `radius` at the vertical
 * offset `lineYFromCenter` (positive = below centre). At the centre the chord
 * is the full diameter; near the top/bottom it shrinks to 0. This is how the
 * fit knows how much text each line can hold without overflowing the circle:
 * line N sits at a y-offset, and the chord at that height bounds its width.
 * (Formula: `Math.sqrt(r² - d²) * 2`.)
 */
function chordWidth(radius: number, lineYFromCenter: number): number {
  const d = Math.abs(lineYFromCenter);
  if (d >= radius) return 0;
  return Math.sqrt(radius * radius - d * d) * 2;
}

/**
 * Fit a node's display name into its disc as up-to-N lines. We walk a FLAT
 * stream of characters, greedily filling each line up to its chord width
 * (chord-at-baseline shrinks near the disc's top/bottom). Spaces are soft
 * break points; spaceless CJK breaks mid-token at the chord boundary — the
 * same two modes a per-char line breaker supports. Overflow gets a trailing
 * ellipsis.
 *
 * The earlier implementation kept a mutable word list and splice()d leftover
 * fragments back into it across the 1..maxLines sweep; because the list
 * persisted between sweeps, re-running re-split the same word and accumulated
 * duplicate fragments (the "的论文给我" repeated-N-times symptom). This
 * flat-char version has no shared mutable structure, so it cannot duplicate.
 */
function fitCaptionIntoCircle(name: string, radius: number, fontSize: number): string[] {
  if (!name) return [];
  // Pre-trim very long names to the area-budget so the fit loop is bounded.
  const maxChars = maxCaptionChars(radius, fontSize);
  const trimmed = name.length > maxChars ? name.slice(0, maxChars) : name;
  const maxLines = Math.max(1, Math.floor((radius * 2) / fontSize));

  // Chord width available on line `li` (0-indexed) of a `lineCount`-line
  // layout, centred around the disc centre (chord-at-baseline model). The
  // baseline is centred around 0.
  const chordForLine = (lineCount: number, li: number): number => {
    const baseline = (1 + li - lineCount / 2) * fontSize;
    const chordCentreDistance = li < lineCount / 2
      ? baseline - fontSize / 2
      : baseline + fontSize / 2;
    return chordWidth(radius, chordCentreDistance);
  };

  // Greedy line fill over a FLAT character stream (array of single chars),
  // breaking at spaces when possible. We don't keep a word list because the
  // old version mutated that list via splice() across the lineCount sweep,
  // which accumulated duplicate fragments ("的论文给我" repeated) — a flat
  // char stream has no shared mutable structure to corrupt.
  // Break preference: a space char is a soft break point (it is consumed, not
  // carried to the next line); otherwise we break mid-token (spaceless CJK).
  const chars = [...trimmed];
  const charWidths = chars.map((c) => measureText(c, fontSize));

  const fillLines = (lineCount: number): { lines: string[]; consumed: number } => {
    const out: string[] = [];
    let ci = 0;
    for (let li = 0; li < lineCount; li++) {
      if (ci >= chars.length) break;
      const chord = chordForLine(lineCount, li);
      let buf = "";
      let bufWidth = 0;
      while (ci < chars.length) {
        const c = chars[ci]!;
        const cw = charWidths[ci]!;
        // A leading space on a fresh line is dropped (no indent from a wrap).
        if (c === " " && !buf) { ci++; continue; }
        if (bufWidth + cw > chord) {
          // Even one char doesn't fit this line's chord: force it onto the
          // line anyway so we make progress (avoids a stuck loop where every
          // line stays empty). A min-node-size floor prevents this in
          // practice, but we guard against tiny-node / large-font edge cases.
          if (!buf) { buf = c; ci++; }
          break;
        }
        buf += c;
        bufWidth += cw;
        ci++;
        // After adding a space, this is a natural break point — if the next
        // char won't fit, stop here (the space is already in buf but trimmed
        // below). For spaceless CJK this never triggers, so we break mid-token
        // at the chord boundary instead — same as the per-char breaker.
        if (c === " ") break;
      }
      out.push(buf.replace(/\s+$/, ""));
    }
    return { lines: out, consumed: ci };
  };

  // Try 1..maxLines, keep the densest layout that fits all chars; if none fit,
  // take maxLines and ellipsis the overflow on the last line (last line gets a
  // trailing ellipsis when content overflows).
  let best: { lines: string[]; consumed: number } = { lines: [], consumed: 0 };
  for (let lc = 1; lc <= maxLines; lc++) {
    const cand = fillLines(lc);
    if (cand.consumed > best.consumed) best = cand;
    if (best.consumed >= chars.length) break;
  }
  // Drop empty trailing lines (a 3-line layout that only used 2).
  let lines = best.lines.filter((l) => l.length > 0);
  if (best.consumed < chars.length) {
    // Overflow: ellipsis the last line so the truncation reads as intentional.
    const last = lines[lines.length - 1] ?? "";
    const lastChord = chordForLine(best.lines.length, best.lines.length - 1);
    // Shrink the last line until `last…` fits the last chord.
    let trial = last;
    while (trial.length > 1 && measureText(`${trial}…`, fontSize) > lastChord) {
      trial = trial.slice(0, -1);
    }
    lines = lines.length ? [...lines.slice(0, -1), `${trial}…`] : [`${trial}…`];
  }
  return lines.filter(Boolean);
}

// Cap the rendered lines so a huge disc doesn't grow a wall of text;
// maxLines = (radius*2)/fontSize gives ~4 at r=23/10px, we keep the same.

/**
 * Caption font size in GRAPH space (before the zoom transform scales it to
 * screen pixels). The base size derives from a node-size ratio:
 *   fontSize = radius / divisor[captionSize] / fontInfoLevel
 *   captionSize default 1 → divisor = 3.5 (the {1:3.5, 2:2.75, 3:2} table)
 *   fontInfoLevel default 1.25 (oc() with no zoom input)
 * so fontSize = radius / 3.5 / 1.25 = radius / 4.375. For nodeSize (radius)
 * 12 that is ~2.74 graph units; the on-screen size is this × zoom scale, so
 * at a typical fit (scale ~3-4×) the caption reads ~8-11px. The previous
 * fixed 10px (graph space) was ~3.6× too large.
 *
 * Computed per-build from the live nodeSize so a thumbnail canvas (nodeSize 5)
 * gets proportionally smaller captions too.
 */
function captionFontSizeFor(nodeSize: number): number {
  return nodeSize / 4.375; // radius / (3.5 × 1.25)
}


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
  // Default relationship width is 1; same base for interactive/non-interactive,
  // the zoom factor scales it below.
  const baseWidth = 1.0;
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
 * Hide node captions once the node shrinks below a readable size on screen.
 * The visibility gate is derived from the node's screen-area ratio:
 *   o = (radius² · π · zoom²) / (refArea / 100)   // node screen area as a
 *                                                 //   % of a 1600×1200 reference
 *   nodeInfoLevel = nc(o, Js)   // Js = [[0.04, 1], [100, 2]]
 *   textOpacity target = nodeInfoLevel < 2 ? 0 : 1   // o < 0.04 → caption hidden
 * The reference area is a FIXED 1600·dpr × 1200·dpr (not the live canvas), so
 * the cutoff behaves the same regardless of viewport size — a node whose
 * on-screen radius·zoom falls below ~15.6px (= √(0.04·19200/π)) drops its
 * caption. We use the exact formula and reference area; dpr cancels out
 * for our logical-pixel SVG, so we take refArea/100 = 1600·1200/100 = 19200.
 *
 * The textOpacity target is a binary value that an animation handler eases
 * toward (so the transition is a short fade, not a hard pop). We mirror that
 * by fading caption opacity across a narrow band straddling the o=0.04 line,
 * so zooming past the threshold reads as the same gentle fade.
 */
const NVL_REF_AREA_OVER_100 = 19200;
// Caption hidden when o < 0.04. (Kept for reference; the live gate below is
// relative to baselineScale per the user's "show only when the node is bigger
// than at first open" request, not an absolute ratio.)
const NVL_LABEL_HIDE_O = 0.04;
// Captions appear only once the current zoom exceeds the first-open fit scale
// by this factor — i.e. the node must be ~1.3× its "just opened" screen size
// before its label shows. Tunable: higher = zoom further in before labels.
const LABEL_SHOW_ZOOM_RATIO = 1.3;
function applyNodeLabelVisibility(
  scale: number,
  nodeSel: Selection<SVGGElement, SimNode, SVGGElement, unknown> | null,
  baselineScale: number,
): void {
  if (!nodeSel) return;
  // BINARY visibility — strictly 0 or 1, no mid-opacity fade. The gate is
  // relative to the first-open fit scale (baselineScale): labels show only
  // after the user zooms in past LABEL_SHOW_ZOOM_RATIO × fit, so a freshly-
  // opened graph (nodes at fit size) shows NO labels until you zoom in a
  // touch — exactly "比一开始打开的节点大小再大一些再显示字". This is
  // graph-size-independent: whether fitScale is 0.5 (big graph) or 1.5
  // (tiny graph), the threshold is the same *relative* zoom-in.
  const visible = scale >= baselineScale * LABEL_SHOW_ZOOM_RATIO ? 1 : 0;
  nodeSel.select("text.memory-canvas-node-label").attr("opacity", visible);
  nodeSel.select("text.memory-canvas-scope-badge").attr("opacity", visible);
}

/**
 * Scale node caption font with zoom via a fontInfoLevel multiplier. The caption
 * is NOT kept at a fixed graph-unit size — it recomputes the size every zoom
 * tick so the caption grows *super-linearly* as the node fills more of the
 * screen:
 *
 *   o = (radius² · π · zoom²) / (refArea / 100)
 *   fontInfoLevel = nc(o, ec)   // ec = [[0.8, 1.1], [3, 1.6], [8, 2.5]]
 *   captionFontSize = (radius / 3.5 / 1.25) · fontInfoLevel
 *
 * That last `· fontInfoLevel` is what the static captionFontSizeFor() omits —
 * it is the difference between captions that stay illegible at max zoom and
 * ones that bloom to a readable size. Because the reference `refArea` is the
 * live canvas (1600·dpr × 1200·dpr), the threshold `o` represents "how much of
 * the screen the node occupies", not an absolute pixel count — we mirror that
 * by using the real canvas area, not the fixed 1600×1200. With our smaller pane
 * that means the ec table actually engages (instead of staying pinned at 1.1),
 * so the font-boost fires on zoom-in exactly when it should.
 *
 * `nc` is the step lookup: first threshold `> o`, else the last entry's value.
 * Mutating font-size on the live <text> re-flows the tspans because their `dy`
 * is in em (relative), so no re-emit is needed.
 */
const NVL_FONTINFO_EC: Array<[number, number]> = [[0.8, 1.1], [3, 1.6], [8, 2.5]];
function ncLookup(o: number, table: Array<[number, number]>): number {
  for (const [threshold, value] of table) {
    if (o < threshold) return value;
  }
  const last = table[table.length - 1];
  return last ? last[1] : 1;
}
// Cache fitCaptionIntoCircle by (name, fontInfoLevel). The wrap depends only
// on name, radius (fixed per build) and fontSize; fontSize takes 4 discrete
// values (one per fontInfoLevel), so keying on fontInfoLevel makes a zoom that
// stays within one level a Map hit rather than a per-char measureText pass.
// The wrap is re-ran every frame in a WebGL renderer; for our SVG path this
// cache keeps the per-tick cost down to attribute writes.
const captionWrapCache = new Map<string, string[]>();
function wrappedLinesFor(name: string, nodeSize: number, fontInfoLevel: number): string[] {
  const key = `${name} ${fontInfoLevel}`;
  const hit = captionWrapCache.get(key);
  if (hit) return hit;
  const fontSize = captionFontSizeFor(nodeSize) * fontInfoLevel;
  const lines = fitCaptionIntoCircle(name, nodeSize, fontSize);
  if (captionWrapCache.size > 4000) captionWrapCache.clear();
  captionWrapCache.set(key, lines);
  return lines;
}
function applyNodeLabelFontSize(
  scale: number,
  nodeSel: Selection<SVGGElement, SimNode, SVGGElement, unknown> | null,
  nodeSize: number,
  canvasArea: number,
): void {
  if (!nodeSel) return;
  // o uses the LIVE canvas area (see module note above) so the ec table
  // engages on our smaller pane instead of pinning at the 1.1 floor.
  const o = (nodeSize * nodeSize * Math.PI * scale * scale) / (canvasArea / 100);
  const fontInfoLevel = ncLookup(o, NVL_FONTINFO_EC);
  const fontSize = captionFontSizeFor(nodeSize) * fontInfoLevel;

  // The wrap + positioning is recomputed every render at the live zoom. We
  // mirror that: re-run fitCaptionIntoCircle at the boosted font size and
  // re-emit tspans positioned by the absolute-y formula
  // (yPos0 = -(lineCount-2)·fontSize/2, line k at yPos0 + k·fontSize). This is
  // what keeps captions inside the disc and vertically centred at every zoom —
  // the earlier "wrap once, only mutate font-size" shortcut made the wrap
  // stale the moment fontInfoLevel grew, so text overflowed (bug 1) and
  // centring drifted (bug 2).
  nodeSel.each(function (node: SimNode) {
    const sel = select(this);
    const label = sel.select("text.memory-canvas-node-label");
    label.attr("font-size", fontSize);
    const lines = node.collapsed
      ? [`+${node.collapsedCount}`]
      : wrappedLinesFor(node.name, nodeSize, fontInfoLevel);
    const tspans = label.selectAll<SVGTSpanElement, string>("tspan").data(lines);
    tspans.exit().remove();
    const yPos0 = -((lines.length - 2) * fontSize) / 2;
    tspans.enter().append("tspan")
      .merge(tspans)
      .attr("x", 0)
      // Absolute y per line (yPos0 + k·fontSize), NOT a dy chain. This
      // centres the block on the node centre for any line count; the old
      // dy=0.35em+1.1em chain centred on the first line, leaving the top half
      // of the disc empty (bug 2).
      .attr("y", (_line: string, i: number) => yPos0 + i * fontSize)
      .text((line: string) => line);
  });
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
  /** produces 成员折叠（规则3，「谁展开谁折叠」模型）的归属映射：
   * ownerId → 它**亲手拉进来**的子节点 id 集（一个新节点只记在第一个拉它
   * 进来的 owner 名下）。canvas 用它判定一个非 scope/aggregate 节点是否
   * 已展开（名下有非空子集 → producesExpanded → 挂「双击收起节点」tooltip，
   * 否则「双击展开节点」）。独立于 expandedScopes/expandedGroups。 */
  expandedNodeMap?: ReadonlyMap<string, ReadonlySet<string>>;
  /** 双击非 scope/aggregate 节点 → toggle 其 produces 成员展开/折叠。explorer
   * 的 toggleProduces 纯客户端（成员已在 subgraph 里，前端投影），无 fetch。
   * 未设置时非 scope 节点双击无展开效果（thumbnail 调用方保持 inert）。 */
  onToggleProduces?: (ownerId: string) => void;
  /** Hover-hint 文案 for 非 scope 节点的 <title> tooltip（与 scopeHints 同
   * 结构，文案当前复用 scope.clickExpand/clickCollapse，后续可分语言包）。 */
  producesHints?: { expand: string; collapse: string };
  /** 每个节点**当前已折叠（不可见）的** produces/citation 相邻成员数
   * （可见性感知，按当前投影 graph 算，由 explorer 传入）。>0 才说明双击
   * 还能拉出新节点。canvas 用它判定一个非 scope/aggregate 节点是否可展开：
   * =0 时 tooltip 不显示"双击展开节点"，避免对「相邻成员都已可见」的节点
   * （如 sub_analysis2.txt Artifact）或「本就无 produces 成员」的节点
   * （如 ResearchGoal，子节点走 next 本就可见）给出误导性提示。 */
  foldedProducesCounts?: ReadonlyMap<string, number>;
  /** 链路高亮 overlay：命中的边 key 集（`source>target:type`）。
   * 链路态下这些边加 `chain-edge` class（加粗+强调色+箭头），从淡显背景
   * 里跳出。不传时无链路高亮。由 explorer 的 chainEdgeKeys memo 传入，
   * 与 matchIds（链上节点集）配合——matchIds 让链外节点淡显、链上节点高亮，
   * chainEdgeKeys 让链上边加粗。 */
  chainEdgeKeys?: ReadonlySet<string>;
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
  fitAll: ((duration: number, noPan?: boolean) => void) | undefined;
  width: number;
  height: number;
  nodeSize: number;
  /** True once the simulation has produced node coordinates; used to gate fit. */
  positionsReady: boolean;
  /**
   * The zoom scale the graph was fit to on first open (and after re-fit on
   * expand). Caption visibility is gated RELATIVE to this — captions only
   * appear once the user zooms ~1.3× past the fit scale, so a freshly-opened
   * graph (node at its "fit" size) shows no labels; the user has to zoom in
   * a touch before labels pop. Without this baseline a fixed scale threshold
   * fires at different relative sizes depending on how big the graph is.
   */
  baselineScale: number;
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
  expandedNodeMap,
  onToggleProduces,
  producesHints,
  foldedProducesCounts,
  chainEdgeKeys,
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
  // produces 折叠（规则3）的 ref 镜像——与 scopeHintsRef/onToggleScopeRef
  // 同模式：click/dblclick handler 在 build 时绑一次，靠 ref 读最新闭包。
  const expandedNodeMapRef = useRef(expandedNodeMap);
  expandedNodeMapRef.current = expandedNodeMap;
  const onToggleProducesRef = useRef(onToggleProduces);
  onToggleProducesRef.current = onToggleProduces;
  const producesHintsRef = useRef(producesHints);
  producesHintsRef.current = producesHints;
  // 可见性感知的「已折叠 produces 相邻成员数」ref 镜像——tooltip 的 .text()
  // 在 build effect 里绑一次，靠 ref 读最新值（展开/折叠后这个数会变，tooltip
  // 需即时反映）。优先于 producesMemberCounts（后者不分可见性）。
  const foldedProducesCountsRef = useRef(foldedProducesCounts);
  foldedProducesCountsRef.current = foldedProducesCounts;
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
    baselineScale: 1,
  });
  // The parent re-polls on a timer and hands us a fresh object each time. Key
  // the rebuild on the graph's *content* so an unchanged graph never re-runs
  // layout — otherwise the user's pan, zoom and selection reset every poll.
  const signature = useMemo(() => JSON.stringify([
    subgraph.nodes.map((node) => `${node.id}:${node.label}:${String(node.extra?.status ?? "")}`).sort(),
    subgraph.edges.map((edge) => `${edge.source}>${edge.target}:${edge.type}`).sort(),
  ]), [subgraph]);

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
    // The design node size is 25 (diameter); a WebGL point sprite uses
    // gl_PointSize = a_size, so `size` is the full drawn diameter. Our SVG
    // draws with radius, so nodeSize is the RADIUS: 25/2 ≈ 12. The previous 23
    // (radius → 46px diameter) made nodes nearly 2× too large and inflated
    // every distance parameter that scales with it.
    const nodeSize = interactive ? 12 : 5;

    const svgSel = select(svgEl);
    svgSel.selectAll("*").remove();

    const defs = svgSel.append("defs");
    // Arrowhead is a notched chevron (headHeight=9, headChinHeight=2, headWidth=7 —
    // a 4-point path with a rear chin notch, not a solid triangle). The head factor
    // is n×(lineWidth>1 ? lineWidth/2 : 1), so at the default lineWidth=1 the arrow
    // is a FIXED size — it does NOT scale with line width. To match that we set
    // markerUnits=userSpaceOnUse (the default markerUnits=strokeWidth would multiply
    // markerWidth by stroke-width, shrinking the arrow whenever the zoom-adapted
    // line narrows — wrong).
    //
    // The design node default radius is 25 (diameter 50); our canvas node radius = 12
    // (diameter 24), i.e. 0.48× the design size. We scale the arrow by the same
    // factor so the arrow/node proportion matches: headHeight 9×0.48≈4.3, headWidth
    // 7×0.48≈3.4. Tip at (9,0) lands on the target node border (refX=9); the notch at
    // (2,0) gives the concave rear that reads as a relationship arrow.
    const arrowScale = 0.48;  // our node diameter (24) / design node diameter (50)
    const arrowW = 9 * arrowScale;   // ≈ 4.3
    const arrowH = 7 * arrowScale;   // ≈ 3.4
    for (const [type, color] of Object.entries(EDGE_COLORS)) {
      defs.append("marker")
        .attr("id", `memory-canvas-arrow-${type}`)
        .attr("viewBox", "0 -3.5 9 7")
        .attr("refX", 9)
        .attr("refY", 0)
        .attr("markerUnits", "userSpaceOnUse")
        .attr("markerWidth", interactive ? arrowW : arrowW * 0.67)
        .attr("markerHeight", interactive ? arrowH : arrowH * 0.67)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-3.5 L9,0 L0,3.5 L2,0 Z")
        .attr("fill", color);
    }

    const zoomLayer = svgSel.append("g").attr("class", "memory-canvas-zoom-layer");
    const edgesLayer = zoomLayer.append("g").attr("class", "memory-canvas-edges");
    const nodesLayer = zoomLayer.append("g").attr("class", "memory-canvas-nodes");

    let zoomBehavior: ReturnType<typeof zoom<SVGSVGElement, unknown>> | undefined;
    if (interactive) {
      zoomBehavior = zoom<SVGSVGElement, unknown>()
        // Design zoom defaults: minZoom 0.075, maxZoom 10. The old 0.2–2.5 range
        // capped zoom so low that captions never reached a readable size — the
        // font-boost in applyNodeLabelFontSize only fires once the node fills
        // enough of the screen, which needs real zoom-in headroom. The 10× max
        // lets a user blow the graph up until a single node's caption is fully
        // legible, exactly as in the Browser.
        .scaleExtent([0.075, 10])
        .filter((event: Event) => {
          if (event.type === "wheel") return true;
          const target = event.target as Element | null;
          return !target?.closest(".memory-canvas-node");
        })
        .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
          zoomLayer.attr("transform", event.transform.toString());
          const ref = simRef.current;
          if (ref.edgeSel) applyZoomAdaptation(event.transform.k, ref.edgeSel, interactive);
          // Caption visibility is gated relative to the first-open fit scale
          // (ref.baselineScale): labels only appear once zoomed in past it, so
          // a freshly-opened graph shows no node text until you zoom in a touch.
          if (ref.nodeSel) applyNodeLabelVisibility(event.transform.k, ref.nodeSel, ref.baselineScale);
          // Caption font is recomputed every zoom tick so it grows super-
          // linearly with zoom (fontInfoLevel). It uses the LIVE canvas area
          // (not a fixed 1600×1200) so the ec thresholds engage on our smaller
          // pane — otherwise captions stay pinned at the 1.1× floor and never
          // become readable, even at max zoom.
          if (ref.nodeSel && ref.width && ref.height) {
            applyNodeLabelFontSize(event.transform.k, ref.nodeSel, ref.nodeSize, ref.width * ref.height);
          }
        });
      svgSel.call(zoomBehavior);
      // d3-zoom binds its own `dblclick.zoom` handler that zooms ×2 and
      // centres on the double-click point — that is the "双击放大居中" the
      // user does NOT want. The whole point of double-click here is to
      // expand/collapse a node (scope / aggregate / produces members), so
      // drop d3-zoom's handler and let our nodesLayer dblclick handler own
      // the gesture unconditionally. (d3-selection .on(name, null) is the
      // documented way to remove a typed listener.)
      svgSel.on("dblclick.zoom", null);
    } else {
      // Thumbnail: no zoom behaviour, just land the layer at origin so nodes
      // are visible. The data effect's fit path translates the layer.
      zoomLayer.attr("transform", "translate(0, 0)");
    }

    // The click handler reads dataRef so the *current* simNodes drive the
    // toggle — bound once here, never rebound on expand/collapse.
    //   - 统一交互模型：原生 click + dblclick，
    //     全部节点不用 250ms 防抖窗口。单击 = 选中（立即，零延迟）；双击 =
    //     toggle 该节点的展开/折叠（scope→子树, aggregate→成员, 其他→produces）。
    //     双击 = 第一次 click（已选中）再 dblclick（展开），浏览器原生事件序。
    //   - 旧实现里 scope 用 250ms 窗口（pendingScopeSelect/DBLCLICK_WINDOW_MS）
    //     是因为把 toggle 挪到了 click 的第二次落点判定；现在 toggle 统一在
    //     dblclick 里处理，scope 也就不需要窗口了——和非 scope 节点一致。
    //   - aggregate 旧实现是 click 立即 toggle（不等 dblclick）；为了模型统一，
    //     现在也挪到 dblclick，与 scope/produces 一致：click 只选中。
    const fireSelect = (id: string) => { onSelectRef.current?.(id); };
    nodesLayer.on("click", (event: MouseEvent) => {
      const g = (event.target as Element | null)?.closest(".memory-canvas-node") as SVGGElement | null;
      if (!g) return;
      const node = select(g).datum() as SimNode;
      event.stopPropagation();
      // 所有节点：单击立即选中。展开/折叠交给 dblclick。
      fireSelect(node.id);
    });
    // 双击 → toggle 展开折叠，按节点类型路由（统一模型，不再有 250ms 窗口）。
    //   - scope (subagent Task)：toggleScope（fetch 子树，上游 mergeExpansions）
    //   - aggregate (Artifacts/Papers)：toggleGroup（fetch 成员，上游）
    //   - 其他：toggleProduces（纯客户端投影，produces 成员一层）
    // 不阻止 click 默认行为——浏览器 dblclick 在 click 之后触发，第一次
    // click 已完成选中，第二次再展开。
    nodesLayer.on("dblclick", (event: MouseEvent) => {
      if (!interactive) return;
      const g = (event.target as Element | null)?.closest(".memory-canvas-node") as SVGGElement | null;
      if (!g) return;
      const node = select(g).datum() as SimNode;
      event.stopPropagation();
      if (node.isScope) {
        // scope 双击：toggleScope 展开其 contains 子树（fetch 子树，上游
        // mergeExpansions 合并）。projectToCanvas 的保留集纳入 expandedScopes 的
        // expansion 节点（见 backbone），所以子树节点不会被主干投影砍掉。
        onToggleScopeRef.current?.(node.id);
        return;
      }
      if (node.isAggregate) {
        onToggleGroupRef.current?.(node.id);
        return;
      }
      // 非 scope/aggregate 节点：toggle produces 成员（explorer 纯客户端投影）。
      onToggleProducesRef.current?.(node.id);
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
    // Fit the whole graph into view: the scale is purely determined by how
    // the graph's bbox fills the pane (with a 5%-ish padding), capped at an
    // upper bound so a tiny graph isn't blown up huge — capped at 2 by design,
    // we cap at 1.5 (interactive). After an expand, this is what keeps the
    // now-larger graph from overflowing into a cramped tangle: the canvas
    // scales back so every node fits with room. There is no "only shrink"
    // guard — the whole point the user reported is that the view DOES re-fit
    // to the new node count after expanding, and that is what makes expanded
    // children not crowd.
    const fitAllFromRef = (duration: number, noPan = false) => {
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
      const fitScale = Math.min(
        (ref.width - padding * 2) / (bboxW + nodeSize * 2),
        (ref.height - padding * 2) / (bboxH + nodeSize * 2),
        interactive ? 1.5 : 1.1,
      );
      const graphCenterX = (minX + maxX) / 2;
      const graphCenterY = (minY + maxY) / 2;
      // The post-layout fit can preserve the pan: the zoom adjusts so every
      // node is visible, but the *current viewport centre is preserved* — the
      // graph is not yanked to the canvas middle. That keeps the user's pan
      // across an incremental expand. We mirror it: keep the existing screen
      // point under the cursor stable, only change the scale (scale about the
      // current zoom focal point). On a fresh fit (noPan=false) we centre the
      // graph as before.
      let transform;
      if (noPan) {
        // Scale about the current viewport centre: the screen centre stays
        // put, only the zoom level changes. screenCentre is the same point in
        // graph space before and after, so translate = centre - centre*scale.
        const current = zoomTransform(ref.svgSel.node() as Element);
        const screenCentreX = ref.width / 2;
        const screenCentreY = ref.height / 2;
        const graphAtCentreX = (screenCentreX - current.x) / current.k;
        const graphAtCentreY = (screenCentreY - current.y) / current.k;
        transform = zoomIdentity
          .translate(screenCentreX - graphAtCentreX * fitScale, screenCentreY - graphAtCentreY * fitScale)
          .scale(fitScale);
      } else {
        transform = zoomIdentity
          .translate(ref.width / 2 - graphCenterX * fitScale, ref.height / 2 - graphCenterY * fitScale)
          .scale(fitScale);
      }
      ref.svgSel.transition().duration(duration).call(ref.zoomBehavior.transform, transform);
      // Record the fit scale as the caption-visibility baseline, but only on
      // a fresh-centre fit (noPan=false). An incremental expand re-fits with
      // noPan=true; we keep the original baseline in that case so caption
      // visibility stays relative to "how the graph looked when first opened",
      // not to the post-expand zoomed-out view.
      if (!noPan) ref.baselineScale = fitScale;
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
    const nodeSize = interactive ? 12 : 5;
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
      // discs (shown folded) and the hover hint ("双击展开节点"/"双击收起节点").
      const folded = isScope ? !expanded : false;
      // Aggregate virtual node (需求3): a folded scope's >1 same-kind products
      // collapsed into one ``_group:…`` node. Read the member count from
      // ``extra.count`` (set by the backend synthesis) so the "▸ N" badge shows
      // how many products are inside. aggregateExpanded mirrors expandedGroups
      // so the badge flips ▸→▾ when the aggregate is open.
      const isAggregate = isAggregateNode(node);
      const aggregateCount = typeof node.extra?.count === "number" ? node.extra.count : 0;
      const aggregateExpanded = isAggregate ? expandedGroups?.has(node.id) === true : false;
      // produces 成员折叠（规则3，「谁展开谁折叠」）：非 scope/aggregate
      // 节点是否处于「展开态」（expandedNodeMap 里有没有它的 key，对应
      // d.expanded 节点级布尔：展开过即 true，折叠删 key 即 false）。由
      // explorer 维护，独立于 expandedScopes/expandedGroups。仅对普通节点
      // 有意义（scope/aggregate 的展开态各自有 expanded/aggregateExpanded）。
      // 用 ref 读最新值（展开/折叠后翻转）。用 has 而非 size>0：浅层折叠删
      // owner key 后 size 不重要，has 才反映「展开过且未折叠」。
      const ownerIsExpanded = expandedNodeMapRef.current?.has(node.id) === true;
      const producesExpanded = (!isScope && !isAggregate)
        ? ownerIsExpanded
        : false;
      // 当前已折叠（不可见）的 produces/citation 相邻成员数（可见性感知，
      // 由 explorer 按当前投影 graph 算后传入）。tooltip 用它判定非 scope/
      // aggregate 节点是否还能展开——>0 才出"双击展开节点"提示；=0（相邻
      // 成员都已可见，或本来就无 produces 成员，如 ResearchGoal）不出提示，
      // 避免对双击是 no-op 的节点给出误导性提示。仅对普通节点有意义
      // （scope 用 childCount，aggregate 用 aggregateCount）。
      const producesCount = (!isScope && !isAggregate)
        ? (foldedProducesCounts?.get(node.id) ?? 0)
        : 0;
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
        producesExpanded,
        producesCount,
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

    // Seed initial positions. The force layout keeps a persistent `d3Nodes` map
    // across updates, so survivors (already in the map with settled x/y) keep
    // their positions; only nodes NEW to the map are unlocated.
    //
    // The circularLayout runs ONLY on the first fill — i.e. when the canvas
    // was empty and is getting its first nodes
    // (`d = s && 0 === Object.keys(this.d3Nodes).length`). On that first fill
    // it seeds every unlocated node on a ring of radius `45 * sqrt(nodeCount)`
    // centred on the graph origin. On every LATER update (an expand), the
    // unlocated new nodes are NOT re-seeded — they enter the simulation with
    // undefined x/y, d3-force initialises them near the origin, and the
    // two-stage preheat (below) with its doubled charge (-800) blasts them
    // apart into the "blooming" arrangement. That is why expanding a ToolCall
    // visibly fans its children out: the preheat's strong repulsion pushes the
    // new (unseeded) nodes away from the survivors and each other, which in
    // turn pushes the survivor ToolCalls apart.
    //
    // We mirror that exactly: survivors copy their settled x/y/vx/vy; new
    // nodes get NO seeded position on an incremental expand (left undefined
    // → d3-force jiggles them near the survivors' centroid). On a FRESH
    // canvas we run the circularLayout seed (radius 45*sqrt(n)).
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
    // 2. On a FRESH canvas only, place the unlocated nodes on a circular
    //    layout (the firstTimeAddingNodes path). The layout centre is the
    //    origin {0,0}; we use the survivors' centroid / canvas centre.
    //    radius = 45 * sqrt(totalNodeCount) — square-root growth keeps the
    //    initial cluster tight. Incremental expands skip this entirely (the
    //    preheat below does the blooming).
    const LINK_DISTANCE_CONST = 45;  // link-distance constant
    const unlocated = simNodes.filter((node) => !seeded.has(node.id));
    if (unlocated.length && !isIncremental) {
      let cx = 0, cy = 0;
      if (seeded.size) {
        for (const id of seeded) {
          const p = posById.get(id);
          if (p) { cx += p.x; cy += p.y; }
        }
        cx /= seeded.size; cy /= seeded.size;
      } else {
        cx = width / 2; cy = height / 2;
      }
      const ringRadiusSeed = 45 * Math.sqrt(simNodes.length);
      unlocated.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / unlocated.length;
        node.x = cx + ringRadiusSeed * Math.sin(angle);
        node.y = cy + ringRadiusSeed * Math.cos(angle);
        node.vx = 0;
        node.vy = 0;
        seeded.add(node.id);
      });
    } else if (unlocated.length && isIncremental) {
      // Incremental: new nodes enter unlocated. d3-force jiggles
      // undefined-position nodes to a small random offset around the existing
      // nodes' centroid; give them that seed explicitly so they start near
      // the live cluster (not the canvas origin) before the preheat blasts
      // them apart. Mirrors d3-force's initializePositions jiggle, but pinned
      // to the survivors' centroid so the bloom grows OUT of the graph.
      let cx = 0, cy = 0;
      for (const id of seeded) {
        const p = posById.get(id);
        if (p) { cx += p.x; cy += p.y; }
      }
      cx = seeded.size ? cx / seeded.size : width / 2;
      cy = seeded.size ? cy / seeded.size : height / 2;
      unlocated.forEach((node) => {
        // Small jitter around the centroid, within one link distance, so the
        // preheat has something to push apart (a stack at one point would
        // collide-stick). Using a deterministic angle from the id hash keeps
        // it stable across re-renders (no Math.random — would break layout
        // determinism and fling on every poll).
        const hash = node.id.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
        const angle = (hash & 0xffff) / 0xffff * 2 * Math.PI;
        const r = LINK_DISTANCE_CONST * 0.5;
        node.x = cx + r * Math.sin(angle);
        node.y = cy + r * Math.cos(angle);
        node.vx = 0;
        node.vy = 0;
      });
    }

    // Degree count per node for the link-strength weighting (mirrors the
    // nodeRelCount + FORCE_LINK_STRENGTH formula). `count[i]` is the number of
    // links incident to node i; a hub node's edges get weakened so high-degree
    // nodes don't drag their whole neighbourhood rigidly. d3-force's forceLink
    // exposes the per-node degree via the `strength` accessor's second arg,
    // but computing it once here keeps the weighting formula readable and
    // matches the `countNodeRels()` shape.
    const relCount = new Map<string, number>();
    for (const link of simLinks) {
      const s = typeof link.source === "object" ? link.source.id : link.source;
      const t = typeof link.target === "object" ? link.target.id : link.target;
      relCount.set(s, (relCount.get(s) ?? 0) + 1);
      relCount.set(t, (relCount.get(t) ?? 0) + 1);
    }

    // Force parameters mirror the new-Browser D3 force layout constants (the
    // module-scope values). These are the ACTUAL new-Browser values
    // (the previous comments wrongly cited the classic Browser's constants).
    //   charge strength: a function returning -400 (FORCE_CHARGE); on the
    //     initial two-stage preheat it is temporarily doubled to -800
    //     (FORCE_CHARGE_START = 2*po) to blast the cluster apart first.
    //   link distance: src.r + tgt.r + 90  (linkDistance accessor;
    //     `90` = 2*LINK_DISTANCE). Falls back to 45 when endpoints are ids.
    //   link strength: 1.2 / (min(srcRels, tgtRels) + (max-1)/100),
    //     clamped to [0.06, 1] — high-degree edges are weakened.
    //   collide radius: node.r + 25.
    //   velocityDecay 0.4, alphaMin 0.05, centerX/Y strength 0.1.
    // We keep forceX/forceY with the per-component centers (we have multiple
    // disconnected components placed on a grid, where a per-component center
    // pull reads better than a single-cluster model); the 0.1 strength
    // applies. forceCenter is dropped (forceX/Y subsume it).
    const linkDistanceFor = (_link: SimLink): number => {
      // src.size + tgt.size + 2*LINK_DISTANCE (=90). All our nodes share
      // `nodeSize`, so this is nodeSize*2 + 90. (Kept as a function to
      // mirror the per-link accessor shape; the link arg is unused.)
      return nodeSize + nodeSize + 90;
    };
    const linkStrengthFor = (link: SimLink): number => {
      const sId = typeof link.source === "object" ? link.source.id : link.source;
      const tId = typeof link.target === "object" ? link.target.id : link.target;
      const sC = relCount.get(sId) ?? 1;
      const tC = relCount.get(tId) ?? 1;
      const minR = Math.min(sC, tC);
      const maxR = Math.max(sC, tC);
      const r = 1.2 / (minR + (maxR - 1) / 100);
      return Math.max(Math.min(r, 1), 0.06);
    };
    const chargeForce = forceManyBody().strength(-400);
    const chargeForceStart = forceManyBody().strength(-800);
    const simulation = forceSimulation<SimNode>(simNodes)
      .velocityDecay(0.4)
      .force("link", forceLink<SimNode, SimLink>(simLinks)
        .id((node: SimNode) => node.id)
        .distance(linkDistanceFor)
        .strength(linkStrengthFor))
      .force("charge", chargeForce)  // ; swapped to chargeForceStart during preheat
      .force("collide", forceCollide<SimNode>().radius(() => nodeSize + 25))
      .force("x", forceX<SimNode>((node: SimNode) => componentCenters.get(node.id)?.cx ?? width / 2).strength(0.1))
      .force("y", forceY<SimNode>((node: SimNode) => componentCenters.get(node.id)?.cy ?? height / 2).strength(0.1))
      .alpha(1)
      // alphaMin(0.05) is the stop threshold; settles within a couple of
      // seconds rather than the d3-default alphaMin(0.001) dreamy tail.
      .alphaMin(0.05)
      .alphaTarget(0);  // fixed target, alpha cools to 0

    // The two-stage preheat runs ONLY on the first layout (the
    // firstTimeAddingNodes path). It does NOT run on an incremental expand —
    // that path is the `shouldReheatNodes` branch: `simulation.alpha(1).restart()`.
    // The "flow"/ float the user wants to SEE comes from that reheat: alpha is
    // reset to 1, then d3-force's native rAF timer ticks at high frequency while
    // alpha decays naturally from 1 → alphaMin (0.05) over ~1-2s — every tick
    // fires our `on("tick")` below and redraws, so the newly-added nodes visibly
    // drift into place instead of snapping. The preheat's synchronous settle
    // (stage1 alpha(1)-every-tick, stage2 natural decay) is for a FRESH canvas
    // so the first paint is converged; the post-restart native decay is the
    // visible float. Mirroring exactly:
    //   fresh:      preheat → `requestAnimationFrame(()=>computing=false); simulation.restart()`
    //   incremental: `simulation.alpha(1).restart()` (shouldReheatNodes)
    if (!isIncremental) {
      simulation.force("charge", chargeForceStart);
      const stage1Start = performance.now();
      let preheatTicks = 0;
      while (performance.now() - stage1Start < 300 && preheatTicks < 200) {
        simulation.alpha(1);  // reset alpha to full every tick (forced oscillation)
        simulation.tick(1);
        preheatTicks++;
      }
      simulation.force("charge", chargeForce);
      const stage2Start = performance.now();
      while (performance.now() - stage2Start < 100 && simulation.alpha() >= 0.05) {
        simulation.tick(1); // natural alpha decay this stage
      }
      // requestAnimationFrame clears the "computing" flag; restart() re-arms
      // d3's rAF timer; alpha carries over from stage2 (~alphaMin) so a fresh
      // canvas barely floats — its settle was off-screen.
      simulation.restart();
    } else {
      // shouldReheatNodes branch: alpha(1).restart(). Resetting alpha to 1 is
      // what gives the incremental expand its visible float — d3 then ticks at
      // full energy and decays to alphaMin over the next ~1-2s, each tick
      // redrawing via on("tick") below. Without the alpha(1) the new subtree
      // would barely move (alpha already ~alphaMin from the previous settle).
      simulation.alpha(1).restart();
    }

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
            .attr("class", (link: SimLink) => isChainEdge(link, chainEdgeKeys) ? "memory-canvas-edge chain-edge" : "memory-canvas-edge")
            .attr("data-id", (link: SimLink) => link.id)
            .attr("stroke", (link: SimLink) => link.surrogate ? EDGE_COLOR_LIGHT : (EDGE_COLORS[link.type] ?? EDGE_COLOR_LIGHT))
            .attr("stroke-width", 1.0)
            .attr("stroke-dasharray", (link: SimLink) => link.surrogate ? "4 3" : null)
            .attr("marker-end", (link: SimLink) => link.surrogate ? null : `url(#memory-canvas-arrow-${link.type})`);
          g.append("text")
            .attr("class", "memory-canvas-edge-label")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            // DOM-mode edge caption size: 6 * captionSize * DPR.
            // captionSize default 1, DPR 1 → 6 graph units; the zoom transform
            // scales it to screen.
            .attr("font-size", 6)
            .attr("font-weight", 400)
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
      .attr("marker-end", (link: SimLink) => link.surrogate ? null : `url(#memory-canvas-arrow-${link.type})`)
      .classed("chain-edge", (link: SimLink) => isChainEdge(link, chainEdgeKeys));
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
          const g = enter.append("g").attr("class", "memory-canvas-node")
            // Seed the transform at the node's seeded position so the very
            // first paint (before the first tick fires) already shows each
            // node where it was placed, not at the SVG origin (0,0). Without
            // this a fresh layout flashes every node stacked at the corner
            // for one frame before the tick handler moves them into place.
            .attr("transform", (node: SimNode) => `translate(${node.x ?? 0}, ${node.y ?? 0})`);

          if (interactive) {
            // Selected-node ring. An expanding pulse only fires on `activated`
            // nodes (`_ = !n && p`), NOT on the steady selected state —
            // selection draws a STATIC ring (DefaultSelectedOuterColor #8FE3E8)
            // plus an animated shadow. The user confirmed the selection has no
            // outward-spreading animation, so this is a single static ring;
            // the soft halo comes from the `selected-node` drop-shadow in the
            // CSS.
            g.append("circle")
              .attr("class", "memory-canvas-selected-ring")
              .attr("r", nodeSize)
              .attr("fill", "none")
              .attr("stroke", "#8FE3E8")  // DefaultSelectedOuterColor
              .attr("stroke-width", 4)
              .attr("pointer-events", "none");
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
              // Each tspan carries its own absolute y (yPos0 + k·fontSize,
              // set in the update block + applyNodeLabelFontSize); the <text>
              // container sits at the node centre (y=0 in the translated group).
              .attr("fill", (node: SimNode) => node.collapsed ? "#475569" : "#ffffff")
              .attr("font-family", '"Open Sans", sans-serif')
              .attr("font-size", captionFontSizeFor(nodeSize))
              .attr("font-weight", 600);
            // Native SVG <title> hover tooltip for every node: 统一双击交互
            // 模型下，所有节点都给一个 <title>——scope 折叠态/展开态、aggregate
            // 折叠态/展开态、非 scope/aggregate 节点的 produces 折叠态/展开态
            // 各自选"双击展开节点"/"双击收起节点"。Zero-JS, browser-rendered。
            // 文案在下面的 update 块按节点类型 + 折叠态重绑。
            g.append("title")
              .attr("class", "memory-canvas-scope-title");
            // The ▸N badge is aggregate-only now (a scope's folded state is
            // shown by the stack discs, not a numeric badge).
            g.filter((node: SimNode) => node.isAggregate === true).append("text")
              .attr("class", "memory-canvas-scope-badge")
              .attr("text-anchor", "start")
              .attr("x", nodeSize * 0.7)
              .attr("y", -nodeSize * 0.7)
              .attr("font-family", '"Open Sans", sans-serif')
              .attr("font-size", captionFontSizeFor(nodeSize) * 1.6)
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
    // Bind the node caption as up-to-N <tspan> lines. The initial pass uses
    // the base font (fontInfoLevel 1, captionFontSizeFor); applyNodeLabelFontSize
    // re-runs the wrap + re-positions on every zoom tick at the boosted size,
    // so this is just the first-frame seed. Both paths position lines the SAME
    // way: absolute y = yPos0 + k·fontSize, which centres the block on the
    // node centre for any line count. The wrap goes through wrappedLinesFor so
    // the first frame shares the same cache the zoom path uses (keyed on
    // fontInfoLevel).
    const captionFontSize = captionFontSizeFor(nodeSize);
    nodeSel.select("text.memory-canvas-node-label")
      .attr("fill", (node: SimNode) => node.collapsed ? "#475569" : "#ffffff")
      .attr("font-size", captionFontSize)
      .each(function (node: SimNode) {
        const sel = select(this);
        const lines = node.collapsed
          ? [`+${node.collapsedCount}`]
          : wrappedLinesFor(node.name, nodeSize, 1);
        const tspans = sel.selectAll<SVGTSpanElement, string>("tspan").data(lines);
        tspans.exit().remove();
        const yPos0 = -((lines.length - 2) * captionFontSize) / 2;
        tspans.enter().append("tspan")
          .merge(tspans)
          .attr("x", 0)
          // Absolute y per line (yPos0 + k·fontSize), not a dy chain —
          // centres the whole block on the node centre regardless of line
          // count. Must stay in sync with applyNodeLabelFontSize's positioning.
          .attr("y", (_line: string, i: number) => yPos0 + i * captionFontSize)
          .text((line: string) => line);
      });
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
    // Hover tooltip for every node（统一双击模型）。scope/aggregate/普通节点
    // 各自按折叠态选"双击展开节点"/"双击收起节点"。
    nodeSel.select("title.memory-canvas-scope-title")
      .text((node: SimNode) => {
        if (node.isScope) {
          // scope 节点：有可展开子树才给提示，避免误导（subagent 无
          // ToolCall 子节点时无内容可展开）。
          if (!node.childCount) return null;
          const hints = scopeHintsRef.current;
          return node.folded ? (hints?.expand ?? "Click to expand") : (hints?.collapse ?? "Click to collapse");
        }
        if (node.isAggregate) {
          // aggregate 节点：双击 toggle 成员展开。aggregateExpanded → 收起提示。
          // 无成员（aggregateCount 为 0）时不给提示——双击是 no-op，避免误导。
          if (!node.aggregateCount) return null;
          const hints = scopeHintsRef.current;
          return node.aggregateExpanded
            ? (hints?.collapse ?? "Click to collapse")
            : (hints?.expand ?? "Click to expand");
        }
        // 非 scope/aggregate 节点（规则3）：双击 toggle produces 成员。
        // producesExpanded → "双击收起节点"；否则 → "双击展开节点"。
        // 可展开判定用**可见性感知**的折叠成员数（foldedProducesCountsRef，
        // 实时读）：当前还有「折叠（不可见）的 produces 相邻成员」才显展开
        // 提示。=0（相邻成员都已可见，如 sub_analysis2.txt Artifact；或本就
        // 无 produces 成员，如 ResearchGoal 子节点走 next）则不出提示——双击
        // 是 no-op，不出 toast，避免误导。读 ref 而非 node.producesCount 是
        // 为了展开/折叠后即时反映（成员变可见后提示该消失/出现）。
        if (!(foldedProducesCountsRef.current?.get(node.id) ?? 0)) return null;
        const hints = producesHintsRef.current ?? scopeHintsRef.current;
        return node.producesExpanded
          ? (hints?.collapse ?? "Double-click to collapse")
          : (hints?.expand ?? "Double-click to expand");
      });

    // Live animation: d3-force's native rAF timer fires `on("tick")` at high
    // frequency while alpha > alphaMin. The layout does NOT drive ticks itself
    // nor add EXTRA_TICKS_PER_RENDER — it relies on this native cadence (the
    // layout's update() only restarts/reheats; the Renderer redraws on each
    // native tick via the React wrapper). That native ~1ms tick cadence over
    // the alpha 1→0.05 decay is the "float" feel: nodes drift continuously
    // toward rest rather than snapping. We mirror it exactly: one tick's DOM
    // write per native tick event (no extra ticks — those collapsed the float
    // into a near-instant jump).
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
    // (the mount effect ran it once on the empty layer), and apply the initial
    // caption visibility for the current zoom (so a freshly-built graph that
    // starts zoomed-out already has captions hidden, not flashing for a frame).
    if (interactive) {
      applyZoomAdaptation(1, edgeSel, interactive);
      // Gate on the live zoom vs the first-open baseline (default 1 before the
      // initial fit lands): captions stay hidden until zoomed in past fit×1.3.
      const currentScale = zoomTransform(ref.svgSel!.node() as Element).k || 1;
      applyNodeLabelVisibility(currentScale, nodeSel, ref.baselineScale);
      // Seed caption font at the zoom-1 fontInfoLevel so the first frame does
      // not pop when applyNodeLabelFontSize runs on the first zoom tick.
      if (ref.width && ref.height) {
        applyNodeLabelFontSize(1, nodeSel, nodeSize, ref.width * ref.height);
      }
    }

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

    // Fit once positions are settled — on BOTH a fresh build AND an
    // incremental expand/collapse. This is the behaviour the user observed in
    // the new Browser: after expanding a node the canvas re-fits to the
    // new, larger graph so every node stays visible with room instead of
    // overflowing into a cramped tangle. The post-layout fit adjusts so every
    // node is visible, but the current viewport centre is preserved (the graph
    // is not yanked to the canvas middle). We mirror that on an incremental
    // expand (noPan=true); a fresh build centres normally. Capped at 1.5×
    // inside fitAllFromRef so a small graph isn't blown up huge.
    let didFit = false;
    const onEnd = () => {
      if (didFit) return;
      didFit = true;
      simRef.current.fitAll?.(260, isIncremental);
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
    ref.edgeSel
      .classed("dimmed", (link: SimLink) => {
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        const bothHidden = Boolean(nodeDimmed.get(sourceId)) && Boolean(nodeDimmed.get(targetId));
        return !typePicked(link.type) || bothHidden;
      })
      // A "connecting" edge straddles the fog: one endpoint fogged (the entry
      // bridge node, e.g. Code) and one highlighted (the focus Artifact). It
      // must render (so the Artifact isn't an orphan) but read as faint — not
      // full-opacity (which would look highlighted) and not 0.14 (invisible).
      // The `.edge-faint` class gives it a mid 0.4 opacity.
      .classed("edge-faint", (link: SimLink) => {
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        const srcDim = Boolean(nodeDimmed.get(sourceId));
        const tgtDim = Boolean(nodeDimmed.get(targetId));
        return typePicked(link.type) && srcDim !== tgtDim;
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

  // Highlight the selected node. Mirrors the interaction model: selecting a
  // node only toggles its `selected` state for the highlight (the CSS
  // `selected-node` class flips the pulsing rings + halo) — the canvas itself
  // NEVER auto-pans or auto-zooms to the selection. The previous version
  // animated a centre-and-zoom on every
  // selection past the first, which read as "double-clicking a node to expand
  // it suddenly enlarges and centres the view" — because a double-click fires
  // a click (select) then a dblclick (expand → signature change → reset), so
  // the very next selection walked the pan/zoom path. Let the user pan/zoom
  // by hand; selection is a pure highlight.
  useEffect(() => {
    const ref = simRef.current;
    if (!ref.nodeSel) return;
    ref.nodeSel.classed("selected-node", (node: SimNode) => node.id === selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, signature]);

  return (
    <div className={interactive ? "memory-canvas" : "memory-canvas memory-canvas-thumb"} ref={hostRef}>
      <svg ref={svgRef} />
    </div>
  );
}