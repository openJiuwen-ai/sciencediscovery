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

"""The candidate genome: a Python module defining ``search_algorithm``.

Vendored from ``examples/openevolve/_openevolve_support.py`` (upstream commit
``411fb59``). The AST gate is the boundary *before* the sandbox: it rejects
unsafe syntax and hard-coded evaluator optima before the candidate ever
reaches Bubblewrap. What confines a candidate is still the sandbox (see
``sandbox.py``); this is the cheap first layer.

OpenEvolve's allowed imports are deliberately narrower than ERA's: the upstream
function-minimization task is solvable with the stdlib, and admitting pandas or
scikit-learn would admit most of what an AST gate would otherwise stop. ERA's
gate (``vendor/era/program.py``) allows the scientific stack because Kaggle
S3E1 needs it — the two gates cannot be shared.
"""

from __future__ import annotations

import ast
import hashlib
import re
from dataclasses import dataclass
from typing import Any, Dict, Tuple


#: What a candidate may import. Upstream's function-minimization task is solvable
#: with the stdlib; admitting more would admit most of what the gate stops.
ALLOWED_IMPORTS = {"bisect", "heapq", "itertools", "math", "random", "statistics"}

#: Names a candidate may not call. Lifted verbatim from upstream; each one is
#: either a reflection primitive (``eval``/``getattr``/``globals``) or an I/O
#: primitive (``open``/``input``) that the sandbox would deny anyway, so
#: rejecting them here is a fast failure rather than a security boundary.
FORBIDDEN_CALLS = {
    "breakpoint",
    "compile",
    "eval",
    "exec",
    "getattr",
    "globals",
    "help",
    "input",
    "locals",
    "open",
    "setattr",
    "vars",
    "__import__",
}

#: Known optima for the upstream function-minimization objective. Hard-coding
#: any of these is the one thing the AST gate refuses by name: the search is
#: supposed to find them, not write them down.
GLOBAL_MIN_X = -1.704
GLOBAL_MIN_Y = 0.678
GLOBAL_MIN_VALUE = -1.519

#: The uniform-random baseline. Upstream ships this as the search's starting
#: point; the archive seeds it as iteration 0 on island 0.
INITIAL_PROGRAM = '''"""Initial random-search genome for the function-minimization task."""

def search_algorithm(objective, budget, rng, bounds):
    """Return the best (x, y) found within a strict objective-call budget."""
    low, high = bounds
    best_x = rng.uniform(low, high)
    best_y = rng.uniform(low, high)
    best_value = objective(best_x, best_y)
    for _ in range(budget - 1):
        x = rng.uniform(low, high)
        y = rng.uniform(low, high)
        value = objective(x, y)
        if value < best_value:
            best_x, best_y, best_value = x, y, value
    return best_x, best_y
'''


@dataclass
class Program:
    """One executable candidate, its lineage and its measured metrics."""

    program_id: str
    iteration: int
    island: int
    parent_id: "str | None"
    code: str
    change_summary: str
    metrics: Dict[str, Any]
    valid: bool
    error: str = ""


def validate_source(source: str, max_length: int = 20_000) -> Tuple[bool, str]:
    """Reject unsafe syntax, disallowed imports and hard-coded optima.

    Mirrors ``examples/openevolve/_openevolve_support.validate_source``. The
    gate is intentionally stricter than ERA's: no top-level assignments beyond
    literal constants, no dunder attribute access, no I/O primitives. A
    candidate that passes this still has to survive the sandbox.
    """
    if not source.strip():
        return False, "empty source"
    if len(source) > max_length:
        return False, f"source length {len(source)} exceeds {max_length}"
    if "\x00" in source:
        return False, "source contains a NUL byte"
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return False, f"SyntaxError: {exc.msg} at line {exc.lineno}"

    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    if not any(node.name == "search_algorithm" for node in functions):
        return False, "missing search_algorithm function"

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in ALLOWED_IMPORTS:
                    return False, f"import {alias.name!r} is not allowed"
        elif isinstance(node, ast.ImportFrom):
            if not node.module or node.module.split(".")[0] not in ALLOWED_IMPORTS:
                return False, f"import from {node.module!r} is not allowed"
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            return False, f"dunder attribute {node.attr!r} is not allowed"
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_CALLS:
            return False, f"name {node.id!r} is not allowed"

    allowed_top_level = (
        ast.Expr,
        ast.Import,
        ast.ImportFrom,
        ast.FunctionDef,
        ast.Assign,
        ast.AnnAssign,
    )
    for node in tree.body:
        if not isinstance(node, allowed_top_level):
            return False, f"top-level {type(node).__name__} is not allowed"
        if isinstance(node, ast.Expr) and not (
            isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
        ):
            return False, "only a module docstring may be a top-level expression"
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            value = node.value
            if not isinstance(value, (ast.Constant, ast.Tuple, ast.List, ast.Dict, ast.Set)):
                return False, "top-level assignments must be literal constants"

    compact = re.sub(r"\s+", "", source)
    for forbidden in (str(GLOBAL_MIN_X), str(GLOBAL_MIN_Y), str(GLOBAL_MIN_VALUE)):
        if forbidden in compact:
            return False, "hard-coding the evaluator's known optimum is not allowed"
    return True, ""


def extract_program(response: str) -> Tuple[str, str]:
    """Parse ``<PROGRAM>`` / fenced code / raw reply into ``(code, summary)``.

    Falls back to the whole reply when there is no ``<PROGRAM>`` block — same
    behaviour as upstream, and the reason an empty completion becomes a
    ``code=""`` candidate rather than a thrown exception.
    """
    program_match = re.search(r"<PROGRAM>\s*(.*?)\s*</PROGRAM>", response, re.I | re.S)
    if program_match:
        code = program_match.group(1).strip()
    else:
        fence = re.search(r"```(?:python)?\s*(.*?)```", response, re.I | re.S)
        code = (fence.group(1) if fence else response).strip()
    summary_match = re.search(
        r"<CHANGE_SUMMARY>\s*(.*?)\s*</CHANGE_SUMMARY>", response, re.I | re.S
    )
    summary = summary_match.group(1).strip() if summary_match else ""
    return code, summary


def program_id(code: str) -> str:
    """Stable identity for a candidate. SHA-256 prefix, matching upstream."""
    return hashlib.sha256(code.encode("utf-8")).hexdigest()[:16]


def _code_tokens(source: str) -> "set[str]":
    return set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?", source.lower()))


def code_distance(left: str, right: str) -> float:
    """Token-Jaccard distance between two programs.

    Used by ``OpenEvolveArchive`` to bin candidates by diversity. Returns 0 for
    identical token sets and 1 for disjoint sets, matching upstream's
    insertion-time binning.
    """
    a, b = _code_tokens(left), _code_tokens(right)
    return 1.0 - len(a & b) / len(a | b) if a or b else 0.0
