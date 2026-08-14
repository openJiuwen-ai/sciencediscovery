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

import {
  Braces,
  Database,
  Filter,
  Palette,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { uniqueValues } from "../chart-spec/filters.js";
import { CHART_TYPE_LABELS, requiredMappings } from "../chart-spec/presets.js";
import type {
  ChartMappings,
  ChartSpec,
  ChartType,
  ColumnProfile,
  DataTable,
  DataValue,
} from "../types.js";

interface ChartConfigPanelProps {
  activeTable: DataTable;
  canDelete: boolean;
  onChange: (spec: ChartSpec) => void;
  onDeleteSpec: () => void;
  onResetSpec: () => void;
  spec: ChartSpec;
}

const MAPPING_LABELS: Record<Exclude<keyof ChartMappings, "tooltip">, string> = {
  colorBy: "Color field",
  facetBy: "Facet field",
  label: "Label field",
  sizeBy: "Point size field",
  x: "X axis",
  y: "Y axis",
};

function fieldOptions(
  columns: ColumnProfile[],
  mapping: Exclude<keyof ChartMappings, "tooltip">,
): ColumnProfile[] {
  if (mapping === "sizeBy") return columns.filter((column) => column.kind === "quantitative" && (column.min ?? 0) >= 0);
  if (mapping === "facetBy") return columns.filter((column) => column.kind === "categorical" && column.uniqueCount <= 24);
  if (mapping === "colorBy") return columns.filter((column) => column.kind === "categorical" || column.kind === "quantitative");
  if (mapping === "label") return columns.filter((column) => column.kind !== "quantitative" || column.uniqueCount < 80);
  return columns.filter((column) => column.kind !== "text" || column.uniqueCount < 80);
}

export function ChartConfigPanel({
  activeTable,
  canDelete,
  onChange,
  onDeleteSpec,
  onResetSpec,
  spec,
}: ChartConfigPanelProps) {
  const categorical = useMemo(
    () => activeTable.columns.filter((column) => column.kind === "categorical" && column.uniqueCount <= 64),
    [activeTable.columns],
  );
  const [filterField, setFilterField] = useState(categorical[0]?.id ?? "");
  useEffect(() => {
    if (!categorical.some((column) => column.id === filterField)) setFilterField(categorical[0]?.id ?? "");
  }, [activeTable.id, categorical, filterField]);
  const filterValues = useMemo(
    () => uniqueValues(activeTable.rows, filterField),
    [activeTable.rows, filterField],
  );
  const includeFilter = spec.displayFilters.find((filter) => filter.kind === "include" && filter.field === filterField);
  const selectedValues = includeFilter?.kind === "include" ? includeFilter.values : filterValues;
  const searchFilter = spec.displayFilters.find((filter) => filter.kind === "search");
  const required = new Set(requiredMappings(spec.type));

  function updateMapping(mapping: Exclude<keyof ChartMappings, "tooltip">, value: string): void {
    onChange({
      ...spec,
      mappings: { ...spec.mappings, [mapping]: value || undefined },
    });
  }

  function toggleFilterValue(value: DataValue): void {
    const exists = selectedValues.some((item) => String(item) === String(value));
    const nextValues = exists
      ? selectedValues.filter((item) => String(item) !== String(value))
      : [...selectedValues, value];
    const otherFilters = spec.displayFilters.filter((filter) =>
      !(filter.kind === "include" && filter.field === filterField));
    onChange({
      ...spec,
      displayFilters: nextValues.length === filterValues.length
        ? otherFilters
        : [...otherFilters, { field: filterField, kind: "include", values: nextValues }],
    });
  }

  function updateSearch(query: string): void {
    const otherFilters = spec.displayFilters.filter((filter) => filter.kind !== "search");
    onChange({
      ...spec,
      displayFilters: query ? [...otherFilters, { kind: "search", query }] : otherFilters,
    });
  }

  return (
    <aside className="csva-config-panel" aria-label="Chart settings">
      <div className="csva-panel-title">
        <span><Palette size={16} /></span>
        <div><strong>Chart settings</strong><small>Current browser view</small></div>
        <button
          aria-label="Delete current chart"
          className="csva-delete-chart"
          disabled={!canDelete}
          onClick={onDeleteSpec}
          title={canDelete ? "Delete current chart" : "At least one chart is required"}
          type="button"
        >
          <Trash2 size={15} />
        </button>
        <button aria-label="Reset chart settings" onClick={onResetSpec} title="Reset chart settings" type="button"><RotateCcw size={15} /></button>
      </div>

      <section className="csva-config-section">
        <h3><Database size={14} /> Data</h3>
        <div className="csva-data-facts">
          <span><strong>{activeTable.rows.length.toLocaleString()}</strong> rows</span>
          <span><strong>{activeTable.columns.length}</strong> fields</span>
          <span><strong>{activeTable.kind}</strong> type</span>
        </div>
      </section>

      <section className="csva-config-section">
        <h3><Braces size={14} /> Visual encoding</h3>
        <label>
          <span>Display name</span>
          <input
            maxLength={80}
            onBlur={() => {
              if (!spec.displayName.trim()) onChange({ ...spec, displayName: "Untitled chart" });
            }}
            onChange={(event) => onChange({ ...spec, displayName: event.target.value })}
            value={spec.displayName}
          />
        </label>
        <label>
          <span>Chart type</span>
          <select
            onChange={(event) => onChange({ ...spec, type: event.target.value as ChartType })}
            value={spec.type}
          >
            {Object.entries(CHART_TYPE_LABELS).map(([value, label]) =>
              <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {(["x", "y", "colorBy", "sizeBy", "facetBy", "label"] as const).map((mapping) => {
          if (spec.type === "table" && mapping !== "label") return null;
          if (spec.type === "histogram" && mapping === "y") return null;
          return (
            <label key={mapping}>
              <span>{MAPPING_LABELS[mapping]}{required.has(mapping) ? <i>Required</i> : null}</span>
              <select
                onChange={(event) => updateMapping(mapping, event.target.value)}
                value={spec.mappings[mapping] ?? ""}
              >
                <option value="">None</option>
                {fieldOptions(activeTable.columns, mapping).map((column) =>
                  <option key={column.id} value={column.id}>{column.id} / {column.kind}</option>)}
              </select>
            </label>
          );
        })}
        <details className="csva-tooltip-fields">
          <summary>Hover fields <span>{spec.mappings.tooltip.length}</span></summary>
          <div>
            {activeTable.columns.map((column) => {
              const checked = spec.mappings.tooltip.includes(column.id);
              return <label key={column.id}><input
                checked={checked}
                onChange={() => onChange({
                  ...spec,
                  mappings: {
                    ...spec.mappings,
                    tooltip: checked
                      ? spec.mappings.tooltip.filter((field) => field !== column.id)
                      : [...spec.mappings.tooltip, column.id].slice(-8),
                  },
                })}
                type="checkbox"
              /><span>{column.id}</span></label>;
            })}
          </div>
        </details>
      </section>

      <section className="csva-config-section">
        <h3><Filter size={14} /> Display filters</h3>
        <label>
          <span>Search visible rows</span>
          <input
            onChange={(event) => updateSearch(event.target.value)}
            placeholder="ID, group, gene..."
            type="search"
            value={searchFilter?.kind === "search" ? searchFilter.query : ""}
          />
        </label>
        {categorical.length ? <>
          <label>
            <span>Category field</span>
            <select onChange={(event) => setFilterField(event.target.value)} value={filterField}>
              {categorical.map((column) => <option key={column.id} value={column.id}>{column.id}</option>)}
            </select>
          </label>
          <div className="csva-filter-values">
            {filterValues.map((value) => {
              const checked = selectedValues.some((item) => String(item) === String(value));
              return <label key={String(value)}><input checked={checked} onChange={() => toggleFilterValue(value)} type="checkbox" /><span>{String(value ?? "Missing")}</span></label>;
            })}
          </div>
        </> : <p className="csva-config-empty">No low-cardinality fields are available for filtering.</p>}
      </section>

      <section className="csva-config-section">
        <h3><Palette size={14} /> Appearance</h3>
        <label>
          <span>Title</span>
          <input value={spec.appearance.title} onChange={(event) => onChange({ ...spec, appearance: { ...spec.appearance, title: event.target.value } })} />
        </label>
        <label>
          <span>Point opacity <output>{Math.round(spec.appearance.opacity * 100)}%</output></span>
          <input min="0.15" max="1" step="0.05" type="range" value={spec.appearance.opacity} onChange={(event) => onChange({ ...spec, appearance: { ...spec.appearance, opacity: Number(event.target.value) } })} />
        </label>
        {spec.mappings.facetBy ? <label>
          <span>Facet columns <output>{spec.appearance.facetColumns}</output></span>
          <input min="1" max="4" step="1" type="range" value={spec.appearance.facetColumns} onChange={(event) => onChange({ ...spec, appearance: { ...spec.appearance, facetColumns: Number(event.target.value) } })} />
        </label> : null}
        <label className="csva-toggle-row"><input checked={spec.appearance.showLegend} onChange={(event) => onChange({ ...spec, appearance: { ...spec.appearance, showLegend: event.target.checked } })} type="checkbox" /><span>Show legend</span></label>
        <label className="csva-toggle-row"><input checked={spec.appearance.showGrid} onChange={(event) => onChange({ ...spec, appearance: { ...spec.appearance, showGrid: event.target.checked } })} type="checkbox" /><span>Show grid</span></label>
      </section>
    </aside>
  );
}
