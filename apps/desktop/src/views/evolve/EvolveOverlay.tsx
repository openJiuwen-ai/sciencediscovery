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
 * One search, as a result cockpit.
 *
 * The questions a person watching a search actually asks are ordered, and the
 * layout answers them in that order: did it get better (the hero), how did it
 * get there (the chart), what did it try (the table), and why was that one
 * rejected (the inspector). A grid of four equal blocks made those peer
 * questions, which is why the old dashboard read as a control room with no
 * window.
 *
 * The candidate table and the inspector are one selection: pressing a row is
 * what fills the right-hand pane. On a narrow window that pane becomes a
 * drawer over the table, so the same click works without a second navigation.
 */

import { useEffect, useRef, useState } from "react";
import { isEvolveRunActive, type EvolveRun } from "@sciencediscovery/schema";

import type { ApiClient } from "../../api/client.js";
import { stopEvolveRun, subscribeEvolveEvents } from "../../api/evolve.js";
import {
  bestCandidate,
  emptyRunView,
  evolveShortTitle,
  formatDelta,
  formatElapsed,
  formatScore,
  formatTokens,
  headlineScore,
  isPlaceholderGoal,
  reduceEvolveRecord,
  runProgress,
  type EvolveRunView,
} from "../../evolve/model.js";
import { evolveStatusLabel, evolveStatusTone } from "../../evolve/status.js";
import { TEXT } from "../../text.js";
import { CandidateInspector } from "./CandidateInspector.js";
import { CandidateTable } from "./CandidateTable.js";
import { ScoreChart } from "./ScoreChart.js";
import { claimsEscape } from "../dialog-escape.js";

export interface EvolveOverlayProps {
  client: ApiClient;
  /** Overlay-level failures — a lost stream, a refused stop. */
  onError: (message: string) => void;
  onClose: () => void;
  /** The run record's own status may have moved; the shelf reads it. */
  onRunChanged: () => void;
  run: EvolveRun;
}

export function EvolveOverlay({ client, onClose, onError, onRunChanged, run }: EvolveOverlayProps) {
  const [view, setView] = useState<EvolveRunView>(() => ({ ...emptyRunView(), status: run.status }));
  const [selectedIndex, setSelectedIndex] = useState<number>();
  const [fullscreen, setFullscreen] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** Re-render once a second while the run is live, for the elapsed clock. */
  const [, setClock] = useState(0);
  const panel = useRef<HTMLElement>(null);
  // The subscription must not resubscribe because a parent re-rendered with a
  // new callback identity: it owns the replay cursor, and restarting it would
  // replay the whole log on every keystroke elsewhere.
  const callbacks = useRef({ onError, onRunChanged });
  useEffect(() => {
    callbacks.current = { onError, onRunChanged };
  }, [onError, onRunChanged]);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setView({ ...emptyRunView(), status: run.status });
    setSelectedIndex(undefined);
    let finished = false;
    // Always resume from 0: the log is the source of truth, and replaying it
    // is how a panel opened after the fact renders exactly what a panel that
    // watched the whole search shows.
    void subscribeEvolveEvents(client, run.id, 0, (record) => {
      if (record.event.type === "search_finished") finished = true;
      setView((current) => reduceEvolveRecord(current, record));
    }, controller.signal)
      .then(() => {
        if (finished) callbacks.current.onRunChanged();
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        callbacks.current.onError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [client, run.id]);

  const active = isEvolveRunActive(view.status);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setClock((tick) => tick + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const close = () => onClose();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const budget = run.goal.budget;
  const headline = headlineScore(view);
  const best = bestCandidate(view);
  const delta = formatDelta(headline, view.baselineScore);
  const rising = headline !== null && view.baselineScore !== null && headline > view.baselineScore;
  const falling = headline !== null && view.baselineScore !== null && headline < view.baselineScore;
  const elapsed = elapsedSeconds(run);
  const progress = runProgress(view, budget.expansions);
  const title = evolveShortTitle(run.goal.statement);
  const statement = run.goal.statement.trim();
  const selected = selectedIndex === undefined
    ? undefined
    : view.candidates.find((candidate) => candidate.nodeIndex === selectedIndex);
  const parent = selected?.parentIndex === null || selected?.parentIndex === undefined
    ? undefined
    : view.candidates.find((candidate) => candidate.nodeIndex === selected.parentIndex);

  const stop = () => {
    setStopping(true);
    void stopEvolveRun(client, run.id)
      .then(() => callbacks.current.onRunChanged())
      .catch((reason: unknown) => callbacks.current.onError(
        reason instanceof Error ? reason.message : String(reason),
      ))
      .finally(() => setStopping(false));
  };

  return <div
    className="evolve-backdrop"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <section
      aria-labelledby="evolve-panel-title"
      aria-modal="true"
      className={`evolve-panel${fullscreen ? " is-fullscreen" : ""}`}
      ref={panel}
      role="dialog"
      tabIndex={-1}
    >
      <header className="evolve-panel-head">
        <div className="evolve-heading">
          <div className="evolve-eyebrow-row">
            <span className="evolve-eyebrow">{TEXT.evolve.panel.eyebrow}</span>
            <span className="evolve-algorithm">{algorithmLabel(view.algorithm ?? run.algorithm)}</span>
            {run.goal.checkpointMode === "auto" ? <span
              className="evolve-pace"
              title={TEXT.evolve.autoPaceTitle}
            >
              {TEXT.evolve.autoPace}
            </span> : null}
          </div>
          <h2 id="evolve-panel-title" title={run.goal.statement}>{title}</h2>
          {title === statement ? null : <details className="evolve-goal">
            <summary>{TEXT.evolve.panel.fullTask}</summary>
            <p>{run.goal.statement}</p>
          </details>}
        </div>

        <div className="evolve-head-actions">
          <span className={`evolve-status is-${evolveStatusTone(view.status)}`}>
            {evolveStatusLabel(view.status)}
          </span>
          {active ? <button
            className="evolve-stop"
            disabled={stopping}
            onClick={stop}
            title={TEXT.evolve.panel.stopHint}
            type="button"
          >
            {stopping ? TEXT.evolve.panel.stopping : TEXT.evolve.panel.stop}
          </button> : null}
          <button
            aria-label={fullscreen ? TEXT.evolve.panel.exitFullscreen : TEXT.evolve.panel.fullscreen}
            className={`evolve-icon-button${fullscreen ? " is-active" : ""}`}
            onClick={() => setFullscreen((value) => !value)}
            title={fullscreen ? TEXT.evolve.panel.exitFullscreen : TEXT.evolve.panel.fullscreen}
            type="button"
          >
            <ExpandGlyph exit={fullscreen} />
          </button>
          <button
            aria-label={TEXT.evolve.panel.close}
            className="evolve-icon-button evolve-close"
            onClick={close}
            title={TEXT.evolve.panel.close}
            type="button"
          >
            ×
          </button>
        </div>
      </header>

      <div className="evolve-hero">
        <div className="evolve-hero-score">
          <span className="evolve-hero-label">{TEXT.evolve.metric.best}</span>
          <div className="evolve-hero-value-row">
            <strong className={`evolve-hero-value${rising ? " is-improved" : ""}`}>
              {formatScore(headline)}
            </strong>
            {delta === undefined || delta === "+0.0000" || delta === "-0.0000" ? null : <span
              className={`evolve-delta${rising ? " is-up" : falling ? " is-down" : " is-flat"}`}
            >
              {rising ? "↑" : falling ? "↓" : ""} {delta}
            </span>}
          </div>
          <span className="evolve-hero-baseline">
            {TEXT.evolve.metric.baseline} {formatScore(view.baselineScore)}
            {best === undefined ? "" : ` · #${best.nodeIndex}`}
          </span>
        </div>

        {/* The budget tracks beside this carry expansions, tokens and time;
            repeating them here would print the same numbers twice. What the
            tracks cannot say is how much the search produced and how deep it
            went, so those are the stats. */}
        <dl className="evolve-stats">
          <Stat label={TEXT.evolve.metric.test} value={formatScore(view.bestTestScore)} />
          <Stat label={TEXT.evolve.metric.candidates} value={String(view.candidates.length)} />
          <Stat label={TEXT.evolve.metric.depth} value={String(view.maxDepth)} />
        </dl>

        <div className="evolve-budget">
          <BudgetTrack
            label={TEXT.evolve.budget.expansions}
            limit={budget.expansions}
            text={`${view.expansions} / ${budget.expansions}`}
            value={view.expansions}
          />
          <BudgetTrack
            label={TEXT.evolve.budget.tokens}
            limit={budget.maxTokens}
            text={`${formatTokens(view.tokens)} / ${formatTokens(budget.maxTokens)}`}
            value={view.tokens}
          />
          <BudgetTrack
            label={TEXT.evolve.budget.elapsed}
            limit={budget.maxSeconds}
            text={elapsed === null ? "—" : `${formatElapsed(elapsed)} / ${formatElapsed(budget.maxSeconds)}`}
            value={elapsed ?? 0}
          />
          {budget.maxCostCents > 0 && view.costCents > 0 ? <BudgetTrack
            label={TEXT.evolve.budget.cost}
            limit={budget.maxCostCents}
            text={`${(view.costCents / 100).toFixed(2)} / ${(budget.maxCostCents / 100).toFixed(2)}`}
            value={view.costCents}
          /> : null}
        </div>

        <div
          aria-label={TEXT.evolve.budget.expansions}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(progress * 100)}
          className="evolve-progress"
          role="progressbar"
        >
          <div className="evolve-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      </div>

      <div className="evolve-notices">
        {isPlaceholderGoal(run.goal) ? <p className="evolve-notice is-warn">
          {TEXT.evolve.notice.placeholder}
        </p> : null}
        {!active && view.expansionsPlanned !== undefined && view.expansions < view.expansionsPlanned
          ? <p className="evolve-notice">
            {TEXT.evolve.notice.stoppedShort(
              view.expansions,
              view.expansionsPlanned,
              view.stopReason ?? "?",
            )}
          </p>
          : null}
        {run.error ? <p className="evolve-notice is-error">{run.error}</p> : null}
        {view.logLines.length === 0 ? null : <details className="evolve-log">
          <summary>
            {TEXT.evolve.notice.log}
            <span>{view.logLines.length}</span>
          </summary>
          <ul>
            {view.logLines.map((line, at) => <li className={`is-${line.level}`} key={at}>{line.message}</li>)}
          </ul>
        </details>}
      </div>

      <div className="evolve-panel-body">
        <div className="evolve-main">
          <section className="evolve-card evolve-card-chart">
            <ScoreChart view={view} />
          </section>
          <section className="evolve-card evolve-card-table">
            <CandidateTable
              candidates={view.candidates}
              onSelect={setSelectedIndex}
              selectedIndex={selectedIndex}
            />
          </section>
        </div>

        <aside className={`evolve-inspector${selected === undefined ? "" : " is-open"}`}>
          <CandidateInspector
            candidate={selected}
            client={client}
            onClose={() => setSelectedIndex(undefined)}
            parent={parent}
            runId={run.id}
          />
        </aside>
      </div>
    </section>
  </div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="evolve-stat">
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>;
}

function BudgetTrack({ label, limit, text, value }: {
  label: string;
  limit: number;
  text: string;
  value: number;
}) {
  const ratio = limit > 0 ? Math.min(1, value / limit) : 0;
  return <div className="evolve-budget-item">
    <div className="evolve-budget-label">
      <span>{label}</span>
      <span>{text}</span>
    </div>
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={text}
      className="evolve-budget-track"
      role="progressbar"
    >
      <div
        className={`evolve-budget-fill${ratio >= 0.9 ? " is-hot" : ""}`}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  </div>;
}

function ExpandGlyph({ exit }: { exit: boolean }) {
  return <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="16">
    {exit
      ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
      : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
  </svg>;
}

function algorithmLabel(algorithm: string): string {
  if (algorithm === "openevolve") return "OpenEvolve";
  if (algorithm === "puct") return "PUCT";
  return algorithm;
}

/** Seconds the run has been going, or `null` before it started.
 *
 *  A finished run reports the span it actually took rather than counting on
 *  forever: the budget is about what was spent, and a clock that keeps growing
 *  after the search ends is describing the wall, not the run. */
function elapsedSeconds(run: EvolveRun): number | null {
  if (!run.startedAt) return null;
  const started = Date.parse(run.startedAt);
  if (Number.isNaN(started)) return null;
  const ended = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return Math.max(0, (Number.isNaN(ended) ? Date.now() : ended) - started) / 1000;
}
