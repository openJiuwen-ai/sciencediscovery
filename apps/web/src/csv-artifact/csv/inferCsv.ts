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
): DataTable {
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

  if (duplicateIds) warnings.push(`Found ${duplicateIds} duplicate identifiers; source row numbers were appended to disambiguate them.`);

  const columns: ColumnProfile[] = fields.map((field) => {
    const values = parsedRows.map((row) => row[field]);
    const present = values.filter((value): value is Exclude<DataValue, null> => value !== null);
    const numeric = present.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return {
      examples: [...new Set(present.map(String))].slice(0, 3),
      id: field,
      kind: kinds.get(field) ?? "text",
      label: field.replaceAll("_", " "),
      ...(numeric.length ? {
        max: Math.max(...numeric),
        min: Math.min(...numeric),
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

export function parseCsvText(content: string, source: DataSourceRecord): DataTable {
  const result = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.replace(/^\uFEFF/, "").trim(),
  });
  const fields = result.meta.fields ?? [];
  if (!fields.length || !result.data.length) throw new Error("CSV must contain a header and at least one data row");
  return profileRows(
    result.data,
    `artifact:${source.sourceArtifactVersionId}`,
    source.fileName,
    inferTableKind(fields),
    source,
    result.errors.slice(0, 8).map((error) =>
      `Row ${(error.row ?? 0) + 2}: ${error.message}`),
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
