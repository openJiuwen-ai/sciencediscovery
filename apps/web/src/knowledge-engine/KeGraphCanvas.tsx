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
import { useLocale } from "../i18n/index.js";

export interface KeGraphCanvasProps {
  graph: KeGraph;
  /** Positions are persisted per KB (localStorage), so this scopes the key. */
  kbId?: string | undefined;
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

/** Edge stroke width grows logarithmically with the support weight (Science
 *  Agent reference: `1 + min(3, log2(1 + weight))`). */
function edgeWidth(supportCount: number): number {
  return 1 + Math.min(3, Math.log2(1 + Math.max(1, supportCount)));
}

type SavedPositions = Record<string, { x: number; y: number }>;

function positionsKey(kbId: string | undefined): string {
  return `keGraphPos:${kbId ?? "default"}`;
}

function loadPositions(kbId: string | undefined): SavedPositions {
  try {
    const raw = globalThis.localStorage?.getItem(positionsKey(kbId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as SavedPositions;
  } catch {
    // Corrupt or unavailable storage → fresh layout.
  }
  return {};
}

function savePositions(kbId: string | undefined, cy: Core): void {
  try {
    // Merge over the stored record: the canvas may be showing a drilled
    // subgraph, and dropping every off-screen node's saved position would
    // lose the user's arrangement of the full graph.
    const positions: SavedPositions = { ...loadPositions(kbId) };
    cy.nodes().forEach((node) => {
      positions[node.id()] = { ...node.position() };
    });
    globalThis.localStorage?.setItem(positionsKey(kbId), JSON.stringify(positions));
  } catch {
    // Storage full/unavailable — positions simply won't persist.
  }
}

/**
 * Force-directed knowledge-graph canvas (cytoscape cose layout).
 * The canvas instance is recreated when the graph's STRUCTURE changes, and
 * node positions the user dragged are persisted per KB and restored after
 * each layout pass (Science Agent subject-graph behavior).
 */
export function KeGraphCanvas({ graph, kbId, onSelect, selectedId }: KeGraphCanvasProps) {
  const { t } = useLocale();
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

  // Types actually present drive the legend (color semantics are per-type).
  const legendTypes = useMemo(
    () => [...new Set(graph.entities.map((entity) => entity.type))].sort(),
    [graph],
  );

  useEffect(() => {
    if (!hostRef.current) return;
    const current = graphRef.current;
    const saved = loadPositions(kbId);
    const cy = cytoscape({
      container: hostRef.current,
      elements: [
        ...current.entities.map((entity) => {
          const savedPosition = saved[entity.id];
          return {
            data: {
              id: entity.id,
              label: entity.name,
              color: TYPE_COLORS[entity.type] ?? TYPE_COLORS["other"],
              size: nodeSize(entity.supportCount),
            },
            // Preset positions for previously dragged nodes; cose lays the rest.
            ...(savedPosition ? { position: { x: savedPosition.x, y: savedPosition.y } } : {}),
          };
        }),
        ...current.edges.map((edge) => ({
          data: {
            id: edge.id,
            source: edge.srcId,
            target: edge.dstId,
            label: edge.type,
            width: edgeWidth(edge.supportCount),
          },
        })),
      ],
      layout: {
        name: "cose",
        animate: false,
        nodeRepulsion: 12000,
        idealEdgeLength: 110,
        nodeOverlap: 16,
        padding: 30,
      },
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
            width: "data(width)",
          },
        },
        { selector: "node:selected", style: { "border-color": "#1d4ed8", "border-width": 4 } },
      ],
    });
    cy.on("tap", "node", (event) => {
      const id = event.target.id() as string;
      onSelectRef.current(id);
    });
    // Persist dragged positions (once per drop, for the whole visible graph).
    cy.on("dragfree", "node", () => savePositions(kbId, cy));
    // Test hook (DA precedent: window.__subjectGraph*): lets E2E journeys emit
    // a node tap deterministically instead of blind-clicking canvas pixels.
    (window as unknown as Record<string, unknown>).__keGraphCy = cy;
    cyRef.current = cy;
    return () => {
      delete (window as unknown as Record<string, unknown>).__keGraphCy;
      cy.destroy();
      cyRef.current = undefined;
    };
    // fingerprint captures structural change; graph itself is read via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, kbId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().unselect();
    if (selectedId) {
      cy.getElementById(selectedId).select();
    }
  }, [selectedId, fingerprint]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={hostRef} data-testid="ke-graph-canvas" style={{ width: "100%", height: "100%" }} />
      {legendTypes.length > 0 ? (
        <div
          data-testid="ke-graph-legend"
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            zIndex: 5,
            fontSize: 11,
            color: "var(--text-secondary, #475569)",
            background: "var(--surface, #ffffff)",
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: "var(--radius-m, 6px)",
            padding: "6px 10px",
            boxShadow: "var(--shadow-1, 0 1px 2px rgba(0,0,0,0.06))",
            maxWidth: 220,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("ke.legend.title")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
            {legendTypes.map((type) => (
              <span key={type} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: TYPE_COLORS[type] ?? TYPE_COLORS["other"],
                    display: "inline-block",
                  }}
                />
                {type}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
