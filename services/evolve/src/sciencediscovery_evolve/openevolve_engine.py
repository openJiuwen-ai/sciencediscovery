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

"""The OpenEvolve search, using the same Domain interface as PUCT.

Mirrors ``puct_engine.py``: same Domain selection (scorecard / test_gate /
custom_script / llm_judge), same ``_Reporter`` event stream, same
``_refuse_unrunnable`` checks. The only difference is ``OpenEvolveArchive``
(MAP-Elites + islands + ring migration) instead of ``PuctTree`` (flat-PUCT).

Both algorithms share the four scoring modes through the Domain seam — exactly
as issue #43 requires: "四种评分模式共用 Domain 接缝，与算法解耦。"
"""

from __future__ import annotations

import math
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import events
from .candidates import CandidateStore
from .completion import CompletionUnavailable, CompletionUsage, completion_for
from .engine import RunSpec
from .measurement import Dataset, missing_candidate_runtime
from .events import Emit, finite
from .logging_config import get_logger
from .vendor.openevolve import (
    OpenEvolveAggregator,
    OpenEvolveArchive,
    OpenEvolveStrategy,
    SCORE_KEY,
    make_propose,
    make_run,
    make_reward,
)

log = get_logger("openevolve")

_MAX_SECONDS = 24 * 3600.0
_SHUTDOWN_GRACE = 120.0


class _Refusal(RuntimeError):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class _Usage:
    def __init__(self) -> None:
        from agentdescent.agents import Usage

        self.totals = Usage()
        self._per_expansion: Dict[int, CompletionUsage] = {}
        self._lock = threading.Lock()

    def add(self, iteration: int, usage: CompletionUsage) -> None:
        self.totals.record(
            completion_tokens=usage.completion,
            prompt_tokens=max(0, usage.total - usage.completion),
        )
        with self._lock:
            self._per_expansion[iteration] = usage

    def read(self) -> int:
        return self.totals.total_tokens

    def of(self, iteration: int) -> Optional[CompletionUsage]:
        with self._lock:
            return self._per_expansion.get(iteration)


class OpenEvolveEngine:
    """One search: seed, expand N times, report the winner.

    Uses the same Domain interface as PUCT — the four scoring modes
    (scorecard / test_gate / custom_script / llm_judge) are selected the same
    way, and only the algorithm state (OpenEvolveArchive instead of PuctTree)
    differs.
    """

    name = "openevolve"
    requires_sandbox = True

    def __init__(
        self,
        *,
        completion_factory: Optional[Callable[..., Callable[[str], str]]] = None,
        store_root: Optional[Path] = None,
    ) -> None:
        self._completion_factory = completion_factory or _default_completion
        self._store_root = store_root or Path(
            os.environ.get("SCIENCE_AGENT_EVOLVE_CANDIDATE_DIR")
            or Path(os.environ.get("SCIENCE_AGENT_DATA_DIR") or "data") / "evolve-candidates"
        )

    def run(self, spec: RunSpec, emit: Emit, should_stop: Callable[[], bool]) -> None:
        try:
            _refuse_unrunnable(spec)
            from .puct_engine import _mode_of, _load
            dataset = _load(spec) if _stages_rows(_mode_of(spec)) else Dataset(())
        except _Refusal as refusal:
            emit(events.log("error", refusal.message))
            emit(events.search_finished("failed", None, 0))
            log.warning("run %s refused: %s", spec.search_id, refusal.message)
            return

        emit(events.search_started(spec.algorithm, spec.scorecard_hash))
        if spec.workers > 1 and _mode(spec) == "serial":
            emit(events.log("warn", f"this search asked for {spec.workers} workers but mode is serial"))

        with tempfile.TemporaryDirectory(prefix=f"openevolve-ledger-{spec.search_id}-") as repo:
            try:
                self._search(spec, dataset, Path(repo), emit, should_stop)
            except _Refusal as refusal:
                emit(events.log("error", refusal.message))
                emit(events.search_finished("failed", None, 0))
                log.warning("run %s failed: %s", spec.search_id, refusal.message)

    def _search(
        self,
        spec: RunSpec,
        dataset: Any,
        repo: Path,
        emit: Emit,
        should_stop: Callable[[], bool],
    ) -> None:
        from agentdescent.evolution import evolve
        from agentdescent.async_evolve import async_evolve
        from agentdescent.staleness import get_policy

        # --- Domain selection: same as PUCT ---
        from .puct_engine import (
            _mode_of, _default_completion, _judge_spec, _scale_of,
            _tasks, _group_tasks, _stages_rows, _held_out_frac,
            _group_held_out_frac, _entrypoint_of,
        )

        baseline: Dict[str, float] = {}
        mode = _mode_of(spec)

        if mode == "test_gate":
            from .test_gate_domain import TestGateError, test_gate_domain
            if not spec.workspace_dir:
                raise _Refusal("test-gated scoring needs a copy of the workspace, and this search was given none")
            try:
                domain = test_gate_domain(
                    scorecard=spec.scorecard,
                    workspace=Path(spec.workspace_dir),
                    capability=spec.sandbox,
                    statement=str(spec.statement or ""),
                    entrypoint_path=_entrypoint_of(spec),
                    candidate_timeout=spec.candidate_timeout_seconds,
                    baseline=baseline,
                )
            except TestGateError as error:
                raise _Refusal(str(error)) from error
        elif mode == "custom_script":
            from .script_domain import ScriptError, script_domain
            try:
                domain = script_domain(
                    scorecard=spec.scorecard,
                    script=spec.script,
                    capability=spec.sandbox,
                    statement=str(spec.statement or ""),
                    baseline_code=spec.baseline_code,
                    candidate_timeout=spec.candidate_timeout_seconds,
                    baseline=baseline,
                )
            except ScriptError as error:
                raise _Refusal(str(error)) from error
        elif mode == "llm_judge":
            from .judge_domain import grader, judge_domain
            domain = judge_domain(
                scorecard=spec.scorecard,
                rubric=spec.rubric,
                grade=grader(
                    self._completion_factory(_judge_spec(spec), None, should_stop),
                    spec.rubric,
                    _scale_of(spec),
                    spec.source_material,
                ),
                statement=str(spec.statement or ""),
                baseline_text=spec.baseline_code,
                baseline=baseline,
            )
        else:
            from .scorecard_domain import scorecard_domain
            domain = scorecard_domain(
                scorecard=spec.scorecard,
                dataset=dataset,
                capability=spec.sandbox,
                statement=str(spec.statement or ""),
                baseline_code=spec.baseline_code,
                candidate_timeout=spec.candidate_timeout_seconds,
                baseline=baseline,
            )

        # --- Algorithm state: OpenEvolveArchive instead of PuctTree ---
        archive = OpenEvolveArchive(
            archive_size=int(spec.options.get("archive_size", 20)),
            num_islands=int(spec.options.get("islands", 3)),
            feature_bins=int(spec.options.get("feature_bins", 4)),
            exploitation_ratio=float(spec.options.get("exploitation_ratio", 0.7)),
            migration_interval=int(spec.options.get("migration_interval", 4)),
            max_code_length=int(spec.options.get("max_code_length", 20_000)),
            rng_seed=int(spec.options.get("seed", 0) or 0),
            candidate_limit=spec.expansions,
        )
        strategy = OpenEvolveStrategy(domain)
        store = CandidateStore(self._store_root)
        usage = _Usage()
        reporter = _Reporter(spec, archive, domain, store, usage, emit)
        archive.on_event = reporter.on_event

        complete = self._model_call(spec, usage, reporter, should_stop)
        tasks = (_tasks(dataset, spec.search_id) if _stages_rows(mode)
                 else _group_tasks(spec))

        artifact_id = "openevolve-" + "".join(
            char if char.isalnum() or char in "_.-" else "-" for char in spec.search_id
        )

        def factory(ledger: Any, verifier: Any, audit: Any, config: Any, policy: Any) -> Any:
            aggregator = OpenEvolveAggregator(
                ledger, verifier, archive, config, policy,
                domain=domain, artifact_id=artifact_id, on_event=reporter.on_event,
            )
            aggregator.seed()
            baseline.update({
                key: float(value) for key, value in archive.best().metrics.items()
                if isinstance(value, (int, float)) and key != SCORE_KEY
            })
            return aggregator

        common: Dict[str, Any] = {
            "aggregator_factory": factory,
            "artifact_id": artifact_id,
            "blast_radius": 0.6,
            "held_out_frac": (_held_out_frac(dataset) if _stages_rows(mode)
                              else _group_held_out_frac(spec)),
            "n_workers": max(1, min(spec.workers, spec.expansions)),
            "propose": make_propose(archive, complete, domain, on_event=reporter.on_event),
            "repo_path": str(repo),
            "run": make_run(domain),
            "eval_concurrency": max(1, min(spec.workers, spec.expansions)),
            "solved_threshold": 1.0,
            "self_verify": False,
            "strategy": strategy,
            "usage": None,
        }

        mode_str = _mode(spec)
        reward = make_reward(domain)
        staleness_policy = get_policy(str(spec.options.get("staleness", "full")))
        try:
            outcome = None
            if mode_str == "async":
                outcome = async_evolve(
                    tasks, reward,
                    async_ratio=int(spec.options.get("async_ratio", 1)),
                    max_iters=spec.expansions,
                    max_seconds=_MAX_SECONDS,
                    shutdown_grace=_SHUTDOWN_GRACE,
                    staleness_policy=staleness_policy,
                    **common,
                )
            else:
                outcome = evolve(
                    tasks, reward,
                    rounds=max(1, spec.expansions // max(1, common["n_workers"])),
                    max_concurrency=1 if mode_str == "serial" else common["n_workers"],
                    max_seconds=_MAX_SECONDS,
                    staleness_policy=staleness_policy,
                    **common,
                )
        except RuntimeError as error:
            raise _Refusal(str(error)) from error

        reporter.note_outcome(outcome, spec.expansions)
        reporter.finish("stopped" if should_stop() else "succeeded")

    def _model_call(
        self,
        spec: RunSpec,
        usage: _Usage,
        reporter: "_Reporter",
        should_stop: Callable[[], bool],
    ) -> Callable[[str, int], Tuple[str, str]]:
        try:
            complete = self._completion_factory(spec, None, should_stop)
        except CompletionUnavailable as error:
            raise _Refusal(f"this search has no model access: {error}") from error

        max_retries = int(spec.options.get("model_retries", 2))
        retry_backoff = float(spec.options.get("retry_backoff", 1.0))

        def call(prompt: str, iteration: int) -> Tuple[str, str]:
            if should_stop():
                archive = reporter.archive
                if archive is not None:
                    archive.candidate_limit = 0
                return "", ""

            import time as _time
            from .logging_config import get_logger as _get_logger
            _log = _get_logger("openevolve.retry")

            for attempt in range(max_retries + 1):
                if should_stop():
                    return "", ""
                # Pass on_failure only on the last attempt; earlier failures
                # are logged but don't emit events (no premature expanded).
                on_failure_cb = (
                    (lambda reason: reporter.note_failure(iteration, reason))
                    if attempt == max_retries else None
                )
                reply = complete(
                    prompt,
                    lambda spent: usage.add(iteration, spent),
                    on_failure_cb,
                )
                code, summary = extract_program_reply(reply)
                if code.strip():
                    return code, summary
                # Empty reply — determine reason for retry logging.
                spent = usage.of(iteration)
                if spent is not None and spent.capped:
                    reason = (
                        f"the model spent {spent.completion} output tokens on hidden thinking, "
                        f"reaching the per-call ceiling of {self.spec.max_tokens_per_call}"
                    )
                else:
                    reason = "the model returned an empty reply"
                if attempt < max_retries:
                    _log.warning("iteration %d attempt %d/%d failed: %s — retrying in %.1fs",
                                  iteration, attempt + 1, max_retries + 1, reason,
                                  retry_backoff * (2 ** attempt))
                    _time.sleep(retry_backoff * (2 ** attempt))
                    continue
                # Last attempt failed — emit one failed expanded with the reason.
                reporter.note_empty(iteration, reason)
                return "", ""

            return "", ""

        return call


# --- Turning the search into the event stream --------------------------------


class _Reporter:
    """The search's events, mirroring ``puct_engine._Reporter``.

    Uses the same Domain interface: ``domain.test_shards`` and ``domain.evaluate``
    for the final test score, ``SCORE_KEY`` for the score field name.
    """

    def __init__(
        self,
        spec: RunSpec,
        archive: Optional[OpenEvolveArchive],
        domain: Any,
        store: CandidateStore,
        usage: _Usage,
        emit: Emit,
    ) -> None:
        self.spec = spec
        self.archive = archive
        self.domain = domain
        self.store = store
        self.usage = usage
        self.emit = emit
        self.attempted = 0
        self.scored = 0
        self._distinct_scores: set = set()
        self.failures: List[str] = []
        self._empty: Dict[int, str] = {}
        self._inspiration_by_iteration: Dict[int, Optional[int]] = {}
        self._lock = threading.Lock()

    def note_failure(self, iteration: int, reason: str) -> None:
        """The call itself did not come back. Emit once; skip if already emitted."""
        with self._lock:
            if iteration in self._empty:
                return
            self._empty[iteration] = f"this call did not return: {reason}"
        self.emit(events.expanded(
            iteration, None, iteration, None, False,
            error=f"model call failed: {reason}",
            iteration=iteration,
        ))

    def note_empty(self, iteration: int, reason: str = "") -> None:
        """Empty reply. Emit once; skip if note_failure already emitted."""
        with self._lock:
            if iteration in self._empty:
                return
            if reason:
                self._empty[iteration] = reason
            else:
                spent = self.usage.of(iteration)
                if spent is not None and spent.capped:
                    self._empty[iteration] = (
                        f"the model spent {spent.completion} output tokens on hidden thinking, "
                        f"reaching the per-call ceiling of {self.spec.max_tokens_per_call}. "
                        "raise the ceiling or disable thinking"
                    )
                else:
                    self._empty[iteration] = "the model returned an empty reply"
        self.emit(events.expanded(
            iteration, None, iteration, None, False,
            error=self._empty[iteration],
            iteration=iteration,
        ))

    def on_event(self, kind: str, payload: Dict[str, Any]) -> None:
        if kind == "selected":
            self.attempted += 1
            iteration = payload["iteration"]
            inspiration_id = payload.get("inspiration_id")
            inspiration_iteration: Optional[int] = None
            if inspiration_id and self.archive is not None:
                inspiration_program = self.archive.programs.get(inspiration_id)
                if inspiration_program is not None:
                    inspiration_iteration = inspiration_program.iteration
            with self._lock:
                self._inspiration_by_iteration[iteration] = inspiration_iteration
            self.emit(events.selected(iteration, []))
        elif kind == "seeded":
            metrics = payload.get("metrics", {})
            seed_score = metrics.get(SCORE_KEY)
            if isinstance(seed_score, (int, float)) and finite(float(seed_score)) is not None:
                self._distinct_scores.add(round(float(seed_score), 6))
            self.emit(events.seeded(0, seed_score))
        elif kind == "node":
            self._node(payload)
        elif kind == "best":
            self._best(payload)
        elif kind == "inserted":
            self.emit(events.inserted(
                payload["node_index"],
                payload["complexity_bin"],
                payload["diversity_bin"],
                payload["island"],
                payload["via"],
            ))
        elif kind == "migrated":
            self.emit(events.migrated(
                payload["node_index"],
                payload["from_island"],
                payload["to_island"],
            ))

    def _node(self, payload: Dict[str, Any]) -> None:
        from .vendor.openevolve import Program
        program: Program = payload["program"]
        metrics: Dict[str, Any] = payload["metrics"]
        valid = bool(payload.get("valid"))
        raw_score = metrics.get(SCORE_KEY)
        if isinstance(raw_score, (int, float)) and finite(float(raw_score)) is not None:
            self._distinct_scores.add(round(float(raw_score), 6))

        parent_index: Optional[int] = None
        if program.parent_id and self.archive is not None:
            parent_program = self.archive.programs.get(program.parent_id)
            if parent_program is not None:
                parent_index = parent_program.iteration

        code = program.code
        code_hash = self.store.put(self.spec.search_id, code) if code.strip() else None

        with self._lock:
            empty = self._empty.pop(program.iteration, "")
            inspiration_iteration = self._inspiration_by_iteration.pop(program.iteration, None)
        error = empty or program.error
        if not valid:
            self.failures.append(error or "the candidate produced no score")
        else:
            self.scored += 1

        self.emit(events.expanded(
            program.iteration, parent_index, program.iteration,
            raw_score if valid else None, valid,
            change_summary=program.change_summary or None,
            code_hash=code_hash, code_chars=len(code) or None,
            error=error or None, iteration=program.iteration,
            island=program.island,
            program_id=program.program_id,
            inspiration_indexes=[inspiration_iteration] if inspiration_iteration is not None else None,
        ))
        if valid:
            criteria = {
                key: float(value) for key, value in metrics.items()
                if isinstance(value, (int, float))
                and key not in (SCORE_KEY, "seconds")
            }
            reward = float(self.domain.reward(metrics))
            self.emit(events.evaluated(
                program.iteration, reward, criteria,
                gate_score=float(raw_score), rollout_score=float(raw_score),
            ))

    def _best(self, payload: Dict[str, Any]) -> None:
        from .vendor.openevolve import Program
        program: Program = payload["program"]
        self.emit(events.merged(
            program.iteration, True, "became the current best",
        ))
        self.emit(events.cost(self.usage.read(), 0))

    def note_outcome(self, outcome: Any, planned: int) -> None:
        if outcome is None:
            return
        reason = str(getattr(outcome, "stop_reason", "") or "")
        error = str(getattr(outcome, "error", "") or "")
        retired = int(getattr(outcome, "retired_workers", 0) or 0)
        done = (len(self.archive.history) - 1) if self.archive is not None else 0

        if error:
            self.emit(events.log("warn", f"the search was ended by an error: {error[:300]}"))
        if retired:
            self.emit(events.log(
                "warn",
                f"{retired} workers retired — model calls failed repeatedly "
                "enough that the framework stopped trying.",
            ))
        if 0 <= done < planned and reason and reason not in ("max_iters", "max_calls"):
            self.emit(events.log(
                "info",
                f"planned {planned} expansions, ran {done}, stopped because {reason}.",
            ))

    def finish(self, status: str, *, test_score: Optional[float] = None) -> None:
        if status == "succeeded" and len(self._distinct_scores) == 1 and self.archive is not None and len(self.archive.history) > 3:
            self.emit(events.log(
                "warn",
                f"{len(self.archive.history)} candidates all scored the same "
                f"({next(iter(self._distinct_scores)):.4f}). The scoring is insensitive "
                "to these changes — likely the candidates don't implement the "
                "evaluator's required interface.",
            ))
        if status == "succeeded" and self.attempted and not self.scored:
            status = "failed"
            self.emit(events.log(
                "error",
                f"{self.attempted} expansions produced no runnable candidate. "
                "This is usually a model/API issue, not a scoring problem. "
                "Check the error column for each candidate and verify model access.",
            ))

        # Evaluate best on test shards — same as PUCT's _Reporter.finish
        best_test_score: Optional[float] = None
        if status != "failed" and self.archive is not None and self.archive.best_id is not None:
            best = self.archive.best()
            if best.valid and self.domain.test_shards:
                try:
                    valid, metrics, error = self.domain.evaluate(
                        best.code, self.domain.test_shards,
                    )
                    if valid:
                        best_test_score = float(metrics.get(SCORE_KEY) or 0.0)
                    else:
                        self.emit(events.log("warn", f"best candidate failed on test shards: {error}"))
                except Exception as exc:
                    self.emit(events.log("warn", f"test-shard evaluation failed: {exc}"))

        best_index: Optional[int] = None
        if self.archive is not None and self.archive.best_id is not None:
            best_index = self.archive.best().iteration
        nodes = len(self.archive.history) if self.archive is not None else 0
        self.emit(events.search_finished(
            status, best_index, nodes, best_test_score=best_test_score,
        ))

        log.info(
            "run %s finished: status=%s nodes=%d migrations=%d",
            self.spec.search_id, status, nodes,
            self.archive.migrations if self.archive is not None else 0,
        )


# --- Refusals and wiring helpers ---------------------------------------------


def _refuse_unrunnable(spec: RunSpec) -> None:
    """Same checks as PUCT: scorecard, normalize, packages, candidate runtime.

    OpenEvolve-specific max_tokens/thinking floors are in ``preflight.ts``
    (Node-side pre-flight), not here — the engine refuses only what PUCT does.
    """
    from .puct_engine import _mode_of
    from .scorecard import KNOWN_NORMALIZE

    if spec.resume_from_sequence:
        raise _Refusal(
            "OpenEvolve search cannot be resumed yet: the archive would have to be "
            "rebuilt from the event log first"
        )
    if not spec.scorecard:
        raise _Refusal("this search was given no scorecard, so there is no way to tell candidates apart")
    # Check normalize kinds (same as PUCT)
    for criterion in spec.scorecard.get("criteria") or []:
        kind = (criterion.get("normalize") or {}).get("kind")
        if kind not in KNOWN_NORMALIZE:
            raise _Refusal(
                f"criterion \"{criterion.get('name', criterion.get('id'))}\" uses the "
                f"normalisation {kind!r}, which this side does not know; supported are "
                f"{sorted(KNOWN_NORMALIZE)}"
            )
    if _mode_of(spec) == "llm_judge":
        if not spec.rubric.strip():
            raise _Refusal("this scorecard is graded by a model but was given no rubric")
        return
    if spec.packages:
        from .provision import ProvisionError, ensure
        try:
            installed, _note = ensure(spec.packages)
        except ProvisionError as error:
            raise _Refusal(str(error)) from error
        if installed:
            log.info("run %s provisioned %s", spec.search_id, ", ".join(installed))
    if _mode_of(spec) == "custom_script" and not spec.script.strip():
        raise _Refusal("this scorecard is scored by an evaluator script but was given none")
    missing = missing_candidate_runtime()
    if missing:
        raise _Refusal(
            f"the sidecar is missing the candidate runtime: {', '.join(missing)}. "
            "The AST gate lets candidates import them, so without them every candidate "
            "fails. Run `uv sync --extra candidates` in services/evolve"
        )

def _mode(spec: RunSpec) -> str:
    mode = str(spec.options.get("mode") or ("async" if spec.workers > 1 else "serial"))
    if mode not in ("async", "serial", "sync"):
        raise _Refusal(f"unknown search mode {mode!r}; choose serial / sync / async")
    return mode


def _stages_rows(mode: str) -> bool:
    """Whether this mode's shards are rows the control plane staged.

    Same as PUCT: only ``dataset_metric`` stages rows that need loading. Every
    other mode (custom_script, test_gate, llm_judge) gets its shards from the
    scorecard or the evaluator, not from a staged dataset directory.
    """
    return mode == "dataset_metric"


def _default_completion(spec: RunSpec, _usage: Any, should_stop: Callable[[], bool]) -> Callable[[str], str]:
    return completion_for(
        spec.llm_url,
        spec.llm_token,
        max_tokens=spec.max_tokens_per_call,
        temperature=float(spec.options.get("temperature", 0.7)),
        thinking=spec.thinking or None,
        should_stop=should_stop,
    )


def extract_program_reply(reply: str) -> Tuple[str, str]:
    from .vendor.openevolve import extract_program
    return extract_program(reply)
