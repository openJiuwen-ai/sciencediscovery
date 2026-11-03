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
            return False, {}, reason
        return evaluate(code, shards)

    def bounded_prompt(program):
        return (
            f"{prompt(program)}\n"
            f"Change only these fields: {editable}. Leave every other field as it is."
        )

    return replace(domain, evaluate=bounded_evaluate, prompt=bounded_prompt)
