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
} from "@science-agent/schema";

import type { ProvenanceRecorder } from "./provenance.js";
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
const FIGURE_TRUNCATION_BYTES = 5 * 1024 * 1024;
const IFRAME_TRUNCATION_BYTES = 2 * 1024 * 1024;
const STRUCTURE_ATOM_TRUNCATION = 8_000;

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

function splitDelimited(source: string, delimiter: RegExp): string[][] {
  return source.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split(delimiter));
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
  const delimiter = subtype === ".csv" ? /,/ : /\t/;
  const lines = splitDelimited(source, delimiter);
  if (!lines.length) return { columns: [], rows: [], totalRows: 0 };
  return {
    columns: lines[0] ?? [],
    rows: lines.slice(1, maxRows + 1),
    totalRows: Math.max(0, lines.length - 1),
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
  return records.length === parsed.length ? records : undefined;
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

/** Apply the char budget to one text form of a JSON document. */
function jsonSourceOf(text: string, maxChars: number): ArtifactJsonSource {
  const truncated = text.length > maxChars;
  return { source: truncated ? text.slice(0, maxChars) : text, totalChars: text.length, truncated };
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
  let parsed: unknown;
  let valid = true;
  try {
    parsed = JSON.parse(source) as unknown;
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
        truncated: table.totalRows > maxRows,
        rawJson: jsonSourceOf(JSON.stringify(parsed, null, 2), maxChars),
      };
    }
  }
  return {
    version,
    kind: "json",
    mode: "json-source",
    ...jsonSourceOf(valid ? JSON.stringify(parsed, null, 2) : source, maxChars),
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

function parseNotebook(source: string, maxCells: number): { cells: NotebookCell[]; totalCells: number } {
  let parsed: { cells?: unknown };
  try {
    parsed = JSON.parse(source) as { cells?: unknown };
  } catch {
    return { cells: [], totalCells: 0 };
  }
  const rawCells = Array.isArray(parsed.cells) ? parsed.cells : [];
  const totalCells = rawCells.length;
  const cells = rawCells.slice(0, maxCells).map<NotebookCell | undefined>((cell) => {
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
  return { cells, totalCells };
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
        source: truncated ? source.slice(0, maxChars) : source,
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
        source: truncated ? source.slice(0, maxChars) : source,
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
      const atomTruncated = atomCount > STRUCTURE_ATOM_TRUNCATION;
      return {
        version,
        kind,
        mode: "structure-source",
        source: charTruncated ? source.slice(0, maxChars) : source,
        atomCount,
        totalChars: source.length,
        truncated: charTruncated || atomTruncated,
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
      const { cells, totalCells } = parseNotebook(source, maxCells);
      return {
        version,
        kind,
        mode: "notebook-cells",
        cells,
        totalCells,
        truncated: totalCells > maxCells,
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
