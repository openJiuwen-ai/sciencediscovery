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
 * The same search, as a table.
 *
 * Not a fallback and not a debug view: a canvas is unreachable to a keyboard and
 * invisible to a screen reader, so without this there is simply no way for some
 * users to read a search at all. It carries every channel the picture encodes —
 * rank, visits, depth, validity, refusal — because "you can get at the data, just
 * not the meaning" is not equivalence.
 */

import type { EvolveRunView } from "./model.js";

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

  return <table className="evolve-table">
    <caption className="visually-hidden">{t("evolve.table.caption")}</caption>
    <thead>
      <tr>
        <th scope="col">#</th>
        <th scope="col">{t("evolve.table.parent")}</th>
        <th scope="col">{t("evolve.table.depth")}</th>
        <th scope="col">{t("evolve.table.score")}</th>
        <th scope="col">{t("evolve.table.rank")}</th>
        <th scope="col">{t("evolve.table.visits")}</th>
        <th scope="col">{t("evolve.table.outcome")}</th>
      </tr>
    </thead>
    <tbody>
      {view.candidates.map((candidate) => {
        const rank = ranks.get(candidate.nodeIndex);
        const best = view.bestNodeIndex === candidate.nodeIndex;
        return <tr
          aria-selected={selectedIndex === candidate.nodeIndex}
          className={candidate.valid ? undefined : "evolve-table-invalid"}
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
          <td>{candidate.parentIndex === null ? "—" : `#${candidate.parentIndex}`}</td>
          <td>{candidate.depth}</td>
          <td>{candidate.score === null ? t("evolve.candidate.failed") : candidate.score.toFixed(4)}</td>
          <td>{rank === undefined ? "—" : `${Math.round(rank * 100)}%`}</td>
          <td>{candidate.visits}</td>
          <td>{outcome(candidate, t)}</td>
        </tr>;
      })}
    </tbody>
  </table>;
}

/** The three outcomes a reader has to be able to tell apart: it merged, a
 *  constraint refused it, or the gate did not find the gain significant. */
function outcome(
  candidate: EvolveRunView["candidates"][number],
  t: ReturnType<typeof useLocale>["t"],
): string {
  if (!candidate.valid) return t("evolve.candidate.failed");
  if (candidate.accepted === undefined) return "—";
  if (candidate.accepted) return t("evolve.table.accepted");
  return candidate.rejectedBy ?? t(`evolve.refusal.${candidate.category ?? "below-threshold"}`);
}
