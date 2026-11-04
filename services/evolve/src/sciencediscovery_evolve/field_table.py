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

"""Rows for the inner-loop confirmation table and the scripted preview run.

The preview numbers are not measurements from a model or an antibody chain.
They exist so the waiting, rejected, repeated, and non-NPU rows can be seen
without a card. A displayed score is empty unless the job completed on NPU.
"""

from __future__ import annotations

import json
from typing import Any

from .direction import field_changes, outside_direction
from .npu_job import interpret_npu_job


def shown_score(valid: bool, metrics: dict[str, Any]) -> str:
    """What the run table prints. Empty stays empty, including a CPU ``0``."""
    if not valid or metrics.get("job_status") != "completed":
        return "—"
    value = metrics.get("score")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "—"
    return f"{float(value):g}"


def _mutate(baseline: dict[str, Any], field: str, new: str) -> dict[str, Any]:
    candidate = dict(baseline)
    candidate[field] = new
    return candidate


def scripted_rounds(baseline: dict[str, Any], editable: list[str]) -> list[dict[str, str]]:
    """Wait, one legal NPU score, one refused edit, one repeat, one non-NPU result."""
    if not editable:
        raise ValueError("tick at least one field")
    direction = {"editable": list(editable)}
    base_text = json.dumps(baseline, ensure_ascii=False)
    first = editable[0]
    second = editable[1] if len(editable) > 1 else editable[0]
    locked = next((key for key in baseline if key not in editable), None)
    if locked is None:
        illegal: dict[str, Any] = {**baseline, "extra": 1}
    else:
        illegal = _mutate(baseline, locked, "other")
    seen: dict[str, float] = {}
    planned: list[tuple[str, dict[str, Any], dict[str, Any], dict[str, Any] | None]] = [
        ("作业未结束，先等待", _mutate(baseline, first, "A"), {"status": "running"}, None),
        ("固定程序在 NPU 上返回分数", _mutate(baseline, first, "A"),
         {"status": "completed"}, {"device": "npu", "score": 0.42}),
        ("改了没有勾选的字段", illegal, {"status": "completed"}, {"device": "npu", "score": 9}),
        ("同一处修改没有更好，不收成新节点", _mutate(baseline, first, "A"),
         {"status": "completed"}, {"device": "npu", "score": 0.42}),
        ("设备不是 NPU，不记 0", _mutate(baseline, second, "Q"),
         {"status": "completed"}, {"device": "cpu", "score": 0}),
    ]
    rows: list[dict[str, str]] = []
    for title, candidate, job, artifact in planned:
        text = json.dumps(candidate, ensure_ascii=False)
        reason = outside_direction(base_text, text, direction)
        if reason:
            rows.append({
                "title": title, "field": "—", "old": "—", "new": "—", "score": "—", "note": reason,
            })
            continue
        valid, metrics, error = interpret_npu_job(job, artifact, metric_key="score")
        key = json.dumps(candidate, sort_keys=True, ensure_ascii=False)
        note = error
        if valid:
            score = float(metrics["score"])
            if key in seen and score <= seen[key]:
                valid = False
                note = "已经见过，而且没有更好，不收成新节点"
                metrics = {"job_status": "rejected"}
            else:
                seen[key] = score
                note = "记下这一次"
        changes = field_changes(base_text, text)
        change = changes[0] if changes else {"field": "—", "old": "—", "new": "—"}
        rows.append({
            "title": title,
            "field": change["field"],
            "old": change["old"],
            "new": change["new"],
            "score": shown_score(valid, metrics),
            "note": note,
        })
    return rows
