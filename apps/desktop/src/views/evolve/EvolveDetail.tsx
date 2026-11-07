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
 * One search, as the 任务 tab of the right column.
 *
 * The three handoffs set the order and the shape: a row of totals first (what
 * the search reached), then the live score chart, then the search tree beside
 * its node list, and the budget last. Each block answers the question the one
 * above it raises — the totals say how far, the chart says how it got there,
 * the tree says what it tried, and the budget says what the trying cost.
 *
 * It is a panel mode rather than a modal: a search outlives the turn that
 * started it, and the reader has to be able to keep reading the conversation
 * while it runs.
 */

import { useEffect, useRef, useState } from "react";
import { isEvolveRunActive, type EvolveRun } from "@sciencediscovery/schema";

import type { ApiClient } from "../../api/client.js";
import { stopEvolveRun, subscribeEvolveEvents } from "../../api/evolve.js";
import {
  adoptRunStatus,
  bestCandidate,
  elapsedSeconds,
  emptyRunView,
  evolveShortTitle,
  formatScore,
  headlineScore,
  isPlaceholderGoal,
  reduceEvolveRecord,
  type EvolveRunView,
} from "../../evolve/model.js";
import { TEXT } from "../../text.js";
import { CandidateInspector } from "./CandidateInspector.js";
import { EvolveNodeList } from "./EvolveNodeList.js";
import { EvolveTree } from "./EvolveTree.js";
import { ScoreChart } from "./ScoreChart.js";

/** How many times a dropped event stream is reopened from the last sequence
 *  that arrived. The server replays the log, so a resume costs one request and
 *  folds only what the panel missed. */
const RESUME_ATTEMPTS = 3;

/** Between resumes: long enough for a restarting server to listen again. */
const RESUME_DELAY_MS = 2_000;

export interface EvolveDetailProps {
  client: ApiClient;
  /** Panel-level failures — a lost stream, a refused stop. */
  onError: (message: string) => void;
  /** The run record's own status may have moved; the cards read it. */
  onRunChanged: () => void;
  run: EvolveRun;
}

export function EvolveDetail({ client, onError, onRunChanged, run }: EvolveDetailProps) {
  const [view, setView] = useState<EvolveRunView>(() => ({ ...emptyRunView(), status: run.status }));
  const [selectedIndex, setSelectedIndex] = useState<number>();
  const [stopping, setStopping] = useState(false);
  /** Re-render once a second while the run is live, for the elapsed clock. */
  const [, setClock] = useState(0);
  // The subscription must not resubscribe because a parent re-rendered with a
  // new callback identity: it owns the replay cursor, and restarting it would
  // replay the whole log on every keystroke elsewhere.
  const callbacks = useRef({ onError, onRunChanged });
  useEffect(() => {
    callbacks.current = { onError, onRunChanged };
  }, [onError, onRunChanged]);

  useEffect(() => {
    const controller = new AbortController();
    setView({ ...emptyRunView(), status: run.status });
    setSelectedIndex(undefined);
    // Open from 0: the log is the source of truth, and replaying it is how a
    // panel opened after the fact renders exactly what a panel that watched the
    // whole search shows. A reconnect resumes from the last sequence folded.
    let cursor = 0;
    let resumes = 0;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      let received = 0;
      void subscribeEvolveEvents(client, run.id, cursor, (record) => {
        received += 1;
        if (record.sequence > cursor) cursor = record.sequence;
        setView((current) => reduceEvolveRecord(current, record));
      }, controller.signal)
        .then(() => {
          // Re-read the record however the stream ended: a run whose sidecar
          // died settles without an event, and only the record's status says so.
          callbacks.current.onRunChanged();
          // A close that delivered nothing is the server saying the log is
          // complete, so it is not retried.
          if (disposed || received === 0 || resumes >= RESUME_ATTEMPTS) return;
          resumes += 1;
          connect();
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted || disposed) return;
          if (resumes >= RESUME_ATTEMPTS) {
            callbacks.current.onError(reason instanceof Error ? reason.message : String(reason));
            return;
          }
          resumes += 1;
          timer = setTimeout(connect, RESUME_DELAY_MS);
        });
    };
    connect();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, run.id]);

  // The record is the authority on whether the search is over. A run that fails
  // before the sidecar sends `search_finished` settles without an event, so the
  // stop button has to follow `run.status` rather than the last event.
  useEffect(() => {
    setView((current) => adoptRunStatus(current, run.status));
  }, [run.status]);

  const active = isEvolveRunActive(view.status);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setClock((tick) => tick + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const budget = run.goal.budget;
  const headline = headlineScore(view);
  const best = bestCandidate(view);
  // The handoff states the gain as a percentage: the last step of the best
  // staircase, not the distance from the starting point — a search that went
  // from 0.14 to 0.73 in six steps did not improve by 439% on the last one.
  const gain = lastGain(view);
  const delta = gain === undefined || Math.abs(gain) < 0.0005
    ? undefined
    : `${gain > 0 ? "+" : ""}${gain.toFixed(3)}%`;
  const rising = gain !== undefined && gain > 0;
  const falling = gain !== undefined && gain < 0;
  const elapsed = elapsedSeconds(run);
  const title = evolveShortTitle(run.goal.statement);
  const algorithm = view.algorithm ?? run.algorithm;
  const valid = view.candidates.filter((candidate) => candidate.valid).length;
  const total = view.candidates.length;
  const selected = selectedIndex === undefined
    ? undefined
    : view.candidates.find((candidate) => candidate.nodeIndex === selectedIndex);
  const parent = selected?.parentIndex === null || selected?.parentIndex === undefined
    ? undefined
    : view.candidates.find((candidate) => candidate.nodeIndex === selected.parentIndex);
  const children = selected === undefined
    ? 0
    : view.candidates.filter((candidate) => candidate.parentIndex === selected.nodeIndex).length;

  const stop = () => {
    setStopping(true);
    void stopEvolveRun(client, run.id)
      .then(() => callbacks.current.onRunChanged())
      .catch((reason: unknown) => callbacks.current.onError(
        reason instanceof Error ? reason.message : String(reason),
      ))
      .finally(() => setStopping(false));
  };

  return <div className="evolve-detail">
    <header className="evolve-task-head">
      <h2 id="evolve-panel-title" title={run.goal.statement}>{title}</h2>
      {active ? <button
        className="evolve-task-stop"
        disabled={stopping}
        onClick={stop}
        title={TEXT.evolve.panel.stopHint}
        type="button"
      >
        {stopping ? TEXT.evolve.panel.stopping : TEXT.evolve.panel.stop}
      </button> : null}
    </header>

    <div className="evolve-detail-scroll">
      <div className="evolve-notices">
        {isPlaceholderGoal(run.goal) ? <p className="evolve-notice is-warn">
          {TEXT.evolve.notice.placeholder}
        </p> : null}
        {run.goal.allowUnisolated === true ? <p className="evolve-notice is-warn evolve-unisolated">
          {TEXT.evolve.unisolatedTitle}
        </p> : null}
        {run.error ? <p className="evolve-notice is-error">{run.error}</p> : null}
      </div>

      <section className="evolve-overview">
        <div className="evolve-overview-cell is-best">
          <span className="evolve-overview-label">{TEXT.evolve.detail.best}</span>
          <span className="evolve-overview-value">
            {formatScore(headline)}
            {delta === undefined ? null : <span
              className={`evolve-overview-delta${rising ? " is-up" : falling ? " is-down" : " is-flat"}`}
            >
              {delta}
            </span>}
          </span>
        </div>
        <div className="evolve-overview-cell">
          <span className="evolve-overview-label">{TEXT.evolve.detail.valid}</span>
          <span className="evolve-overview-value">{valid}/{total}</span>
        </div>
        <div className="evolve-overview-cell">
          <span className="evolve-overview-label">{TEXT.evolve.detail.generations}</span>
          <span className="evolve-overview-value">{view.maxDepth}</span>
        </div>
        <div className="evolve-overview-cell">
          <span className="evolve-overview-label">{TEXT.evolve.detail.algorithm}</span>
          <span className="evolve-overview-value">{algorithm ?? "—"}</span>
        </div>
        <div className="evolve-overview-cell">
          <span className="evolve-overview-label">{TEXT.evolve.detail.tokens}</span>
          <span className="evolve-overview-value">{view.tokens}</span>
        </div>
      </section>

      <section className="evolve-section">
        <h3 className="evolve-section-title">{TEXT.evolve.detail.chartTitle}</h3>
        <ScoreChart onSelect={setSelectedIndex} view={view} />
      </section>

      <section className="evolve-section">
        <h3 className="evolve-section-title">{TEXT.evolve.detail.treeTitle}</h3>
        <div className="evolve-tree-layout">
          <EvolveNodeList
            bestIndex={best?.nodeIndex}
            candidates={view.candidates}
            onSelect={setSelectedIndex}
            selectedIndex={selectedIndex}
          />
          <EvolveTree
            bestIndex={best?.nodeIndex}
            candidates={view.candidates}
            onSelect={setSelectedIndex}
            selectedIndex={selectedIndex}
          />
        </div>
      </section>

      <section className="evolve-section">
        <h3 className="evolve-section-title">{TEXT.evolve.detail.budgetTitle}</h3>
        <div className="evolve-budget">
          <BudgetRow
            label={TEXT.evolve.budget.tokens}
            text={`${group(view.tokens)} / ${group(budget.maxTokens)}`}
            value={view.tokens}
            limit={budget.maxTokens}
          />
          <BudgetRow
            label={TEXT.evolve.budget.elapsed}
            text={elapsed === null
              ? "—"
              : `${span(elapsed)} / ${span(budget.maxSeconds)}`}
            value={elapsed ?? 0}
            limit={budget.maxSeconds}
          />
          <BudgetRow
            label={TEXT.evolve.budget.nodes}
            text={`${view.expansions} / ${budget.expansions}`}
            value={view.expansions}
            limit={budget.expansions}
          />
        </div>
      </section>
    </div>

    {selected === undefined ? null : (
      <div className="evolve-node-drawer">
        <CandidateInspector
          best={best?.nodeIndex === selected.nodeIndex}
          candidate={selected}
          childCount={children}
          client={client}
          onClose={() => setSelectedIndex(undefined)}
          parent={parent}
          runId={run.id}
        />
      </div>
    )}
  </div>;
}

function BudgetRow({ label, limit, text, value }: {
  label: string;
  limit: number;
  text: string;
  value: number;
}) {
  const ratio = limit > 0 ? Math.min(1, Math.max(0, value / limit)) : 0;
  const over = limit > 0 && value > limit;
  return <div className="evolve-budget-row">
    <div className="evolve-budget-head">
      <span>{label}</span>
      <span className={over ? "is-over" : undefined}>{text}</span>
    </div>
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={text}
      className={`evolve-budget-track${over ? " is-over" : ""}`}
      role="progressbar"
    >
      <div className="evolve-budget-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
    </div>
  </div>;
}

/** The last improvement of the best-so-far staircase, as a percentage of the
 *  score it beat. Undefined while nothing has beaten the baseline. Exported
 *  because it is the reading behind the delta and is testable without a DOM. */
export function lastGain(view: EvolveRunView): number | undefined {
  let best = view.baselineScore ?? -Infinity;
  let previous = -Infinity;
  for (const candidate of view.candidates) {
    if (!candidate.valid) continue;
    const score = candidate.gateScore ?? candidate.score;
    if (score === null || score === undefined || !Number.isFinite(score)) continue;
    if (score <= best) continue;
    previous = best;
    best = score;
  }
  if (!Number.isFinite(previous) || previous === 0) return undefined;
  return ((best - previous) / Math.abs(previous)) * 100;
}

/** Thousands separators, as the handoff prints token counts. */
function group(value: number): string {
  return value.toLocaleString("en-US");
}

/** A budget span as the handoff writes it: `46m53s`, `2h00m`. */
function span(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}
