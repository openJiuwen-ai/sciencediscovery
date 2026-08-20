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
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";

import type { MemoryGraphEdgeType, MemoryGraphNodeLabel, MemorySubgraph } from "@sciencediscovery/schema";

/**
 * One colour per node label. Kept in a plain map (not CSS variables) because
 * Cytoscape paints to a canvas and cannot resolve `var(--x)`.
 */
export const NODE_COLORS: Record<MemoryGraphNodeLabel, string> = {
  ResearchGoal: "#7c3aed",
  SubTask: "#2563eb",
  Paper: "#0891b2",
  Evidence: "#0d9488",
  Claim: "#ca8a04",
  Code: "#db2777",
  Artifact: "#16a34a",
};

export const EDGE_COLORS: Record<MemoryGraphEdgeType, string> = {
  produces: "#94a3b8",
  next: "#c4b5fd",
  extracts: "#67e8f9",
  supports: "#fdba74",
  stated_in: "#fcd34d",
  supersedes: "#a78bfa",
  input: "#5eead4",
};

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

// dagre is registered once for the module; Cytoscape throws if an extension
// name is registered twice, which HMR would otherwise trigger.
let dagreRegistered = false;
function registerDagre(): void {
  if (dagreRegistered) return;
  cytoscape.use(dagre);
  dagreRegistered = true;
}

/**
 * Layered layout, flowing left to right.
 *
 * The graph is a run: a `next` chain of SubTasks with a Code and an Artifact
 * hanging off each step. That is a hierarchy, and dagre orders nodes within
 * each rank to minimise crossings — measured against the old `breadthfirst`
 * on a synthetic 141-node run it holds crossings at zero while cutting the
 * longest/mean edge-length ratio from 1.46 to 1.19.
 *
 * `LR` rather than `TB` because the explorer panel is wide: top-to-bottom
 * turned a long chain into a 0.04 aspect-ratio sliver with the whole canvas
 * empty either side, which is most of what made the old picture feel sparse.
 *
 * Separations are derived rather than hardcoded: a three-node chain and a
 * fifty-node run want different spacing, and one fixed number is wrong for one
 * of them.
 */
function hierarchyLayout(nodeCount: number, nodeSize: number, interactive: boolean): cytoscape.LayoutOptions {
  const spread = Math.min(1.6, Math.max(0.85, 16 / Math.max(nodeCount, 1) + 0.7));
  return {
    name: "dagre",
    animate: false,
    edgeSep: nodeSize * 0.3 * spread,
    nodeSep: nodeSize * 1.1 * spread,
    padding: interactive ? 30 : 8,
    rankDir: "LR",
    rankSep: nodeSize * 1.5 * spread,
  } as cytoscape.LayoutOptions;
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
  const cyRef = useRef<Core | undefined>(undefined);
  // Keep the latest callback/data without forcing a graph rebuild every render.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const subgraphRef = useRef(subgraph);
  subgraphRef.current = subgraph;

  // The parent re-polls on a timer and hands us a fresh object each time. Key
  // the rebuild on the graph's *content* so an unchanged graph never re-runs
  // layout — otherwise the user's pan, zoom and selection reset every poll.
  const signature = useMemo(() => JSON.stringify([
    subgraph.nodes.map((node) => `${node.id}:${node.label}:${String(node.extra?.status ?? "")}`).sort(),
    subgraph.edges.map((edge) => `${edge.source}>${edge.target}:${edge.type}`).sort(),
  ]), [subgraph]);

  // Build/rebuild the graph only when the data itself changes. Filtering and
  // selection are applied separately below so the layout never jumps.
  useEffect(() => {
    if (!hostRef.current) return;
    registerDagre();
    const subgraph = subgraphRef.current;
    const done = new Set(["succeeded", "success", "completed", "done", "ok"]);
    // Big enough to hold a caption inside; the thumbnail stays a plain dot.
    const nodeSize = interactive ? 46 : 12;
    const displayNames = graphNodeDisplayNames(subgraph.nodes);
    const nodes: ElementDefinition[] = subgraph.nodes.map((node) => {
      const status = typeof node.extra?.status === "string" ? node.extra.status.toLowerCase() : "";
      // Only work that reports an unfinished status is drawn as pending.
      // Statusless nodes (artifacts, papers, …) are facts, not "incomplete".
      return {
        classes: status && !done.has(status) ? "pending" : "",
        data: { id: node.id, label: node.label, name: displayNames.get(node.id) ?? graphNodeName(node) },
      };
    });
    const known = new Set(subgraph.nodes.map((node) => node.id));
    const edges: ElementDefinition[] = subgraph.edges
      // `supersedes` (Artifact version → previous version) is written to the
      // graph but not drawn here — version history is out of scope for the
      // chain/canvas view. Dropped before layout so it never claims rank
      // space, and absent from the Relationships filter list upstream.
      .filter((edge) => edge.type !== "supersedes" && known.has(edge.source) && known.has(edge.target))
      .map((edge, index) => ({
        data: { id: `e${index}`, source: edge.source, target: edge.target, type: edge.type },
      }));

    const cy = cytoscape({
      container: hostRef.current,
      elements: [...nodes, ...edges],
      autoungrabify: !interactive,
      boxSelectionEnabled: false,
      userPanningEnabled: interactive,
      userZoomingEnabled: interactive,
      minZoom: 0.2,
      maxZoom: 2.5,
      style: [
        {
          selector: "node",
          style: {
            "background-color": (element: cytoscape.NodeSingular) => NODE_COLORS[element.data("label") as MemoryGraphNodeLabel] ?? "#64748b",
            width: nodeSize,
            height: nodeSize,
            label: "data(name)",
            "font-size": interactive ? 8 : 6,
            // Neo4j Browser writes the caption inside the disc. Doing the same
            // frees the space between nodes, which is what previously forced
            // the layout wide enough to keep outside labels from colliding.
            color: interactive ? "#ffffff" : "#334155",
            "text-valign": interactive ? "center" : "bottom",
            "text-halign": "center",
            "text-margin-y": interactive ? 0 : 3,
            "text-max-width": interactive ? `${nodeSize - 10}px` : "56px",
            "text-wrap": interactive ? "wrap" : "ellipsis",
            "text-overflow-wrap": "anywhere",
            "font-weight": interactive ? 600 : 400,
            "background-opacity": 1,
            "border-width": interactive ? 2 : 1.2,
            "border-style": "solid",
            "border-color": "#ffffff",
          },
        },
        {
          selector: "edge",
          style: {
            // `next` is the spine of the run; `produces` hangs off each step.
            // Weighting them the same made the spine impossible to trace.
            width: (element: cytoscape.EdgeSingular) => {
              const type = element.data("type") as MemoryGraphEdgeType;
              const weight = type === "next" ? 2.6 : type === "produces" ? 1.1 : 1.6;
              return interactive ? weight : weight * 0.6;
            },
            "line-color": (element: cytoscape.EdgeSingular) => EDGE_COLORS[element.data("type") as MemoryGraphEdgeType] ?? "#cbd5e1",
            "target-arrow-color": (element: cytoscape.EdgeSingular) => EDGE_COLORS[element.data("type") as MemoryGraphEdgeType] ?? "#cbd5e1",
            "target-arrow-shape": "triangle",
            "arrow-scale": interactive ? 0.9 : 0.5,
            "curve-style": "bezier",
          },
        },
        // Still-running / failed work reads as a hollow dashed outline, so a
        // solid dot always means "settled". No extra ring is needed.
        {
          selector: "node.pending",
          style: {
            "background-opacity": 0.18,
            "border-style": "dashed",
            "border-width": interactive ? 2.5 : 1.6,
            "border-color": (element: cytoscape.NodeSingular) => NODE_COLORS[element.data("label") as MemoryGraphNodeLabel] ?? "#64748b",
          },
        },
        { selector: "node.search-hit", style: { "border-color": "#f59e0b", "border-style": "solid", "border-width": 5, "font-weight": "bold" } },
        {
          selector: "node.selected-node",
          style: { "border-color": "#1d4ed8", "border-style": "solid", "border-width": 4, width: nodeSize * 1.3, height: nodeSize * 1.3 },
        },
        { selector: ".dimmed", style: { opacity: 0.14, "text-opacity": 0 } },
      ],
      layout: hierarchyLayout(subgraph.nodes.length, nodeSize, interactive),
    });

    if (interactive) {
      cy.on("tap", "node", (event) => onSelectRef.current?.(event.target.id() as string));
    }
    cyRef.current = cy;

    // The container is often still animating (modal open) or zero-sized when
    // Cytoscape first measures it, which leaves the graph crammed in a corner.
    // Re-fit whenever the box actually changes size.
    const host = hostRef.current;
    // Fit, then cap the zoom: a 3-node graph fitted to a big panel would
    // otherwise blow the nodes up until their labels collide.
    const fit = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      cy.resize();
      cy.fit(undefined, interactive ? 30 : 8);
      const cap = interactive ? 1.5 : 1.1;
      if (cy.zoom() > cap) { cy.zoom(cap); cy.center(); }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => { observer.disconnect(); cy.destroy(); cyRef.current = undefined; };
  }, [interactive, signature]);

  // Filtering: dim rather than remove, so the layout stays stable and the user
  // keeps their spatial bearings while toggling categories.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const categoryFiltered = Boolean(visibleLabels || visibleEdgeTypes);
    cy.batch(() => {
      // Picking an edge type is a statement about the relationship, so the two
      // nodes it connects come along with it. Node and edge filters therefore
      // union: a node survives if its own label was picked *or* it is an
      // endpoint of a picked relationship.
      const typePicked = (edge: cytoscape.EdgeSingular): boolean =>
        !visibleEdgeTypes || visibleEdgeTypes.has(edge.data("type") as MemoryGraphEdgeType);
      const pulledIn = new Set<string>();
      if (visibleEdgeTypes) {
        cy.edges().forEach((edge) => {
          if (!visibleEdgeTypes.has(edge.data("type") as MemoryGraphEdgeType)) return;
          pulledIn.add(edge.source().id());
          pulledIn.add(edge.target().id());
        });
      }
      cy.nodes().forEach((node) => {
        const byLabel = visibleLabels ? visibleLabels.has(node.data("label") as MemoryGraphNodeLabel) : false;
        const kept = !categoryFiltered || byLabel || pulledIn.has(node.id());
        // A search narrows on top of the category filters: both must pass.
        const searchHidden = matchIds ? !matchIds.has(node.id()) : false;
        node.toggleClass("dimmed", !kept || searchHidden);
        node.toggleClass("search-hit", !!matchIds && matchIds.has(node.id()));
      });
      cy.edges().forEach((edge) => {
        // An edge is only meaningful when both endpoints are still visible.
        const endpointHidden = edge.source().hasClass("dimmed") || edge.target().hasClass("dimmed");
        edge.toggleClass("dimmed", !typePicked(edge) || endpointHidden);
      });
    });
  }, [matchIds, signature, visibleEdgeTypes, visibleLabels]);

  // Dimming alone leaves the surviving nodes as a small island in a mostly
  // greyed-out canvas. Zoom to what survived the filter, and zoom back out when
  // the filter is cleared, so narrowing actually reads as narrowing. Runs after
  // the effect above so the "dimmed" classes are already settled.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !interactive) return;
    const filtered = Boolean(visibleLabels || visibleEdgeTypes || matchIds);
    const target = filtered ? cy.nodes().not(".dimmed") : cy.nodes();
    // Everything filtered out: keep the current view rather than fitting to nothing.
    if (!target.length) return;
    cy.stop();
    cy.animate({ fit: { eles: target, padding: 60 } }, {
      duration: 260,
      easing: "ease-out",
      // Fitting one or two survivors would otherwise magnify them past the cap
      // the initial layout uses.
      complete: () => {
        if (cy.destroyed() || cy.zoom() <= 1.5) return;
        cy.zoom(1.5);
        cy.center(target);
      },
    });
  }, [interactive, matchIds, signature, visibleEdgeTypes, visibleLabels]);

  // Highlight the selected node, and on subsequent selections (after the
  // initial layout fit) pan/zoom the canvas so the node is centered and
  // visible. This is what makes a Provenance parent-link click in the explorer
  // feel like "jump to that node" rather than "highlight off-screen". The
  // first selection after a graph rebuild is skipped so it doesn't fight the
  // freshly-run layout fit; manual taps land on already-visible nodes and the
  // pan is a gentle re-center rather than a jump.
  const didInitialSelectionRef = useRef(false);
  useEffect(() => { didInitialSelectionRef.current = false; }, [signature]);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("selected-node");
    if (!selectedId) return;
    const ele = cy.getElementById(selectedId);
    ele.addClass("selected-node");
    if (!didInitialSelectionRef.current) {
      didInitialSelectionRef.current = true;
      return;
    }
    if (ele.empty() || ele.hasClass("dimmed")) return;
    // Don't zoom out below a comfortable reading level when the user has panned
    // far out; bump the zoom floor rather than forcing a fixed zoom.
    const targetZoom = Math.max(cy.zoom(), 0.8);
    cy.stop();
    cy.animate({ center: { eles: ele }, zoom: targetZoom }, { duration: 260, easing: "ease-out" });
  }, [selectedId, signature]);

  return <div className={interactive ? "memory-canvas" : "memory-canvas memory-canvas-thumb"} ref={hostRef} />;
}
