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
 * Every expansion, as a row the reader can scan.
 *
 * Newest first, because a live search grows at the end and the newest attempt
 * is the one being watched. The verdict column is the reason the table exists:
 * "the model returned nothing", "the candidate crashed", "it broke a
 * constraint" and "it lost on score" are four outcomes a bare number renders
 * identically — as a blank.
 *
 * The chart is the same data seen as a trajectory; this is the data seen as
 * records. Either one alone would leave the other question unanswered.
 */

import { useMemo, useState } from "react";

import type { EvolveCandidateView, Verdict } from "../../evolve/model.js";
import { formatScore, verdictOf } from "../../evolve/model.js";
import { TEXT } from "../../text.js";
import { SearchGlyph } from "./glyphs.js";

type Filter = "all" | "accepted" | "failed" | "rejected";

/** Above this the table draws the first slice and says how many are left. A
 *  search of 900 candidates is a table to query, not to scroll. */
const MAX_ROWS = 400;

export interface CandidateTableProps {
  candidates: readonly EvolveCandidateView[];
  onSelect: (nodeIndex: number) => void;
  selectedIndex?: number;
}

export function CandidateTable({ candidates, onSelect, selectedIndex }: CandidateTableProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const result = { accepted: 0, all: candidates.length, failed: 0, rejected: 0 };
    for (const candidate of candidates) {
      if (candidate.parentIndex === null) continue;
      const verdict = verdictOf(candidate);
      if (verdict === "accepted") result.accepted += 1;
      else if (verdict === "failed") result.failed += 1;
      else result.rejected += 1;
    }
    return result;
  }, [candidates]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...candidates]
      .sort((left, right) => right.nodeIndex - left.nodeIndex)
      .filter((candidate) => {
        if (filter !== "all" && candidate.parentIndex !== null) {
          const verdict = verdictOf(candidate);
          if (filter === "accepted" && verdict !== "accepted") return false;
          if (filter === "failed" && verdict !== "failed") return false;
          if (filter === "rejected" && verdict !== "rejected" && verdict !== "violated") return false;
        }
        if (needle === "") return true;
        return [
          `#${candidate.nodeIndex}`,
          String(candidate.nodeIndex),
          candidate.parentIndex === null ? "" : `#${candidate.parentIndex}`,
          candidate.changeSummary ?? "",
          candidate.error ?? "",
          candidate.rejectedBy ?? "",
          candidate.category ?? "",
        ].some((value) => value.toLocaleLowerCase().includes(needle));
      });
  }, [candidates, filter, query]);

  const shown = filtered.slice(0, MAX_ROWS);

  return <div className="evolve-table">
    <div className="evolve-table-toolbar">
      <div aria-label={TEXT.evolve.table.title} className="evolve-filters" role="group">
        {(["all", "accepted", "rejected", "failed"] as const).map((key) => <button
          aria-pressed={filter === key}
          className="evolve-filter"
          key={key}
          onClick={() => setFilter(key)}
          type="button"
        >
          {filterLabel(key)}
          <span>{counts[key]}</span>
        </button>)}
      </div>
      <label className="evolve-search">
        <SearchGlyph />
        <input
          aria-label={TEXT.evolve.table.search}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={TEXT.evolve.table.search}
          value={query}
        />
      </label>
    </div>

    <div className="evolve-table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">{TEXT.evolve.table.node}</th>
            <th scope="col">{TEXT.evolve.table.parent}</th>
            <th scope="col">{TEXT.evolve.table.change}</th>
            <th className="is-number" scope="col">{TEXT.evolve.table.score}</th>
            <th scope="col">{TEXT.evolve.table.verdict}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((candidate) => {
            const root = candidate.parentIndex === null;
            const verdict = verdictOf(candidate);
            const selected = candidate.nodeIndex === selectedIndex;
            return <tr
              aria-selected={selected}
              className={`evolve-row${selected ? " is-selected" : ""}${candidate.valid ? "" : " is-failed"}`}
              key={candidate.nodeIndex}
              onClick={() => onSelect(candidate.nodeIndex)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onSelect(candidate.nodeIndex);
              }}
              tabIndex={0}
            >
              <td className="evolve-cell-node">#{candidate.nodeIndex}</td>
              <td className="evolve-cell-parent">
                {root ? TEXT.evolve.table.root : `#${candidate.parentIndex}`}
              </td>
              <td className="evolve-cell-change" title={candidate.changeSummary || candidate.error}>
                {candidate.changeSummary || candidate.error || "—"}
              </td>
              <td className="evolve-cell-score">{formatScore(candidate.gateScore ?? candidate.score)}</td>
              <td className="evolve-cell-verdict">
                <span className={`evolve-verdict is-${root ? "root" : verdict}`}>
                  {root ? TEXT.evolve.table.root : verdictLabel(candidate, verdict)}
                </span>
              </td>
            </tr>;
          })}
        </tbody>
      </table>

      {shown.length === 0 ? <p className="evolve-table-empty">
        {candidates.length === 0 ? TEXT.evolve.table.empty : TEXT.evolve.table.noMatch}
      </p> : null}
      {shown.length < filtered.length ? <p className="evolve-table-note">
        {TEXT.evolve.table.truncated(shown.length, filtered.length)}
      </p> : null}
    </div>
  </div>;
}

function filterLabel(key: Filter): string {
  switch (key) {
    case "accepted":
      return TEXT.evolve.table.filterAccepted;
    case "rejected":
      return TEXT.evolve.table.filterRejected;
    case "failed":
      return TEXT.evolve.table.filterFailed;
    default:
      return TEXT.evolve.table.filterAll;
  }
}

function verdictLabel(candidate: EvolveCandidateView, verdict: Verdict): string {
  switch (verdict) {
    case "accepted":
      return TEXT.evolve.table.accepted;
    case "violated":
      // The constraint's own id, when there is one: "too slow" and "too big"
      // send the reader to different edits, and "constraint" says neither.
      return candidate.rejectedBy ?? TEXT.evolve.table.violated;
    case "failed":
      return TEXT.evolve.table.failed;
    default:
      return TEXT.evolve.table.rejected;
  }
}
