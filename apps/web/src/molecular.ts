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

// Format detection for molecular / crystal structure artifacts. Kept free of any
// viewer / DOM imports so it stays trivially unit-testable and safe to evaluate
// during server-side rendering.

export type StructureFormat = "cif" | "mol2" | "pdb" | "sdf" | "xyz";

const EXTENSION_FORMATS: Record<string, StructureFormat> = {
  cif: "cif",
  ent: "pdb",
  mcif: "cif",
  mmcif: "cif",
  mol: "sdf",
  mol2: "mol2",
  pdb: "pdb",
  pqr: "pdb",
  sdf: "sdf",
  xyz: "xyz",
};

const MEDIA_TYPE_FORMATS: Record<string, StructureFormat> = {
  "chemical/x-cif": "cif",
  "chemical/x-mdl-molfile": "sdf",
  "chemical/x-mdl-sdfile": "sdf",
  "chemical/x-mmcif": "cif",
  "chemical/x-mol2": "mol2",
  "chemical/x-pdb": "pdb",
  "chemical/x-xyz": "xyz",
};

function extensionOf(name: string): string {
  const clean = name.trim().toLocaleLowerCase().split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot + 1);
}

/** True when the payload is the platform's own `.structure.json` atom bag. */
export function isStructureJson(content: string): boolean {
  const head = content.trimStart();
  if (!head.startsWith("{") && !head.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(content) as { atoms?: unknown };
    return Array.isArray(parsed.atoms);
  } catch {
    return false;
  }
}

function sniffFormat(content: string): StructureFormat | undefined {
  const trimmed = content.trimStart();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return undefined;
  const lines = trimmed.split(/\r?\n/);

  if (/@<TRIPOS>/.test(trimmed)) return "mol2";
  // SDF / MDL molfile: a counts line ending in V2000/V3000, or an SDF record terminator.
  if (/^\s*\d+\s+\d+.*V[23]000\s*$/m.test(trimmed) || /^\$\$\$\$\s*$/m.test(trimmed)) return "sdf";
  // mmCIF / CIF: data block plus a cell or atom-site loop.
  if (/^data_/m.test(trimmed) && (/_cell_length_a/.test(trimmed) || /_atom_site/.test(trimmed) || /^loop_/m.test(trimmed))) {
    return "cif";
  }
  // PDB: any of the canonical coordinate / header records.
  if (lines.some((line) => /^(ATOM  |HETATM|CRYST1|HEADER|MODEL |SEQRES)/.test(line))) return "pdb";
  // XYZ: an atom count, then a comment, then `element x y z` rows.
  const count = Number(lines[0]?.trim());
  if (Number.isInteger(count) && count > 0 && lines.length >= count + 2) {
    const sample = lines[2]?.trim().split(/\s+/) ?? [];
    if (sample.length >= 4 && /^[A-Za-z]{1,3}\d*$/.test(sample[0]!) && sample.slice(1, 4).every((value) => Number.isFinite(Number(value)))) {
      return "xyz";
    }
  }
  return undefined;
}

/**
 * Resolve the molecular structure format of an artifact version, preferring the
 * declared filename, then the media type, then content sniffing. Returns
 * `undefined` for non-structure payloads (including the JSON atom bag).
 */
export function detectStructureFormat({ content, mediaType, name }: {
  content?: string;
  mediaType?: string;
  name?: string;
}): StructureFormat | undefined {
  if (name) {
    const byExtension = EXTENSION_FORMATS[extensionOf(name)];
    if (byExtension) return byExtension;
  }
  if (mediaType) {
    const byMedia = MEDIA_TYPE_FORMATS[mediaType.trim().toLocaleLowerCase()];
    if (byMedia) return byMedia;
  }
  if (content && !isStructureJson(content)) return sniffFormat(content);
  return undefined;
}
