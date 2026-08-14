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

import { filterRows, uniqueValues } from "../chart-spec/filters.js";
import {
  DEFAULT_CHART_DRAG_MODE,
  type ChartSpec,
  type ColumnProfile,
  type DataRow,
  type DataTable,
  type DataValue,
  type ScaleSpec,
  type ThresholdSpec,
} from "../types.js";

export interface PlotFigure {
  data: Array<Record<string, unknown>>;
  layout: Record<string, unknown>;
  visibleRows: DataRow[];
}

const CATEGORY_COLORS = [
  "#2563eb",
  "#0f766e",
  "#dc5a47",
  "#a16207",
  "#7c3aed",
  "#15803d",
  "#be185d",
  "#475569",
  "#0891b2",
  "#c2410c",
  "#4f46e5",
  "#65a30d",
];

const CONTINUOUS_SCALE: Array<[number, string]> = [
  [0, "#f1f5f9"],
  [0.18, "#bae6fd"],
  [0.42, "#2dd4bf"],
  [0.68, "#facc15"],
  [1, "#dc3f3f"],
];
const MISSING_LABEL = "Missing";
const PROBABILITY_FIELD_PATTERN = /^(?:p(?:[_ .-]?value)?|adjusted[_ .-]?p[_ .-]?value|padj|q(?:[_ .-]?value)?)$/i;

function numeric(value: DataValue): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function displayValue(value: DataValue): string {
  if (value === null) return MISSING_LABEL;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toPrecision(4);
  return String(value);
}

function longestLabelLength(rows: DataRow[], field?: string): number {
  return uniqueValues(rows, field).reduce<number>((longest, value) =>
    Math.max(longest, displayValue(value).length), 0);
}

function fieldProfile(table: DataTable, field?: string): ColumnProfile | undefined {
  return field ? table.columns.find((column) => column.id === field) : undefined;
}

function categoricalAxis(profile: ColumnProfile | undefined, configuredScale: string): boolean {
  return configuredScale === "category"
    || profile?.kind === "categorical"
    || profile?.kind === "identifier"
    || profile?.kind === "text";
}

function axisType(profile: ColumnProfile | undefined, configuredScale: ScaleSpec["xScale"]): string {
  if (categoricalAxis(profile, configuredScale)) return "category";
  if (profile?.kind === "date") return "date";
  return configuredScale;
}

function yAxisTitle(spec: ChartSpec): string {
  const field = spec.mappings.y ?? "";
  return spec.type === "volcano" && PROBABILITY_FIELD_PATTERN.test(field)
    ? `-log10(${field})`
    : field;
}

function axisTraceName(axis: "x" | "y", index: number): string {
  return index === 1 ? axis : `${axis}${index}`;
}

function axisLayoutName(axis: "x" | "y", index: number): string {
  return `${axis}axis${index === 1 ? "" : index}`;
}

function categoryColorMap(rows: DataRow[], field?: string): Map<string, string> {
  return new Map(uniqueValues(rows, field).map((value, index) =>
    [String(value ?? MISSING_LABEL), CATEGORY_COLORS[index % CATEGORY_COLORS.length]!]));
}

function sizeValues(
  rows: DataRow[],
  field: string | undefined,
  minSize: number,
  maxSize: number,
): number[] {
  if (!field) return rows.map(() => Math.max(minSize, 8));
  const values = rows.map((row) => numeric(row[field] ?? null) ?? 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return values.map(() => (minSize + maxSize) / 2);
  return values.map((value) => minSize + (value - min) / (max - min) * (maxSize - minSize));
}

function yValue(row: DataRow, spec: ChartSpec): DataValue {
  const field = spec.mappings.y;
  const value = field ? row[field] ?? null : null;
  if (spec.type !== "volcano" || typeof value !== "number") return value;
  if (PROBABILITY_FIELD_PATTERN.test(field ?? "") && value >= 0 && value <= 1) {
    return -Math.log10(Math.max(value, Number.MIN_VALUE));
  }
  return value;
}

function customData(rows: DataRow[], spec: ChartSpec): DataValue[][] {
  return rows.map((row) => [
    row.__rowId,
    ...spec.mappings.tooltip.map((field) => row[field] ?? null),
    spec.mappings.label ? row[spec.mappings.label] ?? null : null,
  ]);
}

function hoverTemplate(spec: ChartSpec): string {
  const lines = [
    spec.mappings.label ? `<b>%{customdata[${spec.mappings.tooltip.length + 1}]}</b>` : "<b>%{customdata[0]}</b>",
    spec.mappings.x ? `${spec.mappings.x}: %{x}` : "",
    spec.mappings.y ? `${spec.mappings.y}: %{y}` : "",
    ...spec.mappings.tooltip.map((field, index) => `${field}: %{customdata[${index + 1}]}`),
  ].filter(Boolean);
  return `${lines.join("<br>")}<extra></extra>`;
}

function markerForRows(
  rows: DataRow[],
  spec: ChartSpec,
  colorProfile: ColumnProfile | undefined,
  categoryColors: Map<string, string>,
): Record<string, unknown> {
  const colorField = spec.mappings.colorBy;
  const marker: Record<string, unknown> = {
    line: { color: "rgba(255,255,255,.58)", width: 0.5 },
    opacity: spec.appearance.opacity,
    size: sizeValues(rows, spec.mappings.sizeBy, spec.appearance.pointMin, spec.appearance.pointMax),
  };
  if (colorField && colorProfile?.kind === "quantitative") {
    marker.color = rows.map((row) => numeric(row[colorField] ?? null));
    marker.coloraxis = "coloraxis";
  } else if (colorField) {
    marker.color = rows.map((row) => categoryColors.get(String(row[colorField] ?? MISSING_LABEL)) ?? CATEGORY_COLORS[0]);
  } else {
    marker.color = CATEGORY_COLORS[0];
  }
  return marker;
}

function groupsForColor(
  rows: DataRow[],
  colorField: string | undefined,
  colorProfile: ColumnProfile | undefined,
): Array<{ label: string; rows: DataRow[] }> {
  if (!colorField) return [{ label: "Observations", rows }];
  if (colorProfile?.kind === "quantitative") return [{ label: colorField, rows }];
  return uniqueValues(rows, colorField).map((value) => ({
    label: String(value ?? MISSING_LABEL),
    rows: rows.filter((row) => String(row[colorField] ?? MISSING_LABEL) === String(value ?? MISSING_LABEL)),
  }));
}

function baseTrace(
  rows: DataRow[],
  spec: ChartSpec,
  axisIndex: number,
): Record<string, unknown> {
  return {
    customdata: customData(rows, spec),
    hovertemplate: hoverTemplate(spec),
    xaxis: axisTraceName("x", axisIndex),
    yaxis: axisTraceName("y", axisIndex),
  };
}

function scatterTraces(
  rows: DataRow[],
  spec: ChartSpec,
  table: DataTable,
  axisIndex: number,
  showLegend: boolean,
  allRows: DataRow[],
): Array<Record<string, unknown>> {
  const colorProfile = fieldProfile(table, spec.mappings.colorBy);
  const categoryColors = categoryColorMap(allRows, spec.mappings.colorBy);
  return groupsForColor(rows, spec.mappings.colorBy, colorProfile).map((group) => ({
    ...baseTrace(group.rows, spec, axisIndex),
    marker: markerForRows(group.rows, spec, colorProfile, categoryColors),
    mode: "markers",
    name: group.label,
    selected: { marker: { opacity: 1 } },
    showlegend: showLegend && spec.appearance.showLegend && colorProfile?.kind !== "quantitative",
    type: rows.length > 1_500 ? "scattergl" : "scatter",
    unselected: { marker: { opacity: Math.max(0.12, spec.appearance.opacity * 0.28) } },
    x: group.rows.map((row) => spec.mappings.x ? row[spec.mappings.x] ?? null : null),
    y: group.rows.map((row) => yValue(row, spec)),
  }));
}

function distributionTraces(
  rows: DataRow[],
  spec: ChartSpec,
  table: DataTable,
  axisIndex: number,
  showLegend: boolean,
  allRows: DataRow[],
): Array<Record<string, unknown>> {
  const colorProfile = fieldProfile(table, spec.mappings.colorBy);
  const categoryColors = categoryColorMap(allRows, spec.mappings.colorBy);
  return groupsForColor(rows, spec.mappings.colorBy, colorProfile).map((group) => {
    const color = categoryColors.get(group.label) ?? CATEGORY_COLORS[0];
    const common = {
      ...baseTrace(group.rows, spec, axisIndex),
      marker: { color, opacity: spec.appearance.opacity },
      name: group.label,
      showlegend: showLegend && spec.appearance.showLegend && colorProfile?.kind !== "quantitative",
      x: group.rows.map((row) => spec.mappings.x ? row[spec.mappings.x] ?? null : null),
    };
    if (spec.type === "histogram") {
      return { ...common, nbinsx: 32, type: "histogram" };
    }
    const y = group.rows.map((row) => spec.mappings.y ? row[spec.mappings.y] ?? null : null);
    if (spec.type === "box") {
      return { ...common, boxmean: true, boxpoints: "outliers", jitter: 0.22, line: { color }, type: "box", y };
    }
    return {
      ...common,
      box: { visible: true },
      fillcolor: `${color}33`,
      line: { color },
      meanline: { visible: true },
      points: "outliers",
      scalemode: "count",
      type: "violin",
      y,
    };
  });
}

function dotMatrixTrace(
  rows: DataRow[],
  spec: ChartSpec,
  table: DataTable,
  axisIndex: number,
): Record<string, unknown> {
  const profile = fieldProfile(table, spec.mappings.colorBy);
  return {
    ...baseTrace(rows, spec, axisIndex),
    marker: markerForRows(rows, spec, profile, categoryColorMap(rows, spec.mappings.colorBy)),
    mode: "markers",
    name: spec.preset,
    showlegend: false,
    type: "scatter",
    x: rows.map((row) => spec.mappings.x ? row[spec.mappings.x] ?? null : null),
    y: rows.map((row) => spec.mappings.y ? row[spec.mappings.y] ?? null : null),
  };
}

function heatmapTrace(rows: DataRow[], spec: ChartSpec, axisIndex: number): Record<string, unknown> {
  const xValues = uniqueValues(rows, spec.mappings.x);
  const yValues = uniqueValues(rows, spec.mappings.y);
  const colorField = spec.mappings.colorBy;
  const cells = new Map<string, number[]>();
  const cellRowIds = new Map<string, string[]>();
  for (const row of rows) {
    const key = `${String(row[spec.mappings.x ?? ""] ?? MISSING_LABEL)}\u0000${String(row[spec.mappings.y ?? ""] ?? MISSING_LABEL)}`;
    cellRowIds.set(key, [...(cellRowIds.get(key) ?? []), row.__rowId]);
    const value = colorField ? numeric(row[colorField] ?? null) : 1;
    if (value === null) continue;
    cells.set(key, [...(cells.get(key) ?? []), value]);
  }
  const z = yValues.map((y) => xValues.map((x) => {
    const values = cells.get(`${String(x ?? MISSING_LABEL)}\u0000${String(y ?? MISSING_LABEL)}`) ?? [];
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }));
  return {
    coloraxis: "coloraxis",
    customdata: yValues.map((y) => xValues.map((x) => ({
      rowIds: cellRowIds.get(`${String(x ?? MISSING_LABEL)}\u0000${String(y ?? MISSING_LABEL)}`) ?? [],
    }))),
    hovertemplate: `${spec.mappings.x}: %{x}<br>${spec.mappings.y}: %{y}<br>${colorField ?? "count"}: %{z:.4g}<extra></extra>`,
    name: spec.preset,
    type: "heatmap",
    x: xValues.map(displayValue),
    xaxis: axisTraceName("x", axisIndex),
    y: yValues.map(displayValue),
    yaxis: axisTraceName("y", axisIndex),
    z,
  };
}

function rankedBarTraces(
  rows: DataRow[],
  spec: ChartSpec,
  table: DataTable,
  axisIndex: number,
  showLegend: boolean,
  allRows: DataRow[],
): Array<Record<string, unknown>> {
  const sorted = [...rows].sort((left, right) =>
    (numeric(right[spec.mappings.x ?? ""] ?? null) ?? 0) - (numeric(left[spec.mappings.x ?? ""] ?? null) ?? 0)).slice(0, 20);
  const colorProfile = fieldProfile(table, spec.mappings.colorBy);
  const categoryColors = categoryColorMap(allRows, spec.mappings.colorBy);
  return groupsForColor(sorted, spec.mappings.colorBy, colorProfile).map((group) => ({
    ...baseTrace(group.rows, spec, axisIndex),
    marker: {
      color: colorProfile?.kind === "quantitative"
        ? group.rows.map((row) => numeric(row[spec.mappings.colorBy ?? ""] ?? null))
        : categoryColors.get(group.label) ?? CATEGORY_COLORS[0],
      ...(colorProfile?.kind === "quantitative" ? { coloraxis: "coloraxis" } : {}),
      opacity: spec.appearance.opacity,
    },
    name: group.label,
    orientation: "h",
    showlegend: showLegend && spec.appearance.showLegend && colorProfile?.kind !== "quantitative",
    type: "bar",
    x: group.rows.map((row) => row[spec.mappings.x ?? ""] ?? null),
    y: group.rows.map((row) => row[spec.mappings.y ?? ""] ?? null),
  }));
}

function thresholdShapes(
  thresholds: ThresholdSpec[],
  facetCount: number,
): Array<Record<string, unknown>> {
  return Array.from({ length: facetCount }, (_, index) => index + 1).flatMap((axisIndex) =>
    thresholds.map((threshold) => threshold.axis === "x" ? {
      line: { color: threshold.color, dash: "dot", width: 1.4 },
      type: "line",
      x0: threshold.value,
      x1: threshold.value,
      xref: axisTraceName("x", axisIndex),
      y0: 0,
      y1: 1,
      yref: `${axisTraceName("y", axisIndex)} domain`,
    } : {
      line: { color: threshold.color, dash: "dot", width: 1.4 },
      type: "line",
      x0: 0,
      x1: 1,
      xref: `${axisTraceName("x", axisIndex)} domain`,
      y0: threshold.value,
      y1: threshold.value,
      yref: axisTraceName("y", axisIndex),
    }));
}

export function buildFigure(table: DataTable, spec: ChartSpec): PlotFigure {
  const visibleRows = filterRows(table.rows, spec.displayFilters);
  const facetValues = spec.mappings.facetBy
    ? uniqueValues(visibleRows, spec.mappings.facetBy)
    : [null];
  const inferredFacetGroups = facetValues.map((value) => ({
    label: spec.mappings.facetBy ? String(value ?? MISSING_LABEL) : "",
    rows: spec.mappings.facetBy
      ? visibleRows.filter((row) => String(row[spec.mappings.facetBy!] ?? MISSING_LABEL) === String(value ?? MISSING_LABEL))
      : visibleRows,
  }));
  const facetGroups = inferredFacetGroups.length
    ? inferredFacetGroups
    : [{ label: "", rows: [] }];
  const columns = Math.min(spec.appearance.facetColumns, Math.max(1, facetGroups.length));
  const rows = Math.ceil(facetGroups.length / columns);
  const angledXTicks = spec.type === "dot-matrix" || spec.type === "heatmap";
  const xProfile = fieldProfile(table, spec.mappings.x);
  const yProfile = fieldProfile(table, spec.mappings.y);
  const categoricalY = categoricalAxis(yProfile, spec.scales.yScale);
  const longestYLabel = categoricalY ? longestLabelLength(visibleRows, spec.mappings.y) : 0;
  const leftMargin = categoricalY
    ? Math.min(184, Math.max(92, 56 + longestYLabel * 6))
    : 82;
  const data = facetGroups.flatMap((facet, index) => {
    const axisIndex = index + 1;
    const showLegend = index === 0;
    if (spec.type === "scatter" || spec.type === "volcano" || spec.type === "ranked-bubble") {
      return scatterTraces(facet.rows, spec, table, axisIndex, showLegend, visibleRows);
    }
    if (spec.type === "histogram" || spec.type === "box" || spec.type === "violin") {
      return distributionTraces(facet.rows, spec, table, axisIndex, showLegend, visibleRows);
    }
    if (spec.type === "dot-matrix") return [dotMatrixTrace(facet.rows, spec, table, axisIndex)];
    if (spec.type === "heatmap") return [heatmapTrace(facet.rows, spec, axisIndex)];
    if (spec.type === "ranked-bar") {
      return rankedBarTraces(facet.rows, spec, table, axisIndex, showLegend, visibleRows);
    }
    return [];
  });

  const layout: Record<string, unknown> = {
    autosize: true,
    barmode: "overlay",
    boxmode: "group",
    coloraxis: {
      colorbar: { outlinewidth: 0, thickness: 12, title: spec.mappings.colorBy ?? "Value" },
      colorscale: CONTINUOUS_SCALE,
    },
    dragmode: DEFAULT_CHART_DRAG_MODE,
    font: { color: "#344054", family: "Inter, ui-sans-serif, system-ui", size: 12 },
    grid: { columns, pattern: "independent", rows, xgap: 0.08, ygap: 0.13 },
    ...(rows > 1 ? { height: rows * 350 } : {}),
    hoverlabel: { bgcolor: "#111827", bordercolor: "#111827", font: { color: "#ffffff", size: 12 } },
    hovermode: "closest",
    margin: { b: angledXTicks ? 94 : 72, l: leftMargin, r: 42, t: spec.appearance.subtitle ? 82 : 64 },
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    showlegend: spec.appearance.showLegend,
    shapes: thresholdShapes(spec.thresholds, facetGroups.length),
    title: {
      font: { color: "#111827", size: 17 },
      pad: { b: 10 },
      subtitle: spec.appearance.subtitle
        ? { font: { color: "#667085", size: 11 }, text: spec.appearance.subtitle }
        : undefined,
      text: spec.appearance.title,
      x: 0.02,
      xanchor: "left",
    },
    violinmode: "group",
  };

  facetGroups.forEach((facet, index) => {
    const axisIndex = index + 1;
    layout[axisLayoutName("x", axisIndex)] = {
      automargin: true,
      gridcolor: spec.appearance.showGrid ? "#e7ebf0" : "rgba(0,0,0,0)",
      linecolor: "#cbd2da",
      showline: true,
      tickangle: angledXTicks ? -35 : 0,
      title: { standoff: 14, text: spec.mappings.x ?? "" },
      type: axisType(xProfile, spec.scales.xScale),
      zerolinecolor: "#dfe3e8",
    };
    layout[axisLayoutName("y", axisIndex)] = {
      automargin: true,
      autorange: spec.type === "ranked-bar" ? "reversed" : true,
      gridcolor: spec.appearance.showGrid ? "#e7ebf0" : "rgba(0,0,0,0)",
      linecolor: "#cbd2da",
      showline: true,
      title: { standoff: 18, text: yAxisTitle(spec) },
      type: axisType(yProfile, spec.scales.yScale),
      zerolinecolor: "#dfe3e8",
    };
    if (facet.label) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = (column + 0.5) / columns;
      const y = 1 - row / rows;
      layout.annotations = [
        ...((layout.annotations as Array<Record<string, unknown>> | undefined) ?? []),
        {
          font: { color: "#475467", size: 12 },
          showarrow: false,
          text: `<b>${spec.mappings.facetBy}</b> / ${facet.label}`,
          x,
          xref: "paper",
          y: y + 0.018,
          yref: "paper",
        },
      ];
    }
  });

  return { data, layout, visibleRows };
}
