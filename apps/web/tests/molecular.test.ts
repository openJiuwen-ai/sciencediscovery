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


import { cifTrajectoryFormat, detectStructureFormat, isStructureJson } from "../src/molecular.js";

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

const NACL_CORE_CIF = `data_NaCl
_symmetry_space_group_name_H-M 'F m -3 m'
_cell_length_a 5.6402
_cell_length_b 5.6402
_cell_length_c 5.6402
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_symmetry_equiv_pos_as_xyz
'x, y, z'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Na1 Na 0.0 0.0 0.0
Cl1 Cl 0.5 0.5 0.5
`;

const MMCIF = `data_1TQN
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
ATOM 1 N N 10.0 12.0 14.0
`;

test("picks the CIF core parser for crystallographic files and mmCIF otherwise", () => {
  // A crystallographic CIF parsed as mmCIF yields zero models ("No models found").
  assert.equal(cifTrajectoryFormat(NACL_CORE_CIF), "cifCore");
  assert.equal(cifTrajectoryFormat(NACL_CORE_CIF.replace(/_atom_site_fract_x/, "_ATOM_SITE_FRACT_X")), "cifCore");
  assert.equal(cifTrajectoryFormat(MMCIF), "mmcif");
  // A file carrying both keeps the Cartesian (mmCIF) reading.
  assert.equal(cifTrajectoryFormat(`${MMCIF}\n_atom_site.fract_x\n`), "mmcif");
  assert.equal(cifTrajectoryFormat(""), "mmcif");
  // Format detection itself still calls both of them "cif".
  assert.equal(detectStructureFormat({ name: "NaCl_Fm-3m.cif", content: NACL_CORE_CIF }), "cif");
});
