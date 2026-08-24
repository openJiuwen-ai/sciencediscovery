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
 * The full-screen shell a search runs in, and the four blocks inside it.
 *
 * The blocks answer four questions that a user watching a search actually has,
 * and none of them substitutes for another: what happened to the score (and
 * which score), what the search explored, what each expansion did, and what it
 * has cost against its budget. Selecting a candidate anywhere — the canvas, the
 * table, the stream — opens the same detail panel, because they are three views
 * of one list.
 *
 * Structure follows `MemoryGraphExplorer` (backdrop + panel + header + body), so
 * the two full-screen surfaces behave the same way for a keyboard user.
 */

import { useEffect, useState } from "react";

import type { EvolveRun } from "@sciencediscovery/schema";
import { isEvolveRunActive } from "@sciencediscovery/schema";

import type { ApiClient } from "../api.js";
import { useLocale } from "../i18n/LocaleProvider.js";
import { CloseIcon } from "../icons.js";

import { isPlaceholderGoal } from "./command.js";
import { BudgetBar } from "./BudgetBar.js";
import { CandidateDetail } from "./CandidateDetail.js";
import { CandidateStream } from "./CandidateStream.js";
import { ScoreChart } from "./ScoreChart.js";
import { SearchGraphCanvas } from "./SearchGraphCanvas.js";
import { SearchGraphTable } from "./SearchGraphTable.js";
import { layoutSearchGraph } from "./search-graph-layout.js";
import { emptyRunView, reduceEvolveRecord, runProgress, type EvolveRunView } from "./model.js";

export interface EvolvePanelProps {
  client: ApiClient;
  onClose: () => void;
  onError: (message: string) => void;
  /** Bumped by the parent when a run's record changes, so the card and the
   *  panel cannot disagree about a status. */
  onRunChanged: () => void;
  run: EvolveRun;
}

export function EvolvePanel({ client, onClose, onError, onRunChanged, run }: EvolvePanelProps) {
  const { t } = useLocale();
  const [view, setView] = useState<EvolveRunView>(() => ({ ...emptyRunView(), status: run.status }));
  const [stopping, setStopping] = useState(false);
  // The canvas is the default and the table is a peer, not a fallback: a canvas
  // is unreachable to a keyboard and invisible to a screen reader, so the two
  // carry the same information and either one alone is a complete view.
  const [mode, setMode] = useState<"graph" | "table">("graph");
  const [selectedIndex, setSelectedIndex] = useState<number>();

  useEffect(() => {
    const controller = new AbortController();
    let settled = false;
    // Always resume from 0: the log is the source of truth, and replaying it is
    // how a panel opened after the fact renders exactly what a panel that was
    // open the whole time shows.
    void client
      .subscribeEvolveEvents(run.id, 0, (record) => {
        setView((current) => {
          const next = reduceEvolveRecord(current, record);
          if (next.status !== current.status) settled = true;
          return next;
        });
      }, controller.signal)
      .then(() => { if (settled) onRunChanged(); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        onError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [client, onError, onRunChanged, run.id]);

  const progress = runProgress(view, run.goal.budget.expansions);
  const { hidden } = layoutSearchGraph(view);
  const selected = selectedIndex === undefined
    ? undefined
    : view.candidates.find((candidate) => candidate.nodeIndex === selectedIndex);
  const active = isEvolveRunActive(view.status);

  return <div className="evolve-panel-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-label={t("evolve.panel.title")} aria-modal="true" className="evolve-panel" role="dialog">
      <header className="evolve-panel-header">
        <div>
          <span className="eyebrow">{t("evolve.panel.eyebrow")}</span>
          <h2>{run.goal.statement}</h2>
        </div>
        <div className="evolve-panel-controls">
          <span className={`evolve-status evolve-status-${view.status}`}>{t(`evolve.status.${view.status}`)}</span>
          {active ? <button
            className="evolve-stop"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void client.stopEvolveRun(run.id)
                .then(() => onRunChanged())
                .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
            }}
            type="button"
          >{t(stopping ? "evolve.panel.stopping" : "evolve.panel.stop")}</button> : null}
          <button aria-label={t("evolve.panel.close")} className="icon-button" onClick={onClose} type="button">
            <CloseIcon size={20} />
          </button>
        </div>
      </header>

      <div className="evolve-panel-body">
        {/* Say it plainly rather than letting a placeholder scorecard pass for a
            real one: nothing here was chosen by the user yet. */}
        {isPlaceholderGoal(run.goal) ? <p className="evolve-notice">{t("evolve.panel.placeholder")}</p> : null}
        <dl className="evolve-summary">
          <div><dt>{t("evolve.summary.algorithm")}</dt><dd>{view.algorithm ?? run.algorithm}</dd></div>
          <div><dt>{t("evolve.summary.expansions")}</dt><dd>{view.expansions} / {run.goal.budget.expansions}</dd></div>
          <div><dt>{t("evolve.summary.depth")}</dt><dd>{view.maxDepth}</dd></div>
          <div><dt>{t("evolve.summary.tokens")}</dt><dd>{view.tokens}</dd></div>
        </dl>
        <div className="evolve-progress" role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(progress * 100)}>
          <div className="evolve-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="evolve-view-toggle" role="group" aria-label={t("evolve.panel.title")}>
          <button aria-pressed={mode === "graph"} onClick={() => setMode("graph")} type="button">
            {t("evolve.view.graph")}
          </button>
          <button aria-pressed={mode === "table"} onClick={() => setMode("table")} type="button">
            {t("evolve.view.table")}
          </button>
        </div>
        <div className="evolve-dashboard">
          {/* ① what happened to the score, ② what the search explored, ③ every
              expansion in order, ④ what it cost. Four blocks because a user who
              can only see one of them has to guess the other three. */}
          <section className="evolve-block evolve-block-chart">
            <ScoreChart view={view} />
          </section>
          <section className="evolve-block evolve-block-structure">
            {mode === "graph"
              ? <SearchGraphCanvas onSelect={setSelectedIndex} selectedIndex={selectedIndex} view={view} />
              : <SearchGraphTable onSelect={setSelectedIndex} selectedIndex={selectedIndex} view={view} />}
          </section>
          <section className="evolve-block evolve-block-stream">
            <CandidateStream
              candidates={view.candidates}
              onSelect={setSelectedIndex}
              selectedIndex={selectedIndex}
            />
          </section>
          <section className="evolve-block evolve-block-budget">
            <BudgetBar
              elapsedSeconds={elapsedSeconds(run)}
              limits={run.goal.budget}
              spentCents={view.costCents}
              tokens={view.tokens}
            />
          </section>
        </div>
        {selected ? <CandidateDetail
          candidate={selected}
          client={client}
          onClose={() => setSelectedIndex(undefined)}
          parent={selected.parentIndex === null
            ? undefined
            : view.candidates.find((candidate) => candidate.nodeIndex === selected.parentIndex)}
          runId={run.id}
        /> : null}
        {/* Truncation is stated, never silent: a picture that quietly shows 200
            of 900 candidates reads as "this is the search". */}
        {hidden > 0 ? <p className="evolve-notice">
          {t("evolve.view.truncated", { shown: view.candidates.length - hidden, total: view.candidates.length })}
        </p> : null}
        {/* A failed run's reason lives on the run record, not in the event
            fold: the control plane is the only side that knows why a search was
            stopped (a budget gate, a dead sidecar), so it writes that there. */}
        {run.error ? <p className="evolve-panel-error">{run.error}</p> : null}
      </div>
    </section>
  </div>;
}

/** Seconds the run has been going, or `null` before it started.
 *
 * A finished run reports the span it actually took rather than counting on
 * forever: the budget bar is about what was spent, and a bar that keeps growing
 * after the run ends is describing the clock, not the search. */
function elapsedSeconds(run: EvolveRun): number | null {
  if (!run.startedAt) return null;
  const started = Date.parse(run.startedAt);
  if (Number.isNaN(started)) return null;
  const ended = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return Math.max(0, (Number.isNaN(ended) ? Date.now() : ended) - started) / 1000;
}
