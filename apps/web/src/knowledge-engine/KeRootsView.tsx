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
import { useLocale } from "../i18n/index.js";

export interface KeRootsViewProps {
  roots: KeGraphRoots;
  onSelectCommunity: (communityId: number) => void;
}

/** Community bubble palette (Science Agent reference: AntV-G6 category hues). */
const PALETTE = [
  "#5B8FF9", "#5AD8A6", "#5D7092", "#F6BD16", "#E8684A",
  "#6DC8EC", "#9270CA", "#FF9D4D", "#269A99", "#A7B7C7",
];

/**
 * Community-bubble overview: one bubble per Louvain community, sized by
 * member count. This is the entry level of the progressive drill-down
 * (roots → community members → entity focus). Inter-community relation
 * strength is summarized in each bubble's tooltip — the member view shows
 * the actual edges.
 */
export function KeRootsView({ roots, onSelectCommunity }: KeRootsViewProps) {
  const { t } = useLocale();
  const maxSize = Math.max(1, ...roots.communities.map((community) => community.size));
  return (
    <div data-testid="ke-roots" style={{ padding: 24, overflowY: "auto", height: "100%", boxSizing: "border-box" }}>
      <div style={{ color: "var(--text-secondary, #64748b)", fontSize: 13, marginBottom: 16 }}>
        {t("ke.roots.summary", {
          entities: roots.entityCount,
          edges: roots.edgeCount,
          count: roots.communities.length,
        })}
        {roots.method === "entity-type" ? t("ke.roots.groupedByType") : ""}
        {" — "}
        {t("ke.roots.drillHint")}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center" }}>
        {roots.communities.map((community, index) => {
          const diameter = Math.min(160, 64 + Math.round(72 * Math.sqrt(community.size / maxSize)));
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
              title={t("ke.roots.bubbleTip", {
                size: community.size,
                weight: bridgeWeight,
                names: community.topEntities.map((entity) => entity.name).join(", "),
              })}
              onClick={() => onSelectCommunity(community.id)}
              style={style}
            >
              <span style={{ fontWeight: 600, fontSize: 13, color }}>{community.name}</span>
              <span style={{ fontSize: 12, color: "var(--text-secondary, #64748b)" }}>
                {t("ke.roots.bubbleSize", { size: community.size })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
