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

import type { EvolveRunView } from "./model.js";
import {
  diffGraph,
  layoutSearchGraph,
  nodeId,
  SEARCH_COLORS,
  type PositionedEdge,
  type PositionedNode,
  type SearchGraphLayout,
} from "./search-graph-layout.js";

export interface SearchGraphCanvasProps {
  onSelect?: (nodeIndex: number) => void;
  selectedIndex?: number;
  view: EvolveRunView;
}

export function SearchGraphCanvas({ onSelect, selectedIndex, view }: SearchGraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const layoutRef = useRef<SearchGraphLayout | undefined>(undefined);
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
      // Only the scale cap can get here: the drawn set changed, so positions
      // were computed for different candidates and the canvas starts over.
      cy.elements().remove();
      cy.add(toElements(next.nodes, next.edges));
      fit(cy);
    } else {
      if (diff.added.nodes.length || diff.added.edges.length) {
        cy.add(toElements(diff.added.nodes, diff.added.edges));
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
      // Only fit while the picture is still small enough that fitting is not
      // itself a jump; after that the user owns the viewport.
      if (diff.added.nodes.length && next.nodes.length <= 12) fit(cy);
    }
    layoutRef.current = next;
  }, [view]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("selected-node");
    if (selectedIndex !== undefined) cy.$id(nodeId(selectedIndex)).addClass("selected-node");
  }, [selectedIndex, view]);

  return <div className="evolve-canvas" ref={hostRef} />;
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

function fit(cy: Core): void {
  cy.resize();
  cy.fit(undefined, 30);
  if (cy.zoom() > 1.4) {
    cy.zoom(1.4);
    cy.center();
  }
}
