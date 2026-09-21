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

"""Screen MindScience Protenix antibody-design outputs."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import shlex
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np


def to_float(value, default: float = float("nan")) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_cif_atoms(path: Path):
    atoms = []
    bvals: dict[str, list[float]] = defaultdict(list)
    residues: dict[tuple[str, int], list[np.ndarray]] = defaultdict(list)
    atom_site_fields: list[str] = []
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            stripped = line.strip()
            if stripped == "loop_":
                atom_site_fields = []
                continue
            if stripped.startswith("_atom_site."):
                atom_site_fields.append(stripped.split()[0].removeprefix("_atom_site."))
                continue
            if not line.startswith(("ATOM ", "HETATM ")):
                continue
            parts = shlex.split(line)
            record = {}
            if atom_site_fields and len(parts) >= len(atom_site_fields):
                record = dict(zip(atom_site_fields, parts))
            try:
                if record:
                    xyz = np.array([
                        float(record["Cartn_x"]),
                        float(record["Cartn_y"]),
                        float(record["Cartn_z"]),
                    ])
                    bval = float(record.get("B_iso_or_equiv", "nan"))
                    resnum = int(record.get("label_seq_id") or record["auth_seq_id"])
                    atom = record.get("label_atom_id") or record.get("auth_atom_id") or ""
                    chain = record.get("label_asym_id") or record.get("auth_asym_id") or ""
                else:
                    if len(parts) < 17:
                        continue
                    atom = parts[2]
                    chain = parts[5]
                    resnum = int(parts[7])
                    bval = float(parts[13])
                    xyz = np.array([float(parts[14]), float(parts[15]), float(parts[16])])
            except (KeyError, ValueError):
                continue
            if not atom or not chain:
                continue
            atoms.append((chain, resnum, atom, xyz, bval))
            bvals[chain].append(bval)
            if atom == "CA":
                residues[(chain, resnum)].append(xyz)
    return atoms, bvals, residues


def chain_lengths(atoms) -> dict[str, int]:
    seen = {(chain, resnum) for chain, resnum, atom, _xyz, _bval in atoms if atom == "CA"}
    lengths: dict[str, int] = defaultdict(int)
    for chain, _resnum in seen:
        lengths[chain] += 1
    return dict(lengths)


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else float("nan")


def parse_hotspots(text: str) -> list[tuple[str, int]]:
    hotspots = []
    normalized = text.strip()
    if normalized.startswith("[") and normalized.endswith("]"):
        normalized = normalized[1:-1]
    for item in re.split(r"[,;\s]+", normalized):
        if not item:
            continue
        match = re.fullmatch(r"([A-Za-z])([0-9]+)", item)
        if match:
            hotspots.append((match.group(1), int(match.group(2))))
    return hotspots


def find_predictions(root: Path):
    for confidence in sorted(root.rglob("*summary_confidence_sample_*.json")):
        predictions = confidence.parent
        stem = confidence.name.replace("_summary_confidence", "").replace(".json", "")
        cif = predictions / f"{stem}.cif"
        if not cif.exists():
            cifs = sorted(predictions.glob("*.cif"))
            cif = cifs[0] if cifs else None
        if not cif:
            continue
        design_dir = predictions.parent.parent
        yield design_dir.name, confidence, cif


def load_chain_map(protenix_root: Path, design: str) -> dict:
    """Load the sibling Protenix input chain map for a design, if present."""
    candidates = [
        protenix_root.parent / "03_protenix_input" / f"{design}.chain_map.json",
        protenix_root.parent / "03_protenix_input_json" / f"{design}.chain_map.json",
    ]
    for path in candidates:
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                return {}
            return data if isinstance(data, dict) else {}
    return {}


def pdb_residue_positions(path: Path | None) -> dict[str, dict[int, int]]:
    if path is None or not path.is_file():
        return {}
    order: dict[str, list[int]] = defaultdict(list)
    seen: set[tuple[str, int, str]] = set()
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if not line.startswith("ATOM") or line[12:16].strip() != "CA":
                continue
            chain = line[21].strip() or "_"
            insertion = line[26].strip()
            try:
                resnum = int(line[22:26])
            except ValueError:
                continue
            key = (chain, resnum, insertion)
            if key in seen:
                continue
            seen.add(key)
            order[chain].append(resnum)
    return {chain: {resnum: index for index, resnum in enumerate(residues, 1)} for chain, residues in order.items()}


def target_chain_info(chain_map: dict, target_length: int | None, original_chain: str = "") -> tuple[dict | None, str]:
    entries = [(chain, info) for chain, info in chain_map.items() if isinstance(info, dict)]
    preferred = [(chain, info) for chain, info in entries if chain not in {"H", "L"}]
    length_matches = [
        info for _chain, info in preferred or entries
        if target_length is not None and info.get("sequence_length") == target_length
    ]
    if len(length_matches) == 1:
        return length_matches[0], ""
    if len(length_matches) > 1:
        return None, "ambiguous_target_chain"
    if len(preferred) == 1:
        info = preferred[0][1]
        observed_length = info.get("sequence_length")
        if target_length is not None and observed_length != target_length:
            label = original_chain or "target"
            return None, f"target_length_mismatch:{label}:expected_{target_length}:got_{observed_length}"
        return info, ""
    return None, "ambiguous_target_chain" if preferred or entries else ""


def protenix_residue_for_sequence_position(chain_info: dict, sequence_position: int) -> int | None:
    residue_map = chain_info.get("residue_map", [])
    if not isinstance(residue_map, list):
        return None
    for item in residue_map:
        if isinstance(item, dict) and item.get("protenix_residue") == sequence_position:
            return sequence_position
    if 1 <= sequence_position <= len(residue_map):
        value = residue_map[sequence_position - 1].get("protenix_residue") if isinstance(residue_map[sequence_position - 1], dict) else None
        return value if isinstance(value, int) else None
    return None


def mapped_hotspots(chain_map: dict, hotspots: list[tuple[str, int]], target_pdb: Path | None = None) -> tuple[str, list[tuple[str, int]], list[str], str]:
    mapped: list[tuple[str, int]] = []
    target_chains: set[str] = set()
    missing: list[str] = []
    target_positions = pdb_residue_positions(target_pdb)
    mapping_error = ""
    for original_chain, original_residue in hotspots:
        chain_info = chain_map.get(original_chain)
        sequence_position: int | None = None
        chain_positions = target_positions.get(original_chain, {})
        if not isinstance(chain_info, dict):
            sequence_position = chain_positions.get(original_residue)
            chain_info, mapping_error = target_chain_info(
                chain_map,
                len(chain_positions) if chain_positions else None,
                original_chain,
            )
            if mapping_error:
                missing.append(f"{original_chain}{original_residue}")
                continue
        elif chain_positions:
            expected_length = len(chain_positions)
            observed_length = chain_info.get("sequence_length")
            if observed_length != expected_length:
                mapping_error = f"target_length_mismatch:{original_chain}:expected_{expected_length}:got_{observed_length}"
                missing.append(f"{original_chain}{original_residue}")
                continue
        if not isinstance(chain_info, dict):
            missing.append(f"{original_chain}{original_residue}")
            continue
        protenix_chain = str(chain_info.get("protenix_chain", "")).strip()
        residue_map = chain_info.get("residue_map", [])
        if not protenix_chain or not isinstance(residue_map, list):
            missing.append(f"{original_chain}{original_residue}")
            continue
        protenix_residue = None
        if sequence_position is not None:
            protenix_residue = protenix_residue_for_sequence_position(chain_info, sequence_position)
        else:
            for item in residue_map:
                if isinstance(item, dict) and item.get("original_residue") == original_residue:
                    protenix_residue = item.get("protenix_residue")
                    break
        if not isinstance(protenix_residue, int):
            missing.append(f"{original_chain}{original_residue}")
            continue
        target_chains.add(protenix_chain)
        mapped.append((protenix_chain, protenix_residue))
    if mapping_error:
        return "", [], sorted(set(missing)), mapping_error
    if len(target_chains) > 1:
        return "", [], sorted(set(missing)), "ambiguous_target_chain"
    if len(target_chains) == 0:
        return "", [], sorted(set(missing)), ""
    return next(iter(target_chains)), mapped, sorted(set(missing)), ""


def best_rows(root: Path) -> list[dict]:
    rows = []
    for design, confidence_path, cif_path in find_predictions(root):
        conf = json.loads(confidence_path.read_text(encoding="utf-8"))
        ranking = to_float(conf.get("ranking_score"), to_float(conf.get("pb_ranking_score"), 0.0))
        rows.append({
            "design": design,
            "confidence_path": confidence_path,
            "model_cif": cif_path,
            "confidence": conf,
            "ranking_score": ranking,
        })
    rows.sort(key=lambda row: (row["design"], -row["ranking_score"], str(row["confidence_path"])))
    best = {}
    for row in rows:
        best.setdefault(row["design"], row)
    return list(best.values())


def min_contact_count(residues, binder_chains: list[str], target_chain: str, hotspots: list[tuple[str, int]], cutoff: float):
    binder_points = [point for (chain, _resnum), points in residues.items() if chain in binder_chains for point in points]
    if not binder_points:
        return 0, len(hotspots)
    contacts = 0
    for _label, resnum in hotspots:
        target_points = residues.get((target_chain, resnum), [])
        hit = False
        for t in target_points:
            for b in binder_points:
                if float(np.linalg.norm(t - b)) <= cutoff:
                    hit = True
                    break
            if hit:
                break
        if hit:
            contacts += 1
    return contacts, len(hotspots)


def screen_one(row: dict, protenix_root: Path, hotspots_text: str, contact_cutoff: float, target_pdb: Path | None = None) -> dict:
    conf = row["confidence"]
    atoms, bvals, residues = parse_cif_atoms(row["model_cif"])
    lengths = chain_lengths(atoms)
    chain_map = load_chain_map(protenix_root, row["design"])
    original_hotspots = parse_hotspots(hotspots_text)
    target_chain, hotspots, missing_hotspots, hotspot_mapping_error = mapped_hotspots(chain_map, original_hotspots, target_pdb)
    mapping_error = ""
    if not chain_map:
        mapping_error = "missing_chain_map"
    elif not original_hotspots:
        mapping_error = "missing_hotspots"
    elif hotspot_mapping_error:
        mapping_error = hotspot_mapping_error
    elif missing_hotspots:
        mapping_error = "unmapped_hotspots:" + ",".join(missing_hotspots)
    elif not target_chain:
        mapping_error = "ambiguous_target_chain"
    elif not atoms or not lengths:
        mapping_error = "empty_model_atoms"
    chain_ids = sorted(lengths)
    if mapping_error:
        target_chain = target_chain or ""
    binder_chains = [chain for chain in sorted(lengths) if chain != target_chain]
    if not mapping_error and lengths.get(target_chain, 0) == 0:
        mapping_error = "missing_target_chain_atoms:" + target_chain
    if not mapping_error and not binder_chains:
        mapping_error = "missing_binder_chain_atoms"
    binder_plddt_values = [v for chain in binder_chains for v in bvals.get(chain, [])]
    target_plddt_values = bvals.get(target_chain, [])
    contacts, hotspot_n = min_contact_count(residues, binder_chains, target_chain, hotspots, contact_cutoff)
    iptm = to_float(conf.get("iptm"), 0.0)
    ptm = to_float(conf.get("ptm"), 0.0)
    ranking = to_float(conf.get("ranking_score"), row["ranking_score"])
    hotspot_prob = contacts / hotspot_n if hotspot_n else 0.0
    interface_proxy = max(0.0, (1.0 - iptm) * 30.0)
    if mapping_error:
        decision = "FAIL_hotspot_mapping"
    elif iptm >= 0.5 and hotspot_prob >= 0.5:
        decision = "PASS"
    elif iptm >= 0.3 or hotspot_prob >= 0.75:
        decision = "REVIEW"
    else:
        decision = "FAIL_low_interface_confidence"
    return {
        "design": row["design"],
        "design_dir": str(row["confidence_path"].parent.parent.parent),
        "decision": decision,
        "screen_score": f"{(iptm + hotspot_prob) / 2:.3f}",
        "iptm": f"{iptm:.3f}",
        "ptm": f"{ptm:.3f}",
        "ranking_score": f"{ranking:.3f}",
        "interface_confidence_proxy": f"{interface_proxy:.2f}",
        "hotspot_contact_res_n": str(contacts),
        "hotspot_n": str(hotspot_n),
        "hotspot_sequence_positions": ",".join(f"{chain}{resnum}" for chain, resnum in hotspots),
        "hotspot_mapping_error": mapping_error,
        "hotspot_prob": f"{hotspot_prob:.3f}",
        "binder_chain": ",".join(binder_chains),
        "target_chain": target_chain,
        "binder_tokens": str(sum(lengths.get(chain, 0) for chain in binder_chains)),
        "target_tokens": str(lengths.get(target_chain, 0)),
        "binder_plddt_mean": f"{mean(binder_plddt_values):.1f}" if binder_plddt_values else "",
        "target_plddt_mean": f"{mean(target_plddt_values):.1f}" if target_plddt_values else "",
        "best_sample": str(row["confidence_path"].parent.name),
        "protenix_model_cif": str(row["model_cif"]),
        "confidence_json": str(row["confidence_path"]),
    }


def write_report(rows: list[dict], path: Path) -> None:
    counts = Counter(row["decision"] for row in rows)
    ranked = sorted(rows, key=lambda row: (-to_float(row["screen_score"], 0), row["design"]))
    with path.open("w", encoding="utf-8") as handle:
        handle.write("# Protenix Preliminary Screening Report\n\n")
        handle.write(f"Analyzed designs: {len(rows)}\n\n")
        for key in ["PASS", "REVIEW", "FAIL_low_interface_confidence", "FAIL_hotspot_mapping", "FAIL_clash"]:
            handle.write(f"- {key}: {counts.get(key, 0)}\n")
        handle.write("\n## Top Candidates\n\n")
        handle.write("| rank | design | decision | score | iptm | rank_score | interface_proxy | hotspot_contacts | hotspot_prob | binder_plddt | target_plddt |\n")
        handle.write("|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n")
        for i, row in enumerate(ranked[:25], 1):
            handle.write(
                f"| {i} | {row['design']} | {row['decision']} | {row['screen_score']} | {row['iptm']} | "
                f"{row['ranking_score']} | {row['interface_confidence_proxy']} | "
                f"{row['hotspot_contact_res_n']}/{row['hotspot_n']} | {row['hotspot_prob']} | "
                f"{row['binder_plddt_mean']} | {row['target_plddt_mean']} |\n"
            )
        handle.write("\n## Screening Logic\n\n")
        handle.write("This is a preliminary Protenix screen. MindScience Protenix summary confidence is used for ipTM/ranking; ")
        handle.write("the interface column is a compatibility proxy derived from ipTM, not a pairwise-error matrix.\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protenix-root", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--hotspots", default="")
    parser.add_argument("--target-pdb", type=Path)
    parser.add_argument("--contact-cutoff", type=float, default=8.0)
    args = parser.parse_args()
    rows = [screen_one(row, args.protenix_root, args.hotspots, args.contact_cutoff, args.target_pdb) for row in best_rows(args.protenix_root)]
    args.out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.out_dir / "protenix_screening_summary.csv"
    md_path = args.out_dir / "protenix_screening_report.md"
    fieldnames = list(rows[0].keys()) if rows else ["design", "decision"]
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    write_report(rows, md_path)
    print(f"Analyzed {len(rows)} designs")
    print(f"Wrote {csv_path}")
    print(f"Wrote {md_path}")
    if not rows:
        return 2
    if all(row.get("hotspot_mapping_error") for row in rows):
        errors = sorted({row.get("hotspot_mapping_error", "") for row in rows if row.get("hotspot_mapping_error")})
        print("error: all designs failed hotspot mapping: " + "; ".join(errors), file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
