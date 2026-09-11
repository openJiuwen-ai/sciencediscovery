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
 * The workspace card: the only persistent handle a search has.
 *
 * `/evolve` is intercepted in the composer and never creates a chat run, so a
 * search leaves no trace in the session timeline. Close the panel and a search
 * that has been running for half an hour would be unreachable — this card is
 * what makes it findable again, which is why it stays after the panel closes and
 * lists finished runs rather than only the live one.
 *
 * Shape and placement follow `MemoryGraphView`, including its rule: a feature
 * with nothing to show leaves no footprint in the UI.
 */

import type { EvolveRun } from "@sciencediscovery/schema";
import { isEvolveRunActive } from "@sciencediscovery/schema";

import { useState } from "react";

import { useLocale } from "../i18n/LocaleProvider.js";

/** How many finished runs the card lists before folding the rest away. Running
 *  ones are always shown: a search nobody can see is the thing this card exists
 *  to prevent. */
const VISIBLE_FINISHED = 3;

export interface EvolveRunCardProps {
  onOpenRun: (runId: string) => void;
  runs: EvolveRun[];
}

export function EvolveRunCard({ onOpenRun, runs }: EvolveRunCardProps) {
  const { t } = useLocale();
  // Hooks before the early return: a card that renders nothing today may render
  // something on the next poll, and the hook order cannot change with it.
  const [expanded, setExpanded] = useState(false);
  if (!runs.length) return null;

  const active = runs.filter((run) => isEvolveRunActive(run.status));
  const finished = runs.filter((run) => !isEvolveRunActive(run.status));
  const shown = expanded ? [...active, ...finished] : [...active, ...finished.slice(0, VISIBLE_FINISHED)];
  const hidden = expanded ? 0 : finished.length - Math.min(finished.length, VISIBLE_FINISHED);

  return <section className={`evolve-run-card${active.length ? " running" : ""}`}>
    <header className="evolve-run-card-header">
      <h3>{t("evolve.card.title")}</h3>
      {active.length
        ? <span className="evolve-badge evolve-badge-running">{t("evolve.card.running", { count: active.length })}</span>
        : null}
    </header>
    <ul className="evolve-run-list">
      {shown.map((run) => <li key={run.id}>
        <button
          className={`evolve-run-row${isEvolveRunActive(run.status) ? "" : " process-agent-record"}${run.status === "failed" ? " failed" : ""}`}
          onClick={() => onOpenRun(run.id)}
          title={run.goal.statement}
          type="button"
        >
          {/* An active run's status here is whatever it was when the list was
              read, and this side never reads it again — live progress belongs
              to the panel, which streams the run's own event log. Printing
              "queued" for a search that has been expanding for ten minutes is
              worse than saying nothing, so an active run gets one honest label
              and the invitation to open it. Finished statuses are terminal and
              stay accurate once loaded. */}
          <span className={`evolve-status evolve-status-${run.status}`}>
            {isEvolveRunActive(run.status) ? t("evolve.status.live") : t(statusKey(run.status))}
          </span>
          <span className="evolve-run-statement">{run.goal.statement}</span>
          <span className="evolve-run-meta">
            {t("evolve.card.expansions", { done: run.candidates, total: run.goal.budget.expansions })}
          </span>
        </button>
      </li>)}
    </ul>
    {/* A count with no way to act on it is a dead end: the older runs are the
        ones a user comes back for, and they are already loaded. */}
    {hidden > 0 ? <button
      aria-expanded={false}
      className="evolve-run-more"
      onClick={() => setExpanded(true)}
      type="button"
    >{t("evolve.card.more", { count: hidden })}</button> : null}
    {expanded && finished.length > VISIBLE_FINISHED ? <button
      aria-expanded
      className="evolve-run-more"
      onClick={() => setExpanded(false)}
      type="button"
    >{t("evolve.card.less")}</button> : null}
  </section>;
}

/** Terminal statuses read very differently to a user — "you stopped it",
 *  "it ran out of budget" and "it broke" need different next steps — so each
 *  gets its own label rather than a shared "finished". */
function statusKey(status: EvolveRun["status"]): `evolve.status.${EvolveRun["status"]}` {
  return `evolve.status.${status}`;
}
