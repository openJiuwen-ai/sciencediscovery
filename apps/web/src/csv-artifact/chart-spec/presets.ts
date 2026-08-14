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

import type {
  AppearanceSpec,
  ChartMappings,
  ChartSpec,
  ChartType,
  DataTable,
  ScaleSpec,
  ThresholdSpec,
} from "../types.js";

const DEFAULT_APPEARANCE: AppearanceSpec = {
  facetColumns: 2,
  opacity: 0.82,
  pointMax: 22,
  pointMin: 7,
  showGrid: true,
  showLegend: true,
  title: "Untitled chart",
};

const DEFAULT_SCALES: ScaleSpec = {
  colorPalette: "Research",
  facetIndependentAxes: false,
  xScale: "linear",
  yScale: "linear",
};

function sourceVersion(tables: DataTable[], tableId: string): string {
  return tables.find((table) => table.id === tableId)?.source.sourceArtifactVersionId ?? "unknown";
}

function spec(
  tables: DataTable[],
  input: {
    appearance?: Partial<AppearanceSpec>;
    displayName?: string;
    id: string;
    mappings: Partial<ChartMappings>;
    preset: string;
    scales?: Partial<ScaleSpec>;
    tableId: string;
    thresholds?: ThresholdSpec[];
    type: ChartType;
  },
): ChartSpec {
  return {
    appearance: { ...DEFAULT_APPEARANCE, ...input.appearance },
    displayName: input.displayName ?? input.preset,
    displayFilters: [],
    id: input.id,
    mappings: { tooltip: [], ...input.mappings },
    preset: input.preset,
    scales: { ...DEFAULT_SCALES, ...input.scales },
    schemaVersion: 1,
    sourceArtifactVersionId: sourceVersion(tables, input.tableId),
    tableId: input.tableId,
    thresholds: input.thresholds ?? [],
    type: input.type,
  };
}

function matchingField(table: DataTable, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const column = table.columns.find((candidate) => pattern.test(candidate.id));
    if (column) return column.id;
  }
  return undefined;
}

export function createCustomSpec(table: DataTable, sequence: number): ChartSpec {
  const quantitative = table.columns.filter((column) => column.kind === "quantitative").map((column) => column.id);
  const categorical = table.columns.find((column) => column.kind === "categorical")?.id;
  const identifier = table.columns.find((column) => column.kind === "identifier")?.id;
  const displayName = `New chart ${sequence}`;
  const type: ChartType = quantitative.length >= 2
    ? "scatter"
    : quantitative.length === 1
      ? "histogram"
      : "table";

  return spec([table], {
    appearance: { title: displayName },
    displayName,
    id: `custom-chart-${sequence}`,
    mappings: {
      colorBy: categorical,
      label: identifier,
      sizeBy: type === "scatter" ? quantitative[2] : undefined,
      tooltip: [identifier, categorical].filter((field): field is string => Boolean(field)),
      x: type === "table" ? undefined : quantitative[0],
      y: type === "scatter" ? quantitative[1] : undefined,
    },
    preset: "Custom chart",
    tableId: table.id,
    type,
  });
}

export function createDefaultSpecs(table: DataTable): ChartSpec[] {
  const tables = [table];
  const quantitative = table.columns.filter((column) => column.kind === "quantitative").map((column) => column.id);
  const categorical = table.columns.filter((column) => column.kind === "categorical").map((column) => column.id);
  const identifier = table.columns.find((column) => column.kind === "identifier")?.id;
  const tooltip = [identifier, categorical[0]].filter((field): field is string => Boolean(field));
  const result: ChartSpec[] = [];
  const effect = matchingField(table, [/log2[_ .-]?(?:fc|fold)/i, /^effect/i]);
  const significance = matchingField(table, [
    /^neg[_ .-]?log10/i,
    /^adjusted[_ .-]?p[_ .-]?value$/i,
    /^padj$/i,
    /^q[_ .-]?value$/i,
    /^p[_ .-]?value$/i,
  ]);
  const term = matchingField(table, [/^term$/i, /^pathway$/i, /^gene[_ .-]?set$/i]);
  const ratio = matchingField(table, [/gene[_ .-]?ratio/i, /^ratio$/i]);
  const gene = matchingField(table, [/^gene$/i, /^feature$/i, /^marker$/i]);
  const group = matchingField(table, [/^cell[_ .-]?type$/i, /^cluster$/i, /^group$/i]);
  const meanExpression = matchingField(table, [/^(?:mean|average|avg)[_ .-]?(?:expression|expr)$/i]);
  const percentExpressing = matchingField(table, [/^pct[_ .-]?(?:expressing|expression|expr)$/i, /^percent[_ .-]?expressing$/i]);
  const hitCount = matchingField(table, [/^hit[_ .-]?count$/i, /^count$/i, /^gene[_ .-]?count$/i]);
  const negLogSignificance = matchingField(table, [/^neg[_ .-]?log10/i]);
  const embeddingPairs = [
    {
      id: "umap",
      label: "UMAP",
      x: matchingField(table, [/^umap[_ .-]?(?:1|x)$/i]),
      y: matchingField(table, [/^umap[_ .-]?(?:2|y)$/i]),
    },
    {
      id: "tsne",
      label: "t-SNE",
      x: matchingField(table, [/^(?:t[_ .-]?sne|tsne)[_ .-]?(?:1|x)$/i]),
      y: matchingField(table, [/^(?:t[_ .-]?sne|tsne)[_ .-]?(?:2|y)$/i]),
    },
    {
      id: "pca",
      label: "PCA",
      x: matchingField(table, [/^(?:pca[_ .-]?1|pc[_ .-]?1)$/i]),
      y: matchingField(table, [/^(?:pca[_ .-]?2|pc[_ .-]?2)$/i]),
    },
  ];

  for (const embedding of embeddingPairs) {
    if (!embedding.x || !embedding.y) continue;
    result.push(spec(tables, {
      appearance: { title: `${embedding.label} projection` },
      id: `artifact-${embedding.id}`,
      mappings: {
        colorBy: categorical[0],
        label: identifier,
        tooltip,
        x: embedding.x,
        y: embedding.y,
      },
      preset: embedding.label,
      tableId: table.id,
      type: "scatter",
    }));
  }

  if (effect && significance) {
    const pValueY = !/^neg/i.test(significance);
    result.push(spec(tables, {
      appearance: { subtitle: pValueY ? "Y values are displayed as -log10" : undefined, title: "Volcano plot" },
      id: "uploaded-volcano",
      mappings: { colorBy: categorical[0], label: identifier, tooltip, x: effect, y: significance },
      preset: "Volcano plot",
      tableId: table.id,
      thresholds: [
        { axis: "x", color: "#a4262c", label: "-0.5", value: -0.5 },
        { axis: "x", color: "#14734f", label: "0.5", value: 0.5 },
        { axis: "y", color: "#9a6700", label: "P = 0.05", value: -Math.log10(0.05) },
      ],
      type: "volcano",
    }));
  }

  if (table.kind === "matrix" && gene && group && meanExpression) {
    result.push(spec(tables, {
      appearance: { title: "Marker expression dot plot" },
      id: "artifact-marker-dotplot",
      mappings: {
        colorBy: meanExpression,
        sizeBy: percentExpressing,
        tooltip: [meanExpression, percentExpressing].filter((field): field is string => Boolean(field)),
        x: gene,
        y: group,
      },
      preset: "Marker dot plot",
      scales: { xScale: "category", yScale: "category" },
      tableId: table.id,
      type: "dot-matrix",
    }));
    result.push(spec(tables, {
      appearance: { title: "Marker expression heatmap" },
      id: "artifact-marker-heatmap",
      mappings: {
        colorBy: meanExpression,
        tooltip: percentExpressing ? [percentExpressing] : [],
        x: gene,
        y: group,
      },
      preset: "Marker heatmap",
      scales: { xScale: "category", yScale: "category" },
      tableId: table.id,
      type: "heatmap",
    }));
  }

  if (term && quantitative.length) {
    const ranking = negLogSignificance ?? ratio ?? quantitative[0]!;
    result.push(spec(tables, {
      appearance: { title: "Ranked enrichment results" },
      id: "uploaded-ranked",
      mappings: {
        colorBy: categorical[0],
        label: term,
        tooltip: [ratio, hitCount, significance].filter((field): field is string => Boolean(field)),
        x: ranking,
        y: term,
      },
      preset: "Enrichment bar chart",
      scales: { yScale: "category" },
      tableId: table.id,
      type: "ranked-bar",
    }));
    if (ratio && hitCount) {
      result.push(spec(tables, {
        appearance: { title: "Enrichment bubble chart" },
        id: "artifact-enrichment-bubble",
        mappings: {
          colorBy: negLogSignificance ?? significance,
          label: term,
          sizeBy: hitCount,
          tooltip: [significance, hitCount].filter((field): field is string => Boolean(field)),
          x: ratio,
          y: term,
        },
        preset: "Enrichment bubble chart",
        scales: { yScale: "category" },
        tableId: table.id,
        type: "ranked-bubble",
      }));
    }
  }

  if (!embeddingPairs.some((embedding) => embedding.x && embedding.y) && quantitative.length >= 2) {
    result.push(spec(tables, {
      appearance: { title: "Scatter plot" },
      id: "uploaded-scatter",
      mappings: {
        colorBy: categorical[0],
        label: identifier,
        sizeBy: quantitative[2],
        tooltip,
        x: quantitative[0],
        y: quantitative[1],
      },
      preset: "Scatter plot",
      tableId: table.id,
      type: "scatter",
    }));
  }

  const coordinatePattern = /^(?:umap|t[_ .-]?sne|tsne|pca|pc)[_ .-]?\d+$/i;
  const distributionField = quantitative.find((field) => !coordinatePattern.test(field)) ?? quantitative[0];
  if (quantitative[0]) {
    result.push(spec(tables, {
      appearance: { title: `${distributionField} distribution` },
      id: "uploaded-histogram",
      mappings: { colorBy: categorical[0], tooltip, x: distributionField },
      preset: "Histogram",
      tableId: table.id,
      type: "histogram",
    }));
    if (categorical[0]) {
      result.push(spec(tables, {
        appearance: { title: `${distributionField} grouped by ${categorical[0]}` },
        id: "uploaded-box",
        mappings: { colorBy: categorical[0], tooltip, x: categorical[0], y: distributionField },
        preset: "Box plot",
        scales: { xScale: "category" },
        tableId: table.id,
        type: "box",
      }));
      result.push(spec(tables, {
        appearance: { title: `${distributionField} expression distribution` },
        id: "artifact-violin",
        mappings: { colorBy: categorical[0], tooltip, x: categorical[0], y: distributionField },
        preset: "Violin plot",
        scales: { xScale: "category" },
        tableId: table.id,
        type: "violin",
      }));
    }
  }
  result.push(spec(tables, {
    appearance: { title: `${table.label} records` },
    id: "uploaded-table",
    mappings: { tooltip: [] },
    preset: "Data table",
    tableId: table.id,
    type: "table",
  }));
  return result;
}

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  box: "Box plot",
  "dot-matrix": "Dot matrix",
  heatmap: "Heatmap",
  histogram: "Histogram",
  "ranked-bar": "Ranked bar chart",
  "ranked-bubble": "Ranked bubble chart",
  scatter: "Scatter plot",
  table: "Data table",
  violin: "Violin plot",
  volcano: "Volcano plot",
};

export function requiredMappings(type: ChartType): Array<keyof ChartMappings> {
  if (type === "histogram") return ["x"];
  if (type === "table") return [];
  return ["x", "y"];
}
