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

// Pin the shared artifact classifier's behaviour. This is the contract that
// keeps `provenance.ts` (recording), `store.ts` (validation), and the
// dashboard preview (rendering) in sync. Adding a new extension in only one
// caller, such as adding `.xyz` only in provenance.ts, must not recur.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SCIENTIFIC_ARTIFACT_KINDS,
  SCIENTIFIC_ARTIFACT_KIND_SET,
  classifyScientificArtifact,
  resolveScientificArtifactKind,
} from "@science-agent/schema";

test("SCIENTIFIC_ARTIFACT_KINDS matches the canonical kinds", () => {
  assert.deepEqual(SCIENTIFIC_ARTIFACT_KINDS, [
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
  ]);
});

test("SCIENTIFIC_ARTIFACT_KIND_SET accepts every canonical kind and rejects typos", () => {
  for (const kind of SCIENTIFIC_ARTIFACT_KINDS) {
    assert.equal(SCIENTIFIC_ARTIFACT_KIND_SET.has(kind), true);
  }
  assert.equal(SCIENTIFIC_ARTIFACT_KIND_SET.has("dataset " as never), false);
  assert.equal(SCIENTIFIC_ARTIFACT_KIND_SET.has("Figure" as never), false);
});

test("classifyScientificArtifact recognises figure extensions", () => {
  for (const path of ["plot.png", "image.jpg", "image.jpeg", "drawing.svg", "photo.webp"]) {
    assert.equal(classifyScientificArtifact(path), "figure", `${path} should classify as figure`);
  }
});

test("classifyScientificArtifact recognises text dataset extensions", () => {
  assert.equal(classifyScientificArtifact("table.csv"), "dataset");
  assert.equal(classifyScientificArtifact("table.tsv"), "dataset");
});

test("classifyScientificArtifact classifies .json as json, not dataset", () => {
  assert.equal(classifyScientificArtifact("records.json"), "json");
  assert.equal(classifyScientificArtifact("antibody_pipeline/runs/t1/03_af3_input_json/output_0.json"), "json");
  assert.equal(classifyScientificArtifact("CONFIG.JSON"), "json");
});

test("classifyScientificArtifact recognises binary dataset extensions even though the preview endpoint declines to parse them", () => {
  for (const path of ["data.parquet", "data.feather", "spreadsheet.xlsx"]) {
    assert.equal(classifyScientificArtifact(path), "dataset", `${path} should classify as dataset`);
  }
});

test("classifyScientificArtifact routes .structure.json to structure, not json", () => {
  assert.equal(classifyScientificArtifact("pocket.structure.json"), "structure");
  assert.equal(classifyScientificArtifact("data.json"), "json");
});

test("resolveScientificArtifactKind upgrades legacy .json catalog entries and leaves every other kind alone", () => {
  assert.equal(resolveScientificArtifactKind("dataset", "records.json"), "json");
  assert.equal(resolveScientificArtifactKind("dataset", "table.csv"), "dataset");
  assert.equal(resolveScientificArtifactKind("dataset", "data.parquet"), "dataset");
  // `.structure.json` stayed a structure before and after the change.
  assert.equal(resolveScientificArtifactKind("structure", "pocket.structure.json"), "structure");
  // An explicitly declared kind is never rewritten from the extension.
  assert.equal(resolveScientificArtifactKind("other", "config.json"), "other");
  assert.equal(resolveScientificArtifactKind("notebook", "analysis.ipynb"), "notebook");
});

test("classifyScientificArtifact recognises molecular structure extensions including .xyz", () => {
  for (const path of ["protein.pdb", "ligand.cif", "membrane.mmcif", "drug.mol2", "library.sdf", "trajectory.xyz"]) {
    assert.equal(classifyScientificArtifact(path), "structure", `${path} should classify as structure`);
  }
});

test("classifyScientificArtifact recognises report, markdown, latex, html, and notebook extensions", () => {
  assert.equal(classifyScientificArtifact("paper.pdf"), "report");
  assert.equal(classifyScientificArtifact("paper.docx"), "report");
  assert.equal(classifyScientificArtifact("notes.md"), "markdown");
  assert.equal(classifyScientificArtifact("notes.markdown"), "markdown");
  assert.equal(classifyScientificArtifact("manuscript.tex"), "latex");
  assert.equal(classifyScientificArtifact("dashboard.html"), "html");
  assert.equal(classifyScientificArtifact("dashboard.htm"), "html");
  assert.equal(classifyScientificArtifact("analysis.ipynb"), "notebook");
});

test("classifyScientificArtifact is case-insensitive on extensions and ignores query strings only via path semantics", () => {
  assert.equal(classifyScientificArtifact("PAPER.PDF"), "report");
  assert.equal(classifyScientificArtifact("Output/Tables/Data.CSV"), "dataset");
});

test("classifyScientificArtifact returns undefined for unknown extensions", () => {
  assert.equal(classifyScientificArtifact("readme"), undefined);
  assert.equal(classifyScientificArtifact("binary.bin"), undefined);
  assert.equal(classifyScientificArtifact("archive.tar.gz"), undefined);
  assert.equal(classifyScientificArtifact(".gitignore"), undefined);
});

test("classifyScientificArtifact treats hidden dotfiles without a real extension as unknown", () => {
  assert.equal(classifyScientificArtifact(".bashrc"), undefined);
});
