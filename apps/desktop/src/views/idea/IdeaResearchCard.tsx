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
 * The session's Idea Tree research, as a card in the conversation.
 *
 * It shows what the engine reported and nothing more: a token count the engine has not
 * reported stays "not reported" instead of becoming 0, and a phase the UI does not know
 * is printed as the raw engine phase rather than mapped onto something that sounds
 * successful. The controls are the ones the research's own status allows; a completed or
 * ended research keeps its card so a reopened session shows the persisted state without
 * starting anything.
 */

import type { IdeaResearchState, IdeaResearchView } from "@sciencediscovery/schema";
import { TEXT } from "../../text.js";
import "../../styles/idea-tree.css";

const t = TEXT.ideaTree;

/** The engine's phase names are a closed set; an unknown one is shown verbatim. */
function phaseLabel(phase: string): string {
  return (t.phase as Record<string, string | undefined>)[phase] ?? phase;
}

export function ideaStatusLabel(status: IdeaResearchState["status"]): string {
  return (t.status as Record<string, string | undefined>)[status] ?? status;
}

/** Which controls a status allows. Nothing here starts a research: only the agent
 *  command and the create operation do, and the card never creates one. */
export function ideaControls(status: IdeaResearchState["status"]): { pause: boolean; resume: boolean; end: boolean } {
  return {
    pause: status === "running",
    resume: status === "paused" || status === "interrupted",
    end: status === "running" || status === "pausing" || status === "paused" || status === "interrupted",
  };
}

interface Props {
  view: IdeaResearchView;
  busy?: boolean;
  onOpen?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onEnd?: () => void;
}

export function IdeaResearchCard({ view, busy = false, onOpen, onPause, onResume, onEnd }: Props) {
  const research = view.research;
  const controls = ideaControls(research.status);
  const batchTotal = research.batch.length;
  return (
    <section className={`idea-research-card is-${research.status}`} aria-label={t.heading}>
      <header>
        <span className="eyebrow">{t.heading}</span>
        <strong>{ideaStatusLabel(research.status)}</strong>
      </header>
      <p className="idea-research-objective">
        <span>{t.objective}</span>
        {research.objective}
      </p>
      <div className="idea-research-progress">
        <span>{phaseLabel(research.phase)}</span>
        <span>{t.round(research.round)}</span>
        {batchTotal > 0 ? <span>{t.batch(research.batchCompleted, batchTotal)}</span> : null}
        <span>{research.usageKnown ? t.tokens(research.tokens) : t.tokensUnknown}</span>
      </div>
      {research.reason ? <p className="idea-research-reason">{t.reason(research.reason)}</p> : null}
      <footer>
        {onOpen ? (
          <button className="secondary-button" onClick={onOpen} type="button">{t.open}</button>
        ) : null}
        {controls.pause && onPause ? (
          <button className="secondary-button" disabled={busy} onClick={onPause} type="button">{t.pause}</button>
        ) : null}
        {controls.resume && onResume ? (
          <button className="secondary-button" disabled={busy} onClick={onResume} type="button">{t.resume}</button>
        ) : null}
        {controls.end && onEnd ? (
          <button className="secondary-button" disabled={busy} onClick={onEnd} type="button">{t.end}</button>
        ) : null}
      </footer>
    </section>
  );
}
