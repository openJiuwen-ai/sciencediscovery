// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file or in this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses from this software is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

/**
 * The search, as a table.
 *
 * PUCT: tree-oriented — parent, depth, rank, visits, outcome.
 * OpenEvolve: evolution timeline — iteration, island, parent, score, cell, via, outcome.
 *
 * Three views do not repeat:
 * - Graph = spatial layout
 * - Grid = archive snapshot
 * - Table = chronological timeline
 */

import type { EvolveCandidateView, EvolveRunView } from "./model.js";

import { useLocale } from "../i18n/LocaleProvider.js";

import { rankScores } from "./search-graph-layout.js";

export interface SearchGraphTableProps {
  onSelect?: (nodeIndex: number) => void;
  selectedIndex?: number;
  view: EvolveRunView;
}

export function SearchGraphTable({ onSelect, selectedIndex, view }: SearchGraphTableProps) {
  const { t } = useLocale();
  const ranks = rankScores(view.candidates);
  const isOpenEvolve = view.algorithm === "openevolve";

  return <table className="evolve-table">
    <caption className="visually-hidden">{t("evolve.table.caption")}</caption>
    <thead>
      <tr>
        <th scope="col">#</th>
        <th scope="col">{t("evolve.table.parent")}</th>
        {isOpenEvolve ? (
          <>
            <th scope="col">{t("evolve.table.island")}</th>
            <th scope="col">{t("evolve.table.score")}</th>
            <th scope="col">{t("evolve.table.cell")}</th>
            <th scope="col">{t("evolve.table.via")}</th>
            <th scope="col">{t("evolve.table.outcome")}</th>
          </>
        ) : (
          <>
            <th scope="col">{t("evolve.table.depth")}</th>
            <th scope="col">{t("evolve.table.score")}</th>
            <th scope="col">{t("evolve.table.rank")}</th>
            <th scope="col">{t("evolve.table.visits")}</th>
            <th scope="col">{t("evolve.table.outcome")}</th>
          </>
        )}
      </tr>
    </thead>
    <tbody>
      {view.candidates.map((candidate) => {
        const rank = ranks.get(candidate.nodeIndex);
        const best = view.bestNodeIndex === candidate.nodeIndex;
        const parentLabel = candidate.parentIndex === null ? "—" : `#${candidate.parentIndex}`;
        const scoreLabel = candidate.score === null
          ? (candidate.error ? candidate.error.slice(0, 40) : t("evolve.candidate.failed"))
          : candidate.score.toFixed(4);
        const outcomeLabel = best
          ? `★ ${t("evolve.table.accepted")}`
          : candidate.accepted === false
            ? (candidate.rejectedBy ?? candidate.category ?? t("evolve.table.rejected"))
            : candidate.valid ? "—" : (candidate.error ? candidate.error.slice(0, 40) : t("evolve.candidate.failed"));
        return <tr
          aria-selected={selectedIndex === candidate.nodeIndex}
          className={[
            candidate.valid ? undefined : "evolve-table-invalid",
            best ? "evolve-table-best" : undefined,
            candidate.cellVia === "migration" ? "evolve-table-migrated" : undefined,
          ].filter(Boolean).join(" ")}
          key={candidate.nodeIndex}
        >
          <th scope="row">
            <button
              className="evolve-table-index"
              onClick={() => onSelect?.(candidate.nodeIndex)}
              type="button"
            >
              {best ? "★ " : ""}#{candidate.nodeIndex}
            </button>
          </th>
          <td>{parentLabel}</td>
          {isOpenEvolve ? (
            <>
              <td className="evolve-table-island">
                <span className="evolve-table-island-dot" data-island={candidate.island ?? 0} />
                {candidate.island ?? 0}
              </td>
              <td>{scoreLabel}</td>
              <td className="evolve-table-cell">
                {candidate.complexityBin !== undefined && candidate.diversityBin !== undefined
                  ? `(${candidate.complexityBin},${candidate.diversityBin})`
                  : "—"}
              </td>
              <td>{candidate.cellVia ?? "—"}</td>
              <td>{outcomeLabel}</td>
            </>
          ) : (
            <>
              <td>{candidate.depth}</td>
              <td>{scoreLabel}</td>
              <td>{rank === undefined ? "—" : `${Math.round(rank * 100)}%`}</td>
              <td>{candidate.visits}</td>
              <td>{outcomeLabel}</td>
            </>
          )}
        </tr>;
      })}
    </tbody>
  </table>;
}
