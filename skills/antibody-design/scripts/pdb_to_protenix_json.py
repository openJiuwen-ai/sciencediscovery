#!/usr/bin/env python3
# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Convert ProteinMPNN PDB outputs into MindScience Protenix input JSON."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

AA = {
    "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C",
    "GLN": "Q", "GLU": "E", "GLY": "G", "HIS": "H", "ILE": "I",
    "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F", "PRO": "P",
    "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",
}


def pdb_chains(path: Path) -> list[tuple[str, list[tuple[int, str, str]]]]:
    residues: dict[tuple[str, int, str], str] = {}
    order: list[str] = []
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if not line.startswith("ATOM") or line[12:16].strip() != "CA":
                continue
            chain = line[21].strip() or "_"
            if chain not in order:
                order.append(chain)
            try:
                resnum = int(line[22:26])
            except ValueError:
                continue
            residues[(chain, resnum, line[26].strip())] = AA.get(line[17:20].strip().upper(), "X")
    grouped: dict[str, list[tuple[int, str, str]]] = defaultdict(list)
    for (chain, resnum, ins), aa in residues.items():
        grouped[chain].append((resnum, ins, aa))
    return [(chain, sorted(grouped[chain])) for chain in order if grouped.get(chain)]


def protenix_json_for_pdb(path: Path) -> tuple[list[dict], dict]:
    chains = pdb_chains(path)
    if not chains:
        raise ValueError(f"no protein chains found in {path}")
    sequences = [
        {"proteinChain": {"sequence": "".join(aa for _resnum, _ins, aa in residues), "count": 1}}
        for _chain, residues in chains
    ]
    protenix_chain_ids = [chr(ord("A") + idx) for idx in range(len(chains))]
    chain_map = {
        original: {
            "protenix_chain": protenix_chain_ids[idx],
            "sequence_length": len(residues),
            "residue_map": [
                {
                    "original_residue": resnum,
                    "insertion_code": ins,
                    "protenix_residue": pos,
                    "aa": aa,
                }
                for pos, (resnum, ins, aa) in enumerate(residues, 1)
            ],
        }
        for idx, (original, residues) in enumerate(chains)
    }
    return [{"name": path.stem, "sequences": sequences}], chain_map


def convert_one(path: Path, output_dir: Path) -> tuple[Path, Path]:
    data, chain_map = protenix_json_for_pdb(path)
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"{path.stem}.json"
    map_path = output_dir / f"{path.stem}.chain_map.json"
    json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    map_path.write_text(json.dumps(chain_map, indent=2), encoding="utf-8")
    return json_path, map_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, help="ProteinMPNN PDB file or directory")
    parser.add_argument("-o", "--output", type=Path, required=True)
    args = parser.parse_args()
    inputs = sorted(args.input.glob("*_dldesign_0.pdb")) if args.input.is_dir() else [args.input]
    if not inputs:
        raise SystemExit(f"no ProteinMPNN PDB files found in {args.input}")
    for pdb in inputs:
        json_path, map_path = convert_one(pdb, args.output)
        print(f"Wrote {json_path} and {map_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
