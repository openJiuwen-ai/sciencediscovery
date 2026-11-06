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
  fieldOrder: readonly string[] = [],
  headerNames: Readonly<Record<string, string>> = {},
): DataTable {
  const unnamed = new Set(unnamedFields);
  // JavaScript enumerates integer-like keys in numeric order, so a header whose
  // first column is called `10` would lose the file order in the key union.
  // Importers that know the header pass the order in; the union stays the
  // fallback for callers that only have rows.
  const fields = fieldOrder.length
    ? [...fieldOrder]
    : [...new Set(rows.flatMap((row) => Object.keys(row)).filter((field) => field !== INTERNAL_ROW_ID))];
  const rawColumns = new Map<string, string[]>();
  for (const field of fields) {
    rawColumns.set(field, rows.map((row) => {
      const cell = readCell(row, field);
      return cell === null || cell === undefined ? "" : String(cell);
    }));
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
  const nextSuffixes = new Map<string, number>();
  let duplicateIds = 0;

  const parsedRows: DataRow[] = rows.map((row, index) => {
    const parsed: DataRow = { __rowId: "" };
    for (const field of fields) {
      writeCell(parsed, field, parseValue(readCell(row, field), kinds.get(field) !== "quantitative"));
    }
    const candidate = idField ? String(parsed[idField] ?? "").trim() : "";
    const baseRowId = candidate || `row-${index + 2}`;
    let rowId = baseRowId;
    if (seenIds.has(rowId)) {
      duplicateIds += 1;
      let suffix = Math.max(index + 2, nextSuffixes.get(baseRowId) ?? 0);
      // A generated suffix can itself match an existing source identifier.
      while (seenIds.has(rowId)) {
        rowId = `${baseRowId}#${suffix}`;
        suffix += 1;
      }
      nextSuffixes.set(baseRowId, suffix);
    }
    seenIds.add(rowId);
    parsed.__rowId = rowId;
    return parsed;
  });

  if (duplicateIds) warnings.push(translateActive("csv.importDuplicateIds", { count: duplicateIds }));

  const columns: ColumnProfile[] = fields.map((field) => {
    const values = parsedRows.map((row) => row[field]);
    const present = values.filter((value): value is Exclude<DataValue, null> => value !== null);
    // `renamedHeaders` is a plain object, so `headerNames[field]` would answer
    // with `toString`/`__proto__` and friends from Object.prototype for a header
    // that happens to carry one of those names. Read the mapping the same way the
    // cells are read: own properties only, so a file's `toString` column is named
    // by the file, not by the prototype.
    const header = Object.hasOwn(headerNames, field) ? headerNames[field] : undefined;
    let min: number | undefined;
    let max: number | undefined;
    for (const value of present) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      min = min === undefined ? value : Math.min(min, value);
      max = max === undefined ? value : Math.max(max, value);
    }
    return {
      examples: [...new Set(present.map(String))].slice(0, 3),
      ...(header === undefined ? {} : { header }),
      id: field,
      kind: kinds.get(field) ?? "text",
      label: unnamed.has(field) ? "" : header ?? field.replaceAll("_", " "),
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
 * A header may be named after an inherited member (`toString`, `constructor`,
 * `__proto__`). `field in row` and a bare `row[field]` both see the prototype,
 * so an import must read and write own properties only: otherwise a short
 * record shows `function toString() { [native code] }` for a column the file
 * left empty.
 */
function readCell(row: Record<string, unknown>, field: string): unknown {
  return Object.hasOwn(row, field) ? row[field] : undefined;
}

function writeCell(row: Record<string, unknown>, field: string, value: unknown): void {
  // `row["__proto__"] = value` runs the inherited setter and drops the cell, so
  // `__proto__` is always defined as an own enumerable data property.
  if (field === "__proto__") {
    Object.defineProperty(row, field, { configurable: true, enumerable: true, value, writable: true });
    return;
  }
  row[field] = value;
}

/** The grid keys every row by this field; a file column cannot use the name. */
const INTERNAL_ROW_ID = "__rowId";

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
): { fields: string[]; surplusFields: string[]; surplusCount: number; kept: number } {
  // A header column may itself be called `__parsed_extra`. Papa then pushes its
  // value into the same array it uses for surplus cells, so the first element
  // belongs to that column and only the rest are surplus.
  const reservedColumn = headerFields.includes(PAPA_OVERFLOW_FIELD);
  const surplusCells = (overflow: unknown): unknown[] =>
    Array.isArray(overflow) ? (reservedColumn ? overflow.slice(1) : overflow) : [];

  let surplusCount = 0;
  for (const row of rows) {
    surplusCount = Math.max(surplusCount, surplusCells(readCell(row, PAPA_OVERFLOW_FIELD)).length);
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
    const overflow = readCell(row, PAPA_OVERFLOW_FIELD);
    const extras = surplusCells(overflow);
    if (Array.isArray(overflow)) {
      if (reservedColumn) writeCell(row, PAPA_OVERFLOW_FIELD, overflow[0]);
      else delete row[PAPA_OVERFLOW_FIELD];
    }
    for (const field of headerFields) {
      if (!Object.hasOwn(row, field)) writeCell(row, field, undefined);
    }
    const cells = foldsTail
      ? [...extras.slice(0, kept - 1), extras.slice(kept - 1).join(", ")]
      : extras;
    surplusFields.forEach((field, index) => {
      writeCell(row, field, cells[index]);
    });
  }
  return { fields: [...headerFields, ...surplusFields], kept, surplusCount, surplusFields };
}

export function parseCsvText(content: string, source: DataSourceRecord): DataTable {
  const rows: Array<Record<string, unknown>> = [];
  const errors: Papa.ParseError[] = [];
  let fields: string[] = [];
  // Papa renames a repeated header to a unique id (`a` twice becomes `a` and
  // `a_1`) and reports `a_1 -> a` here; the id keys the row, the original name
  // is what a reader must see.
  let renamedHeaders: Record<string, string> = {};
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
      const meta = result.meta as Papa.ParseMeta & { renamedHeaders?: Record<string, string> | null };
      if (meta.renamedHeaders) renamedHeaders = meta.renamedHeaders;
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
  // `profileRows` writes the row id into `__rowId` itself, so a file column of
  // that name cannot be rendered. Keep it hidden as the key-union fallback does,
  // but report it instead of letting the row id overwrite the value silently.
  const headerFields = fields.filter((field) => field !== INTERNAL_ROW_ID);
  const rectangular = rectangularizeRows(rows, headerFields);
  const warnings = errors.map((error) =>
    translateActive("csv.parseRowError", { message: error.message, row: (error.row ?? 0) + 2 }));
  if (headerFields.length !== fields.length) {
    warnings.push(translateActive("csv.importReservedColumn", { name: INTERNAL_ROW_ID }));
  }
  const renamedCount = Object.keys(renamedHeaders).length;
  if (renamedCount) warnings.push(translateActive("csv.importRenamedColumns", { count: renamedCount }));
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
    inferTableKind(headerFields),
    source,
    warnings,
    rectangular.surplusFields,
    rectangular.fields,
    renamedHeaders,
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
