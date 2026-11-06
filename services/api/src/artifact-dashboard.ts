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

// Read-only dashboard aggregation and per-version preview routing for
// scientific artifacts. This module is the contract surface
// between the SessionStore/CAS layer and the right-hand workbench panel.
//
// It deliberately touches no schema mutation: payload types live here and
// the frontend matches them. Once 0.1.0 fields stabilise they may be hoisted
// into the schema package as a follow-up.

import type {
  Project,
  ScientificArtifact,
  ScientificArtifactKind,
  ScientificArtifactVersion,
  Session,
} from "@sciencediscovery/schema";

import { randomUUID } from "node:crypto";

import type { ProvenanceRecorder } from "@sciencediscovery/provenance";
import type { SessionStore } from "./store.js";

/** Marker error codes the API catches and maps to specific HTTP statuses. */
export class ArtifactDashboardError extends Error {
  readonly code: "ARTIFACT_NOT_FOUND" | "ARTIFACT_CONTENT_UNAVAILABLE";
  constructor(code: "ARTIFACT_NOT_FOUND" | "ARTIFACT_CONTENT_UNAVAILABLE", message: string) {
    super(message);
    this.code = code;
  }
}

// -- Dashboard aggregation ----------------------------------------------------

export interface ArtifactDashboardContext {
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionTitle: string;
  /**
   * 0.1.0 placeholder — Project/Session do not yet carry label fields. This is
   * always `[]`; once project and Session labels are implemented, the server
   * can fill the array without a schema break for callers.
   */
  labels: string[];
}

export interface ArtifactDashboardEntry {
  artifact: ScientificArtifact;
  kind: ScientificArtifactKind;
  versions: ScientificArtifactVersion[];
  latestVersionId: string | undefined;
  hasParents: boolean;
}

export interface ArtifactDashboard {
  context: ArtifactDashboardContext;
  artifacts: ArtifactDashboardEntry[];
}

export async function buildArtifactDashboard(
  store: SessionStore,
  sessionId: string,
  project: Project | undefined,
  session: Session,
): Promise<ArtifactDashboard> {
  const artifacts = store.listArtifacts(sessionId);
  const entries: ArtifactDashboardEntry[] = artifacts.map((artifact) => {
    const versions = store.listArtifactVersions(sessionId, artifact.id);
    const latestVersionId = versions.at(-1)?.id;
    const hasParents = versions.some((version) => version.inputArtifactVersionIds.length > 0);
    return { artifact, kind: artifact.kind, versions, latestVersionId, hasParents };
  });
  return {
    context: {
      projectId: project?.id ?? session.projectId,
      projectName: project?.name ?? "",
      sessionId,
      sessionTitle: session.title,
      labels: [],
    },
    artifacts: entries,
  };
}

// -- Per-version preview ------------------------------------------------------

export type NotebookCellType = "code" | "markdown" | "raw";

export interface NotebookCell {
  cell_type: NotebookCellType;
  source: string;
  execution_count?: number | null;
}

/** A JSON document rendered as text, with the char budget already applied. */
export interface ArtifactJsonSource {
  source: string;
  totalChars: number;
  truncated: boolean;
}

export type ArtifactPreviewPayload =
  | {
      version: ScientificArtifactVersion;
      kind: "figure";
      mode: "figure-url";
      contentUrl: string;
      size: number;
      truncated: false;
      note?: string;
    }
  | {
      version: ScientificArtifactVersion;
      kind: "markdown";
      mode: "markdown-source";
      source: string;
      totalChars: number;
      truncated: boolean;
    }
  | {
      /** `"json"` when a JSON document turned out to be a record array. */
      version: ScientificArtifactVersion;
      kind: "dataset" | "json";
      mode: "dataset-table";
      mediaSubtype: "csv" | "tsv" | "json";
      columns: string[];
      rows: string[][];
      totalRows: number;
      truncated: boolean;
      /**
       * How many cells of the returned rows were left out of the preview
       * because the grid's width is capped (see MAX_PREVIEW_COLUMNS). Zero for
       * a table that came back whole; the count is a user-visible loss, so the
       * viewer can say it instead of showing a silently shorter row.
       */
      clippedCells: number;
      /**
       * The file's own column count (its header) and the count the preview
       * shows. They differ when the header is wider than MAX_PREVIEW_COLUMNS; a
       * data line wider than the header widens the grid but is not a column, so
       * its lost cells are reported through clippedCells instead.
       */
      clippedColumns: { total: number; shown: number };
      /**
       * Human-readable sentences for everything the preview left out: a clipped
       * column set, clipped row cells, both, or nothing. Empty when the preview
       * is whole, so a consumer can show them verbatim.
       */
      warnings: string[];
      /**
       * The re-indented source document, carried only for JSON-backed tables so
       * the viewer can offer a raw-JSON view of the same version. Absent for
       * csv/tsv, which have no JSON form to switch to.
       */
      rawJson?: ArtifactJsonSource;
    }
  | {
      /**
       * A JSON document that does not map to a table: `source` is the
       * re-indented document, or the raw text when it does not parse
       * (`parsed: false`).
       */
      version: ScientificArtifactVersion;
      kind: "json";
      mode: "json-source";
      source: string;
      totalChars: number;
      truncated: boolean;
      parsed: boolean;
    }
  | {
      version: ScientificArtifactVersion;
      kind: "structure";
      mode: "structure-source";
      source: string;
      atomCount: number;
      totalChars: number;
      truncated: boolean;
    }
  | {
      version: ScientificArtifactVersion;
      kind: "report";
      mode: "report-iframe";
      contentUrl: string;
      size: number;
      truncated: boolean;
      note?: string;
    }
  | {
      version: ScientificArtifactVersion;
      kind: "html";
      mode: "html-iframe";
      contentUrl: string;
      size: number;
      truncated: boolean;
      note?: string;
    }
  | {
      version: ScientificArtifactVersion;
      kind: "notebook";
      mode: "notebook-cells";
      cells: NotebookCell[];
      totalCells: number;
      truncated: boolean;
      editable: false;
    }
  | {
      version: ScientificArtifactVersion;
      kind: "latex";
      mode: "latex-source";
      source: string;
      totalChars: number;
      truncated: boolean;
    }
  | {
      version: ScientificArtifactVersion;
      kind: ScientificArtifactKind;
      mode: "binary-fallback";
      contentUrl: string;
      size: number;
      note?: string;
    };

const DEFAULT_MAX_ROWS = 100;
const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_MAX_CELLS = 200;
/**
 * The widest table a preview renders. 1001 is the widest legitimate header the
 * preview contract covers (the regression test previews a 1001-column table
 * whole), so a wider line is an outlier, not a table: a 400 KB file holding one
 * 200k-field line used to ask for 100 x 200001 cells and a 60.8 MB response.
 * 1001 columns also keeps the payload bound near the existing text budget: with
 * MAX_PREVIEW_ROWS it caps a table at 100 x 1001 = 100,100 cells, the same
 * order as DEFAULT_MAX_CHARS (one cell is a few bytes of JSON).
 */
const MAX_PREVIEW_COLUMNS = 1_001;
/**
 * The most rows one table preview returns. `maxRows` may lower it and never
 * raise it, so a client query parameter cannot lift the payload bound; the
 * widest and tallest preview is MAX_PREVIEW_ROWS x MAX_PREVIEW_COLUMNS.
 */
const MAX_PREVIEW_ROWS = DEFAULT_MAX_ROWS;
const FIGURE_TRUNCATION_BYTES = 5 * 1024 * 1024;
const IFRAME_TRUNCATION_BYTES = 2 * 1024 * 1024;

const DATASET_TEXT_SUFFIXES = [".csv", ".tsv", ".json"] as const;
type DatasetTextSubtype = (typeof DATASET_TEXT_SUFFIXES)[number];

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function contentUrlFor(sessionId: string, version: ScientificArtifactVersion): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(version.id)}/content`;
}

async function readCasText(recorder: ProvenanceRecorder, hash: string): Promise<string> {
  try {
    return (await recorder.cas.read(hash)).toString("utf8");
  } catch (error) {
    throw new ArtifactDashboardError(
      "ARTIFACT_CONTENT_UNAVAILABLE",
      error instanceof Error ? error.message : "Artifact content unavailable",
    );
  }
}

/**
 * Split delimited text into records the way a spreadsheet writes them (RFC 4180):
 * a delimiter or newline inside a quoted field is data, and a doubled quote
 * inside a quoted field is one quote. A quote only opens a field at its start,
 * so an apostrophe mid-cell is left alone. Blank lines stay out, as before.
 *
 * A field is kept as spans of the source and only joined when the field ends,
 * so an ordinary run costs one `slice` instead of one concatenation per
 * character. A file whose only cell opens a quote and never closes it is one
 * field over the whole file: built character by character that is quadratic
 * string garbage on a preview request, and it stays linear here.
 */
function splitDelimited(rawSource: string, delimiter: string): string[][] {
  // Excel writes "CSV UTF-8" and "TSV UTF-8" with a leading byte-order mark. It
  // is an encoding marker, not part of the first header cell, so a client that
  // matches columns by name must never see it. Strip exactly one U+FEFF, and
  // only at the start of the file: a U+FEFF anywhere else is ordinary data.
  const source = rawSource.startsWith("\uFEFF") ? rawSource.slice(1) : rawSource;
  const records: string[][] = [];
  let record: string[] = [];
  // Completed spans of the field being read; `spanStart` opens the one still
  // pending. Only an escaped quote (`""`) closes a span before the field ends.
  let parts: string[] = [];
  let spanStart = 0;
  let quoted = false;
  let touched = false;

  const pushSpan = (end: number) => {
    if (end > spanStart) parts.push(source.slice(spanStart, end));
  };
  const endField = (end: number) => {
    pushSpan(end);
    record.push(parts.length === 1 ? parts[0] ?? "" : parts.join(""));
    parts = [];
  };
  const endRecord = (end: number) => {
    if (touched) {
      endField(end);
      records.push(record);
    }
    record = [];
    parts = [];
    touched = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (quoted) {
      if (char === '"' && source.charAt(index + 1) === '"') {
        pushSpan(index);
        parts.push('"');
        index += 1;
        spanStart = index + 1;
      } else if (char === '"') {
        pushSpan(index);
        quoted = false;
        spanStart = index + 1;
      }
      touched = true;
      continue;
    }
    if (char === '"' && parts.length === 0 && spanStart === index) {
      quoted = true;
      touched = true;
      spanStart = index + 1;
      continue;
    }
    if (char === delimiter) {
      endField(index);
      spanStart = index + 1;
      touched = true;
      continue;
    }
    if (char === "\n" || char === "\r") {
      const terminator = index;
      if (char === "\r" && source.charAt(index + 1) === "\n") index += 1;
      endRecord(terminator);
      spanStart = index + 1;
      continue;
    }
    touched = true;
  }
  if (touched || record.length > 0) {
    endField(source.length);
    records.push(record);
  }
  return records;
}

function datasetSubtypeFor(name: string): DatasetTextSubtype | undefined {
  const lower = name.toLocaleLowerCase();
  return DATASET_TEXT_SUFFIXES.find((suffix) => lower.endsWith(suffix));
}

function parseDelimitedTable(source: string, subtype: ".csv" | ".tsv", maxRows: number): {
  columns: string[];
  rows: string[][];
  totalRows: number;
  clippedCells: number;
  clippedColumns: { total: number; shown: number };
  warnings: string[];
} {
  const delimiter = subtype === ".csv" ? "," : "\t";
  const lines = splitDelimited(source, delimiter);
  if (!lines.length) {
    return { columns: [], clippedCells: 0, clippedColumns: { shown: 0, total: 0 }, rows: [], totalRows: 0, warnings: [] };
  }
  const header = lines[0] ?? [];
  const totalRows = Math.max(0, lines.length - 1);
  // The width is the widest line of the whole file, capped by a constant, and
  // never a function of how many rows the caller asked for: maxRows is a client
  // query parameter, and the same file must show the same columns at maxRows=1
  // and maxRows=1000. A wide line past the window therefore still sets the width
  // and the returned rows are padded to it, because the renderer prints one <th>
  // per column and one <td> per cell.
  const widest = lines.reduce((widestLine, line) => Math.max(widestLine, line.length), 0);
  // The file's own column count is a property of its header, never of a data
  // line: one 5,000-field row is a wide row, not a 5,000-column schema, and
  // announcing it as one tells the reader something false about the file.
  const totalColumns = header.length;
  // A wider line may contribute a few unnamed surplus columns, so a ragged table
  // does not lose cells it really has — but only up to the cap the CSV importer
  // uses, min(16, max(2, header)): one outlier line cannot turn a two-column file
  // into a 1,001-column grid. The header's own columns are never capped by this,
  // and MAX_PREVIEW_COLUMNS stays the absolute limit on the payload.
  const surplusLimit = Math.min(16, Math.max(2, header.length));
  const surplusShown = Math.min(Math.max(0, widest - totalColumns), surplusLimit);
  const width = Math.min(totalColumns + surplusShown, MAX_PREVIEW_COLUMNS);
  // The row count is bounded by its own constant, so the payload stays inside
  // MAX_PREVIEW_ROWS x MAX_PREVIEW_COLUMNS cells. `maxRows` only lowers it.
  const rows = lines.slice(1, Math.min(maxRows, MAX_PREVIEW_ROWS) + 1);
  // The width can come from a line this call does not return. The column set must
  // not depend on how many rows a caller asks for, so the width stays file-wide;
  // but then the grid is padded with unnamed columns, and blank cells, for a row
  // the reader never sees. That padding used to be invisible — `clippedCells: 0`
  // and an empty `warnings` — so it is counted and named here instead.
  const widestShown = rows.reduce((widestRow, row) => Math.max(widestRow, row.length), totalColumns);
  const shownSurplus = Math.min(Math.max(0, widestShown - totalColumns), surplusLimit);
  // The padding has to be counted from the grid that was actually built, not
  // from `totalColumns + surplusShown`: `width` is capped by MAX_PREVIEW_COLUMNS,
  // so at a wide header the cap can swallow the surplus, and the sentence must
  // never claim unnamed columns the grid does not hold.
  const renderedSurplus = Math.max(0, width - totalColumns);
  const paddingOnlyColumns = Math.max(0, renderedSurplus - shownSurplus);
  const paddingOnlyCells = paddingOnlyColumns * rows.length;
  // Columns past the width leave the preview: the header keeps its first names
  // and the payload says how many columns the file had, so a cut table is never
  // mistaken for a narrow one. A data line wider than the header widens the grid
  // without changing the column count; its lost cells are reported as cells.
  // `shown` counts named columns, so it never exceeds the header; unnamed
  // surplus columns are padding, not part of the file's schema.
  const clippedColumns = { shown: Math.min(totalColumns, width), total: totalColumns };
  let clippedCells = 0;
  const paddedRows = rows.map((row) => {
    if (row.length === width) return row;
    if (row.length > width) {
      clippedCells += row.length - width;
      return row.slice(0, width);
    }
    return [...row, ...Array.from({ length: width - row.length }, () => "")];
  });
  const warnings: string[] = [];
  if (clippedColumns.total > clippedColumns.shown) {
    warnings.push(`The file has ${clippedColumns.total} columns; the preview shows the first ${clippedColumns.shown}.`);
  }
  if (clippedCells > 0) {
    warnings.push(`${clippedCells} cells past the preview width are not shown.`);
  }
  if (paddingOnlyColumns > 0) {
    const columnWord = paddingOnlyColumns === 1 ? "column" : "columns";
    const cellWord = paddingOnlyCells === 1 ? "cell" : "cells";
    const rowWord = rows.length === 1 ? "row" : "rows";
    warnings.push(
      `The preview pads ${paddingOnlyColumns} unnamed ${columnWord} (${paddingOnlyCells} blank ${cellWord}) `
      + `because the file has a wider line past the first ${rows.length} ${rowWord}, which is not shown.`,
    );
  }
  return {
    clippedCells,
    clippedColumns,
    columns: header.length >= width
      ? header.slice(0, width)
      : [...header, ...Array.from({ length: width - header.length }, () => "")],
    rows: paddedRows,
    totalRows,
    warnings,
  };
}

/**
 * The only JSON shape the table preview can render honestly: a non-empty array
 * whose every element is a plain object, i.e. a record array. Anything else —
 * a top-level object, an array of scalars, a mixed array — has no row/column
 * mapping and must be shown as JSON text instead of an empty grid.
 */
function jsonRecordArray(parsed: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const records = parsed.filter(
    (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
  if (records.length !== parsed.length) return undefined;
  // Keys are the row/column mapping: an array of empty objects would become a table with no
  // columns, so it must fall through to the JSON view like any other unmappable shape.
  return records.some((record) => Object.keys(record).length > 0) ? records : undefined;
}

function recordArrayTable(records: Record<string, unknown>[], maxRows: number): {
  columns: string[];
  rows: string[][];
  totalRows: number;
  clippedCells: number;
  clippedColumns: { total: number; shown: number };
  warnings: string[];
} {
  const columns = records.reduce<string[]>((acc, record) => {
    for (const key of Object.keys(record)) {
      if (!acc.includes(key)) acc.push(key);
    }
    return acc;
  }, []);
  const rows = records.slice(0, maxRows).map<string[]>((record) => columns.map((column) => {
    const value = record[column];
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }));
  return {
    clippedCells: 0,
    clippedColumns: { shown: columns.length, total: columns.length },
    columns,
    rows,
    totalRows: records.length,
    warnings: [],
  };
}

/**
 * JSON.parse rounds every integer beyond 2^53 to the nearest double, so a
 * document that stores a 64-bit identifier would preview with different digits
 * than it holds. Keep the stored literal: a linear scan rewrites exactly those
 * integer tokens to placeholders before parsing, and the renderers put the
 * digits back. Strings are copied verbatim, so a row that merely looks like a
 * big number is left alone.
 *
 * Each placeholder is minted for one document: a random uuid makes it
 * unforgeable by text a user wrote, a counter keeps the placeholders inside one
 * document distinct, and the surrounding U+0001/U+0002 controls cannot appear
 * in a JSON string without an escape. The closing control also keeps one
 * placeholder from being a prefix of another once the counter reaches 10.
 */
export function createBigIntegerMarker(): string {
  return `\u0001sd-bigint-${randomUUID()}:`;
}

function protectBigIntegers(source: string): { text: string; placeholders: Map<string, string> } {
  const marker = createBigIntegerMarker();
  const placeholders = new Map<string, string>();
  let text = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (source[index - 1] === '"') break;
      }
      text += source.slice(start, index);
      continue;
    }
    // Outside a string a digit or a leading minus can only open a number token.
    const number = char === "-" || (char >= "0" && char <= "9")
      ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))
      : null;
    if (!number) {
      text += char;
      index += 1;
      continue;
    }
    const literal = number[0];
    const integer = !/[.eE]/.test(literal);
    if (integer && !Number.isSafeInteger(Number(literal))) {
      const token = `${marker}${placeholders.size}\u0002`;
      placeholders.set(token, literal);
      // JSON.stringify adds the quotes and escapes the U+0001 prefix: an
      // unescaped control character is not a valid JSON string.
      text += JSON.stringify(token);
    } else {
      text += literal;
    }
    index += literal.length;
  }
  return { text, placeholders };
}

/**
 * Write the stored digits back over the placeholders a render path produced.
 *
 * A placeholder reaches the renderers in two shapes: `JSON.stringify` quotes it
 * and escapes its U+0001 prefix (the raw JSON and source views), while the
 * table renderer carries the bare string (String(value)). The quoted shape goes
 * first so the digits become a JSON number again rather than a string holding
 * the same digits. Only a placeholder this document minted is restored, and its
 * exact text is known from the map, so user text is never rewritten.
 */
function restoreBigIntegers(text: string, placeholders: Map<string, string>): string {
  if (placeholders.size === 0) return text;
  let restored = text;
  for (const [placeholder, literal] of placeholders) {
    restored = restored.split(JSON.stringify(placeholder)).join(literal);
    restored = restored.split(placeholder).join(literal);
  }
  return restored;
}

/**
 * Apply the char budget to one text form of a JSON document.
 *
 * The budget is counted in UTF-16 code units (that is what `totalChars` reports),
 * but the cut itself must not land inside a surrogate pair: a preview ending on an
 * unpaired high surrogate is invalid UTF-16 and renders as a replacement glyph in
 * every consumer that does not patch it. A character that would straddle the cut
 * is dropped whole, so the result is never longer than the budget.
 */
function truncateAtCodePoint(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const last = text.charCodeAt(maxChars - 1);
  const next = text.charCodeAt(maxChars);
  const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return text.slice(0, splitsPair ? maxChars - 1 : maxChars);
}

function jsonSourceOf(text: string, maxChars: number): ArtifactJsonSource {
  const truncated = text.length > maxChars;
  return { source: truncated ? truncateAtCodePoint(text, maxChars) : text, totalChars: text.length, truncated };
}

/**
 * Route one JSON document: record arrays keep the dataset table, everything
 * else (objects, scalar arrays, unparseable text) becomes readable JSON/plain
 * text so the preview never reduces to `0 rows`.
 *
 * A table payload also carries `rawJson`, re-indented from the stored document
 * rather than rebuilt from the flattened rows, so the viewer can switch to the
 * complete original JSON without a second request.
 */
function buildJsonPreview(
  version: ScientificArtifactVersion,
  kind: "dataset" | "json",
  source: string,
  maxRows: number,
  maxChars: number,
): ArtifactPreviewPayload {
  // The delimited path treats a leading U+FEFF as an encoding marker rather than
  // as the first character of its first cell (splitDelimited), and a JSON file
  // written by a Windows tool carries the same marker. Apply that same rule here
  // before parsing: exactly one U+FEFF, and only at the start, or a valid
  // document is reported as unparseable text.
  const document = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const protectedJson = protectBigIntegers(document);
  let parsed: unknown;
  let valid = true;
  try {
    parsed = JSON.parse(protectedJson.text) as unknown;
  } catch {
    valid = false;
  }
  if (valid) {
    const records = jsonRecordArray(parsed);
    if (records) {
      const table = recordArrayTable(records, maxRows);
      return {
        version,
        kind,
        mode: "dataset-table",
        mediaSubtype: "json",
        ...table,
        rows: table.rows.map((row) => row.map((cell) => (
          restoreBigIntegers(cell, protectedJson.placeholders)
        ))),
        truncated: table.totalRows > maxRows,
        rawJson: jsonSourceOf(
          restoreBigIntegers(JSON.stringify(parsed, null, 2), protectedJson.placeholders),
          maxChars,
        ),
      };
    }
  }
  return {
    version,
    kind: "json",
    mode: "json-source",
    ...jsonSourceOf(
      valid ? restoreBigIntegers(JSON.stringify(parsed, null, 2), protectedJson.placeholders) : source,
      maxChars,
    ),
    parsed: valid,
  };
}

function countStructureAtoms(source: string): number {
  if (source.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(source) as { atoms?: unknown };
      return Array.isArray(parsed.atoms) ? parsed.atoms.length : 0;
    } catch {
      return 0;
    }
  }
  let count = 0;
  for (const line of source.split(/\r?\n/)) {
    const record = line.slice(0, 6).trim();
    if (record === "ATOM" || record === "HETATM") count++;
  }
  return count;
}

function parseNotebook(source: string, maxCells: number): { cells: NotebookCell[]; totalCells: number; truncated: boolean } {
  let parsed: { cells?: unknown };
  try {
    parsed = JSON.parse(source) as { cells?: unknown };
  } catch {
    return { cells: [], totalCells: 0, truncated: false };
  }
  const rawCells = Array.isArray(parsed.cells) ? parsed.cells : [];
  const totalCells = rawCells.length;
  // Unsupported cells must not consume the preview budget, so map and filter first.
  const supported = rawCells.map<NotebookCell | undefined>((cell) => {
    if (!cell || typeof cell !== "object") return undefined;
    const entry = cell as { cell_type?: unknown; source?: unknown; execution_count?: unknown };
    const cellType = entry.cell_type;
    if (cellType !== "code" && cellType !== "markdown" && cellType !== "raw") return undefined;
    const rawSource = entry.source;
    const text = Array.isArray(rawSource)
      ? rawSource.map((part) => (typeof part === "string" ? part : "")).join("")
      : typeof rawSource === "string"
        ? rawSource
        : "";
    const executionCount = typeof entry.execution_count === "number" || entry.execution_count === null
      ? entry.execution_count
      : undefined;
    return {
      cell_type: cellType,
      source: text,
      ...(executionCount !== undefined ? { execution_count: executionCount } : {}),
    };
  }).filter((cell): cell is NotebookCell => cell !== undefined);
  // totalCells describes the document; truncated only means a supported cell is hidden.
  return { cells: supported.slice(0, maxCells), totalCells, truncated: supported.length > maxCells };
}

export async function buildArtifactVersionPreview(
  store: SessionStore,
  recorder: ProvenanceRecorder,
  sessionId: string,
  versionId: string,
  maxRowsParam?: string,
  maxCharsParam?: string,
  maxCellsParam?: string,
): Promise<ArtifactPreviewPayload> {
  const version = store.getArtifactVersion(sessionId, versionId);
  if (!version) {
    throw new ArtifactDashboardError("ARTIFACT_NOT_FOUND", "Artifact version not found");
  }
  const artifact = store.getArtifact(sessionId, version.artifactId);
  if (!artifact) {
    throw new ArtifactDashboardError("ARTIFACT_NOT_FOUND", "Artifact not found");
  }
  // maxRows may ask for fewer rows, never for more: the row constant is what
  // makes the payload bound a constant instead of a function of the request.
  const maxRows = Math.min(MAX_PREVIEW_ROWS, parsePositiveInt(maxRowsParam, DEFAULT_MAX_ROWS));
  const maxChars = parsePositiveInt(maxCharsParam, DEFAULT_MAX_CHARS);
  const maxCells = parsePositiveInt(maxCellsParam, DEFAULT_MAX_CELLS);
  const size = version.content.size;
  const url = contentUrlFor(sessionId, version);
  const kind = artifact.kind;

  switch (kind) {
    case "figure": {
      const large = size > FIGURE_TRUNCATION_BYTES;
      return {
        version,
        kind,
        mode: "figure-url",
        contentUrl: url,
        size,
        truncated: false,
        ...(large ? { note: "Large image; use the content endpoint for the full-resolution original." } : {}),
      };
    }
    case "markdown": {
      const source = await readCasText(recorder, version.content.hash);
      const truncated = source.length > maxChars;
      return {
        version,
        kind,
        mode: "markdown-source",
        source: truncated ? truncateAtCodePoint(source, maxChars) : source,
        totalChars: source.length,
        truncated,
      };
    }
    case "latex": {
      const source = await readCasText(recorder, version.content.hash);
      const truncated = source.length > maxChars;
      return {
        version,
        kind,
        mode: "latex-source",
        source: truncated ? truncateAtCodePoint(source, maxChars) : source,
        totalChars: source.length,
        truncated,
      };
    }
    case "dataset": {
      const subtype = datasetSubtypeFor(artifact.logicalName);
      if (!subtype) {
        return {
          version,
          kind,
          mode: "binary-fallback",
          contentUrl: url,
          size,
          note: "Binary dataset format; use the content endpoint to download.",
        };
      }
      const source = await readCasText(recorder, version.content.hash);
      // A `.json` file explicitly declared as a dataset still only gets the
      // table when its content is a record array.
      if (subtype === ".json") return buildJsonPreview(version, kind, source, maxRows, maxChars);
      const table = parseDelimitedTable(source, subtype, maxRows);
      return {
        version,
        kind,
        mode: "dataset-table",
        mediaSubtype: subtype === ".csv" ? "csv" : "tsv",
        ...table,
        truncated: table.totalRows > maxRows,
      };
    }
    case "json": {
      const source = await readCasText(recorder, version.content.hash);
      return buildJsonPreview(version, kind, source, maxRows, maxChars);
    }
    case "structure": {
      const source = await readCasText(recorder, version.content.hash);
      const atomCount = countStructureAtoms(source);
      const charTruncated = source.length > maxChars;
      // Only bytes actually removed make the preview truncated. The atom budget limits what the
      // structure viewer highlights (`ScientificArtifacts.tsx` slices atoms itself), not what this
      // payload returns, so folding it into `truncated` claimed a cut that never happened.
      return {
        version,
        kind,
        mode: "structure-source",
        source: charTruncated ? truncateAtCodePoint(source, maxChars) : source,
        atomCount,
        totalChars: source.length,
        truncated: charTruncated,
      };
    }
    case "report": {
      const truncated = size > IFRAME_TRUNCATION_BYTES;
      return {
        version,
        kind,
        mode: "report-iframe",
        contentUrl: url,
        size,
        truncated,
        ...(truncated ? { note: "PDF exceeds the inline preview budget; use the content endpoint." } : {}),
      };
    }
    case "html": {
      const truncated = size > IFRAME_TRUNCATION_BYTES;
      return {
        version,
        kind,
        mode: "html-iframe",
        contentUrl: url,
        size,
        truncated,
        ...(truncated ? { note: "HTML payload exceeds the inline preview budget; use the content endpoint." } : {}),
      };
    }
    case "notebook": {
      const source = await readCasText(recorder, version.content.hash);
      const { cells, totalCells, truncated } = parseNotebook(source, maxCells);
      return {
        version,
        kind,
        mode: "notebook-cells",
        cells,
        totalCells,
        truncated,
        editable: false,
      };
    }
    case "other":
      return {
        version,
        kind,
        mode: "binary-fallback",
        contentUrl: url,
        size,
        note: "No inline preview is available for this artifact type.",
      };
  }
}
