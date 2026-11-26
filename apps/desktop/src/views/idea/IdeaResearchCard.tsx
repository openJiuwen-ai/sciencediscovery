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
 * The session's Idea Tree research, as a card at the foot of the transcript.
 *
 * Same shape as an Evolve search card, because a running research is the same kind of
 * thing: something the conversation produced that keeps running after the turn that
 * started it. The whole card is the way into the task panel — a card this size with one
 * clickable word in it would make the rest decorative — and it carries no "open the
 * panel" control, exactly like the search card.
 *
 * It shows what the engine reported and nothing more: an unreported token count is not
 * shown as 0, and a phase the UI does not know is printed verbatim.
 */

import type { IdeaResearchState, IdeaResearchView } from "@sciencediscovery/schema";
import { TITLE_COLUMNS, truncateColumns } from "../../text/columns.js";
import { TEXT } from "../../text.js";
import { EvolveTreeGlyph } from "../evolve/glyphs.js";

const t = TEXT.ideaTree;

/** Title of the card: the objective's first line, folded to one short sentence.
 *  The cut follows the search card's rule, so a mixed list cuts and marks at the
 *  same width; the whole objective stays in the button's tooltip. */
export function ideaCardTitle(objective: string): string {
  const line = objective.replace(/\s+/g, " ").trim();
  if (!line) return t.heading;
  return truncateColumns(line, TITLE_COLUMNS);
}

/** The engine's phase names are a closed set; an unknown one is shown verbatim. */
export function ideaPhaseLabel(phase: string): string {
  return (t.phase as Record<string, string | undefined>)[phase] ?? phase;
}

export function ideaStatusLabel(status: IdeaResearchState["status"]): string {
  return (t.status as Record<string, string | undefined>)[status] ?? status;
}

/** The tone suffix the stylesheet colours the state chip by, mirroring the search card. */
export function ideaStatusTone(status: IdeaResearchState["status"]): string {
  switch (status) {
    case "running":
    case "pausing":
      return "live";
    case "completed":
      return "good";
    case "interrupted":
      return "warn";
    case "budget_exhausted":
      return "warn";
    case "ended":
      return "quiet";
    default:
      return "quiet";
  }
}

export function isIdeaResearchActive(status: IdeaResearchState["status"]): boolean {
  return status === "running" || status === "pausing";
}

/** The spin the state chip turns while a research is live: eight rays, so it reads as a
 *  turning spark rather than as a letter of the text beside it (same mark as Evolve's). */
function BurstGlyph() {
  return (
    <svg fill="none" height="12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" viewBox="0 0 12 12" width="12">
      <path d="M6 1.2v9.6M1.2 6h9.6M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8" />
    </svg>
  );
}

/** The session's researches as the Idea Tree block of the transcript: one card
 *  per research, in the order the list reports them. */
export function IdeaResearchCards({ onOpen, views }: { onOpen: (researchId: string) => void; views: readonly IdeaResearchView[] }) {
  if (!views.length) return null;
  return (
    <div className="idea-cards">
      {views.map((view) => (
        <IdeaResearchCard
          key={view.research.id}
          onOpen={onOpen}
          view={view}
        />
      ))}
    </div>
  );
}

export function IdeaResearchCard({ onOpen, view }: { onOpen: (researchId: string) => void; view: IdeaResearchView }) {
  const research = view.research;
  const active = isIdeaResearchActive(research.status);
  const batchTotal = research.batch.length;
  return (
    <button
      className={`evolve-run-card idea-run-card is-${research.status}`}
      onClick={() => onOpen(research.id)}
      title={[research.objective, ideaStatusLabel(research.status)].join(" · ")}
      type="button"
    >
      <span aria-hidden="true" className="evolve-run-mark">
        <EvolveTreeGlyph size={16} />
      </span>
      <span className="evolve-run-text">
        <span className="evolve-run-title">{ideaCardTitle(research.objective)}</span>
        <span className="evolve-run-meta">
          <span>{ideaPhaseLabel(research.phase)}</span>
          <span>{t.round(research.round)}</span>
          {batchTotal > 0 ? <span>{t.batch(research.batchCompleted, batchTotal)}</span> : null}
          <span>{research.usageKnown ? t.tokens(research.tokens) : t.tokensUnknown}</span>
        </span>
      </span>
      <span className={`evolve-run-state is-${ideaStatusTone(research.status)}`}>
        {active ? <span aria-hidden="true" className="evolve-run-spin"><BurstGlyph /></span> : null}
        {active ? TEXT.evolve.working : ideaStatusLabel(research.status)}
      </span>
    </button>
  );
}
