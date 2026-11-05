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

import Papa from "papaparse";

import type { ColumnProfile, DataRow, DataValue, FilterSpec } from "../types.js";

function sameValue(left: DataValue, right: DataValue): boolean {
  if (left === null || right === null) return left === right;
  return String(left) === String(right);
}

export function filterRows(rows: DataRow[], filters: FilterSpec[]): DataRow[] {
  return rows.filter((row) => filters.every((filter) => {
    if (filter.kind === "include") {
      return filter.values.some((value) => sameValue(row[filter.field] ?? null, value));
    }
    if (filter.kind === "range") {
      const value = row[filter.field];
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      return (filter.min === undefined || value >= filter.min)
        && (filter.max === undefined || value <= filter.max);
    }
    const needle = filter.query.trim().toLocaleLowerCase();
    if (!needle) return true;
    if (filter.field) return String(row[filter.field] ?? "").toLocaleLowerCase().includes(needle);
    return Object.entries(row).some(([field, value]) =>
      field !== "__rowId" && String(value ?? "").toLocaleLowerCase().includes(needle));
  }));
}

export function uniqueValues(rows: DataRow[], field?: string): DataValue[] {
  if (!field) return [];
  const seen = new Map<string, DataValue>();
  for (const row of rows) {
    const value = row[field] ?? null;
    const key = `${typeof value}:${String(value)}`;
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()].sort((left, right) =>
    String(left ?? "Missing").localeCompare(String(right ?? "Missing"), undefined, { numeric: true }));
}

function safeSpreadsheetValue(value: DataValue): DataValue {
  if (typeof value !== "string") return value;
  return /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

/**
 * Header text for a column: a real column shows the header the file wrote (its
 * field id unless Papa had to make a duplicate unique), while an unnamed column
 * (a CSV cell with no header) shows an empty header instead of an internal key.
 * `label` is "" only for those unnamed columns; every real label is its header
 * with underscores spaced, so this stays an equality check, not `||`.
 */
export function columnHeaderName(column: ColumnProfile): string {
  return column.label === "" ? "" : column.header ?? column.id;
}

/**
 * Export CSV with the same header text the grid shows: a real column keeps its
 * field id, an unnamed column exports an empty header while its values stay in
 * place. Papa's object-record form keys columns by name, so two unnamed columns
 * would collide; build the header row and the body positionally instead. Header
 * names reach Papa as data values, so they get the same formula neutralization
 * as the cells.
 */
export function tableToCsv(rows: readonly DataRow[], columns: readonly ColumnProfile[]): string {
  const header = Papa.unparse([columns.map((column) => safeSpreadsheetValue(columnHeaderName(column)))]);
  if (!rows.length) return header;
  const body = Papa.unparse(rows.map((row) =>
    columns.map((column) => safeSpreadsheetValue(row[column.id] ?? null))));
  return `${header}\r\n${body}`;
}

export function downloadText(content: string, fileName: string, mediaType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
