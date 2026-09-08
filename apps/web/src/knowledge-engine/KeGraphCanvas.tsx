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

import cytoscape, { type Core } from "cytoscape";
import { useEffect, useMemo, useRef } from "react";

import type { KeGraph } from "../api/knowledge-engine.js";

export interface KeGraphCanvasProps {
  graph: KeGraph;
  onSelect: (entityId: string) => void;
  selectedId?: string | undefined;
}

/** Deterministic per-type palette (colorblind-leaning). */
const TYPE_COLORS: Record<string, string> = {
  virus: "#7c3aed",
  protein: "#2563eb",
  antibody: "#059669",
  gene: "#0891b2",
  epitope: "#65a30d",
  "cell-line": "#ca8a04",
  assay: "#ea580c",
  drug: "#dc2626",
  method: "#db2777",
  dataset: "#4f46e5",
  "host-factor": "#0d9488",
  disease: "#b91c1c",
  other: "#64748b",
};

function nodeSize(supportCount: number): number {
  return Math.min(14 + Math.sqrt(supportCount) * 8, 44);
}

/**
 * Force-directed knowledge-graph canvas (cytoscape cose layout).
 * The canvas instance is recreated when the graph DATA changes (W1 keeps
 * updates coarse; progressive drill-down arrives with the W4 wave).
 */
export function KeGraphCanvas({ graph, onSelect, selectedId }: KeGraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // Rebuild the canvas only when the graph's STRUCTURE changes — polling
  // hands us a fresh object identity every cycle with identical content,
  // and recreating the instance on that cadence would flicker the layout
  // and lose the user's pan/zoom on every tick.
  const fingerprint = useMemo(() => {
    const entities = graph.entities.map((entity) => `${entity.id}:${entity.supportCount}:${entity.communityId ?? ""}`).join("|");
    const edges = graph.edges.map((edge) => `${edge.id}:${edge.supportCount}`).join("|");
    return `${entities}#${edges}`;
  }, [graph]);

  useEffect(() => {
    if (!hostRef.current) return;
    const current = graphRef.current;
    const cy = cytoscape({
      container: hostRef.current,
      elements: [
        ...current.entities.map((entity) => ({
          data: {
            id: entity.id,
            label: entity.name,
            color: TYPE_COLORS[entity.type] ?? TYPE_COLORS["other"],
            size: nodeSize(entity.supportCount),
          },
        })),
        ...current.edges.map((edge) => ({
          data: { id: edge.id, source: edge.srcId, target: edge.dstId, label: edge.type },
        })),
      ],
      layout: { name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 90 },
      maxZoom: 2.5,
      minZoom: 0.1,
      wheelSensitivity: 0.3,
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
            "text-valign": "bottom",
            "text-margin-y": 4,
            "text-wrap": "ellipsis",
            "text-max-width": "120px",
            width: "data(size)",
          },
        },
        {
          selector: "edge",
          style: {
            "curve-style": "bezier",
            "line-color": "#cbd5e1",
            "font-size": 8,
            label: "data(label)",
            "text-rotation": "autorotate",
            color: "#94a3b8",
            width: 1.5,
          },
        },
        { selector: "node:selected", style: { "border-color": "#1d4ed8", "border-width": 4 } },
      ],
    });
    cy.on("tap", "node", (event) => {
      const id = event.target.id() as string;
      onSelectRef.current(id);
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = undefined;
    };
    // fingerprint captures structural change; graph itself is read via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().unselect();
    if (selectedId) {
      cy.getElementById(selectedId).select();
    }
  }, [selectedId, fingerprint]);

  return <div ref={hostRef} data-testid="ke-graph-canvas" style={{ width: "100%", height: "100%" }} />;
}
