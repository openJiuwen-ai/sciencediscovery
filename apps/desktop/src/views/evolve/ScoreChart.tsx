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
 * The climb, drawn as one line.
 *
 * The accent line is **best so far**, not the score of each expansion. Joining
 * every candidate in expansion order draws a sawtooth: parallel expansions are
 * independent draws, so consecutive indices are not a trajectory, and the
 * zig-zag reads as instability while the run is actually climbing. Individual
 * gate scores stay as dots, and the test split — the one number measured on
 * data the search never saw — is a single diamond at the end.
 *
 * A failed candidate is a hollow point on the floor, not a gap. A gap reads as
 * "nothing happened here"; what happened is that an expansion was spent.
 *
 * Hand-drawn SVG rather than a chart library: this is one step line, a few
 * hundred circles and two rules, and the app has no charting dependency it
 * would be honest to add for it.
 */

import { TEXT } from "../../text.js";
import {
  bestCandidate,
  formatScore,
  headlineScore,
  type EvolveRunView,
} from "../../evolve/model.js";

interface Point {
  index: number;
  value: number;
}

export interface ChartSeries {
  failed: number[];
  gate: Point[];
  rollout: Point[];
}

const WIDTH = 820;
const HEIGHT = 250;
const PAD = { bottom: 34, left: 52, right: 26, top: 18 };

export function ScoreChart({ view }: { view: EvolveRunView }) {
  const series = collectSeries(view);
  const bounds = boundsOf(series, view);

  if (!series.rollout.length && !series.gate.length && view.baselineScore === null) {
    return <p className="evolve-chart-empty">{TEXT.evolve.chart.empty}</p>;
  }

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const floor = PAD.top + plotHeight;
  const x = (index: number) => PAD.left + plotWidth * (index / bounds.maxIndex);
  const y = (value: number) => {
    // The window starts below the baseline, so anything worse than the
    // baseline clamps to the floor — still visible as "tried, below the
    // window" rather than dragging the axis down to zero for one dead node.
    const clamped = Math.min(bounds.max, Math.max(bounds.min, value));
    return PAD.top + plotHeight * (1 - (clamped - bounds.min) / (bounds.max - bounds.min || 1));
  };

  const gate = [...series.gate].sort((left, right) => left.index - right.index);
  // The best-so-far staircase: starts at the baseline and steps up where a
  // candidate first beats everything before it.
  let best = view.baselineScore ?? -Infinity;
  let line = "";
  let areaStart = 0;
  if (view.baselineScore !== null) {
    line = `M${x(0).toFixed(1)},${y(view.baselineScore).toFixed(1)}`;
    areaStart = x(0);
  }
  for (const point of gate) {
    if (point.value <= best) continue;
    if (!line) {
      line = `M${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`;
      areaStart = x(point.index);
    } else {
      line += ` H${x(point.index).toFixed(1)} V${y(point.value).toFixed(1)}`;
    }
    best = point.value;
  }
  if (line) line += ` H${x(bounds.maxIndex).toFixed(1)}`;
  const area = line
    ? `${line} L${x(bounds.maxIndex).toFixed(1)},${floor.toFixed(1)} L${areaStart.toFixed(1)},${floor.toFixed(1)} Z`
    : "";

  const gateByIndex = new Map(series.gate.map((point) => [point.index, point.value]));
  const rolloutOnly = series.rollout.filter((point) => gateByIndex.get(point.index) !== point.value);
  const bestScore = headlineScore(view);
  const bestNode = bestCandidate(view);

  const ticks = Array.from({ length: 5 }, (_unused, at) =>
    bounds.min + ((bounds.max - bounds.min) * at) / 4);

  return <figure className="evolve-chart">
    <figcaption className="evolve-chart-head">
      <span className="evolve-chart-caption">{TEXT.evolve.chart.title}</span>
      <span className="evolve-chart-legend">
        <span className="evolve-key is-best">{TEXT.evolve.chart.best}</span>
        <span className="evolve-key is-gate">{TEXT.evolve.chart.gate}</span>
        <span className="evolve-key is-rollout">{TEXT.evolve.chart.rollout}</span>
        {view.bestTestScore === undefined ? null : <span className="evolve-key is-test">
          {TEXT.evolve.chart.test} {formatScore(view.bestTestScore)}
        </span>}
        <span className="evolve-key is-failed">{TEXT.evolve.chart.failed}</span>
      </span>
    </figcaption>

    <svg
      aria-label={TEXT.evolve.chart.aria(
        formatScore(view.baselineScore),
        formatScore(bestScore),
        view.candidates.length,
      )}
      className="evolve-chart-svg"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    >
      {ticks.map((tick, at) => <g key={at}>
        <line
          className="evolve-chart-grid"
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={y(tick)}
          y2={y(tick)}
        />
        <text className="evolve-chart-tick" textAnchor="end" x={PAD.left - 8} y={y(tick) + 3.5}>
          {axisLabel(tick, bounds.max - bounds.min)}
        </text>
      </g>)}

      {view.baselineScore === null ? null : <>
        <line
          className="evolve-chart-baseline"
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={y(view.baselineScore)}
          y2={y(view.baselineScore)}
        />
        <text
          className="evolve-chart-baseline-label"
          textAnchor="end"
          x={WIDTH - PAD.right}
          y={y(view.baselineScore) - 6}
        >
          {TEXT.evolve.chart.baseline} {formatScore(view.baselineScore)}
        </text>
      </>}

      {area ? <path className="evolve-chart-area" d={area} /> : null}
      {line ? <path className="evolve-chart-line" d={line} /> : null}

      {series.failed.map((index) => <circle
        className="evolve-chart-failed"
        cx={x(index)}
        cy={floor}
        key={`failed-${index}`}
        r={3.2}
      >
        <title>{`#${index} · ${TEXT.evolve.chart.failed}`}</title>
      </circle>)}

      {rolloutOnly.map((point) => <circle
        className="evolve-chart-rollout"
        cx={x(point.index)}
        cy={y(point.value)}
        key={`rollout-${point.index}`}
        r={2.6}
      >
        <title>{`#${point.index} · ${TEXT.evolve.chart.rollout} ${formatScore(point.value)}`}</title>
      </circle>)}

      {series.gate.map((point) => <circle
        className={`evolve-chart-dot${bestNode?.nodeIndex === point.index ? " is-best" : ""}`}
        cx={x(point.index)}
        cy={y(point.value)}
        key={`gate-${point.index}`}
        r={bestNode?.nodeIndex === point.index ? 4.4 : 3.2}
      >
        <title>{`#${point.index} · ${TEXT.evolve.chart.gate} ${formatScore(point.value)}`}</title>
      </circle>)}

      {view.bestTestScore === undefined ? null : <g className="evolve-chart-test">
        <rect
          height={7.6}
          transform={`rotate(45 ${x(bounds.maxIndex)} ${y(view.bestTestScore)})`}
          width={7.6}
          x={x(bounds.maxIndex) - 3.8}
          y={y(view.bestTestScore) - 3.8}
        />
        <text
          textAnchor="end"
          x={x(bounds.maxIndex) - 10}
          y={y(view.bestTestScore) - 10}
        >
          {TEXT.evolve.chart.test} {formatScore(view.bestTestScore)}
        </text>
      </g>}

      <line
        className="evolve-chart-axis"
        x1={PAD.left}
        x2={WIDTH - PAD.right}
        y1={floor}
        y2={floor}
      />
      <text className="evolve-chart-x" textAnchor="start" x={PAD.left} y={HEIGHT - 10}>0</text>
      <text className="evolve-chart-x" textAnchor="end" x={WIDTH - PAD.right} y={HEIGHT - 10}>
        {bounds.maxIndex}
      </text>
      <text className="evolve-chart-x-label" textAnchor="middle" x={PAD.left + plotWidth / 2} y={HEIGHT - 10}>
        {TEXT.evolve.chart.xAxis}
      </text>
    </svg>
  </figure>;
}

/** Pure, and exported so the reading of the events is testable without a DOM. */
export function collectSeries(view: EvolveRunView): ChartSeries {
  const gate: Point[] = [];
  const rollout: Point[] = [];
  const failed: number[] = [];
  for (const candidate of view.candidates) {
    if (!candidate.valid) {
      failed.push(candidate.nodeIndex);
      continue;
    }
    // An engine that measures once and ranks on the same number has no
    // `gateScore`; falling back to `score` keeps one line rather than none.
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
  series: ChartSeries,
  view: EvolveRunView,
): { max: number; maxIndex: number; min: number } {
  const values = [...series.gate, ...series.rollout].map((point) => point.value);
  if (view.baselineScore !== null) values.push(view.baselineScore);
  if (view.bestTestScore !== undefined) values.push(view.bestTestScore);

  const low = view.baselineScore ?? (values.length ? Math.min(...values) : 0);
  const high = values.length ? Math.max(...values) : 1;
  // A flat run would otherwise divide by zero and draw every point on the axis.
  const span = high - low || Math.abs(high) * 0.2 || 0.1;
  return {
    max: high + span * 0.16,
    maxIndex: Math.max(1, ...view.candidates.map((candidate) => candidate.nodeIndex)),
    min: Math.max(0, low - span * 0.16),
  };
}

/** Axis labels gain a decimal only when the data needs it: `0.44` reads
 *  better than `0.440`, and a run whose scores differ in the third place still
 *  gets a usable axis. */
function axisLabel(value: number, range: number): string {
  if (range >= 2) return value.toFixed(1);
  if (range >= 0.2) return value.toFixed(2);
  return value.toFixed(3);
}
