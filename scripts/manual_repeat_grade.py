#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Offline repeat-grade for Yi-authorized Manual #346 inputs (2 answers × N repeats).

Supports official or registered local-variant rubrics. For #346 local-rubric-v1
measurement, da-13-3 uses --local-variant; da-14-1 stays official (no local pin).
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
JUDGE = ROOT / "test/benchmarks/biomnibench-da/judge.py"
sys.path.insert(0, str(JUDGE.parent))
from rubrics import local_rubric_path, local_variant_for, rubric_identity  # noqa: E402


def summarize(cards: list[dict]) -> dict:
    scored = [c for c in cards if c.get("status") == "scored"]
    criteria: dict = {}
    if scored:
        for number in scored[0].get("criteria", {}):
            sequence = [
                c["criteria"][number]["level"] if c.get("status") == "scored" else None
                for c in cards
            ]
            valid = [x for x in sequence if x is not None]
            adjacent = [(a, b) for a, b in zip(sequence, sequence[1:]) if a and b]
            pairs = [(a, b) for i, a in enumerate(valid) for b in valid[i + 1 :]]
            criteria[number] = {
                "levels": sequence,
                "counts": dict(Counter(valid)),
                "adjacent_changes": sum(a != b for a, b in adjacent),
                "adjacent_comparisons": len(adjacent),
                "pair_disagreements": sum(a != b for a, b in pairs),
                "pair_comparisons": len(pairs),
            }
    scores = [c.get("score") if c.get("status") == "scored" else None for c in cards]
    valid_scores = [x for x in scores if x is not None]
    return {
        "planned": len(cards),
        "scored": len(scored),
        "failed": len(cards) - len(scored),
        "scores": scores,
        "score_range": [min(valid_scores), max(valid_scores)] if valid_scores else None,
        "criteria": criteria,
    }


def render(report: dict) -> str:
    channel = report.get("rubric_channel", "mixed")
    lines = [
        f"# Offline {channel} repeat grading (Manual new traces)",
        "",
        f"Status: {report['status']}; judge: {report['model']}; temperature: 0.",
        "Source: Manual validation run 40819738668 (research-9=da-13-3, research-12=da-14-1).",
        "Not the original eight historical pairs. No research rerun.",
        f"Mode: {report.get('mode')}; da-13-3 channel={report.get('da_13_3_channel')}; "
        f"da-14-1 channel={report.get('da_14_1_channel')}.",
        "",
        "| Answer | Case | Channel | Scored / planned | Scores | Range |",
        "|---|---|---|---|---|---|",
    ]
    for row in report["answers"]:
        lines.append(
            f"| {row['id']} | {row['case_id']} | {row.get('rubric_channel')} | "
            f"{row['scored']} / {row['planned']} | "
            f"{row['scores']} | {row['score_range']} |"
        )
    lines += [
        "",
        "| Answer | Criterion | Levels | Adjacent changes | Pair disagreements |",
        "|---|---|---|---|---|",
    ]
    for row in report["answers"]:
        for number, criterion in row["criteria"].items():
            lines.append(
                f"| {row['id']} | {number} | {criterion['levels']} | "
                f"{criterion['adjacent_changes']}/{criterion['adjacent_comparisons']} | "
                f"{criterion['pair_disagreements']}/{criterion['pair_comparisons']} |"
            )
    return "\n".join(lines) + "\n"


def resolve_rubric(case_id: str, data_root: Path, prefer_local: bool) -> tuple[Path, dict, bool]:
    """Return (rubric_path, identity, use_local_flag)."""
    if prefer_local:
        variant = local_variant_for(case_id)
        if not variant:
            raise SystemExit(f"No local rubric registered for {case_id}")
        path = local_rubric_path(case_id)
        identity = rubric_identity(path, case_id)
        if identity["channel"] != "local-variant":
            raise SystemExit(f"Expected local-variant identity for {case_id}")
        return path, identity, True
    path = (data_root / case_id / "tests/rubric.txt").resolve()
    if not path.is_file():
        raise SystemExit(f"Missing official rubric: {path}")
    identity = rubric_identity(path, case_id)
    if identity["channel"] != "official":
        raise SystemExit(f"Expected official rubric for {case_id}, got {identity}")
    return path, identity, False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument(
        "--local-for",
        default="da-13-3",
        help="Comma-separated case_ids to grade with registered local-variant (default: da-13-3)",
    )
    args = parser.parse_args()
    if args.repeats < 3:
        raise SystemExit("--repeats must be >= 3")
    for name in ("BIOMNI_JUDGE_MODEL", "BIOMNI_JUDGE_BASE_URL", "BIOMNI_JUDGE_API_KEY"):
        if not os.environ.get(name):
            raise SystemExit(f"Missing {name}")
    if not JUDGE.is_file():
        raise SystemExit(f"Missing judge.py at {JUDGE}")
    local_cases = {c.strip() for c in args.local_for.split(",") if c.strip()}
    manifest = json.loads(args.inputs.read_text())
    rows = manifest["answers"]
    if len(rows) != 2 or {r["case_id"] for r in rows} != {"da-13-3", "da-14-1"}:
        raise SystemExit("Expected exactly one Manual answer each for da-13-3 and da-14-1")
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    report = {
        "status": "running",
        "mode": "manual-offline-local-repeat-grade",
        "full_e2e_rerun": False,
        "source_run": manifest.get("source_run"),
        "note": manifest.get("note"),
        "temperature": 0,
        "model": os.environ["BIOMNI_JUDGE_MODEL"],
        "repeats": args.repeats,
        "local_for": sorted(local_cases),
        "da_13_3_channel": "local-variant" if "da-13-3" in local_cases else "official",
        "da_14_1_channel": "local-variant" if "da-14-1" in local_cases else "official",
        "rubric_channel": "local-variant+official",
        "answers": [],
    }
    base = args.inputs.resolve().parent
    for row in rows:
        evidence = (base / row["evidence"]).resolve()
        prefer_local = row["case_id"] in local_cases
        rubric_path, identity, use_local = resolve_rubric(
            row["case_id"], args.data_root.resolve(), prefer_local
        )
        files = {name: (evidence / name).read_bytes() for name in ("trace.md", "answer.txt")}
        if any(not content.strip() for content in files.values()):
            raise SystemExit(f"Empty saved input: {row['id']}")
        root = out / row["id"]
        root.mkdir()
        (root / "rubric.txt").write_bytes(rubric_path.read_bytes())
        (root / "rubric-identity.json").write_text(json.dumps(identity, indent=2) + "\n")
        for name, content in files.items():
            (root / name).write_bytes(content)
        cards: list[dict] = []
        for index in range(1, args.repeats + 1):
            attempt = root / f"repeat-{index:02}"
            attempt.mkdir()
            scorecard = attempt / "quality-scorecard.json"
            log_path = attempt / "judge.log"
            cmd = [
                sys.executable,
                str(JUDGE),
            ]
            if use_local:
                cmd.append("--local-variant")
            cmd += [
                "--case",
                row["case_id"],
                "--rubric",
                str(root / "rubric.txt"),
                "--trace",
                str(root / "trace.md"),
                "--answer",
                str(root / "answer.txt"),
                "--output",
                str(scorecard),
            ]
            with log_path.open("w") as log:
                try:
                    proc = subprocess.run(
                        cmd,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        timeout=3900,
                        cwd=str(JUDGE.parent),
                    )
                    if scorecard.exists():
                        card = json.loads(scorecard.read_text())
                        if proc.returncode and card.get("status") != "scored":
                            card = {"status": "error", "exit_code": proc.returncode, "card": card}
                    else:
                        card = {
                            "status": "error",
                            "exit_code": proc.returncode,
                            "error": "missing scorecard",
                        }
                except (OSError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
                    card = {"status": "error", "error_type": type(exc).__name__, "error": str(exc)}
            cards.append(card)
        report["answers"].append(
            {
                "id": row["id"],
                "case_id": row["case_id"],
                "rubric_channel": identity["channel"],
                "rubric": identity,
                "source_artifact": row.get("source_artifact"),
                "baseline_scorecard_score": row.get("baseline_scorecard_score"),
                "artifact_sha256": {
                    name: hashlib.sha256(content).hexdigest() for name, content in files.items()
                },
                **summarize(cards),
            }
        )
        (out / "repeat-grade.json").write_text(json.dumps(report, indent=2) + "\n")
    report["status"] = "complete" if all(r["failed"] == 0 for r in report["answers"]) else "incomplete"
    (out / "repeat-grade.json").write_text(json.dumps(report, indent=2) + "\n")
    (out / "repeat-grade.md").write_text(render(report))
    print(json.dumps({"status": report["status"], "answers": len(report["answers"]), "repeats": args.repeats,
                      "local_for": sorted(local_cases)}))
    return 0 if report["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
