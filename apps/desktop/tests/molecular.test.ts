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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  cifTrajectoryFormat,
  detectStructureFormat,
  isStructureJson,
} from "../src/molecular.js";

const PDB = [
  "HEADER    OXIDOREDUCTASE                          02-JAN-99   1ABC",
  "ATOM      1  N   MET A   1      39.447  32.297   6.985  1.00 20.00           N",
  "ATOM      2  CA  MET A   1      40.104  32.877   6.118  1.00 20.00           C",
  "END",
].join("\n");

const MMCIF = ["data_1ABC", "loop_", "_atom_site.group_PDB", "_atom_site.Cartn_x", "ATOM C 1.0"].join("\n");

const CIF_CORE = [
  "data_NaCl",
  "_cell_length_a 5.64",
  "loop_",
  "_atom_site_fract_x",
  "_atom_site_fract_y",
  "_atom_site_fract_z",
  "0.0 0.0 0.0",
].join("\n");

const SDF = ["methane", "  Mol", "  5  4  0  0  0  0  0  0  0  0999 V2000", "M  END", "$$$$"].join("\n");

// The platform's own atom bag: a `.json` that is a structure by kind and a
// hand-rolled summary rather than a file Mol* should be handed.
const STRUCTURE_JSON = JSON.stringify({ atoms: [{ element: "C", x: 0, y: 0, z: 0 }] });

test("a structure is recognised by its extension", () => {
  assert.equal(detectStructureFormat({ name: "protein.pdb" }), "pdb");
  assert.equal(detectStructureFormat({ name: "crystal.cif" }), "cif");
  assert.equal(detectStructureFormat({ name: "ligand.sdf" }), "sdf");
  assert.equal(detectStructureFormat({ name: "traj.xyz" }), "xyz");
  assert.equal(detectStructureFormat({ name: "docked.mol2" }), "mol2");
  // Aliases the platform's kind table also folds into "structure".
  assert.equal(detectStructureFormat({ name: "1abc.ent" }), "pdb");
  assert.equal(detectStructureFormat({ name: "1abc.mmcif" }), "cif");
});

test("an extensionless artifact is recognised by its media type", () => {
  assert.equal(detectStructureFormat({ mediaType: "chemical/x-pdb", name: "model" }), "pdb");
  assert.equal(detectStructureFormat({ mediaType: "CHEMICAL/X-MMCIF" }), "cif");
});

test("content is sniffed when neither the name nor the media type says", () => {
  assert.equal(detectStructureFormat({ content: PDB, name: "download" }), "pdb");
  assert.equal(detectStructureFormat({ content: MMCIF }), "cif");
  assert.equal(detectStructureFormat({ content: SDF }), "sdf");
  assert.equal(detectStructureFormat({ content: "3\nwater\nO 0.0 0.0 0.0\nH 0.0 0.0 1.0\nH 0.757 0.586 0.0" }), "xyz");
});

test("anything that is not a structure stays out of the viewer", () => {
  assert.equal(detectStructureFormat({ content: "# Report\n\nNothing molecular here." }), undefined);
  assert.equal(detectStructureFormat({ content: '{"rows": 3}', name: "data.json" }), undefined);
  assert.equal(detectStructureFormat({ content: "" }), undefined);
});

test("the platform's own .structure.json bag is left to the JSON preview", () => {
  assert.equal(isStructureJson(STRUCTURE_JSON), true);
  assert.equal(detectStructureFormat({ content: STRUCTURE_JSON, name: "run.structure.json" }), undefined);
  // …while a genuine structure file that happens to be named .json is not
  // claimed either: the viewer is for the formats Mol* parses from the file.
  assert.equal(detectStructureFormat({ content: PDB, name: "confused.json" }), undefined);
});

test("a crystallographic .cif goes to Mol*'s CIF-core parser", () => {
  assert.equal(cifTrajectoryFormat(CIF_CORE), "cifCore");
  assert.equal(cifTrajectoryFormat(MMCIF), "mmcif");
  // A file carrying both is an mmCIF: the Cartesian columns are the ones it
  // means, and this is Mol*'s own tie-break.
  assert.equal(cifTrajectoryFormat(`${MMCIF}\n_atom_site.fract_x`), "mmcif");
});
