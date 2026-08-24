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
 * The three scores, drawn apart.
 *
 * They are three different measurements and conflating any two of them hides
 * the thing the split was built for:
 *
 * * **rollout** is what the search can see, and what it ranks on.
 * * **gate** is what decides — drawn bold, because a candidate that is better
 *   on rollout and worse on gate is the case the whole design exists to catch,
 *   and one averaged line would draw it as progress.
 * * **test** is a single point at the end, on shards that took no part. It is
 *   the only number that means anything outside this run.
 *
 * A failed expansion is a hollow point on the axis, not a gap in the line: a
 * gap reads as "nothing happened here", and what happened is that a candidate
 * was spent. Baseline is a dashed horizontal rule, because every score in the
 * run is relative to it.
 *
 * Hand-drawn SVG rather than a chart library: this is four polylines and a
 * dozen circles, it has to be readable by a screen reader (there is a table
 * beside it), and the app's one charting dependency is 4.6MB of plotly loaded
 * for a different purpose.
 */

import { useLocale } from "../i18n/LocaleProvider.js";

import type { EvolveRunView } from "./model.js";

interface Point {
  index: number;
  value: number;
}

export interface ScoreChartProps {
  view: EvolveRunView;
}

const WIDTH = 560;
const HEIGHT = 200;
const PAD = { bottom: 22, left: 34, right: 12, top: 12 };

export function ScoreChart({ view }: ScoreChartProps) {
  const { t } = useLocale();
  const series = collectSeries(view);
  const bounds = boundsOf(series, view);

  if (!series.rollout.length && !series.gate.length) {
    return <p className="evolve-chart-empty">{t("evolve.chart.empty")}</p>;
  }

  const x = (index: number) => PAD.left
    + (WIDTH - PAD.left - PAD.right) * (bounds.maxIndex === 0 ? 0.5 : index / bounds.maxIndex);
  const y = (value: number) => PAD.top
    + (HEIGHT - PAD.top - PAD.bottom) * (1 - (value - bounds.min) / (bounds.max - bounds.min || 1));
  const path = (points: Point[]) => points.map((point, at) =>
    `${at === 0 ? "M" : "L"}${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");

  return <figure className="evolve-chart">
    <svg
      aria-label={t("evolve.chart.title")}
      role="img"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <line className="evolve-chart-axis" x1={PAD.left} x2={WIDTH - PAD.right}
        y1={HEIGHT - PAD.bottom} y2={HEIGHT - PAD.bottom} />
      <line className="evolve-chart-axis" x1={PAD.left} x2={PAD.left}
        y1={PAD.top} y2={HEIGHT - PAD.bottom} />
      <text className="evolve-chart-tick" x={PAD.left - 4} y={PAD.top + 8} textAnchor="end">
        {bounds.max.toFixed(2)}
      </text>
      <text className="evolve-chart-tick" x={PAD.left - 4} y={HEIGHT - PAD.bottom} textAnchor="end">
        {bounds.min.toFixed(2)}
      </text>

      {view.baselineScore === null ? null : <>
        <line className="evolve-chart-baseline" x1={PAD.left} x2={WIDTH - PAD.right}
          y1={y(view.baselineScore)} y2={y(view.baselineScore)} />
        <text className="evolve-chart-tick" x={WIDTH - PAD.right} y={y(view.baselineScore) - 4}
          textAnchor="end">{t("evolve.chart.baseline")}</text>
      </>}

      {series.rollout.length
        ? <path className="evolve-chart-line evolve-chart-rollout" d={path(series.rollout)} />
        : null}
      {/* Bold, and drawn last of the two so it is never hidden under the line
          the search is allowed to see. */}
      {series.gate.length
        ? <path className="evolve-chart-line evolve-chart-gate" d={path(series.gate)} />
        : null}

      {series.failed.map((index) => <circle
        className="evolve-chart-failed" cx={x(index)} cy={HEIGHT - PAD.bottom} key={`f${index}`} r={4}
      />)}
      {series.gate.map((point) => <circle
        className="evolve-chart-dot evolve-chart-gate-dot"
        cx={x(point.index)} cy={y(point.value)} key={`g${point.index}`} r={3}
      />)}
      {view.bestTestScore === undefined ? null : <circle
        className="evolve-chart-test" cx={x(bounds.maxIndex)} cy={y(view.bestTestScore)} r={5}
      />}
    </svg>
    <figcaption className="evolve-chart-legend">
      <span className="evolve-chart-key evolve-chart-key-gate">{t("evolve.chart.gate")}</span>
      <span className="evolve-chart-key evolve-chart-key-rollout">{t("evolve.chart.rollout")}</span>
      <span className="evolve-chart-key evolve-chart-key-test">
        {t("evolve.chart.test")}
        {view.bestTestScore === undefined ? "" : ` ${view.bestTestScore.toFixed(4)}`}
      </span>
      <span className="evolve-chart-key evolve-chart-key-failed">{t("evolve.chart.failed")}</span>
    </figcaption>
  </figure>;
}

/** Pure, and exported so the reading of the events is testable without a DOM. */
export function collectSeries(view: EvolveRunView): {
  failed: number[];
  gate: Point[];
  rollout: Point[];
} {
  const gate: Point[] = [];
  const rollout: Point[] = [];
  const failed: number[] = [];
  for (const candidate of view.candidates) {
    if (!candidate.valid) {
      failed.push(candidate.nodeIndex);
      continue;
    }
    // `gateScore` is absent on an engine that measures once and ranks on the
    // same number; falling back to `score` keeps one line rather than none.
    const gateValue = candidate.gateScore ?? candidate.score;
    if (gateValue !== null && gateValue !== undefined) {
      gate.push({ index: candidate.nodeIndex, value: gateValue });
    }
    const rolloutValue = candidate.rolloutScore ?? candidate.score;
    if (rolloutValue !== null && rolloutValue !== undefined) {
      rollout.push({ index: candidate.nodeIndex, value: rolloutValue });
    }
  }
  return { failed, gate, rollout };
}

function boundsOf(
  series: { gate: Point[]; rollout: Point[] },
  view: EvolveRunView,
): { max: number; maxIndex: number; min: number } {
  const values = [...series.gate, ...series.rollout].map((point) => point.value);
  if (view.baselineScore !== null) values.push(view.baselineScore);
  if (view.bestTestScore !== undefined) values.push(view.bestTestScore);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  // A flat run would otherwise divide by zero and draw every point on the axis.
  const pad = (max - min) * 0.1 || 0.05;
  return {
    max: max + pad,
    maxIndex: Math.max(1, ...view.candidates.map((candidate) => candidate.nodeIndex)),
    min: Math.max(0, min - pad),
  };
}
