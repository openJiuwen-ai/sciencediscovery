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

"""Remember directed edits so the search does not spend a slot twice.

A seen edit is not a new node. A reply that is not a JSON object, or that
leaves the declared fields, is not a run either. The model is asked again,
inside the same slot. Coming back with a better score updates the existing
node. A fault may be tried ``FAULT_LIMIT`` times; retries after the first do
not take another slot. Waiting is not a fault and does not take a slot either.

The vendor search still appends whatever ``add_node`` returns. Skipped results
are marked and dropped by the event filter, so ``vendor/puct/search.py`` stays
as it is.
"""

from __future__ import annotations

import json
import math
import threading
from dataclasses import replace
from typing import Any, Callable, Mapping, Optional, Tuple

from .direction import field_changes, outside_direction
from .vendor.puct.domain import Domain
from .vendor.puct.tree import Node

FAULT_LIMIT = 2
#: How many times one slot may ask again after the model repeats a measured edit.
#: The repeat itself is not returned, so it does not spend the search's round.
REDRAW_LIMIT = 3


def _measured_score(metrics: Any) -> float:
    """A real score, including ``0``. A missing score is not a measurement."""
    raw = metrics.get("score") if isinstance(metrics, Mapping) else None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return float("-inf")
    return float(raw)


def canonical_edit(code: str) -> Optional[str]:
    """One key for one JSON object. A free program has no key."""
    try:
        parsed = json.loads(code)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    return json.dumps(parsed, sort_keys=True, separators=(",", ":"))


class EditMemory:
    """Scores and fault counts for one directed search."""

    def __init__(self) -> None:
        self.baseline = ""
        self.best: dict[str, float] = {}
        self.faults: dict[str, int] = {}
        self.nodes: dict[str, Any] = {}
        self._lock = threading.Lock()

    def note_seed(self, code: str, score: float) -> None:
        self.baseline = code
        key = canonical_edit(code)
        if key is None:
            return
        with self._lock:
            self.best[key] = float(score)
            self.nodes[key] = None

    def skip_reason(self, code: str) -> str:
        """Why this candidate must not be sent to the runner, or ``""``."""
        key = canonical_edit(code)
        if key is None:
            return ""
        with self._lock:
            if key in self.best:
                return "repeat"
            if self.faults.get(key, 0) >= FAULT_LIMIT:
                return "faults"
        return ""

    def repeat_reason(self, code: str) -> str:
        """Why this proposal is not a new run, or ``""`` when it is new."""
        key = canonical_edit(code)
        if key is None:
            return ""
        with self._lock:
            if key not in self.best:
                return ""
            score = self.best[key]
            seen = [f"{item} (score {value:g})" for item, value in self.best.items()]
        summary = self.summary_for(code) or "the same JSON"
        return (
            "This edit was already measured and does not take another run: "
            f"{summary}; {key} (score {score:g}). "
            "Already measured: " + "; ".join(seen) + ". "
            "Propose a different JSON. Change an editable field to a value that is not in that list."
        )

    def hold(self, code: str, direction: Optional[Mapping[str, Any]] = None) -> Tuple[str, str]:
        """``(log line, prompt)`` when this reply must not run, else ``("", "")``."""
        repeated = self.repeat_reason(code)
        if repeated:
            return (
                "this edit was already measured, so it does not take a run; asking for a different one",
                repeated,
            )
        if not isinstance(direction, Mapping):
            return "", ""
        text = str(code or "").strip()
        try:
            parsed = json.loads(text) if text else None
        except json.JSONDecodeError:
            parsed = None
        if not isinstance(parsed, dict):
            return (
                "this reply is not a JSON object, so it does not take a run; asking again",
                "The reply was not a JSON object, so it does not take a run. "
                "Return one JSON object and nothing else. Change only an editable field.",
            )
        if not self.baseline:
            return "", ""
        why = outside_direction(self.baseline, text, direction)
        if not why:
            return "", ""
        return (
            "this edit is outside the declared fields, so it does not take a run; asking again",
            "This edit is not run: " + why + ". "
            "Return one JSON object. Change only an editable field and leave every other field as it is.",
        )

    def summary_for(self, code: str) -> str:
        changes = field_changes(self.baseline, code)
        if not changes:
            return ""
        return ", ".join(f"{item['field']}: {item['old']} → {item['new']}" for item in changes)

    def classify(self, program: Any, score: float) -> Tuple[str, str]:
        """``adopt``, ``update``, ``drop``, or ``refund``, plus a short note."""
        metrics = program.metrics if isinstance(getattr(program, "metrics", None), Mapping) else {}
        status = str(metrics.get("job_status") or "")
        key = canonical_edit(getattr(program, "code", "") or "")
        if status == "waiting":
            return "refund", "waiting is not a score and does not take a slot"
        if status == "rejected":
            return "refund", str(getattr(program, "error", "") or "outside the editable fields")
        with self._lock:
            if key and self.faults.get(key, 0) >= FAULT_LIMIT:
                return "refund", "this edit has already failed often enough"
            failed = status == "fault" or (not getattr(program, "valid", False) and status != "completed")
            if failed:
                if key:
                    self.faults[key] = self.faults.get(key, 0) + 1
                    if self.faults[key] > 1:
                        return "refund", "a fault retry does not take another slot"
                return "drop", str(getattr(program, "error", "") or "fault, no score")
            if key and key in self.best:
                seen = self.best[key]
                if not math.isfinite(score) or score <= seen:
                    return "refund", "this edit was already seen and did not improve"
                self.best[key] = score
                return "update", self.summary_for(program.code) or "seen edit improved"
            if key and getattr(program, "valid", False) and math.isfinite(score):
                self.best[key] = score
        return "adopt", ""


def _refund(holder: Any, iteration: int) -> None:
    lock = getattr(holder, "_lock", None)

    def once() -> None:
        nxt = getattr(holder, "_next_iteration", None)
        if isinstance(nxt, int) and iteration > 0 and nxt == iteration + 1:
            holder._next_iteration = iteration

    if lock is None:
        once()
        return
    with lock:
        once()


def _undo_visit(tree: Any, parent_index: Optional[int]) -> None:
    nodes = getattr(tree, "nodes", None)
    lock = getattr(tree, "_lock", None)
    if not isinstance(nodes, list):
        return

    def once() -> None:
        cursor = parent_index
        seen: set[int] = set()
        while isinstance(cursor, int) and cursor not in seen and 0 <= cursor < len(nodes):
            seen.add(cursor)
            node = nodes[cursor]
            if getattr(node, "num_visits", 0) > 0:
                node.num_visits -= 1
            cursor = getattr(node, "parent_index", None)

    if lock is None:
        once()
        return
    with lock:
        once()


def guard_evaluate(domain: Domain, memory: EditMemory) -> Domain:
    """Skip the runner once an edit has used its fault retries."""
    evaluate = domain.evaluate

    def guarded(code: str, shards: Any) -> Tuple[bool, dict[str, Any], str]:
        reason = memory.skip_reason(code)
        if reason == "repeat":
            return False, {"job_status": "rejected"}, (
                "this edit was already measured and does not take another run"
            )
        if reason:
            return False, {"job_status": "fault", "score": float("-inf")}, (
                "this edit has already failed often enough"
            )
        return evaluate(code, shards)

    return replace(domain, evaluate=guarded)


def guard_tree(tree: Any, memory: EditMemory) -> None:
    """Wrap one PUCT tree. A skipped result is not inserted."""
    original_seed = tree.seed
    original_add = tree.add_node

    def seed(program: Any, score: float) -> Any:
        node = original_seed(program, score)
        memory.note_seed(program.code, score)
        key = canonical_edit(program.code)
        if key is not None:
            memory.nodes[key] = node
        return node

    def add_node(program: Any, score: float, parent_index: Optional[int], promise: Optional[float] = None) -> Any:
        action, note = memory.classify(program, score)
        summary = memory.summary_for(program.code)
        if summary:
            program.change_summary = summary
        if action == "adopt":
            node = original_add(program, score, parent_index, promise)
            key = canonical_edit(program.code)
            if key is not None:
                memory.nodes[key] = node
            return node
        if action == "update":
            key = canonical_edit(program.code)
            node = memory.nodes.get(key) if key else None
            if node is not None:
                node.score = score
                node.program = program
                if note:
                    program.error = note
                return node
            action = "refund"
        if note:
            program.error = note
        if action == "refund":
            _refund(tree, int(getattr(program, "iteration", 0) or 0))
            _undo_visit(tree, parent_index)
        ghost = Node(-1, parent_index if isinstance(parent_index, int) else 0, program, score, promise=promise)
        ghost.skipped = True  # type: ignore[attr-defined]
        return ghost

    tree.seed = seed
    tree.add_node = add_node


def guard_archive(archive: Any, memory: EditMemory) -> None:
    """Wrap one OpenEvolve archive the same way."""
    original = archive.add_program

    def add_program(program: Any, baseline: bool = False) -> bool:
        if baseline:
            memory.note_seed(program.code, _measured_score(program.metrics))
            key = canonical_edit(program.code)
            if key is not None:
                memory.nodes[key] = program
            return original(program, baseline=True)
        score = _measured_score(program.metrics)
        action, note = memory.classify(program, score)
        summary = memory.summary_for(program.code)
        if summary:
            program.change_summary = summary
        if action == "adopt":
            inserted = original(program, baseline=False)
            key = canonical_edit(program.code)
            if key is not None:
                memory.nodes[key] = program
            return inserted
        if action == "update":
            key = canonical_edit(program.code)
            stored = memory.nodes.get(key) if key else None
            if stored is not None:
                stored.metrics = dict(program.metrics)
                stored.valid = True
                stored.change_summary = program.change_summary
                if note:
                    program.error = note
                return False
            action = "refund"
        if note:
            program.error = note
        if action == "refund":
            _refund(archive, int(getattr(program, "iteration", 0) or 0))
        program.skipped = True
        return False

    archive.add_program = add_program


def redraw_known(
    complete: Callable[..., Any],
    memory: EditMemory,
    emit_log: Callable[[str], None],
    limit: int = REDRAW_LIMIT,
    direction: Optional[Mapping[str, Any]] = None,
) -> Callable[..., Any]:
    """Ask again inside one slot when the reply must not be run.

    The search loop counts one call to ``propose``, and ``propose`` calls
    ``complete`` once. A repeat, a reply that is not a JSON object, and an
    edit that leaves the declared fields all stay inside that call. They do
    not spend a round and they are not sent to the runner.
    """

    def call(prompt: str, iteration: int) -> Any:
        result = complete(prompt, iteration)
        asked = prompt
        for _ in range(max(0, limit)):
            code = result[0] if isinstance(result, tuple) and result else ""
            log_line, reason = memory.hold(str(code or ""), direction)
            if not reason:
                return result
            emit_log(log_line)
            asked = asked.rstrip() + "\n\n" + reason + "\n"
            result = complete(asked, iteration)
        return result

    return call


def watch_events(
    on_event: Callable[[str, Mapping[str, Any]], None],
    emit_log: Callable[[str, str], None],
    memory: EditMemory,
) -> Callable[[str, dict[str, Any]], None]:
    """Drop skipped nodes. A real node keeps the field change as its summary."""

    def wrapped(kind: str, payload: dict[str, Any]) -> None:
        if kind == "node":
            node = payload.get("node")
            program = payload.get("program")
            if program is None and node is not None:
                program = getattr(node, "program", None)
            if getattr(node, "skipped", False) or getattr(program, "skipped", False):
                emit_log("info", str(getattr(program, "error", "") or "this edit was not adopted"))
                return
            code = str(getattr(program, "code", "") or "")
            summary = memory.summary_for(code)
            if summary:
                ops = payload.get("ops")
                if isinstance(ops, dict):
                    ops["change_summary"] = summary
                if program is not None:
                    program.change_summary = summary
        on_event(kind, payload)

    return wrapped
