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
 * The most cells a padded preview may hold (returned rows x width). Padding a
 * short row is what squares the grid, but padding every row to one outlier
 * line copies that line into each of them: a 400 KB file holding one 200k-field
 * line asked for 100 x 200001 cells and a 60.8 MB response. The preview
 * already spends 100k characters on a text source (DEFAULT_MAX_CHARS) and one
 * cell is a few bytes of JSON, so the grid gets that same 100k-cell budget.
 */
const MAX_PREVIEW_CELLS = DEFAULT_MAX_CHARS;
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
} {
  const delimiter = subtype === ".csv" ? "," : "\t";
  const lines = splitDelimited(source, delimiter);
  if (!lines.length) return { columns: [], rows: [], totalRows: 0 };
  const header = lines[0] ?? [];
  const rows = lines.slice(1, maxRows + 1);
  // The table is as wide as the header plus any extra cell a returned row
  // carries: the renderer prints one <th> per column and one <td> per cell, so a
  // short row is padded and an extra cell gets its own blank header instead of
  // landing under the wrong one. Only the returned rows count, or a wide row
  // beyond maxRows would add an empty column no returned row fills.
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), header.length);
  const totalRows = Math.max(0, lines.length - 1);
  // The rectangle is worth its price only while it fits the cell budget. Past
  // it, return every row at its own width — the shape before the padding fix —
  // so one pathological line cannot be copied into all the rows around it.
  // This is one decision for the whole table, never per row, and it drops no
  // column: a legitimately wide table is still previewed whole.
  if (rows.length * width > MAX_PREVIEW_CELLS) return { columns: header, rows, totalRows };
  return {
    columns: header.length === width
      ? header
      : [...header, ...Array.from({ length: width - header.length }, () => "")],
    rows: rows.map((row) => (
      row.length === width ? row : [...row, ...Array.from({ length: width - row.length }, () => "")]
    )),
    totalRows,
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
  return { columns, rows, totalRows: records.length };
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
  const maxRows = parsePositiveInt(maxRowsParam, DEFAULT_MAX_ROWS);
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
