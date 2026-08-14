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

import assert from "node:assert/strict";
import test from "node:test";

import { detectStructureFormat, isStructureJson } from "../src/molecular.js";

test("detects molecular formats from the artifact filename", () => {
  assert.equal(detectStructureFormat({ name: "complex.pdb" }), "pdb");
  assert.equal(detectStructureFormat({ name: "quartz.cif" }), "cif");
  assert.equal(detectStructureFormat({ name: "protein.mmcif" }), "cif");
  assert.equal(detectStructureFormat({ name: "cluster.xyz" }), "xyz");
  assert.equal(detectStructureFormat({ name: "ligand.mol2" }), "mol2");
  assert.equal(detectStructureFormat({ name: "notes.txt" }), undefined);
});

test("falls back to media type then content sniffing", () => {
  assert.equal(detectStructureFormat({ mediaType: "chemical/x-pdb" }), "pdb");
  assert.equal(detectStructureFormat({ mediaType: "chemical/x-xyz" }), "xyz");
  const pdb = "HEADER    HYDROLASE\nATOM      1  CA  ALA A   1      10.0  12.0  14.0  1.00  0.00           C\n";
  assert.equal(detectStructureFormat({ content: pdb }), "pdb");
  const xyz = "3\nwater\nO  0.0 0.0 0.0\nH  0.96 0.0 0.0\nH -0.24 0.93 0.0\n";
  assert.equal(detectStructureFormat({ content: xyz }), "xyz");
  const cif = "data_quartz\n_cell_length_a 4.913\nloop_\n_atom_site_label\nSi1\n";
  assert.equal(detectStructureFormat({ content: cif }), "cif");
});

test("does not treat the platform structure JSON as a 3D structure format", () => {
  const json = JSON.stringify({ atoms: [{ element: "C", x: 0, y: 0, z: 0 }] });
  assert.equal(isStructureJson(json), true);
  assert.equal(detectStructureFormat({ content: json }), undefined);
  assert.equal(detectStructureFormat({ name: "model.structure.json", content: json }), undefined);
});
