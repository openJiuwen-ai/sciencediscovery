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
 * One row per expansion: where it came from, what it changed, what it scored,
 * and what happened to it.
 *
 * The fourth column is the reason this block exists. "The model returned
 * nothing", "the candidate crashed", "it broke a constraint" and "it did not
 * beat the best" are four different outcomes that a score column alone renders
 * identically — as a blank. Each one sends the user somewhere different, so
 * each is named, and the full error is one click away rather than in a log.
 */

import { useLocale } from "../i18n/LocaleProvider.js";

import type { EvolveCandidateView } from "./model.js";

export interface CandidateStreamProps {
  candidates: readonly EvolveCandidateView[];
  onSelect: (nodeIndex: number) => void;
  selectedIndex?: number;
}

export function CandidateStream({ candidates, onSelect, selectedIndex }: CandidateStreamProps) {
  const { t } = useLocale();
  const expansions = candidates.filter((candidate) => candidate.parentIndex !== null);

  return <div className="evolve-stream">
    <h3 className="evolve-block-title">{t("evolve.stream.title")}</h3>
    {expansions.length === 0
      ? <p className="evolve-chart-empty">{t("evolve.stream.empty")}</p>
      : <ul className="evolve-stream-list">
        {expansions.map((candidate) => <li key={candidate.nodeIndex}>
          <button
            aria-current={candidate.nodeIndex === selectedIndex}
            className={`evolve-stream-row${candidate.nodeIndex === selectedIndex ? " is-selected" : ""}`}
            onClick={() => onSelect(candidate.nodeIndex)}
            type="button"
          >
            <span className="evolve-stream-index">#{candidate.nodeIndex}</span>
            <span className="evolve-stream-parent">
              {t("evolve.stream.parent")} #{candidate.parentIndex}
            </span>
            <span className="evolve-stream-summary">
              {candidate.changeSummary || candidate.error || "—"}
            </span>
            <span className="evolve-stream-score">
              {candidate.score === null ? "—" : candidate.score.toFixed(4)}
            </span>
            <span className={`evolve-stream-verdict evolve-verdict-${verdictOf(candidate)}`}>
              {verdictLabel(candidate, t)}
            </span>
          </button>
        </li>)}
      </ul>}
  </div>;
}

/** Exported: which of the four outcomes a row is showing is the whole point of
 *  the block, and it is worth pinning without a DOM. */
export function verdictOf(candidate: EvolveCandidateView): string {
  if (candidate.accepted) return "accepted";
  if (!candidate.valid) return candidate.category === "constraint-violated" ? "violated" : "failed";
  return candidate.category === "constraint-violated" ? "violated" : "rejected";
}

function verdictLabel(
  candidate: EvolveCandidateView,
  t: (key: never) => string,
): string {
  const verdict = verdictOf(candidate);
  if (verdict === "accepted") return t("evolve.stream.accepted" as never);
  if (verdict === "violated") {
    // The constraint's own id, when there is one: "too slow" and "too big" send
    // the user to different edits, and "constraint" tells them neither.
    return candidate.rejectedBy ?? t("evolve.refusal.constraint-violated" as never);
  }
  if (verdict === "failed") return t("evolve.refusal.candidate-failed" as never);
  return t("evolve.refusal.below-threshold" as never);
}
