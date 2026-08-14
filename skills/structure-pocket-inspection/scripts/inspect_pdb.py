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

"""Summarize a PDB file and list residues near a ligand or Cartesian center."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def parse_atom(line: str) -> dict[str, object] | None:
    if not line.startswith(("ATOM  ", "HETATM")) or len(line) < 54:
        return None
    altloc = line[16].strip()
    if altloc not in {"", "A"}:
        return None
    try:
        return {
            "record": line[:6].strip(),
            "atom": line[12:16].strip(),
            "residue": line[17:20].strip(),
            "chain": line[21].strip() or "_",
            "residue_number": int(line[22:26]),
            "insertion": line[26].strip(),
            "x": float(line[30:38]),
            "y": float(line[38:46]),
            "z": float(line[46:54]),
        }
    except ValueError:
        return None


def distance(left: dict[str, object], right: tuple[float, float, float]) -> float:
    return math.sqrt(sum((float(left[key]) - value) ** 2 for key, value in zip(("x", "y", "z"), right)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdb", type=Path)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--ligand")
    target.add_argument("--center", nargs=3, type=float, metavar=("X", "Y", "Z"))
    parser.add_argument("--cutoff", type=float, default=5.0)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 0 < args.cutoff <= 25:
        parser.error("--cutoff must be greater than 0 and at most 25 Å")

    atoms: list[dict[str, object]] = []
    malformed = 0
    for line in args.pdb.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("ENDMDL"):
            break
        atom = parse_atom(line)
        if atom:
            atoms.append(atom)
        elif line.startswith(("ATOM  ", "HETATM")):
            malformed += 1

    if args.ligand:
        ligand_atoms = [atom for atom in atoms if atom["residue"] == args.ligand.upper()]
        if not ligand_atoms:
            raise SystemExit(f"Ligand residue {args.ligand.upper()} was not found")
        centers = [(float(atom["x"]), float(atom["y"]), float(atom["z"])) for atom in ligand_atoms]
    else:
        ligand_atoms = []
        centers = [tuple(args.center)]

    nearby: dict[tuple[object, ...], float] = {}
    for atom in atoms:
        if atom["record"] != "ATOM":
            continue
        nearest = min(distance(atom, center) for center in centers)
        if nearest <= args.cutoff:
            key = (atom["chain"], atom["residue_number"], atom["insertion"], atom["residue"])
            nearby[key] = min(nearest, nearby.get(key, math.inf))

    chains = sorted({str(atom["chain"]) for atom in atoms if atom["record"] == "ATOM"})
    result = {
        "input": str(args.pdb),
        "atoms": len(atoms),
        "chains": chains,
        "malformed_atom_records": malformed,
        "target": {"ligand": args.ligand.upper(), "atoms": len(ligand_atoms)} if args.ligand else {"center": centers[0]},
        "cutoff_angstrom": args.cutoff,
        "nearby_residues": [
            {"chain": key[0], "number": key[1], "insertion": key[2], "residue": key[3], "nearest_angstrom": round(value, 3)}
            for key, value in sorted(nearby.items(), key=lambda item: item[1])
        ],
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
