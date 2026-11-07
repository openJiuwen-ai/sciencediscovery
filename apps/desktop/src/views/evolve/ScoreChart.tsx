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
 * The handoff draws three layers: a blue staircase of the best score so far,
 * the gate-measured evaluations behind it as dots, and the points that never
 * ran as hollow red circles on the floor. Below the baseline the band is
 * hatched, because "worse than where we started" is a place worth seeing
 * rather than a place to clip away.
 *
 * The x axis is the expansion index, not wall-clock time: a search fans out,
 * so two points at neighbouring minutes are not a sequence, while the index
 * says exactly how many ideas the run had spent.
 *
 * Hand-drawn SVG rather than a chart library: this is one step line, a few
 * hundred circles and two rules, and the app has no charting dependency it
 * would be honest to add for it.
 */

import { useState } from "react";

import { TEXT } from "../../text.js";
import { CrownGlyph } from "./glyphs.js";
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
  /** Measured by the acceptance gate — the filled blue points. */
  significant: Point[];
}

const WIDTH = 820;
const HEIGHT = 280;
const PAD = { bottom: 46, left: 56, right: 20, top: 22 };

export function ScoreChart({ onSelect, view }: {
  /** Opens the node's detail, the same way a row of the node list does. */
  onSelect?: (index: number) => void;
  view: EvolveRunView;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const series = collectSeries(view);
  if (!series.significant.length && view.baselineScore === null) {
    return <p className="evolve-chart-empty">{TEXT.evolve.chart.empty}</p>;
  }

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const floor = PAD.top + plotHeight;
  const bounds = boundsOf(series, view);
  const x = (index: number) => PAD.left + plotWidth * (index / bounds.maxIndex);
  const y = (value: number) => {
    const clamped = Math.min(bounds.max, Math.max(bounds.min, value));
    return PAD.top + plotHeight * (1 - (clamped - bounds.min) / (bounds.max - bounds.min || 1));
  };

  const points = [...series.significant].sort((left, right) => left.index - right.index);
  // The best-so-far staircase: starts at the baseline and steps up where a
  // candidate first beats everything before it.
  let best = view.baselineScore ?? -Infinity;
  let line = "";
  if (view.baselineScore !== null) line = `M${x(0).toFixed(1)},${y(view.baselineScore).toFixed(1)}`;
  for (const point of points) {
    if (point.value <= best) continue;
    line = line
      ? `${line} H${x(point.index).toFixed(1)} V${y(point.value).toFixed(1)}`
      : `M${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`;
    best = point.value;
  }
  if (line) line += ` H${x(bounds.maxIndex).toFixed(1)}`;

  const bestScore = headlineScore(view);
  const bestNode = bestCandidate(view);
  // Five vertical rules, as the handoff draws them, labelled by the expansion
  // index that sits at each fraction of the run.
  const ticks = Array.from({ length: 5 }, (_unused, at) =>
    Math.round((bounds.maxIndex * at) / 4));

  // The node the pointer is on. Its depth is not in the series (that is only
  // what the gate measured), so it is read from the run, and a candidate the
  // list no longer holds simply gets no generation line.
  const hoverPoint = hovered === null ? undefined : pointAt(hovered, series);
  const hoverDepth = hoverPoint === undefined
    ? undefined
    : view.candidates.find((candidate) => candidate.nodeIndex === hoverPoint.index)?.depth;
  const hoverX = hoverPoint === undefined ? 0 : x(hoverPoint.index);
  const hoverY = hoverPoint === undefined
    ? 0
    : hoverPoint.failed ? floor : y(hoverPoint.value ?? 0);
  // The card is placed below-right of the point, except near an edge, where it
  // would leave the drawing; there it flips to the other side.
  const flipX = hoverX > WIDTH * 0.62;
  const flipY = hoverY > HEIGHT * 0.68;

  return <figure className="evolve-chart">
    <div className="evolve-chart-canvas">
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
        <defs>
          <pattern
            height="10"
            id="evolve-hatch"
            patternTransform="rotate(45 0 0)"
            patternUnits="userSpaceOnUse"
            width="8"
          >
            <line className="evolve-chart-hatch-line" x1="0" x2="0" y1="0" y2="10" />
          </pattern>
        </defs>

        {ticks.map((index, at) => <g key={at}>
          <line
            className="evolve-chart-grid"
            x1={x(index)}
            x2={x(index)}
            y1={PAD.top}
            y2={floor}
          />
          <text
            className="evolve-chart-x"
            textAnchor={at === 0 ? "start" : at === ticks.length - 1 ? "end" : "middle"}
            x={x(index)}
            y={HEIGHT - 24}
          >
            {index}
          </text>
        </g>)}

        {view.baselineScore === null ? null : <rect
          className="evolve-chart-below"
          fill="url(#evolve-hatch)"
          height={Math.max(0, floor - y(view.baselineScore))}
          width={plotWidth}
          x={PAD.left}
          y={y(view.baselineScore)}
        />}

        {view.baselineScore === null ? null : <g>
          <line
            className="evolve-chart-baseline"
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={y(view.baselineScore)}
            y2={y(view.baselineScore)}
          />
          <text
            className="evolve-chart-tick"
            textAnchor="end"
            x={PAD.left - 8}
            y={y(view.baselineScore) + 3.5}
          >
            {ruleLabel(view.baselineScore)}
          </text>
          <text
            className="evolve-chart-baseline-label"
            textAnchor="start"
            x={PAD.left}
            y={y(view.baselineScore) + 16}
          >
            {TEXT.evolve.chart.baseline}
          </text>
        </g>}

        {bestScore === null ? null : <g>
          <line
            className="evolve-chart-best-line"
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={y(bestScore)}
            y2={y(bestScore)}
          />
          <text
            className="evolve-chart-tick is-best"
            textAnchor="end"
            x={PAD.left - 8}
            y={y(bestScore) + 3.5}
          >
            {ruleLabel(bestScore)}
          </text>
        </g>}

        {/* The rule under the pointer: the handoff draws it top to bottom, so
            the reader can see which expansion a point belongs to even when the
            card is off to the side. */}
        {hoverPoint === undefined ? null : <line
          className="evolve-chart-guide"
          x1={hoverX}
          x2={hoverX}
          y1={PAD.top}
          y2={HEIGHT}
        />}

        {line ? <path className="evolve-chart-line" d={line} /> : null}

        {series.failed.map((index) => <circle
          className="evolve-chart-failed"
          cx={x(index)}
          cy={floor}
          key={`failed-${index}`}
          r={hovered === index ? 4.4 : 3.4}
        />)}

        {series.significant.map((point) => <circle
          className={`evolve-chart-dot is-significant${bestNode?.nodeIndex === point.index ? " is-best" : ""}`}
          cx={x(point.index)}
          cy={y(point.value)}
          key={`significant-${point.index}`}
          r={hovered === point.index ? 5 : 3.8}
        />)}

        {view.bestTestScore === undefined ? null : <g className="evolve-chart-test">
          <circle cx={x(bounds.maxIndex)} cy={y(view.bestTestScore)} r={4.6} />
          <title>{`${TEXT.evolve.chart.test} ${formatScore(view.bestTestScore)}`}</title>
        </g>}

        {bestNode === undefined || bestScore === null ? null : <g className="evolve-chart-best">
          <circle cx={x(bestNode.nodeIndex)} cy={y(bestScore)} r={7.2} />
          <g transform={`translate(${x(bestNode.nodeIndex) - 5} ${y(bestScore) - 5})`}>
            <CrownGlyph size={10} />
          </g>
          <title>{`#${bestNode.nodeIndex} · ${TEXT.evolve.chart.best}`}</title>
        </g>}

        {/* The points are small by design; the hit areas are not. This layer is
            last so it sits above the best marker and the step line, and it
            carries the accessible name the visible dot used to give as a
            native `<title>` — the card below replaces that tooltip. */}
        {series.significant.map((point) => <circle
          aria-label={`#${point.index} · ${TEXT.evolve.chart.significant} ${formatScore(point.value)}`}
          className="evolve-chart-hit"
          cx={x(point.index)}
          cy={y(point.value)}
          key={`hit-${point.index}`}
          onBlur={() => setHovered((current) => current === point.index ? null : current)}
          onClick={() => onSelect?.(point.index)}
          onFocus={() => setHovered(point.index)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onSelect?.(point.index);
          }}
          onMouseEnter={() => setHovered(point.index)}
          onMouseLeave={() => setHovered((current) => current === point.index ? null : current)}
          r={13}
          role="button"
          tabIndex={0}
        />)}
        {series.failed.map((index) => <circle
          aria-label={`#${index} · ${TEXT.evolve.chart.failed}`}
          className="evolve-chart-hit"
          cx={x(index)}
          cy={floor}
          key={`hit-failed-${index}`}
          onBlur={() => setHovered((current) => current === index ? null : current)}
          onClick={() => onSelect?.(index)}
          onFocus={() => setHovered(index)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onSelect?.(index);
          }}
          onMouseEnter={() => setHovered(index)}
          onMouseLeave={() => setHovered((current) => current === index ? null : current)}
          r={12}
          role="button"
          tabIndex={0}
        />)}

        <line
          className="evolve-chart-axis"
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={floor}
          y2={floor}
        />
        <text className="evolve-chart-tick" textAnchor="end" x={PAD.left - 8} y={floor + 3.5}>0</text>
        <text className="evolve-chart-tick is-top" textAnchor="end" x={PAD.left - 8} y={PAD.top + 3.5}>
          {axisLabel(bounds.max, bounds.max - bounds.min)}
        </text>
        <text
          className="evolve-chart-x-label"
          textAnchor="middle"
          x={PAD.left + plotWidth / 2}
          y={HEIGHT - 4}
        >
          {TEXT.evolve.chart.xAxis}
        </text>
      </svg>

      {hoverPoint === undefined ? null : (
        <div
          className={`evolve-chart-tooltip${flipX ? " is-left" : ""}${flipY ? " is-above" : ""}`}
          style={{
            left: `${(hoverX / WIDTH) * 100}%`,
            top: `${(hoverY / HEIGHT) * 100}%`,
          }}
        >
          <div className="evolve-chart-tooltip-head">
            <span className={`evolve-chart-tooltip-bullet${hoverPoint.failed ? " is-failed" : ""}`} />
            <span className="evolve-chart-tooltip-node">
              {TEXT.evolve.detail.nodeTitle(hoverPoint.index)}
            </span>
            {hoverDepth === undefined ? null : (
              <span className="evolve-chart-tooltip-gen">
                {TEXT.evolve.detail.generation(hoverDepth)}
              </span>
            )}
            {hoverPoint.failed ? (
              <span className="evolve-chart-tooltip-failed">{TEXT.evolve.chart.failed}</span>
            ) : bestNode?.nodeIndex === hoverPoint.index ? (
              <span className="evolve-chart-tooltip-best">
                <CrownGlyph size={13} />
                {TEXT.evolve.detail.bestTag}
              </span>
            ) : null}
          </div>
          {hoverPoint.value === null ? null : (
            <div className="evolve-chart-tooltip-score">{formatScore(hoverPoint.value)}</div>
          )}
        </div>
      )}
    </div>

    <figcaption className="evolve-chart-legend">
      <span className="evolve-key is-best">
        <CrownGlyph size={13} />
        {TEXT.evolve.chart.best}
      </span>
      <span className="evolve-key is-significant">{TEXT.evolve.chart.significant}</span>
      <span className="evolve-key is-test">{TEXT.evolve.chart.test}</span>
      <span className="evolve-key is-failed">{TEXT.evolve.chart.failed}</span>
      <span className="evolve-key is-below">{TEXT.evolve.chart.belowBaseline}</span>
    </figcaption>
  </figure>;
}

interface HoverPoint {
  failed: boolean;
  index: number;
  value: number | null;
}

/** The plotted point at a node index, or nothing when the list has moved on
 *  since the pointer entered the dot. */
function pointAt(index: number, series: ChartSeries): HoverPoint | undefined {
  const measured = series.significant.find((point) => point.index === index);
  if (measured !== undefined) return { failed: false, index, value: measured.value };
  return series.failed.includes(index) ? { failed: true, index, value: null } : undefined;
}

/** Pure, and exported so the reading of the events is testable without a DOM. */
export function collectSeries(view: EvolveRunView): ChartSeries {
  const significant: Point[] = [];
  const failed: number[] = [];
  for (const candidate of view.candidates) {
    if (!candidate.valid) {
      failed.push(candidate.nodeIndex);
      continue;
    }
    // A gate score is the one the acceptance decision read. A candidate the
    // gate never measured has no comparable reading, so it is left out of the
    // plot entirely rather than drawn with a different-looking score.
    const value = candidate.gateScore;
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    significant.push({ index: candidate.nodeIndex, value });
  }
  return { failed, significant };
}

function boundsOf(
  series: ChartSeries,
  view: EvolveRunView,
): { max: number; maxIndex: number; min: number } {
  const values = series.significant.map((point) => point.value);
  if (view.baselineScore !== null) values.push(view.baselineScore);
  if (view.bestTestScore !== undefined) values.push(view.bestTestScore);

  const low = Math.min(0, view.baselineScore ?? (values.length ? Math.min(...values) : 0));
  const high = values.length ? Math.max(...values) : 1;
  // A normalized score gets the handoff's 0–1 frame; anything else keeps a
  // margin so the best point is not glued to the top edge.
  const frame = high <= 1 && low >= 0;
  const span = high - low || Math.abs(high) * 0.2 || 0.1;
  return {
    max: frame ? 1 : high + span * 0.16,
    maxIndex: Math.max(1, ...view.candidates.map((candidate) => candidate.nodeIndex)),
    min: frame ? 0 : low - span * 0.16,
  };
}

/** Axis labels gain a decimal only when the data needs it: `0.44` reads
 *  better than `0.440`, and a run whose scores differ in the third place still
 *  gets a usable axis. */
/** The label beside the baseline and best rules: the handoff prints three
 *  decimals there, because these two are readings rather than axis bounds. */
function ruleLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function axisLabel(value: number, range: number): string {
  // A whole-number bound is the frame the chart was drawn in, and the handoff
  // writes it as `1`, not `1.00`.
  if (Number.isInteger(value)) return String(value);
  if (range >= 2) return value.toFixed(1);
  if (range >= 0.2) return value.toFixed(2);
  return value.toFixed(3);
}
