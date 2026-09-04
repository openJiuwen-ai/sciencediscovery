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
 * The island overview (openevolve only).
 *
 * Unlike the graph canvas (which shows every candidate as a node on a
 * timeline), this view shows the **MAP-Elites archive state** at a glance:
 *
 * - Each island is a **column** with its colour and a header showing the
 *   island number and how many candidates hold cells on it.
 * - Inside each column, the candidates that currently occupy cells are listed
 *   top-to-bottom by score (best at top). Each shows its iteration number,
 *   score, and cell coordinates `(complexity, diversity)`.
 * - Candidates that arrived via **migration** carry a `↔` badge with the
 *   source island, so the ring topology is visible.
 * - The global best is highlighted with a star.
 *
 * PUCT runs have no islands and no cells, so this component renders nothing
 * when the run is not `algorithm === "openevolve"`.
 */

import type { EvolveCandidateView, EvolveRunView } from "./model.js";

import { useLocale } from "../i18n/LocaleProvider.js";
import { SEARCH_COLORS } from "./search-graph-layout.js";

const ISLAND_COLOURS = SEARCH_COLORS.island;

export interface SearchCellGridProps {
  view: EvolveRunView;
  onSelectNode?: (nodeIndex: number) => void;
  selectedNodeIndex?: number;
}

export function SearchCellGrid({ view, onSelectNode, selectedNodeIndex }: SearchCellGridProps) {
  const { t } = useLocale();
  if (view.algorithm !== "openevolve") return null;

  // Collect candidates that hold a cell (have complexityBin from an inserted event).
  const occupied = view.candidates.filter(
    (c) => c.complexityBin !== undefined && c.diversityBin !== undefined,
  );

  if (occupied.length === 0) {
    return <div className="search-cell-grid-empty">{t("evolve.grid.empty")}</div>;
  }

  // Group by island.
  const islands = [...new Set(occupied.map((c) => c.island ?? 0))].sort((a, b) => a - b);
  const byIsland = new Map<number, EvolveCandidateView[]>();
  for (const c of occupied) {
    const island = c.island ?? 0;
    const list = byIsland.get(island) ?? [];
    list.push(c);
    byIsland.set(island, list);
  }

  // Sort each island's candidates by score (best first), failed last.
  for (const list of byIsland.values()) {
    list.sort((a, b) => {
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    });
  }

  // Collect migration info for the summary.
  const migrations = view.candidates.filter(
    (c) => c.migratedToIsland !== undefined || c.cellVia === "migration",
  );

  return (
    <div className="search-cell-grid" role="grid" aria-label={t("evolve.grid.caption")}>
      {/* Summary bar */}
      <div className="search-cell-grid-summary">
        <span className="search-cell-grid-summary-item">
          {islands.length} {t("evolve.grid.island")}
          {islands.length !== 1 ? "s" : ""}
        </span>
        <span className="search-cell-grid-summary-sep">·</span>
        <span className="search-cell-grid-summary-item">{occupied.length} cells occupied</span>
        {migrations.length > 0 ? (
          <>
            <span className="search-cell-grid-summary-sep">·</span>
            <span className="search-cell-grid-summary-item">{migrations.length} migrations {"↔"}</span>
          </>
        ) : null}
      </div>

      {/* Island columns */}
      <div className="search-cell-grid-islands">
        {islands.map((island) => {
          const colour = ISLAND_COLOURS[island % ISLAND_COLOURS.length];
          const candidates = byIsland.get(island) ?? [];
          return (
            <div key={island} className="search-cell-island" style={{ borderColor: colour }}>
              <div className="search-cell-island-header" style={{ color: colour }}>
                <span className="search-cell-island-dot" style={{ background: colour }} />
                {t("evolve.grid.island")} {island}
                <span className="search-cell-island-count">{candidates.length}</span>
              </div>
              <div className="search-cell-island-body">
                {candidates.map((c) => {
                  const isBest = view.bestNodeIndex === c.nodeIndex;
                  const isMigrated = c.cellVia === "migration";
                  const isSelected = selectedNodeIndex === c.nodeIndex;
                  return (
                    <button
                      key={c.nodeIndex}
                      type="button"
                      className={`search-cell-card ${isBest ? "search-cell-card-best" : ""} ${isMigrated ? "search-cell-card-migrated" : ""} ${isSelected ? "search-cell-card-selected" : ""}`}
                      onClick={() => onSelectNode?.(c.nodeIndex)}
                      title={`#${c.nodeIndex} · ${c.score === null ? "failed" : `score ${c.score.toFixed(4)}`} · cell(${c.complexityBin},${c.diversityBin})${isMigrated ? " · migrated" : ""}`}
                    >
                      <div className="search-cell-card-row">
                        <span className="search-cell-card-iter">#{c.nodeIndex}</span>
                        {isBest ? <span className="search-cell-card-star" title="global best">{"★"}</span> : null}
                        {isMigrated ? <span className="search-cell-card-mig" title="migrated">{"↔"}</span> : null}
                      </div>
                      <div className="search-cell-card-row">
                        <span className="search-cell-card-score">
                          {c.score === null ? "—" : c.score.toFixed(3)}
                        </span>
                        <span className="search-cell-card-cell">
                          ({c.complexityBin},{c.diversityBin})
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
