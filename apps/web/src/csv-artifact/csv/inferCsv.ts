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

import { translateActive } from "../../i18n/index.js";
import type {
  ColumnKind,
  ColumnProfile,
  DataRow,
  DataSourceRecord,
  DataTable,
  DataTableKind,
  DataValue,
} from "../types.js";

const IDENTIFIER_NAMES = new Set([
  "barcode",
  "cell",
  "cell_id",
  "gene",
  "gene_id",
  "id",
  "sample_id",
  "term",
]);
const CATEGORICAL_NAMES = new Set([
  "batch",
  "cell_type",
  "cluster",
  "condition",
  "direction",
  "group",
  "sample",
  "significance",
]);
const DATE_NAME_PATTERN = /(?:^|_)(?:date|time|timestamp)(?:$|_)/i;

export const MAX_CSV_DATA_ROWS = 1_000_000;

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll(/[\s.-]+/g, "_");
}

function looksNumeric(value: string): boolean {
  if (!value.trim()) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed);
}

function isMissingText(value: string): boolean {
  return /^(?:n\/a|na|nan|null)$/i.test(value.trim());
}

function parseValue(value: unknown, preserveText: boolean): DataValue {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || isMissingText(text)) return null;
  if (!preserveText && looksNumeric(text)) return Number(text);
  if (/^(?:true|false)$/i.test(text)) return text.toLocaleLowerCase() === "true";
  return text;
}

function inferKind(
  field: string,
  values: string[],
  uniqueCount: number,
  rowCount: number,
): ColumnKind {
  const normalized = normalizeName(field);
  if (IDENTIFIER_NAMES.has(normalized)) return "identifier";
  const nonEmpty = values.filter((value) => value.trim() && !isMissingText(value));
  if (!nonEmpty.length) return "text";
  const numericShare = nonEmpty.filter(looksNumeric).length / nonEmpty.length;
  if (numericShare >= 0.95) {
    if (CATEGORICAL_NAMES.has(normalized) && uniqueCount <= 64) return "categorical";
    return "quantitative";
  }
  if (DATE_NAME_PATTERN.test(normalized)) {
    const dateShare = nonEmpty.filter((value) => Number.isFinite(Date.parse(value))).length / nonEmpty.length;
    if (dateShare >= 0.9) return "date";
  }
  const categoryLimit = Math.min(64, Math.max(12, Math.ceil(rowCount * 0.12)));
  if (CATEGORICAL_NAMES.has(normalized) || uniqueCount <= categoryLimit) return "categorical";
  if (uniqueCount === rowCount && rowCount > 1) return "identifier";
  return "text";
}

export function profileRows(
  rows: Array<Record<string, unknown>>,
  tableId: string,
  label: string,
  kind: DataTableKind,
  source: DataSourceRecord,
  warnings: string[] = [],
  unnamedFields: readonly string[] = [],
): DataTable {
  const unnamed = new Set(unnamedFields);
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)).filter((field) => field !== "__rowId"))];
  const rawColumns = new Map<string, string[]>();
  for (const field of fields) {
    rawColumns.set(field, rows.map((row) => row[field] === null || row[field] === undefined ? "" : String(row[field])));
  }

  const kinds = new Map<string, ColumnKind>();
  for (const field of fields) {
    const values = rawColumns.get(field) ?? [];
    const uniqueCount = new Set(values.filter((value) => value.trim() && !isMissingText(value))).size;
    kinds.set(field, inferKind(field, values, uniqueCount, rows.length));
  }

  const idField = fields.find((field) => IDENTIFIER_NAMES.has(normalizeName(field)))
    ?? fields.find((field) => kinds.get(field) === "identifier");
  const seenIds = new Set<string>();
  let duplicateIds = 0;

  const parsedRows: DataRow[] = rows.map((row, index) => {
    const parsed: DataRow = { __rowId: "" };
    for (const field of fields) {
      parsed[field] = parseValue(row[field], kinds.get(field) !== "quantitative");
    }
    const candidate = idField ? String(parsed[idField] ?? "").trim() : "";
    let rowId = candidate || `row-${index + 2}`;
    if (seenIds.has(rowId)) {
      duplicateIds += 1;
      rowId = `${rowId}#${index + 2}`;
    }
    seenIds.add(rowId);
    parsed.__rowId = rowId;
    return parsed;
  });

  if (duplicateIds) warnings.push(translateActive("csv.importDuplicateIds", { count: duplicateIds }));

  const columns: ColumnProfile[] = fields.map((field) => {
    const values = parsedRows.map((row) => row[field]);
    const present = values.filter((value): value is Exclude<DataValue, null> => value !== null);
    let min: number | undefined;
    let max: number | undefined;
    for (const value of present) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      min = min === undefined ? value : Math.min(min, value);
      max = max === undefined ? value : Math.max(max, value);
    }
    return {
      examples: [...new Set(present.map(String))].slice(0, 3),
      id: field,
      kind: kinds.get(field) ?? "text",
      label: unnamed.has(field) ? "" : field.replaceAll("_", " "),
      ...(min !== undefined && max !== undefined ? {
        max,
        min,
      } : {}),
      missingCount: values.length - present.length,
      uniqueCount: new Set(present.map(String)).size,
    };
  });

  return {
    columns,
    id: tableId,
    kind,
    label,
    rows: parsedRows,
    source,
    warnings,
  };
}

function inferTableKind(fields: string[]): DataTableKind {
  const normalized = new Set(fields.map(normalizeName));
  const hasEffect = [...normalized].some((field) =>
    /^(?:log2_?(?:fc|fold_change)|fold_change|effect(?:_size)?)$/.test(field));
  const hasSignificance = [...normalized].some((field) =>
    /^(?:p(?:_?value)?|adjusted_p_value|padj|q(?:_?value)?|neg_log10_.+)$/.test(field));
  if (hasEffect && hasSignificance) {
    return "differential";
  }
  if (normalized.has("term") && [...normalized].some((field) => field.includes("gene_ratio") || field.includes("enrichment"))) {
    return "enrichment";
  }
  const hasExpressionSummary = [...normalized].some((field) =>
    /^(?:mean|average|avg)_?(?:expression|expr)$/.test(field));
  const hasFeature = normalized.has("gene") || normalized.has("feature");
  const hasGroup = ["cell_type", "cluster", "group"].some((field) => normalized.has(field));
  if (hasFeature && hasGroup && hasExpressionSummary) {
    return "matrix";
  }
  if ([...normalized].some((field) => field.startsWith("umap_") || field.startsWith("tsne_"))
    && [...normalized].some((field) => ["cell_id", "barcode", "cell"].includes(field))) {
    return "cells";
  }
  return "generic";
}

const PAPA_OVERFLOW_FIELD = "__parsed_extra";

/**
 * Surplus columns are capped at the header width, floored at 2 and ceilinged at
 * 16. A table therefore materializes at most `2 x header width` cells per row
 * (`3 x` for a one-column header), so one wide record cannot multiply the cost
 * of every other row. Header columns are never part of the cap: a legitimate
 * 200-column header still yields 200 columns.
 */
const SURPLUS_COLUMN_FLOOR = 2;
const SURPLUS_COLUMN_CEILING = 16;

function surplusColumnLimit(headerWidth: number): number {
  return Math.min(SURPLUS_COLUMN_CEILING, Math.max(SURPLUS_COLUMN_FLOOR, headerWidth));
}

/**
 * Papa reports cells past the header under its own `__parsed_extra` key and
 * leaves a short record without its trailing header keys. Neither shape may
 * define a column, so every record is rebuilt to the table width: the header
 * fields in file order, then one `__extra_N` field per surplus cell. Extra
 * fields are unnamed (empty label) and a missing cell stays undefined, which
 * profiles as null, so the table is rectangular without dropping a value.
 *
 * Past `surplusColumnLimit` surplus cells the trailing cells are folded into
 * the last surplus column as one comma-joined value, and the caller warns.
 */
function rectangularizeRows(
  rows: Array<Record<string, unknown>>,
  headerFields: string[],
): { surplusFields: string[]; surplusCount: number; kept: number } {
  // A header column may itself be called `__parsed_extra`. Papa then pushes its
  // value into the same array it uses for surplus cells, so the first element
  // belongs to that column and only the rest are surplus.
  const reservedColumn = headerFields.includes(PAPA_OVERFLOW_FIELD);
  const surplusCells = (overflow: unknown): unknown[] =>
    Array.isArray(overflow) ? (reservedColumn ? overflow.slice(1) : overflow) : [];

  let surplusCount = 0;
  for (const row of rows) {
    surplusCount = Math.max(surplusCount, surplusCells(row[PAPA_OVERFLOW_FIELD]).length);
  }
  const kept = Math.min(surplusCount, surplusColumnLimit(headerFields.length));

  const taken = new Set(headerFields);
  const surplusFields: string[] = [];
  while (surplusFields.length < kept) {
    let field = `__extra_${surplusFields.length + 1}`;
    while (taken.has(field)) field = `${field}_`;
    taken.add(field);
    surplusFields.push(field);
  }
  const foldsTail = surplusCount > kept;

  for (const row of rows) {
    const overflow = row[PAPA_OVERFLOW_FIELD];
    const extras = surplusCells(overflow);
    if (Array.isArray(overflow)) {
      if (reservedColumn) row[PAPA_OVERFLOW_FIELD] = overflow[0];
      else delete row[PAPA_OVERFLOW_FIELD];
    }
    for (const field of headerFields) {
      if (!(field in row)) row[field] = undefined;
    }
    const cells = foldsTail
      ? [...extras.slice(0, kept - 1), extras.slice(kept - 1).join(", ")]
      : extras;
    surplusFields.forEach((field, index) => {
      row[field] = cells[index];
    });
  }
  return { kept, surplusCount, surplusFields };
}

export function parseCsvText(content: string, source: DataSourceRecord): DataTable {
  const rows: Array<Record<string, unknown>> = [];
  const errors: Papa.ParseError[] = [];
  let fields: string[] = [];
  let tooManyRows = false;
  Papa.parse<Record<string, unknown>>(content, {
    chunkSize: 256 * 1024,
    header: true,
    skipEmptyLines: "greedy",
    step: (result, parser) => {
      // Step callbacks exclude the header and skipped blank records, and keep
      // quoted newlines inside their record. Do not silently truncate a file.
      if (rows.length === MAX_CSV_DATA_ROWS) {
        tooManyRows = true;
        parser.abort();
        return;
      }
      fields = result.meta.fields ?? [];
      rows.push(result.data);
      for (const error of result.errors) {
        if (errors.length < 8) errors.push(error);
      }
    },
    transformHeader: (header) => header.replace(/^\uFEFF/, "").trim(),
  });
  if (tooManyRows) {
    throw new Error(translateActive("csv.tooManyRows", { count: MAX_CSV_DATA_ROWS.toLocaleString("en-US") }));
  }
  if (!fields.length || !rows.length) throw new Error(translateActive("csv.parseHeaderRequired"));
  const rectangular = rectangularizeRows(rows, fields);
  const warnings = errors.map((error) =>
    translateActive("csv.parseRowError", { message: error.message, row: (error.row ?? 0) + 2 }));
  if (rectangular.surplusCount > rectangular.kept) {
    warnings.push(translateActive("csv.importSurplusColumns", {
      count: rectangular.surplusCount.toLocaleString("en-US"),
      kept: rectangular.kept,
    }));
  }
  return profileRows(
    rows,
    `artifact:${source.sourceArtifactVersionId}`,
    source.fileName,
    inferTableKind(fields),
    source,
    warnings,
    rectangular.surplusFields,
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
