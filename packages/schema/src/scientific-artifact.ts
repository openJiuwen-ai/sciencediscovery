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

// Shared classifier for scientific artifacts. Lifted from
// `ProvenanceRecorder.artifactKind` so the same source of truth covers
// provenance recording, store validation, and dashboard rendering. Keeping
// this in the schema package avoids the historical sync bug where adding a
// new extension (e.g. `.xyz`) in one caller forgot to update the others.

import type { ScientificArtifactKind } from "./artifact-provenance.js";

/** Local extname — keeps the schema package free of node type dependencies. */
function extensionOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const tail = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = tail.lastIndexOf(".");
  if (dot <= 0) return ""; // dot===-1 (none) or dot===0 (e.g. ".gitignore")
  return tail.slice(dot).toLocaleLowerCase();
}

const EXTENSION_KIND: Record<string, ScientificArtifactKind> = {
  ".csv": "dataset",
  ".cif": "structure",
  ".docx": "report",
  ".feather": "dataset",
  ".htm": "html",
  ".html": "html",
  ".ipynb": "notebook",
  ".jpeg": "figure",
  ".jpg": "figure",
  ".json": "json",
  ".markdown": "markdown",
  ".md": "markdown",
  ".mmcif": "structure",
  ".mol2": "structure",
  ".parquet": "dataset",
  ".pdf": "report",
  ".pdb": "structure",
  ".png": "figure",
  ".sdf": "structure",
  ".svg": "figure",
  ".tex": "latex",
  ".tsv": "dataset",
  ".webp": "figure",
  ".xlsx": "dataset",
  ".xyz": "structure",
};

/** Canonical, ordered list of every `ScientificArtifactKind`. */
export const SCIENTIFIC_ARTIFACT_KINDS: readonly ScientificArtifactKind[] = [
  "dataset",
  "figure",
  "html",
  "json",
  "latex",
  "markdown",
  "notebook",
  "other",
  "report",
  "structure",
];

/** Set form of {@link SCIENTIFIC_ARTIFACT_KINDS} for cheap membership checks. */
export const SCIENTIFIC_ARTIFACT_KIND_SET: ReadonlySet<ScientificArtifactKind> = new Set(SCIENTIFIC_ARTIFACT_KINDS);

/**
 * Resolve the {@link ScientificArtifactKind} for a workspace path by its file
 * extension. Returns `undefined` for paths the platform does not yet model.
 * The `.structure.json` atom bag is reported as `"structure"`, matching the
 * provenance recorder and store validation behaviour; every other `.json` file
 * is `"json"` — a plain JSON document, not necessarily a tabular dataset.
 */
export function classifyScientificArtifact(path: string): ScientificArtifactKind | undefined {
  const extension = extensionOf(path);
  if (!extension) return undefined;
  if (extension === ".json" && path.endsWith(".structure.json")) return "structure";
  return EXTENSION_KIND[extension];
}

/**
 * Kind a stored artifact record should be rendered and previewed with.
 *
 * `.json` artifacts recorded before JSON became its own kind carry
 * `"dataset"`, which routes a plain JSON document into the table preview and
 * shows an empty `0 rows` grid. Re-derive those from the logical
 * name so old catalog entries behave exactly like newly recorded ones. Every
 * other stored kind is authoritative and returned unchanged — an explicitly
 * declared kind is never overridden by the extension table.
 */
export function resolveScientificArtifactKind(
  kind: ScientificArtifactKind,
  logicalName: string,
): ScientificArtifactKind {
  if (kind !== "dataset") return kind;
  return classifyScientificArtifact(logicalName) === "json" ? "json" : kind;
}
