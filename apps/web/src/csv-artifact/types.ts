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

export type DataValue = boolean | null | number | string;

export interface DataRow {
  __rowId: string;
  [field: string]: DataValue;
}

export type ColumnKind =
  | "categorical"
  | "date"
  | "identifier"
  | "quantitative"
  | "text";

export interface ColumnProfile {
  examples: DataValue[];
  id: string;
  kind: ColumnKind;
  label: string;
  max?: number;
  min?: number;
  missingCount: number;
  uniqueCount: number;
}

export type DataTableKind =
  | "cells"
  | "differential"
  | "enrichment"
  | "generic"
  | "matrix";

export interface DataSourceRecord {
  fileHash: string;
  fileName: string;
  fileSize: number;
  importedAt: string;
  sourceArtifactVersionId: string;
}

export interface DataTable {
  columns: ColumnProfile[];
  id: string;
  kind: DataTableKind;
  label: string;
  rows: DataRow[];
  source: DataSourceRecord;
  warnings: string[];
}

export type ChartType =
  | "box"
  | "dot-matrix"
  | "heatmap"
  | "histogram"
  | "ranked-bar"
  | "ranked-bubble"
  | "scatter"
  | "table"
  | "violin"
  | "volcano";

export type ChartDragMode = "lasso" | "pan";

export const DEFAULT_CHART_DRAG_MODE: ChartDragMode = "pan";

export interface ChartMappings {
  colorBy?: string;
  facetBy?: string;
  label?: string;
  sizeBy?: string;
  tooltip: string[];
  x?: string;
  y?: string;
}

export interface IncludeFilter {
  field: string;
  kind: "include";
  values: DataValue[];
}

export interface RangeFilter {
  field: string;
  kind: "range";
  max?: number;
  min?: number;
}

export interface SearchFilter {
  field?: string;
  kind: "search";
  query: string;
}

export type FilterSpec = IncludeFilter | RangeFilter | SearchFilter;

export interface ScaleSpec {
  colorPalette: string;
  facetIndependentAxes: boolean;
  xScale: "category" | "linear" | "log";
  yScale: "category" | "linear" | "log";
}

export interface ThresholdSpec {
  axis: "x" | "y";
  color: string;
  label: string;
  value: number;
}

export interface AppearanceSpec {
  facetColumns: number;
  opacity: number;
  pointMax: number;
  pointMin: number;
  showGrid: boolean;
  showLegend: boolean;
  subtitle?: string;
  title: string;
}

export interface ChartSpec {
  appearance: AppearanceSpec;
  displayName: string;
  displayFilters: FilterSpec[];
  id: string;
  mappings: ChartMappings;
  preset: string;
  scales: ScaleSpec;
  schemaVersion: 1;
  sourceArtifactVersionId: string;
  tableId: string;
  thresholds: ThresholdSpec[];
  type: ChartType;
}
