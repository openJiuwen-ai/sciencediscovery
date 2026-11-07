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
 * The same tree, read as rows.
 *
 * The tree answers "where did this come from"; the rows answer "what did it
 * score". Both are one selection, so pressing a row highlights the node and
 * opens the drawer, exactly as pressing the node does.
 *
 * The handoff sorts this list by time. That column is deliberately absent: the
 * list is in node order, which is the order the expanded events arrived in, so
 * a second ordering would only disagree with the tree beside it.
 */

import type { EvolveCandidateView } from "../../evolve/model.js";
import { formatScore } from "../../evolve/model.js";
import { TEXT } from "../../text.js";
import { CrownGlyph } from "./glyphs.js";

export interface EvolveNodeListProps {
  bestIndex?: number;
  candidates: EvolveCandidateView[];
  onSelect: (index: number) => void;
  selectedIndex?: number;
}

export function EvolveNodeList({ bestIndex, candidates, onSelect, selectedIndex }: EvolveNodeListProps) {
  const rows = [...candidates].sort((left, right) => left.nodeIndex - right.nodeIndex);
  return <div className="evolve-node-list">
    <header className="evolve-node-list-head">{TEXT.evolve.detail.nodeList}</header>
    {rows.length === 0
      ? <p className="evolve-tree-empty">{TEXT.evolve.detail.treeEmpty}</p>
      : <ol className="evolve-node-rows">
        {rows.map((candidate, at) => {
          const best = candidate.nodeIndex === bestIndex && candidate.valid;
          const score = candidate.gateScore ?? candidate.score;
          const tone = !candidate.valid
            ? "failed"
            : best
              ? "best"
              : candidate.gateScore === undefined ? "quiet" : "significant";
          return <li key={candidate.nodeIndex}>
            <button
              aria-pressed={candidate.nodeIndex === selectedIndex}
              className={`evolve-node-row is-${tone}${candidate.nodeIndex === selectedIndex ? " is-selected" : ""}`}
              onClick={() => onSelect(candidate.nodeIndex)}
              type="button"
            >
              <span aria-hidden="true" className="evolve-node-rank">{at + 1}.</span>
              <span aria-hidden="true" className="evolve-node-dot" />
              <span className="evolve-node-name">
                <span className="evolve-node-title">
                  {TEXT.evolve.detail.nodeTitle(candidate.nodeIndex)}
                  {best ? <span className="evolve-node-best">
                    <CrownGlyph size={13} />
                    {TEXT.evolve.detail.bestTag}
                  </span> : null}
                </span>
                <span className="evolve-node-gen">{TEXT.evolve.detail.generation(candidate.depth)}</span>
              </span>
              <span className="evolve-node-score">
                {candidate.valid ? formatScore(score) : "-"}
              </span>
            </button>
          </li>;
        })}
      </ol>}
  </div>;
}
