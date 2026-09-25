#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Read-only, offline TC quality judge. Run on retained evidence; never gate delivery."""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request

VERSION = "tc-research-quality-v1"
WEIGHTS = dict(A=20, B=25, C=25, D=15, E=15)
TOOLS = [{"type": "function", "function": {"name": "read_evidence", "description": "Read a registered frozen document, by zero-based character offset; no code execution or network access.", "parameters": {"type": "object", "properties": {"file": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}}, "required": ["file"]}}},
         {"type": "function", "function": {"name": "search_evidence", "description": "Literal search in one registered frozen document, up to five matches.", "parameters": {"type": "object", "properties": {"file": {"type": "string"}, "query": {"type": "string"}}, "required": ["file", "query"]}}}]


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    with open(path, "w", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def normalize_score(raw, identities):
    if raw.get("rubric_version") != VERSION or raw.get("status") not in ("scored", "insufficient_evidence"):
        raise ValueError("Invalid rubric version/status")
    if set(raw.get("dimensions", {})) != set(WEIGHTS):
        raise ValueError("Exactly dimensions A through E are required")
    for key in ("evaluated_artifacts", "critical_findings", "verification_scope", "summary"):
        if key not in raw:
            raise ValueError(f"Missing {key}")
    if not raw["evaluated_artifacts"] or not raw["verification_scope"] or not raw["summary"]:
        raise ValueError("Missing evaluated artifacts or verification scope/summary")
    allowed = {(v["artifact_id"], v["version_id"]) for v in identities.values()}
    for artifact in raw["evaluated_artifacts"]:
        if (artifact.get("artifact_id"), artifact.get("version_id")) not in allowed:
            raise ValueError("Judge cited an unknown artifact/version")
    result = json.loads(json.dumps(raw))
    total, unknown = 0, False
    for key, weight in WEIGHTS.items():
        dim = result["dimensions"][key]
        for field in ("reason", "evidence", "defects", "uncertainties"):
            if field not in dim:
                raise ValueError(f"Missing {key}.{field}")
        if not dim["reason"] or not dim["evidence"]:
            raise ValueError(f"Missing evidence/reason for {key}")
        level = dim.get("level")
        if level is None and raw["status"] == "insufficient_evidence":
            dim["score"] = None
            unknown = True
        elif type(level) is int and 0 <= level <= 4:
            dim["score"] = level * weight / 4
            total += dim["score"]
        else:
            raise ValueError(f"Invalid level for {key}")
    result["total_score"] = None if unknown or raw["status"] == "insufficient_evidence" else total
    result["gating"] = False
    result["score_calculation"] = "Computed from unchanged judge levels and fixed rubric weights; raw response retained."
    return result


def audit_comparison(report, calls):
    text = report["text"].replace("\r\n", "\n")
    result = {"method": "Deterministic text comparison only; no severity judgement. Normalize CRLF to LF, preserve all other characters.",
              "artifact_id": report["id"], "version_id": report["version"], "calls": []}
    for index, call in enumerate(calls):
        submitted = call.get("report_text", "").replace("\r\n", "\n")
        diff = list(difflib.unified_diff(submitted.splitlines(), text.splitlines(), fromfile="MCP_input", tofile="final_artifact", n=0))
        result["calls"].append({"index": index, "exact_match": submitted == text, "submitted_characters": len(submitted), "final_characters": len(text),
                                "result": call.get("result"), "diff_excerpt": "\n".join(diff)[:12000], "diff_truncated": len("\n".join(diff)) > 12000})
    return result


def load_evidence(directory):
    def read(name):
        return json.loads((directory / name).read_text())
    metrics, artifacts, children, calls = [read(n) for n in ("team-metrics.json", "team-artifacts.json", "team-children.json", "signoff-calls.json")]
    delivery = metrics.get("delivery", {})
    names = [a["logicalName"] for a in delivery.get("artifacts", []) if a["logicalName"] in artifacts]
    # Retained pre-refactor TC exports always used this report name. New runs use final handoff identities.
    if not names and "delivery" not in metrics and "evidence_brief.md" in artifacts:
        names = ["evidence_brief.md"]
    reports = [n for n in names if n.lower().endswith((".md", ".txt"))]
    preferred = [n for n in reports if n.split("/")[-1] == "evidence_brief.md"]
    report_name = preferred[0] if len(preferred) == 1 else reports[0] if len(reports) == 1 else None
    if report_name is None:
        raise ValueError("No unambiguous final text report for quality evaluation")
    docs = {"artifact/" + k: v["text"] for k, v in artifacts.items()}
    overview = []
    for child in children:
        docs[f'child/{child["id"]}.json'] = json.dumps(child, ensure_ascii=False, indent=2)
        overview.append({k: child.get(k) for k in ("id", "specialistId", "status", "createdAt", "finishedAt", "input")})
    docs["children-overview.json"] = json.dumps(overview, ensure_ascii=False, indent=2)
    docs["signoff-calls.json"] = json.dumps(calls, ensure_ascii=False, indent=2)
    docs["final-answer.txt"] = delivery.get("answer", "Final response was not retained in this older evidence export.")
    identities = {"artifact/" + k: {"artifact_id": v["id"], "version_id": v["version"], "sha256": hashlib.sha256(v["text"].encode()).hexdigest(), "characters": len(v["text"])} for k, v in artifacts.items()}
    initial = {k: v for k, v in docs.items() if k == "artifact/" + report_name or k.endswith(("knowledge_summary.md", "analysis_summary.md", "analysis_results.json")) or "evaluation" in k and k.endswith(".json")}
    # Explicit excerpts when unusually large; remaining text is accessible via the read-only tools.
    initial = {k: {"text": v[:60000], "characters": len(v), "truncated": len(v) > 60000} for k, v in initial.items()}
    facts = audit_comparison(artifacts[report_name], calls)
    payload = {"original_task": metrics["prompt"], "workflow_requirements": metrics["configuration"]["skill"]["instructions"],
               "final_report": "artifact/" + report_name, "final_answer": docs["final-answer.txt"], "artifact_versions": identities,
               "documents": {k: len(v) for k, v in docs.items()}, "initial_documents": initial, "audit_comparison": facts}
    return docs, identities, payload


def read_tool(docs, name, args):
    text = docs[args["file"]]  # Registry only: never read an arbitrary filesystem path.
    if name == "read_evidence":
        offset, limit = args.get("offset", 0), args.get("limit", 16000)
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 30000:
            raise ValueError("Invalid read range (limit 1..30000)")
        return {"file": args["file"], "offset": offset, "total_characters": len(text), "text": text[offset:offset + limit],
                "next_offset": offset + limit if offset + limit < len(text) else None}
    if name == "search_evidence":
        query = args["query"]
        if not isinstance(query, str) or not query or len(query) > 2000:
            raise ValueError("Invalid literal query")
        matches, pos = [], 0
        for _ in range(5):
            index = text.find(query, pos)
            if index < 0:
                break
            matches.append({"offset": index, "text": text[max(0, index - 800):index + len(query) + 1400]})
            pos = index + len(query)
        return {"file": args["file"], "matches": matches}
    raise ValueError("Unknown read-only tool")


def evaluate(directory, output, request, rounds=20):
    docs, identities, payload = load_evidence(directory)
    write(output / "evidence-manifest.json", identities)
    write(output / "audit-comparison.json", payload["audit_comparison"])
    rubric = Path(__file__).with_name(VERSION + ".txt").read_text()
    messages = [{"role": "system", "content": rubric}, {"role": "user", "content": "独立评审以下冻结证据。可用只读工具抽查源数据、代码、交接和执行记录；不联网、不执行代码。必须说明抽查范围。最终 evaluated_artifacts 使用 artifact_id/version_id；dimensions 使用 A/B/C/D/E 键，level 为0–4整数，未知为null。每项包含 reason/evidence/defects/uncertainties。分数由程序依既定权重计算，不要把自述当作核实。\n" + json.dumps(payload, ensure_ascii=False)}]
    reads, read_chars, sequence = [], 0, 0
    def call(final=False):
        nonlocal sequence
        sequence += 1
        body = {"messages": messages, "tools": TOOLS, "max_tokens": 32768, "temperature": 0}
        if final:
            body.update(tool_choice="none", response_format={"type": "json_object"})
        raw = request(body)
        write(output / f"response-{sequence:02}.json", raw)
        choice = raw["choices"][0]
        if choice.get("finish_reason") == "length":
            raise ValueError("Judge output truncated; inspect retained finish_reason and usage")
        return choice["message"]
    # Bounded read-only exploration. End by constraining tool choice, not removing tools
    # (some providers otherwise emit textual tool markup instead of a final JSON result).
    for _ in range(rounds):
        msg = call()
        tools = msg.get("tool_calls") or []
        if not tools:
            try:
                return normalize_score(json.loads(msg.get("content", "")), identities)
            except (ValueError, KeyError, TypeError):
                break
        messages.append(msg)
        for tool in tools:
            try:
                if read_chars >= 500000:
                    raise ValueError("Evidence read budget reached; disclose remaining uncertainty")
                result = read_tool(docs, tool["function"]["name"], json.loads(tool["function"]["arguments"]))
                read_chars += len(json.dumps(result))
            except (ValueError, KeyError, TypeError) as exc:
                result = {"error": str(exc)}
            reads.append({"round": sequence, "call": tool, "result": result})
            write(output / "evidence-reads.json", reads)
            messages.append({"role": "tool", "tool_call_id": tool["id"], "content": json.dumps(result, ensure_ascii=False)})
        if read_chars >= 500000:
            break
    for attempt in range(2):
        messages.append({"role": "user", "content": "证据查阅结束。仅返回规定的完整JSON对象，不再调用工具。根据实际核实范围评分并说明未核实事项。"})
        msg = call(final=True)
        try:
            return normalize_score(json.loads(msg.get("content", "")), identities)
        except (ValueError, KeyError, TypeError) as exc:
            if attempt:
                raise ValueError(f"Invalid final score after bounded retry: {exc}") from exc
            messages.append({"role": "assistant", "content": msg.get("content", "")})
            messages.append({"role": "user", "content": f"上次输出未通过结构校验：{exc}。仅修正格式和缺失字段，不要改变rubric。"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)  # Each assessment has its own immutable evidence/output record.
    started = time.monotonic()
    result = {"rubric_version": VERSION, "status": "running", "total_score": None, "gating": False}
    write(args.output / "scorecard.json", result)
    try:
        base = os.environ.get("TEAM_JUDGE_BASE_URL") or os.environ.get("OPENAI_BASE_URL")
        token = os.environ.get("TEAM_JUDGE_API_KEY") or os.environ.get("OPENAI_API_KEY")
        model = os.environ.get("TEAM_JUDGE_MODEL") or os.environ.get("RACE_MODEL")
        if not all((base, token, model)):
            raise ValueError("Configure TEAM_JUDGE_BASE_URL/MODEL/API_KEY (or OPENAI_BASE_URL/API_KEY and RACE_MODEL)")
        def request(body):
            body["model"] = model
            req = urllib.request.Request(base.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                         headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as response:
                return json.load(response)
        result = evaluate(args.input, args.output, request)
        result["model"] = model
        result["rubric_sha256"] = hashlib.sha256(Path(__file__).with_name(VERSION + ".txt").read_bytes()).hexdigest()
    except Exception as exc:
        result.update(status="error", total_score=None, error_type=type(exc).__name__, error=str(exc))
    result["duration_seconds"] = time.monotonic() - started
    write(args.output / "scorecard.json", result)


if __name__ == "__main__":
    main()
