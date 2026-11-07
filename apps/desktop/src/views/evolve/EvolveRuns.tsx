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
 * The session's searches, as cards at the foot of the transcript.
 *
 * A search is the only thing this app produces that keeps running after the
 * turn that started it has ended, and closing the panel must not make it
 * unreachable. The handoff draws that handle as the last card of the answer
 * that started the search — the run's name, how long it has been going and
 * what it is doing — so it lives in the conversation rather than in a bar
 * above it: it is what the conversation produced, and it scrolls with it.
 *
 * It renders nothing when the session has no searches, so a conversation that
 * never used evolve looks exactly as it did before.
 */

import { useEffect, useState } from "react";
import { isEvolveRunActive, type EvolveRun } from "@sciencediscovery/schema";

import { elapsedSeconds, evolveShortTitle } from "../../evolve/model.js";
import { evolveStatusLabel, evolveStatusTone } from "../../evolve/status.js";
import { TEXT } from "../../text.js";
import { EvolveTreeGlyph } from "./glyphs.js";

/** How many searches the transcript shows before folding the rest behind a
 *  count. Running ones are never folded, and at three cards the list is
 *  already taller than the answer above it. */
const VISIBLE = 3;

export interface EvolveRunsProps {
  onOpen: (runId: string) => void;
  runs: EvolveRun[];
}

export function EvolveRuns({ onOpen, runs }: EvolveRunsProps) {
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
  const shown = expanded ? ordered : ordered.slice(0, VISIBLE);
  const hidden = ordered.length - shown.length;

  return (
    <section aria-label={TEXT.evolve.title} className="evolve-runs">
      {shown.map((run) => <EvolveRunCard key={run.id} onOpen={onOpen} run={run} />)}
      {hidden > 0 ? (
        <button className="evolve-runs-more" onClick={() => setExpanded(true)} type="button">
          {TEXT.evolve.moreRuns(hidden)}
        </button>
      ) : null}
      {expanded && ordered.length > VISIBLE ? (
        <button className="evolve-runs-more" onClick={() => setExpanded(false)} type="button">
          {TEXT.evolve.fewerRuns}
        </button>
      ) : null}
    </section>
  );
}

/** One search as the handoff's card: the mark, what the search is called, how
 *  long it has been running, and what it is doing now. The whole card is the
 *  way into the cockpit — a card this size with a single clickable word in it
 *  would make the rest look decorative. */
function EvolveRunCard({ onOpen, run }: { onOpen: (runId: string) => void; run: EvolveRun }) {
  const active = isEvolveRunActive(run.status);
  useElapsedClock(active);
  const elapsed = elapsedSeconds(run);
  return (
    <button
      className="evolve-run-card"
      onClick={() => onOpen(run.id)}
      title={[
        run.goal.statement,
        evolveStatusLabel(run.status),
        ...(run.goal.checkpointMode === "auto" ? [TEXT.evolve.autoPaceTitle] : []),
      ].join(" · ")}
      type="button"
    >
      <span aria-hidden="true" className="evolve-run-mark">
        <EvolveTreeGlyph size={16} />
      </span>
      <span className="evolve-run-text">
        <span className="evolve-run-title">{evolveShortTitle(run.goal.statement)}</span>
        <span className="evolve-run-meta">
          <span className="evolve-run-elapsed">
            {elapsed === null ? TEXT.evolve.notStarted : TEXT.evolve.elapsed(elapsed)}
          </span>
          {run.goal.checkpointMode === "auto"
            ? <span className="evolve-chip-auto">{TEXT.evolve.autoPace}</span>
            : null}
        </span>
      </span>
      <span className={`evolve-run-state is-${evolveStatusTone(run.status)}`}>
        {active ? <span aria-hidden="true" className="evolve-run-spin"><BurstGlyph /></span> : null}
        {active ? TEXT.evolve.working : evolveStatusLabel(run.status)}
      </span>
    </button>
  );
}

/** Re-render once a second while the run is live, for the elapsed clock.
 *  A finished run's time never changes, so it costs nothing to freeze there. */
function useElapsedClock(active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => tick((count) => count + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
}

/** The spin the state chip turns while a search is live. Eight rays, so it
 *  reads as a turning spark rather than as a letter of the text beside it. */
function BurstGlyph() {
  return <svg fill="none" height="12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" viewBox="0 0 12 12" width="12">
    <path d="M6 1.2v9.6M1.2 6h9.6M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8" />
  </svg>;
}
