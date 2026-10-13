# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Official DRB II prompts and rubric matching, with bounded transport and strict completeness."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import re
from collections import Counter


def parse_model_text(text):
    # Upstream's key-repair regex can corrupt valid compact JSON. Never rewrite strings.
    candidate = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*([\s\S]*?)\s*```", candidate)
    try:
        return json.loads(fenced.group(1) if fenced else candidate), True
    except (ValueError, TypeError):
        return None, False


def validate_batch(expected, parsed):
    rows = parsed.get("results") if isinstance(parsed, dict) else None
    return (isinstance(rows, list) and all(isinstance(r, dict) for r in rows)
            and Counter(r.get("rubric_item") for r in rows) == Counter(expected)
            and all(type(r.get("score")) is int and r["score"] in (-1, 0, 1)
                    and isinstance(r.get("reason"), str) and isinstance(r.get("evidence"), str) for r in rows))


def summarize(scores, rubric):
    dimensions = {}
    for name, expected in rubric.items():
        actual = scores.get(name, {})
        if set(actual) != set(expected):
            raise ValueError(f"Missing, duplicate or unexpected rubric items: {name}")
        values = [row.get("score") for row in actual.values()]
        if any(type(v) is not int or v not in (-1, 0, 1) for v in values):
            raise ValueError("Invalid rubric score")
        dimensions[name] = {"items": len(values), "passed": values.count(1), "blocked": values.count(-1)}
    total = sum(v["items"] for v in dimensions.values())
    if not total:
        raise ValueError("Empty rubric")
    return {"dimensions": dimensions, "items": total, "raw_items": sum(len(v) for v in rubric.values()),
            "overall_score": 100 * sum(v["passed"] for v in dimensions.values()) / total,
            "blocked_rate": 100 * sum(v["blocked"] for v in dimensions.values()) / total}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--id", type=int, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    result = {"status": "error", "judge_model": os.environ.get("E2E_JUDGE_MODEL"),
              "leaderboard_comparable": False, "calls": []}
    try:
        # Caller verifies pinned hashes before starting; verify again before importing code.
        import subprocess
        subprocess.run(["node", str(Path(__file__).with_name("verify.mjs")), str(args.upstream)], check=True)
        sys.path.insert(0, str(args.upstream))
        import run_evaluation as official
        from gpt_client import GPTOutput
        import requests
        task = next(json.loads(line) for line in (args.upstream / "tasks_and_rubrics.jsonl").read_text().splitlines()
                    if json.loads(line)["idx"] == args.id)
        result["report_sha256"] = hashlib.sha256(args.report.read_bytes()).hexdigest()
        result["license"] = task["license"]
        style = os.environ.get("DRB2_JUDGE_API_STYLE", "openai")
        if style not in ("openai", "deepseek"):
            raise ValueError("DRB2_JUDGE_API_STYLE must be openai or deepseek")
        budget = int(os.environ.get("DRB2_JUDGE_MAX_OUTPUT_TOKENS", "32768"))
        if not 1024 <= budget <= 65536:
            raise ValueError("Judge output budget must be in 1024..65536")
        result.update(api_style=style, max_output_tokens=budget)

        class Client:
            def query(self, input_data):
                nonlocal budget
                payload = {"model": os.environ["E2E_JUDGE_MODEL"], "messages": [{"role": "user", "content": input_data.text}],
                           "stream": False, ("max_tokens" if style == "deepseek" else "max_completion_tokens"): budget}
                call = {"started_at": time.time(), "max_output_tokens": budget}
                tick = time.monotonic()
                try:
                    response = requests.post(os.environ["E2E_JUDGE_BASE_URL"].rstrip("/") + "/chat/completions",
                        headers={"Authorization": "Bearer " + os.environ["E2E_JUDGE_TOKEN"]},
                        json=payload, timeout=(30, 600), allow_redirects=False)
                    call["http_status"] = response.status_code
                    if response.status_code != 200:
                        raise ValueError(f"Judge HTTP {response.status_code}")
                    body = response.json()
                    call["usage"] = body.get("usage")
                    choice = body["choices"][0]
                    call["finish_reason"] = choice.get("finish_reason")
                    if choice.get("finish_reason") == "length":
                        budget = min(budget * 2, 65536)
                        raise ValueError("Judge output truncated")
                    if choice.get("finish_reason") != "stop" or not choice["message"].get("content"):
                        raise ValueError("Judge did not finish a nonempty response")
                    usage = body.get("usage", {})
                    return GPTOutput(text=choice["message"]["content"], usage_metadata={
                        "promptTokenCount": usage.get("prompt_tokens", 0),
                        "candidatesTokenCount": usage.get("completion_tokens", 0),
                        "totalTokenCount": usage.get("total_tokens", 0)}, raw_response=body)
                except Exception as error:
                    call["error_type"] = type(error).__name__
                    raise ValueError("Judge request failed; see judge-calls.jsonl") from None
                finally:
                    call["duration_seconds"] = time.monotonic() - tick
                    result["calls"].append(call)
                    with (args.output / "judge-calls.jsonl").open("a") as handle:
                        handle.write(json.dumps(call) + "\n")

        official.client = Client()
        official.parse_model_text = parse_model_text
        # Validate multiplicity before upstream's text-keyed output merges duplicates.
        official.validate_batch_result = validate_batch
        _, raw, _ = official.process_one_with_chunking(args.id, str(args.report), task["content"],
            chunk_size=15, max_paper_chars=max(150000, len(args.report.read_text())), max_retries=3)
        (args.output / "rubric-results.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2))
        if "error" in raw:
            raise ValueError(raw["error"])
        result.update(summarize(raw["scores"], task["content"]["rubric"]))
        result["status"] = "completed"
    except Exception as error:
        result["error"] = str(error) if isinstance(error, ValueError) else type(error).__name__
    finally:
        result["duration_seconds"] = time.monotonic() - started
        (args.output / "scorecard.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
