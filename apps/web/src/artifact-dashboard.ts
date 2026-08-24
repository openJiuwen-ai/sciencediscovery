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

// Front-end mirror of the dashboard / preview payload contracts emitted by
// `services/api/src/artifact-dashboard.ts`. Per the design draft the
// payload types intentionally live outside the schema package until 0.1.0
// fields stabilise; the web app matches the JSON shape returned by the API.

import type {
  ScientificArtifact,
  ScientificArtifactKind,
  ScientificArtifactVersion,
} from "@sciencediscovery/schema";

export interface ArtifactDashboardContext {
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionTitle: string;
  /** 0.1.0 placeholder — always empty until project and Session labels are implemented. */
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

/** Union of every `mode` the preview payload can report. */
export type ArtifactPreviewMode = ArtifactPreviewPayload["mode"];

/** Type guard that narrows a preview payload by its `mode`. */
export function previewOf<T extends ArtifactPreviewMode>(
  payload: ArtifactPreviewPayload,
  mode: T,
): Extract<ArtifactPreviewPayload, { mode: T }> | undefined {
  return payload.mode === mode
    ? (payload as Extract<ArtifactPreviewPayload, { mode: T }>)
    : undefined;
}
