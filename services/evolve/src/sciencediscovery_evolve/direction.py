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

"""Keep a search on the fields the scorecard named.

A directed search starts from a JSON object and may change only the keys in
``direction.editable``. Any other difference is refused before it is scored.
A search with no direction is unchanged.
"""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any, Mapping, Optional

from .vendor.puct.domain import Domain


def _render(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def baseline_rows(baseline: str) -> list[dict[str, str]]:
    """The confirmation table: one row per top-level field. The raw object is not the view."""
    try:
        parsed = json.loads(baseline)
    except json.JSONDecodeError as error:
        raise ValueError("the baseline is not JSON") from error
    if not isinstance(parsed, dict):
        raise ValueError("the baseline is not a JSON object")
    return [{"field": str(key), "value": _render(value)} for key, value in parsed.items()]


def field_changes(baseline: str, candidate: str) -> list[dict[str, str]]:
    """Fields whose value differs. Empty when the candidate is not the same object shape."""
    try:
        base = json.loads(baseline)
        cand = json.loads(candidate)
    except json.JSONDecodeError:
        return []
    if not isinstance(base, dict) or not isinstance(cand, dict):
        return []
    changes: list[dict[str, str]] = []
    for key, old in base.items():
        if key in cand and cand[key] != old:
            changes.append({"field": str(key), "old": _render(old), "new": _render(cand[key])})
    return changes


def outside_direction(baseline: str, candidate: str, direction: Mapping[str, Any]) -> str:
    """Return why ``candidate`` leaves the declared direction, or ``""``."""
    editable = direction.get("editable")
    if not isinstance(editable, list) or not editable or not all(isinstance(item, str) for item in editable):
        return "direction names no editable field"
    try:
        base = json.loads(baseline)
        cand = json.loads(candidate)
    except json.JSONDecodeError:
        return "a directed search edits a JSON object, not a free program"
    if not isinstance(base, dict) or not isinstance(cand, dict):
        return "a directed search edits a JSON object, not a free program"
    extra = sorted(set(cand) - set(base))
    if extra:
        return f"unknown field: {extra[0]}"
    missing = sorted(set(base) - set(cand))
    if missing:
        return f"fixed field removed: {missing[0]}"
    allowed = set(editable)
    for key, value in cand.items():
        if key not in allowed and value != base[key]:
            return f"fixed field changed: {key}"
    return ""


def bound_domain(domain: Domain, baseline_code: str, direction: Optional[Mapping[str, Any]]) -> Domain:
    """Wrap ``domain`` so candidates outside ``direction`` are not scored."""
    if not direction:
        return domain
    evaluate = domain.evaluate
    prompt = domain.prompt
    editable = ", ".join(str(item) for item in direction.get("editable") or [])

    def bounded_evaluate(code: str, shards):
        reason = outside_direction(baseline_code, code, direction)
        if reason:
            # ``-inf`` is the dead-node sentinel the unchanged aggregator reads.
            # It is not a measured score, and it is not ``0``.
            return False, {"job_status": "rejected", "score": float("-inf")}, reason
        valid, metrics, error = evaluate(code, shards)
        if isinstance(metrics, Mapping) and "score" not in metrics:
            metrics = {**dict(metrics), "score": float("-inf")}
        return valid, metrics, error

    def bounded_prompt(program):
        return (
            f"{prompt(program)}\n"
            f"Change only these fields: {editable}. Leave every other field as it is."
        )

    return replace(domain, evaluate=bounded_evaluate, prompt=bounded_prompt)
