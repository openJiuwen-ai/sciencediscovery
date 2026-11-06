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
 * The session's searches, as a single line under its header.
 *
 * A search is the only thing this app produces that keeps running after the
 * turn that started it has ended, and closing the panel must not make it
 * unreachable. A full card in the transcript would be wrong — the search is
 * not a message — so the shelf is a thin, always-visible handle: what is
 * running, how far along it is, and the way back into the panel.
 *
 * It renders nothing when the session has no searches, so a conversation that
 * never used evolve looks exactly as it did before.
 */

import { useState } from "react";
import { isEvolveRunActive, type EvolveRun } from "@sciencediscovery/schema";

import { evolveShortTitle } from "../../evolve/model.js";
import { evolveStatusLabel, evolveStatusTone } from "../../evolve/status.js";
import { TEXT } from "../../text.js";
import { EvolveGlyph, PlusGlyph } from "./glyphs.js";

/** How many searches the shelf shows before folding the rest behind a count.
 *  Running ones are never folded: a search nobody can see is the thing this
 *  row exists to prevent. */
const VISIBLE = 3;

export interface EvolveShelfProps {
  onNew: () => void;
  onOpen: (runId: string) => void;
  runs: EvolveRun[];
}

export function EvolveShelf({ onNew, onOpen, runs }: EvolveShelfProps) {
  const [expanded, setExpanded] = useState(false);
  if (runs.length === 0) return null;

  // Running first, then newest. `createdAt` is ISO, so the string comparison is
  // the chronology; a locale-aware date parse here would only add a way to be
  // wrong about an unparseable timestamp.
  const ordered = [...runs].sort((left, right) => {
    const leftActive = isEvolveRunActive(left.status) ? 0 : 1;
    const rightActive = isEvolveRunActive(right.status) ? 0 : 1;
    if (leftActive !== rightActive) return leftActive - rightActive;
    return right.createdAt.localeCompare(left.createdAt);
  });
  const active = ordered.filter((run) => isEvolveRunActive(run.status));
  const shown = expanded ? ordered : ordered.slice(0, VISIBLE);
  const hidden = ordered.length - shown.length;

  return (
    <section aria-label={TEXT.evolve.title} className="evolve-shelf">
      <div className="evolve-shelf-id">
        <span aria-hidden="true" className="evolve-shelf-mark">
          <EvolveGlyph size={16} />
        </span>
        <span className="evolve-shelf-label">
          <strong>{TEXT.evolve.title}</strong>
          <span>
            {active.length > 0
              ? TEXT.evolve.runningCount(active.length)
              : TEXT.evolve.shelfHint}
          </span>
        </span>
      </div>

      <div className="evolve-shelf-runs">
        {shown.map((run) => <button
          className={`evolve-chip${isEvolveRunActive(run.status) ? " is-live" : ""}`}
          key={run.id}
          onClick={() => onOpen(run.id)}
          title={[
            run.goal.statement,
            evolveStatusLabel(run.status),
            ...(run.goal.checkpointMode === "auto" ? [TEXT.evolve.autoPaceTitle] : []),
            ...(run.goal.allowUnisolated === true ? [TEXT.evolve.unisolatedTitle] : []),
          ].join(" · ")}
          type="button"
        >
          <span className={`evolve-dot is-${evolveStatusTone(run.status)}`} aria-hidden="true" />
          <span className="evolve-chip-title">{evolveShortTitle(run.goal.statement)}</span>
          {run.goal.checkpointMode === "auto"
            ? <span className="evolve-chip-auto">{TEXT.evolve.autoPace}</span>
            : null}
          {run.goal.allowUnisolated === true
            ? <span className="evolve-chip-unisolated">{TEXT.evolve.unisolated}</span>
            : null}
          <span className="evolve-chip-meta">
            {run.candidates}/{run.goal.budget.expansions}
          </span>
        </button>)}
        {hidden > 0 ? <button className="evolve-chip is-more" onClick={() => setExpanded(true)} type="button">
          {TEXT.evolve.moreRuns(hidden)}
        </button> : null}
        {expanded && ordered.length > VISIBLE ? <button className="evolve-chip is-more" onClick={() => setExpanded(false)} type="button">
          {TEXT.evolve.fewerRuns}
        </button> : null}
      </div>

      <button className="evolve-shelf-new" onClick={onNew} type="button">
        <PlusGlyph />
        {TEXT.evolve.newRun}
      </button>
    </section>
  );
}
