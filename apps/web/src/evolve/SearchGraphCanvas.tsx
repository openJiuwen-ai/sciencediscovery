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
 * The search tree, drawn incrementally.
 *
 * A thin host: every decision about where a node goes and what it looks like is
 * in `search-graph-layout.ts`, and this file applies the result. That split is
 * what makes the interesting behaviour testable without a DOM, and it is why
 * this component has no layout engine — Cytoscape runs with `preset` positions.
 *
 * Three rules it exists to keep:
 *
 * * **Appending a node never moves an existing one.** Coordinates are a formula
 *   over (depth, insertion order), not a solver's output.
 * * **A property change is a data patch, never a re-layout.** Visits, scores and
 *   a new best arrive constantly; each one re-running a layout would shuffle the
 *   picture under the user's cursor.
 * * **Pan, zoom and selection survive every update.** They are the user's state,
 *   not the data's.
 */

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { useEffect, useRef } from "react";

import { useLocale } from "../i18n/index.js";
import type { EvolveRunView } from "./model.js";
import {
  diffGraph,
  layoutSearchGraph,
  nodeId,
  SEARCH_COLORS,
  type PositionedEdge,
  type PositionedLabel,
  type PositionedNode,
  type SearchGraphLayout,
} from "./search-graph-layout.js";

export interface SearchGraphCanvasProps {
  autoFollow?: boolean;
  onSelect?: (nodeIndex: number) => void;
  selectedIndex?: number;
  view: EvolveRunView;
}

export function SearchGraphCanvas({ autoFollow = true, onSelect, selectedIndex, view }: SearchGraphCanvasProps) {
  const { t } = useLocale();
  const hostRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const layoutRef = useRef<SearchGraphLayout | undefined>(undefined);
  const userMovedRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!hostRef.current) return;
    const cy = cytoscape({
      autoungrabify: true,
      boxSelectionEnabled: false,
      container: hostRef.current,
      elements: [],
      layout: { name: "preset" },
      maxZoom: 2.5,
      minZoom: 0.15,
      wheelSensitivity: 0.3,
      zoomingEnabled: true,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            "border-color": "#ffffff",
            "border-width": 1.5,
            color: "#0f172a",
            "font-size": 10,
            height: "data(size)",
            label: "data(label)",
            "text-halign": "center",
            "text-valign": "center",
            "text-wrap": "wrap",
            width: "data(size)",
          },
        },
        // A failed expansion stays in the picture, dashed: it is a node in the
        // tree, and hiding it would make "the model returned nothing"
        // indistinguishable from "the program did not run".
        {
          selector: "node[?invalid]",
          style: { "border-color": SEARCH_COLORS.invalid, "border-style": "dashed", "border-width": 2 },
        },
        {
          selector: "node[?refused]",
          style: { "border-color": SEARCH_COLORS.refused, "border-style": "double", "border-width": 4 },
        },
        {
          selector: "node[?elected]",
          style: { "border-color": SEARCH_COLORS.elected, "border-width": 4 },
        },
        { selector: "node.selected-node", style: { "border-color": "#1d4ed8", "border-width": 4 } },
        {
          selector: 'node[type = "label"]',
          style: {
            "background-color": "transparent",
            "background-opacity": 0,
            "border-width": 0,
            color: "data(color)",
            "font-size": 12,
            "font-weight": "bold",
            height: 20,
            label: "data(label)",
            "text-halign": "right",
            "text-valign": "center",
            width: 50,
          },
        },
        {
          selector: "edge",
          style: {
            "curve-style": "bezier",
            "line-color": SEARCH_COLORS.edge,
            "target-arrow-color": SEARCH_COLORS.edge,
            "target-arrow-shape": "triangle",
            width: 1.4,
          },
        },
        {
          selector: 'edge[type = "inspires"]',
          style: { "line-color": SEARCH_COLORS.inspires, "line-style": "dotted", width: 1 },
        },
      ],
    });
    cy.on("tap", "node", (event) => {
      const index = Number(event.target.data("nodeIndex"));
      if (Number.isFinite(index)) onSelectRef.current?.(index);
    });
    // Track user viewport interaction so auto-fit stops fighting them.
    cy.on("viewport", () => {
      userMovedRef.current = true;
    });
    cy.on("dragfree", () => {
      userMovedRef.current = true;
    });
    cyRef.current = cy;
    layoutRef.current = undefined;
    return () => {
      cy.destroy();
      cyRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const next = layoutSearchGraph(view);
    const diff = diffGraph(layoutRef.current, next);

    if (diff.rebuild) {
      cy.elements().remove();
      cy.add(toElements(next.nodes, next.edges));
      cy.add(toLabelElements(next.labels));
      fit(cy);
    } else {
      if (diff.added.nodes.length || diff.added.edges.length) {
        cy.add(toElements(diff.added.nodes, diff.added.edges));
      }
      // Add/update labels (OpenEvolve island headers)
      const existingLabels = new Set(cy.nodes('[type = "label"]').map((n) => n.id()));
      const newLabels = next.labels.filter((l) => !existingLabels.has(l.id));
      if (newLabels.length) cy.add(toLabelElements(newLabels));
      for (const label of next.labels) {
        cy.$id(label.id).data({ color: label.color, label: label.text });
      }
      for (const node of diff.patched) {
        // A data patch, not a layout: the styling reads these fields, so the
        // node redraws in place.
        cy.$id(node.id).data({
          color: node.color,
          elected: node.elected,
          invalid: !node.valid,
          label: node.label,
          refused: node.refused,
          size: node.size,
          title: node.title,
        });
      }
      // Auto-fit while the user hasn't interacted with the viewport. After
      // they pan or zoom manually, respect their viewport — but add a "Fit"
      // button so they can always get back to seeing everything.
      // Auto-fit: if autoFollow is on and the user hasn't interacted,
      // follow the latest node by panning to it (not full fit, which would
      // jump too much). If autoFollow is off, only fit when no user interaction.
      if (diff.added.nodes.length) {
        if (autoFollow && !userMovedRef.current) {
          // Pan to the latest node so the user sees new candidates appear.
          const latest = diff.added.nodes[diff.added.nodes.length - 1];
          if (latest) {
            cy.animate({ center: { eles: cy.$id(latest.id) }, duration: 150 });
          }
        } else if (!autoFollow && !userMovedRef.current) {
          fit(cy);
        }
      }
    }
    layoutRef.current = next;
  }, [view]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("selected-node");
    if (selectedIndex !== undefined) cy.$id(nodeId(selectedIndex)).addClass("selected-node");
  }, [selectedIndex, view]);

  const handleFit = () => {
    userMovedRef.current = false;
    const cy = cyRef.current;
    if (cy) fit(cy);
  };

  return (
    <div className="evolve-canvas-wrap">
      <div className="evolve-canvas" ref={hostRef} />
      <div className="evolve-canvas-toolbar">
        <button type="button" className="evolve-canvas-btn" onClick={handleFit} title={t("evolve.fitView")}>
          {`⤢ ${t("evolve.fit")}`}
        </button>
      </div>
    </div>
  );
}

function toElements(nodes: PositionedNode[], edges: PositionedEdge[]): ElementDefinition[] {
  return [
    ...nodes.map((node) => ({
      data: {
        color: node.color,
        elected: node.elected,
        id: node.id,
        invalid: !node.valid,
        label: node.label,
        nodeIndex: node.nodeIndex,
        refused: node.refused,
        size: node.size,
        title: node.title,
      },
      position: { x: node.x, y: node.y },
    })),
    ...edges.map((edge) => ({
      data: { id: edge.id, source: edge.source, target: edge.target, type: edge.type },
    })),
  ];
}

function toLabelElements(labels: PositionedLabel[]): ElementDefinition[] {
  return labels.map((label) => ({
    data: {
      color: label.color,
      id: label.id,
      label: label.text,
      type: "label",
    },
    position: { x: label.x, y: label.y },
    selectable: false,
  }));
}

function fit(cy: Core): void {
  cy.resize();
  cy.fit(undefined, 20);
  // Allow zoom up to 2.0 so small runs don't look like dots.
  // Below 1.0 means the canvas shows more than the nodes need; above
  // means it zooms in. For a 12-candidate run the fit naturally lands
  // around 0.5–0.8, which is fine. For a 3-candidate run it would be
  // ~2.0, which makes nodes comfortably large.
  const zoom = cy.zoom();
  if (zoom > 2.0) {
    cy.zoom(2.0);
    cy.center();
  } else if (zoom < 0.3) {
    // Don't force a zoom-in on large runs — the user can pan. But set
    // a floor so nodes are at least ~10px (size 34 * 0.3 ≈ 10).
    cy.zoom(0.3);
    cy.center();
  }
}
