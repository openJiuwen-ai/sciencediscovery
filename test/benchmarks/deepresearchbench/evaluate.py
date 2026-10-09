#!/usr/bin/env python3
"""Pinned upstream RACE/FACT runner. Never treat missing evaluation as a pass."""
import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from race_contract import ContractClient, VERSION as CONTRACT_VERSION

UPSTREAM_COMMIT = "852f4022d1f98fb707222e395405136e8f0e8d52"
DIMS = ("comprehensiveness", "insight", "instruction_following", "readability")


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def fact_metrics(groups):
    counts = dict(supported=0, unsupported=0, unknown=0)
    for group in groups.values():
        facts = group["facts"]
        results = group.get("validate_res", [])
        if group.get("validate_error"):
            counts["unknown"] += len(facts)
            continue
        if sorted(r["idx"] for r in results) != list(range(len(facts))):
            raise ValueError("FACT omitted or duplicated statement indices")
        for result in results:
            if result["result"] not in counts:
                raise ValueError("Unknown FACT verdict")
            counts[result["result"]] += 1
    checked = counts["supported"] + counts["unsupported"]
    total = checked + counts["unknown"]
    return {**counts, "total": total, "effective_citations": counts["supported"],
            "citation_accuracy": 100 * counts["supported"] / checked if checked else None,
            "verification_coverage": 100 * checked / total if total else 0}


def validate_race(raw, criteria):
    for dim in DIMS:
        expected = [c["criterion"] for c in criteria["criterions"][dim]]
        rows = raw.get(dim, [])
        if sorted(r["criterion"] for r in rows) != sorted(expected):
            raise ValueError(f"RACE missing/duplicate criteria: {dim}")
        for row in rows:
            for field in ("article_1_score", "article_2_score"):
                score = row[field]
                if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 10:
                    raise ValueError("Invalid RACE score")


def gate(result, thresholds):
    if result.get("race", {}).get("status") != "completed":
        return "blocked"
    if result["race"]["overall_score"] * 100 < thresholds["race"]:
        return "failed"
    if result.get("fact", {}).get("status") != "completed":
        return "partial"
    fact = result["fact"]
    if (fact["citation_accuracy"] is None or fact["citation_accuracy"] < thresholds["fact"]
            or fact["verification_coverage"] < thresholds["coverage"] or fact["effective_citations"] < 1):
        return "failed"
    return "passed"


def preflight(upstream, mode):
    commit = subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip()
    if commit != UPSTREAM_COMMIT:
        raise ValueError("Unexpected upstream revision; review evaluator changes before updating the pin")
    dirty = subprocess.check_output(["git", "-C", str(upstream), "diff", "HEAD", "--", "utils", "prompt", "data", "deepresearch_bench_race.py"], text=True)
    if dirty:
        raise ValueError("Upstream evaluator/data have tracked modifications")
    backend = os.environ.get("LLM_BACKEND", "openrouter")
    required = ["OPENAI_API_KEY" if backend == "openai" else "OPENROUTER_API_KEY"]
    if backend not in ("openai", "openrouter"):
        raise ValueError("LLM_BACKEND must be openai or openrouter")
    if mode == "full":
        required.append("JINA_API_KEY")
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        raise ValueError("Missing evaluation credentials: " + ", ".join(missing))
    sys.path.insert(0, str(upstream))
    import requests, tqdm  # noqa: F401 — fail before the costly agent run
    from utils import api
    return api


def evaluate(args, result):
    result["race"] = {"status": "running"}
    result["fact"] = {"status": "pending"} if args.mode == "full" else {"status": "skipped", "reason": "FACT disabled by race-only configuration"}
    result["scoring_contract"] = CONTRACT_VERSION
    api = preflight(args.upstream, args.mode)
    from utils.clean_article import ArticleCleaner
    from utils.json_extractor import extract_json_from_markdown
    from deepresearch_bench_race import process_single_item
    from tqdm import tqdm
    source = json.loads(args.input.read_text())
    def row(relative):
        return next(json.loads(line) for line in (args.upstream / relative).read_text().splitlines()
                    if str(json.loads(line)["id"]) == str(source["id"]))
    task = row("data/prompt_data/query.jsonl")
    criteria = row("data/criteria_data/criteria.jsonl")
    reference = row("data/test_data/cleaned_data/reference.jsonl")
    if source["prompt"] != task["prompt"] or not source["article"].strip():
        raise ValueError("Input must carry the exact original benchmark prompt and a non-empty report")
    result.update(case_id=source["id"], report_sha256=hashlib.sha256(source["article"].encode()).hexdigest(),
                  judges={"race": api.Model, "clean": api.CLEAN_Model, "fact": api.FACT_Model},
                  judge_backend=api.LLM_BACKEND, upstream_commit=UPSTREAM_COMMIT,
                  reference_sha256=hashlib.sha256(reference["article"].encode()).hexdigest())
    # These details are needed to compare runs. Do not persist endpoints or credentials.
    write(args.output / "criteria.json", criteria)
    write(args.output / "reference.json", reference)
    original_client = api.AIClient
    calls = []
    class RecordedClient(original_client):
        def _post(self, payload):
            response = super()._post(payload)
            write(args.output / f"judge-response-{len(calls)+1}.json", response)
            self.last_usage = response.get("usage")
            return response
        def generate(self, user_prompt, system_prompt="", **kwargs):
            number = len(calls) + 1
            started = time.monotonic()
            print(f"Judge call {number}: {self.model}", flush=True)
            write(args.output / f"judge-input-{number}.json", {"model": self.model, "prompt": user_prompt, "system": system_prompt})
            answer = super().generate(user_prompt, system_prompt, **kwargs)
            record = {"model": self.model, "seconds": time.monotonic() - started,
                      "usage": getattr(self, "last_usage", None), "answer": answer}
            calls.append(record)
            write(args.output / f"judge-output-{number}.json", record)
            result["judge_calls"] = [{k: v for k, v in c.items() if k != "answer"} for c in calls]
            write(args.output / "scorecard.json", result)
            return answer
    api.AIClient = RecordedClient
    # Imported FACT call_model uses api.AIClient dynamically, retaining official prompts.
    clean = ArticleCleaner(RecordedClient(model=api.CLEAN_Model)).clean_single(source, language=task["language"])
    if not clean or clean.get("error"):
        raise ValueError("RACE cleaning failed")
    write(args.output / "cleaned.json", clean)
    race = process_single_item(task, {task["prompt"]: clean}, {task["prompt"]: reference},
                               {task["prompt"]: criteria}, ContractClient(RecordedClient(model=api.Model), criteria,
                                   extract_json_from_markdown, lambda name, value: write(args.output / name, value)),
                               threading.Lock(), tqdm(total=1), 1, task["language"])
    if race.get("error"):
        raise ValueError("RACE evaluation failed; inspect judge artifacts")
    validate_race(json.loads((args.output / "race-normalized.json").read_text()), criteria)
    result["race"] = {**race, "status": "completed"}
    write(args.output / "scorecard.json", result)
    if args.mode != "full":
        return
    result["fact"] = {"status": "running"}
    from utils import extract, deduplicate, validate
    lang = {task["id"]: task["language"]}
    extract.run([source], str(args.output / "extracted.jsonl"), lang)
    if not isinstance(source.get("citations"), list):
        raise ValueError("FACT extraction failed")
    deduplicate.run([source], str(args.output / "deduplicated.jsonl"), lang)
    groups = source.get("citations_deduped")
    if not isinstance(groups, dict):
        raise ValueError("FACT deduplication failed")
    import requests
    for url, group in groups.items():
        # Same Jina request/content format as upstream, with a finite timeout.
        # A fetch error is unknown, never a successful citation or a fabricated zero.
        try:
            if not url.startswith(("https://", "http://")):
                raise ValueError("Invalid citation URL")
            response = requests.get(f"https://r.jina.ai/{url}", headers={
                "Accept": "application/json", "Authorization": api.READ_API_KEY,
                "X-Timeout": "60000", "X-With-Generated-Alt": "true"}, timeout=(15, 90))
            response.raise_for_status()
            data = response.json()["data"]
            if not data.get("content", "").strip():
                raise ValueError("Empty source")
            group["url_content"] = "\n\n".join(data.get(k, "") or "" for k in ("title", "description", "content"))
            group["article_id"] = task["id"]
            verdict = validate.validate((url, group), lang)
            group.update(validate_res=verdict["validate_res"], validate_error=verdict["error"])
        except Exception as error:
            group.update(validate_res=[], validate_error=type(error).__name__)
        write(args.output / "validated.json", source)
    result["fact"] = {"status": "completed", **fact_metrics(groups)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--mode", choices=["race", "full"], default="full")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--min-race", type=float, default=40)
    parser.add_argument("--min-fact", type=float, default=70)
    parser.add_argument("--min-coverage", type=float, default=80)
    args = parser.parse_args()
    args.upstream = args.upstream.resolve()
    if any(not math.isfinite(v) or not 0 <= v <= 100 for v in (args.min_race, args.min_fact, args.min_coverage)):
        parser.error("Quality thresholds must be in [0, 100]")
    if args.preflight:
        preflight(args.upstream, args.mode)
        print("Evaluation preflight passed")
        return 0
    if not args.input or not args.output:
        parser.error("--input and --output are required")
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False)  # Never reuse cached scores from another attempt.
    started = time.monotonic()
    thresholds = {"race": args.min_race, "fact": args.min_fact, "coverage": args.min_coverage}
    result = {"schema_version": 1, "status": "running", "mode": args.mode, "thresholds": thresholds,
              "race": {"status": "not_run"}, "fact": {"status": "not_run"}, "judge_calls": []}
    try:
        with (args.output / "evaluator.log").open("w") as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            evaluate(args, result)
        result["status"] = gate(result, thresholds)
    except Exception as error:
        result.update(status="error", error_type=type(error).__name__)
        for phase in ("race", "fact"):
            if result[phase]["status"] == "running":
                result[phase] = {"status": "error", "error_type": type(error).__name__}
            elif result[phase]["status"] in ("pending", "not_run"):
                result[phase] = {"status": "skipped", "reason": "Prerequisite evaluation failed"}
        # Keep detailed failures in a private local artifact, not the public scorecard.
        detail = str(error)
        for name, secret in os.environ.items():
            if any(word in name for word in ("KEY", "TOKEN", "SECRET")) and len(secret) >= 8:
                detail = detail.replace(secret, "[redacted]")
        diagnostic = args.output / "evaluation-error.json"
        with diagnostic.open("w") as stream:
            os.chmod(diagnostic, 0o600)
            json.dump({"error_type": type(error).__name__, "error": detail}, stream, indent=2)
        result["error_artifact"] = diagnostic.name
    finally:
        result["duration_seconds"] = time.monotonic() - started
        write(args.output / "scorecard.json", result)
    print(json.dumps({"status": result["status"], "output": str(args.output)}))
    return 0 if result["status"] == "passed" or (args.mode == "race" and result["status"] == "partial") else 1


if __name__ == "__main__":
    raise SystemExit(main())
