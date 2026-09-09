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

import type { CSSProperties } from "react";

import type { KeGraphRoots } from "../api/knowledge-engine.js";

export interface KeRootsViewProps {
  roots: KeGraphRoots;
  onSelectCommunity: (communityId: number) => void;
}

const PALETTE = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#be185d", "#4d7c0f"];

/**
 * Community-bubble overview: one bubble per Louvain community, sized by
 * member count. This is the entry level of the progressive drill-down
 * (roots → community members → entity focus). Inter-community relation
 * strength is summarized under each bubble pair count — the member view
 * shows the actual edges.
 */
export function KeRootsView({ roots, onSelectCommunity }: KeRootsViewProps) {
  const maxSize = Math.max(1, ...roots.communities.map((community) => community.size));
  return (
    <div data-testid="ke-roots" style={{ padding: 24, overflowY: "auto" }}>
      <div style={{ color: "#64748b", fontSize: 13, marginBottom: 16 }}>
        {roots.entityCount} entities · {roots.edgeCount} edges · {roots.communities.length} communities
        {roots.method === "entity-type" ? " (grouped by type — graph too large for Louvain)" : ""}
        {" — "}click a community to drill in
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center" }}>
        {roots.communities.map((community, index) => {
          const diameter = 72 + Math.round(88 * Math.sqrt(community.size / maxSize));
          const color = PALETTE[index % PALETTE.length];
          const style: CSSProperties = {
            width: diameter,
            height: diameter,
            borderRadius: "50%",
            background: `${color}1a`,
            border: `2px solid ${color}`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            padding: 8,
            textAlign: "center",
            overflow: "hidden",
          };
          const bridgeWeight = roots.communityEdges
            .filter((edge) => edge.source === community.id || edge.target === community.id)
            .reduce((sum, edge) => sum + edge.weight, 0);
          return (
            <button
              key={community.id}
              type="button"
              data-testid={`ke-community-${community.id}`}
              title={`${community.size} entities · ${bridgeWeight} cross-community support · top: ${community.topEntities
                .map((entity) => entity.name)
                .join(", ")}`}
              onClick={() => onSelectCommunity(community.id)}
              style={style}
            >
              <span style={{ fontWeight: 600, fontSize: 13, color }}>{community.name}</span>
              <span style={{ fontSize: 12, color: "#64748b" }}>{community.size} entities</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
