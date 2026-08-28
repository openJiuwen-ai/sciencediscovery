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

"""The PUCT tree search, wired the way upstream's own ERA port wires it.

`futs.search`'s loop body is a Strategy plus an Aggregator (`vendor/puct/search.py`);
AgentDescent supplies the workers, the ledger, the evidence cards, the staleness
handling and the barrier-free runtime. This module is the wiring plus the parts
that are ours: the scorecard as a :class:`Domain`, the model call, and turning
the search into the event stream the rest of the system reads.

**Why not a loop of our own.** An earlier revision drove `PuctTree` directly and
hand-rolled the wave scheduling, on the reasoning that `evolve()` reports only
round aggregates and could not describe a tree. That was wrong in its premise:
`aggregator_factory` is a documented parameter of both `evolve` and
`async_evolve`, `AggregatorProtocol` is the seam it plugs into, and upstream's
the upstream port puts the whole tree there. Everything the hand-rolled version had to
build — worker pool, virtual loss, wave dispatch, the "results as they finish"
consumer — is machinery the engine already owns and has tested.

**Three modes over one set of plug-ins.** `serial` and `sync` go through
`evolve` (one worker, or N with a round barrier); `async` goes through
`async_evolve` (no barrier, staleness policy live). Upstream uses that to show
the parallel runs are the same search; here it also means a real engine can be
run single-threaded when a reproduction needs one, without the stub.
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
from .events import Emit
from .logging_config import get_logger
from .measurement import (
    GATE,
    ROLLOUT,
    TEST,
    Dataset,
    DatasetError,
    load_dataset,
    measure_shards,
    missing_candidate_runtime,
    shard_indices,
)
from .judge_domain import JudgeUnavailable, grader, judge_domain
from .scorecard import KNOWN_NORMALIZE
from .scorecard_domain import SCORE_KEY, scorecard_domain
from .text_candidate import extract_text
from .vendor.puct.program import extract_program
from .vendor.puct.search import (
    PuctStrategy,
    PuctTreeAggregator,
    make_propose,
    make_reward,
    make_run,
)
from .vendor.puct.tree import PRIOR_FACTORS, PuctTree, Node

log = get_logger("puct")

#: How long the run may sit past its expansion budget before the engine is told
#: to wind down. The budget is `max_iters`; this is the safety net for a backend
#: that never returns.
_MAX_SECONDS = 24 * 3600.0

#: How long `async_evolve` waits for in-flight workers once it is done.
_SHUTDOWN_GRACE = 120.0


def _rollout_budget(expansions: int) -> int:
    """`max_iters` in the unit upstream actually counts: worker rollouts.

    Not expansions, and passing one for the other is what made a run of 20 stop
    at 5. Upstream increments its counter once per clean rollout, but only calls
    `propose` when that rollout scored **below** `solved_threshold` — a task it
    already solves needs no proposal. So every solved rollout spends a slot of
    the budget and produces no candidate, and upstream's own wrapper says as
    much by computing `max_iters = rounds * n_workers`.

    Measured on two live runs: a linkage search whose shards each held a single
    record scored 0 or 1 with nothing between, 11 of 16 shards came out at 1.0,
    and 20 rollouts yielded 5 expansions; a compression search yielded 8.

    Five times, then. A solved rollout costs one sandbox evaluation and **no
    model call**, so headroom here is paid in seconds rather than tokens, and
    the real cap on expansions is the tree's own `candidate_limit`, which
    refuses to select a parent past it.
    """
    return max(1, int(expansions)) * 5


class _Refusal(RuntimeError):
    """A run-level fault: the search cannot start, or cannot mean anything."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class _Usage:
    """Token spend, on top of the framework's own counter.

    `agentdescent.agents.Usage` already does the hard half — thread-safe totals
    of calls, tokens and seconds, which is exactly what the cost event carries —
    so it is used rather than reimplemented.

    What it does not have is **which expansion** a call belonged to, and this
    engine needs that: with three calls in flight there is no such thing as "the
    last call", and blaming expansion 3's empty reply on expansion 5's token
    count is worse than not explaining it at all.
    """

    def __init__(self) -> None:
        from agentdescent.agents import Usage

        self.totals = Usage()
        self._per_expansion: Dict[int, CompletionUsage] = {}
        self._lock = threading.Lock()

    def add(self, iteration: int, usage: CompletionUsage) -> None:
        self.totals.record(completion_tokens=usage.completion,
                           prompt_tokens=max(0, usage.total - usage.completion))
        with self._lock:
            self._per_expansion[iteration] = usage

    def read(self) -> int:
        return self.totals.total_tokens

    def of(self, iteration: int) -> Optional[CompletionUsage]:
        with self._lock:
            return self._per_expansion.get(iteration)


class PuctEngine:
    """One search: seed, expand N times, report the winner."""

    name = "puct"
    #: Candidates are model-written Python that gets executed. A run without a
    #: backend is refused at the seam in `server.py`, not here.
    requires_sandbox = True

    def __init__(
        self,
        *,
        completion_factory: Optional[Callable[..., Callable[[str], str]]] = None,
        domain_factory: Optional[Callable[..., Any]] = None,
        store_root: Optional[Path] = None,
    ) -> None:
        self._completion_factory = completion_factory or _default_completion
        self._domain_factory = domain_factory or scorecard_domain
        # Same data dir the rest of the stack uses: a candidate source that
        # landed in the user's home directory would be invisible to every tool
        # that knows where this deployment keeps its state.
        self._store_root = store_root or Path(
            os.environ.get("SCIENCE_AGENT_EVOLVE_CANDIDATE_DIR")
            or Path(os.environ.get("SCIENCE_AGENT_DATA_DIR") or "data") / "evolve-candidates"
        )

    def run(self, spec: RunSpec, emit: Emit, should_stop: Callable[[], bool]) -> None:
        try:
            _refuse_unrunnable(spec)
            # A judged scorecard has no dataset and needs none; asking for one
            # would refuse exactly the runs this mode exists for.
            dataset = _load(spec) if _stages_rows(_mode_of(spec)) else Dataset(())
        except _Refusal as refusal:
            # Nothing measurable was set up, so every candidate would fail
            # identically. Reporting that as a search which found nothing would
            # send the user looking at their candidates for a fault that is in
            # the run's configuration.
            emit(events.log("error", refusal.message))
            emit(events.search_finished("failed", None, 0))
            log.warning("run %s refused: %s", spec.search_id, refusal.message)
            return

        emit(events.search_started(spec.algorithm, spec.scorecard_hash))
        if spec.workers > 1 and _mode(spec) == "serial":
            emit(events.log("warn", f"this search asked for {spec.workers} workers, but the mode is serial"))

        with tempfile.TemporaryDirectory(prefix=f"evolve-ledger-{spec.search_id}-") as repo:
            try:
                self._search(spec, dataset, Path(repo), emit, should_stop)
            except _Refusal as refusal:
                emit(events.log("error", refusal.message))
                emit(events.search_finished("failed", None, 0))
                log.warning("run %s failed: %s", spec.search_id, refusal.message)

    # -- the search ------------------------------------------------------------

    def _search(
        self,
        spec: RunSpec,
        dataset: Dataset,
        repo: Path,
        emit: Emit,
        should_stop: Callable[[], bool],
    ) -> None:
        from agentdescent.evolution import evolve
        from agentdescent.async_evolve import async_evolve
        from agentdescent.staleness import get_policy

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

            # The general case: no table to measure, no suite to run, no prose
            # to mark — so the drafting model wrote the evaluator. Same seam
            # again, which is the point of having cut one.
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
            # Nothing to execute and nothing to measure: a model reads the
            # candidate against a frozen rubric. Same `Domain` seam, so the
            # engine, the tree and the aggregator are unchanged — which is the
            # seam doing its job rather than a coincidence.
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
            domain = self._domain_factory(
                scorecard=spec.scorecard,
                dataset=dataset,
                capability=spec.sandbox,
                statement=str(spec.statement or ""),
                baseline_code=spec.baseline_code,
                candidate_timeout=spec.candidate_timeout_seconds,
                baseline=baseline,
            )

        tree = PuctTree(c_puct=float(spec.options.get("c_puct", 1.0)),
                        prior_factors=_prior_factors(spec.options),
                        candidate_limit=spec.expansions)
        store = CandidateStore(self._store_root)
        usage = _Usage()
        reporter = _Reporter(spec, tree, domain, store, usage, emit)

        complete = self._model_call(spec, usage, reporter, should_stop, tree)
        tasks = (_tasks(dataset, spec.search_id) if _stages_rows(mode)
                 else _group_tasks(spec))
        # No colon: the engine refuses an artifact id that is not a safe
        # filename, because it becomes one inside the ledger's git repo.
        artifact_id = "puct-" + "".join(
            char if char.isalnum() or char in "_.-" else "-" for char in spec.search_id
        )

        def factory(ledger: Any, verifier: Any, audit: Any, config: Any, policy: Any) -> Any:
            aggregator = PuctTreeAggregator(
                ledger, verifier, tree, config, policy,
                domain=domain, artifact_id=artifact_id, on_event=reporter.on_event,
                repair=_repairer(spec, complete, domain),
            )
            # Seeded here so the root's numbers are what everything after is
            # normalised against — the domain's baseline is empty until now.
            aggregator.seed()
            baseline.update({
                key: float(value) for key, value in tree.root().program.metrics.items()
                if isinstance(value, (int, float)) and key != SCORE_KEY
            })
            return aggregator

        common: Dict[str, Any] = {
            "aggregator_factory": factory,
            "artifact_id": artifact_id,
            # A whole-program rewrite touches every key there is.
            "blast_radius": 1.0,
            # Positional, and documented as such: the held-out set is the tail of
            # the task list, so ordering rollout shards before gate shards makes
            # the engine's held-out set exactly the scorecard's gate shards.
            "held_out_frac": (_held_out_frac(dataset) if _stages_rows(mode)
                              else _group_held_out_frac(spec)),
            "n_workers": max(1, min(spec.workers, spec.expansions)),
            "propose": make_propose(tree, complete, domain, on_event=reporter.on_event),
            "repo_path": str(repo),
            "run": make_run(domain),
            # A held-out evaluation here is a sandboxed process, not an API call,
            # so the useful concurrency is the worker count.
            "eval_concurrency": max(1, min(spec.workers, spec.expansions)),
            # Never "solved": upstream skips `propose` on a rollout whose task
            # already scores past this, which makes sense for a multi-task bench
            # and none at all for a single-artifact tree search — the shard is a
            # *measurement*, not a task to finish, and a proposal is equally
            # valuable whichever shard this rollout happened to draw. Measured
            # on a live compression run: the evaluator clamped any shard
            # compressed past 50% to a flat 1.0, four of six rollout shards
            # saturated, and two-thirds of the rollout budget burned on skips —
            # a run planned for 20 expansions made 12 and stopped on max_iters
            # in under two minutes. The scorecard's own solvedThreshold keeps
            # governing the control plane; it just no longer turns rollouts
            # into no-ops.
            "solved_threshold": 2.0,
            "self_verify": False,
            "strategy": PuctStrategy(domain),
            "usage": None,
        }

        mode = _mode(spec)
        reward = make_reward(domain)
        try:
            outcome = None
            if mode == "async":
                outcome = async_evolve(
                    tasks, reward,
                    async_ratio=int(spec.options.get("async_ratio", 1)),
                    max_iters=_rollout_budget(spec.expansions),
                    max_seconds=_MAX_SECONDS,
                    shutdown_grace=_SHUTDOWN_GRACE,
                    # A discarded card is a whole trained-and-scored program, and
                    # the tree is append-only: a node's place in it is its parent
                    # index, so a late arrival is still a legitimate expansion of
                    # the parent it was drawn from. There is nothing for it to be
                    # stale against.
                    staleness_policy=get_policy(str(spec.options.get("staleness", "full"))),
                    **common,
                )
            else:
                outcome = evolve(
                    tasks, reward,
                    rounds=max(1, spec.expansions // max(1, common["n_workers"])),
                    max_concurrency=1 if mode == "serial" else common["n_workers"],
                    max_seconds=_MAX_SECONDS,
                    **common,
                )
        except RuntimeError as error:
            # `PuctTreeAggregator.seed` refuses a root that will not run, and the
            # engine surfaces it here. Every score in the search is relative to
            # the root, so without it there is nothing for "better" to mean.
            raise _Refusal(str(error)) from error

        # Whatever the framework decided is the only account of why a run of 24
        # expansions stopped at 7. Discarding it — which this did — leaves the
        # status line saying "succeeded" for a search whose workers died on the
        # second call, and nothing anywhere that says otherwise.
        reporter.note_outcome(outcome, spec.expansions)
        reporter.finish("stopped" if should_stop() else "succeeded")

    def _model_call(
        self,
        spec: RunSpec,
        usage: _Usage,
        reporter: "_Reporter",
        should_stop: Callable[[], bool],
        tree: PuctTree,
    ) -> Callable[[str, int], Tuple[str, str]]:
        """`(prompt, iteration) -> (code, change_summary)`.

        Owned here rather than handed to the framework as an `Agent` so a stop, a
        token count and an empty reply each mean something to this engine.
        """
        try:
            # No client-level sink: every call supplies its own, because with N
            # expansions in flight a shared one cannot say which expansion a
            # token count belongs to.
            complete = self._completion_factory(spec, None, should_stop)
        except CompletionUnavailable as error:
            raise _Refusal(f"this search has no access to a model: {error}") from error

        def call(prompt: str, iteration: int) -> Tuple[str, str]:
            if should_stop():
                # Upstream's own way of saying "no more expansions": past the
                # candidate limit, `select_parent` returns None and the workers
                # wind down. Reusing it means a stop looks like a finished
                # budget rather than a special case.
                tree.candidate_limit = 0
                return "", ""
            reply = complete(
                prompt,
                lambda spent: usage.add(iteration, spent),
                lambda reason: reporter.note_failure(iteration, reason),
            )
            # A prompt or an abstract has no module docstring and may arrive
            # unfenced; reading it with the program parser would discard it.
            code, summary = (extract_text(reply) if _mode_of(spec) == "llm_judge"
                             else extract_program(reply))
            if not code.strip():
                reporter.note_empty(iteration)
            return code, summary

        return call


# --- Turning the search into the event stream --------------------------------


class _Reporter:
    """The search's events, in the order the rest of the system reads them.

    Single-threaded by contract for everything but `note_empty`: the aggregator's
    `step` is the only caller of the node and sweep hooks, and `selected` is
    emitted from a worker but carries only that worker's own facts.
    """

    def __init__(
        self,
        spec: RunSpec,
        tree: PuctTree,
        domain: Any,
        store: CandidateStore,
        usage: _Usage,
        emit: Emit,
    ) -> None:
        self.spec = spec
        self.tree = tree
        self.domain = domain
        self.store = store
        self.usage = usage
        self.emit = emit
        # Empty until the framework returns. `finish` runs on paths where it
        # never does — a stop, a crash — and an absent reason has to be
        # distinguishable from a reason the framework declined to give.
        self._stop_reason = ""
        self._planned = spec.expansions
        self.attempted = 0
        self.scored = 0
        #: Every finite score seen, rounded — one member after a whole run means
        #: the scoring could not tell any candidate from the seed.
        self._distinct_scores: set[float] = set()
        self.failures: List[str] = []
        self._empty: Dict[int, str] = {}
        self._sweep: List[Tuple[Node, Dict[str, Any]]] = []
        self._lock = threading.Lock()

    def note_failure(self, iteration: int, reason: str) -> None:
        """The call itself did not come back.

        Recorded ahead of `note_empty` and never overwritten by it: a call that
        was aborted after fifteen minutes and a model that answered with nothing
        are the same empty string one frame later, and they need opposite fixes.
        Measured on this stack: a thinking-enabled whole-program rewrite ran
        900 seconds without the provider sending a single response header, the
        proxy's ceiling cut it off, and the search recorded it as "the model
        returned an empty reply" — sending the reader to look for output that
        never existed.
        """
        with self._lock:
            self._empty[iteration] = f"this call returned nothing: {reason}"

    def note_empty(self, iteration: int) -> None:
        """Two failures wear the same empty reply and need opposite fixes."""
        spent = self.usage.of(iteration)
        with self._lock:
            if iteration in self._empty:
                # Already explained by the call that never came back.
                return
            if spent is not None and spent.capped:
                self._empty[iteration] = (
                    f"the model spent all {spent.completion} output tokens on hidden "
                    f"thinking and had not started the answer when it hit the "
                    f"{self.spec.max_tokens_per_call} per-call ceiling. Raise the ceiling, "
                    "or turn thinking off"
                )
            else:
                self._empty[iteration] = "the model returned an empty reply"

    def on_event(self, kind: str, payload: Dict[str, Any]) -> None:
        if kind == "selected":
            self.attempted += 1
            self.emit(events.selected(payload["parent_index"], payload["ancestors"]))
        elif kind == "seeded":
            seed_score = payload["metrics"].get(SCORE_KEY)
            if isinstance(seed_score, (int, float)) and math.isfinite(float(seed_score)):
                self._distinct_scores.add(round(float(seed_score), 6))
            # The seed's source goes into the same store an expansion's does.
            # Without it the detail view has no "before" to diff against, and
            # since almost every node's parent is the root, that meant every
            # diff in the run rendered as pure addition.
            seed_code = ""
            node = payload.get("node")
            if node is not None and getattr(node, "program", None) is not None:
                seed_code = getattr(node.program, "code", "") or ""
            seed_hash = self.store.put(self.spec.search_id, seed_code) if seed_code.strip() else None
            self.emit(events.seeded(
                0, payload["metrics"].get(SCORE_KEY),
                code_hash=seed_hash, code_chars=len(seed_code) or None,
            ))
        elif kind == "node":
            self._node(payload)
        elif kind == "swept":
            self._swept(payload)
        elif kind == "repaired":
            # A repair is an extra model call the user paid for, so it is said
            # out loud either way: silently succeeding hides where the budget
            # went, and silently failing hides that the attempt was made.
            self.emit(events.log(
                "info",
                # "scored nothing", not "did not run": a candidate that runs and gets
                # every case wrong lands here just as often as one that raises.
                ("repaired a candidate that had scored nothing (%.4f): %s"
                 % (payload["after"], payload["why"]))
                if payload.get("kept") else
                ("a candidate scored nothing; one repair was tried and did not land: %s"
                 % payload["why"]),
            ))

    def _node(self, payload: Dict[str, Any]) -> None:
        node: Node = payload["node"]
        metrics: Dict[str, Any] = payload["metrics"]
        raw_score = metrics.get(SCORE_KEY)
        if isinstance(raw_score, (int, float)) and math.isfinite(float(raw_score)):
            # Rounded, so float noise between two identical evaluations does
            # not read as two different scores.
            self._distinct_scores.add(round(float(raw_score), 6))
        ops: Dict[str, Any] = payload["ops"]
        code = str(ops.get("code") or "")
        iteration = int(ops.get("iteration") or 0)
        valid = bool(node.program.valid)
        code_hash = self.store.put(self.spec.search_id, code) if code.strip() else None

        with self._lock:
            # Ours wins over the gate's. Both are true — the source *is* empty —
            # but "the gate refused an empty program" is the symptom and "the
            # model spent its whole budget thinking" is the cause, and only one
            # of them tells the user which knob to turn.
            empty = self._empty.pop(iteration, "")
            error = empty or node.program.error
        if not valid:
            self.failures.append(error or "the candidate produced no score")
        else:
            self.scored += 1

        self.emit(events.expanded(
            node.index, node.parent_index, _depth(self.tree, node),
            metrics.get(SCORE_KEY) if valid else None, valid,
            change_summary=str(ops.get("change_summary") or "") or None,
            code_hash=code_hash, code_chars=len(code) or None,
            error=error or None, iteration=iteration,
        ))
        if valid:
            criteria = {
                key: float(value) for key, value in metrics.items()
                if isinstance(value, (int, float)) and key not in (SCORE_KEY, "seconds")
            }
            # Both numbers are the held-out one under PUCT: a node is scored on
            # the gate shards and ranked on that same score. Saying so with two
            # equal fields beats inventing a rollout figure that is not measured.
            self.emit(events.evaluated(
                node.index, float(metrics[SCORE_KEY]), criteria,
                gate_score=float(metrics[SCORE_KEY]),
                rollout_score=float(metrics[SCORE_KEY]),
            ))
        self._sweep.append((node, metrics))

    def _swept(self, payload: Dict[str, Any]) -> None:
        best: Node = payload["best"]
        sweep, self._sweep = self._sweep, []
        for node, metrics in sweep:
            accepted = node.index == best.index and bool(payload.get("changed"))
            violated = metrics.get("violated")
            if node.program.valid:
                reason = "became the best node" if accepted else "did not beat the best node"
                category = None if accepted else "below-threshold"
            elif violated:
                reason = node.program.error or "tripped a veto"
                category = "constraint-violated"
            else:
                # Never reached the point of being compared, which is a different
                # problem from being compared and losing.
                reason = node.program.error or "the candidate did not run"
                category = "candidate-failed"
            self.emit(events.merged(
                node.index, accepted, reason,
                category=category,
                rejected_by=str(violated) if violated else None,
            ))
        # Absolute, never a delta: a replayed delta double-counts where a
        # replayed absolute does not. Cents stay 0 — this system has no price
        # table, and a fabricated number would be shown to the user as fact.
        self.emit(events.cost(self.usage.read(), 0))

    def note_outcome(self, outcome: Any, planned: int) -> None:
        """Say why the search stopped, when that is not "it ran out of budget".

        `stop_reason` and `retired_workers` come back on the framework's result
        and were being dropped. A run that ends early because every worker
        retired, or because a backend error killed it, is not the same event as
        one that spent its expansions — and told apart only here.

        The reason is recorded on `search_finished` unconditionally, including
        the ordinary ones this stays quiet about. Suppressing the log line for
        `max_iters` keeps a normal ending from reading like a fault; suppressing
        the *field* as well left a run that stopped at 8 of 20 expansions with
        no recoverable account of why, and the one number that would have
        explained it had been thrown away by this method.
        """
        if outcome is None:
            return
        reason = str(getattr(outcome, "stop_reason", "") or "")
        error = str(getattr(outcome, "error", "") or "")
        retired = int(getattr(outcome, "retired_workers", 0) or 0)
        done = len(self.tree.nodes) - 1  # the seed is not an expansion
        self._stop_reason = reason
        self._planned = planned

        if error:
            self.emit(events.log("warn", f"the search was ended by an error: {error[:300]}"))
        if retired:
            self.emit(events.log(
                "warn",
                f"{retired} workers dropped out partway through — their model calls failed "
                "often enough in a row that the framework stopped retrying them. This search "
                "will make noticeably fewer expansions than planned.",
            ))
        if 0 <= done < planned and reason and reason not in ("max_iters", "max_calls"):
            self.emit(events.log(
                "info",
                f"planned {planned} expansions, made {done}; it stopped because {reason}.",
            ))

    def finish(self, status: str) -> None:
        if status == "succeeded" and len(self._distinct_scores) == 1 and len(self.tree.nodes) > 3:
            # Succeeded is a claim that the search searched. When every valid
            # candidate landed on the same number as the seed — watched a
            # Gaussian-integral run finish 9 nodes all at 0.6666667 — the run
            # walked blind: no candidate ever outranked another, selection had
            # nothing to select on, and "became the best node" was float noise. That is
            # a scoring problem, not a candidate problem, and it deserves to be
            # said before the status line frames the run as an achievement.
            self.emit(events.log(
                "warn",
                f"all {len(self.tree.nodes)} candidates scored the same "
                f"({next(iter(self._distinct_scores)):.4f}). The scoring is insensitive to "
                "these changes and the search got no signal at all — most likely the "
                "candidates do not implement the interface the evaluator calls, or the "
                "scoring only looks at a part none of them touched.",
            ))
        if status == "succeeded" and self.attempted and not self.scored:
            # Not "the search found nothing": nothing ever ran. Reporting that as
            # success sends the user looking at their scorecard for a fault that
            # is not there.
            status = "failed"
            common = max(set(self.failures), key=self.failures.count) if self.failures else "no reason given"
            self.emit(events.log(
                "error",
                f"none of the {self.attempted} expansions produced a candidate that ran; "
                f"the most common reason was: {common}",
            ))

        best = self.tree.best()
        test_score: Optional[float] = None
        if status != "failed" and best.program.valid and self.domain.test_shards:
            # The only number in the run the search never optimised against,
            # which is the only reason a reported improvement means anything
            # outside this process.
            valid, metrics, error = self.domain.evaluate(
                best.program.code, self.domain.test_shards)
            if valid:
                test_score = float(metrics[SCORE_KEY])
            else:
                self.emit(events.log("warn", f"the best candidate failed on the test shards: {error}"))

        self.emit(events.search_finished(
            status, best.index if best.program.valid else None, len(self.tree.nodes),
            best_test_score=test_score,
            stop_reason=self._stop_reason,
            expansions_planned=self._planned,
        ))
        log.info("run %s finished: status=%s nodes=%d best=%d",
                 self.spec.search_id, status, len(self.tree.nodes), best.index)


# --- Refusals and wiring helpers ---------------------------------------------


def _refuse_unrunnable(spec: RunSpec) -> None:
    if spec.resume_from_sequence:
        raise _Refusal(
            "a PUCT search cannot be resumed yet: the tree would have to be rebuilt from "
            "the event log first, or new nodes reuse indices that are already taken and one "
            "index in the graph ends up with two different contents"
        )
    if not spec.scorecard:
        raise _Refusal("this search was given no scorecard, so there is no way to tell candidates apart")
    # Before the search starts, alongside the other configuration faults. The
    # tree raises on an unknown factor too, but that happens after the run has
    # been announced as started and after the dataset has been staged, so the
    # user watches a run begin and then die for a typo.
    try:
        unknown = [
            factor for factor in _prior_factors(spec.options) if factor not in PRIOR_FACTORS
        ]
    except ValueError as error:
        raise _Refusal(f"the prior argument has the wrong shape: {error}") from error
    if unknown:
        raise _Refusal(
            f"unknown prior factor(s) {unknown}; this side supports {list(PRIOR_FACTORS)}"
        )
    for criterion in spec.scorecard.get("criteria") or []:
        kind = (criterion.get("normalize") or {}).get("kind")
        if kind not in KNOWN_NORMALIZE:
            raise _Refusal(
                f"criterion \"{criterion.get('name', criterion.get('id'))}\" uses the "
                f"normalisation {kind!r}, which this side does not know; supported are "
                f"{sorted(KNOWN_NORMALIZE)}"
            )
    if _mode_of(spec) == "llm_judge":
        # Nothing is executed, so neither the scientific stack nor the sandbox
        # is needed. Demanding them would refuse exactly the runs this mode
        # exists for — a prompt, an abstract, a protocol.
        if not spec.rubric.strip():
            raise _Refusal("this scorecard is graded by a model but was given no rubric")
        return
    if spec.packages:
        # Before anything is measured, and refused rather than warned about: a
        # run whose candidates were promised a library and did not get it fails
        # every expansion with ModuleNotFoundError and reads as a model that
        # cannot write code.
        from .provision import ProvisionError, ensure

        try:
            installed, _note = ensure(spec.packages)
        except ProvisionError as error:
            raise _Refusal(str(error)) from error
        if installed:
            log.info("run %s provisioned %s", spec.search_id, ", ".join(installed))
    if _mode_of(spec) == "custom_script" and not spec.script.strip():
        # Said here rather than at the first expansion: every candidate would
        # fail identically, and a search that reports twelve failed candidates
        # sends the user reading candidates for a fault in the configuration.
        raise _Refusal("this scorecard is scored by an evaluator script but was given none")
    missing = missing_candidate_runtime()
    if missing:
        raise _Refusal(
            f"the sidecar is missing the candidate runtime: {', '.join(missing)}. "
            "The AST gate lets candidates import them, so without them every candidate "
            "fails. Run `uv sync --extra candidates` in services/evolve"
        )


def _load(spec: RunSpec) -> Dataset:
    try:
        return load_dataset(spec.dataset_dir or None, spec.scorecard)
    except DatasetError as error:
        raise _Refusal(str(error)) from error


def _split_of(spec: RunSpec) -> Dict[str, int]:
    """The scorecard's shard counts.

    A judged search stages nothing, so its shard counts live only here — and a
    shard there is one independent grading rather than a group of rows. Reading
    them from the card keeps one source for both modes.
    """
    for criterion in spec.scorecard.get("criteria") or []:
        split = (criterion.get("measure") or {}).get("split")
        if isinstance(split, dict):
            return {
                "gate": int(split.get("gateShards") or 0),
                "rollout": int(split.get("rolloutShards") or 0),
            }
    return {"gate": 0, "rollout": 0}


def _stages_rows(mode: str) -> bool:
    """Whether this mode's shards are rows the control plane staged.

    One predicate rather than a list of modes repeated at each site. It was a
    list, and adding the fourth mode missed two of the three copies: the run
    started, reported "only 0 usable shards", and failed before its first candidate —
    because it had asked an empty dataset how many shards existed. Every other
    mode's shards come from the card, and what a shard *is* differs per mode
    (one grading, a set of test ids, whatever the evaluator slices) — which is
    exactly why counting them from a directory of rows is wrong for all of them.
    """
    return mode == "dataset_metric"


def _group_tasks(spec: RunSpec) -> List[Any]:
    """Rollout groups first, gate groups last.

    Same positional rule as the measured mode, and for the same reason: the
    engine splits its task list by position, so this ordering is what makes its
    held-out set exactly the groups that decide. A "group" is a repeated grading
    for a judged card and a set of test ids for a test-gated one — the same
    three-way split with a different unit.
    """
    from agentdescent.evolution import Task

    counts = _case_groups(spec) if _mode_of(spec) == "test_gate" else _split_of(spec)
    total = counts["rollout"] + counts["gate"]
    if counts["gate"] < 4:
        raise _Refusal(
            f"the hold-out needs at least 4 groups to tell an improvement from noise; "
            f"this card allots {counts['gate']}"
        )
    return [
        Task(id=f"{spec.search_id}:group-{index}", prompt=f"group {index}",
             meta={"shard": index})
        for index in range(total)
    ]


def _tasks(dataset: Dataset, search_id: str) -> List[Any]:
    """Rollout shards first, gate shards last.

    The engine splits by **position** — the last `held_out_frac` of the sequence
    is held out, in the order given — so this ordering plus `_held_out_frac` is
    what makes the engine's held-out set exactly the scorecard's gate shards,
    rather than an arbitrary fraction of them.
    """
    from agentdescent.evolution import Task

    ordered: List[Any] = []
    for role in (ROLLOUT, GATE):
        for shard in shard_indices(dataset, role):
            ordered.append(Task(
                id=f"{search_id}:shard-{shard}",
                prompt=f"evaluate this program on shard {shard}",
                meta={"shard": shard},
            ))
    if len(ordered) < 4:
        raise _Refusal(
            f"this search has only {len(ordered)} usable shards; the acceptance gate needs "
            f"at least 4 to tell an improvement from noise"
        )
    return ordered


def _group_held_out_frac(spec: RunSpec) -> float:
    counts = _case_groups(spec) if _mode_of(spec) == "test_gate" else _split_of(spec)
    total = counts["rollout"] + counts["gate"]
    if not counts["gate"] or not total:
        raise _Refusal("this scorecard allots no hold-out groups, so there is no acceptance gate")
    return counts["gate"] / total


def _held_out_frac(dataset: Dataset) -> float:
    gate = len(shard_indices(dataset, GATE))
    total = len(shard_indices(dataset, ROLLOUT)) + gate
    if not gate or not total:
        raise _Refusal("the staged dataset has no gate shards, so there is no acceptance gate")
    return gate / total


def _mode_of(spec: RunSpec) -> str:
    """The scorecard's measurement kind. One card, one mode — a mixed card is
    refused up front rather than half-measured."""
    criteria = spec.scorecard.get("criteria") or []
    kinds = {str((c.get("measure") or {}).get("kind") or "") for c in criteria}
    if len(kinds) > 1:
        raise _Refusal(
            f"one scorecard mixes the measurement kinds {sorted(kinds)}; this engine does "
            f"one at a time"
        )
    return next(iter(kinds), "dataset_metric")


def _entrypoint_of(spec: RunSpec) -> str:
    for criterion in spec.scorecard.get("criteria") or []:
        entry = (criterion.get("measure") or {}).get("entrypoint")
        if isinstance(entry, list) and entry:
            return str(entry[0])
    return ""


def _case_groups(spec: RunSpec) -> Dict[str, int]:
    for criterion in spec.scorecard.get("criteria") or []:
        split = (criterion.get("measure") or {}).get("caseSplit")
        if isinstance(split, dict):
            return {
                "gate": int(split.get("gateGroups") or 0),
                "rollout": int(split.get("rolloutGroups") or 0),
            }
    return {"gate": 0, "rollout": 0}


def _scale_of(spec: RunSpec) -> Dict[str, Any]:
    for criterion in spec.scorecard.get("criteria") or []:
        scale = (criterion.get("measure") or {}).get("scale")
        if isinstance(scale, dict):
            return scale
    return {"max": 10, "min": 0}


def _judge_spec(spec: RunSpec) -> RunSpec:
    """The same run, pointed at the judge's own proxy token.

    A separate token because the proxy pins the model to the token — which is
    what stops a caller choosing what it is billed for — so the grader cannot
    borrow the mutator's.
    """
    from dataclasses import replace

    if not spec.judge_url or not spec.judge_token:
        raise _Refusal("this scorecard is graded by a model, but this search was given no access to one")
    return replace(spec, llm_url=spec.judge_url, llm_token=spec.judge_token)


def _mode(spec: RunSpec) -> str:
    mode = str(spec.options.get("mode") or ("async" if spec.workers > 1 else "serial"))
    if mode not in ("async", "serial", "sync"):
        raise _Refusal(f"unknown search mode {mode!r}; the choices are serial / sync / async")
    return mode


def _prior_factors(options: Dict[str, Any]) -> Tuple[str, ...]:
    """``options["prior"]`` as a tuple, refusing anything not recognised.

    Refused rather than filtered. The value is drafted by a model and travels
    through four processes to get here; silently dropping a misspelling would
    run the search under the uniform prior and report success, and the run that
    was supposed to test whether the prior helps would have answered a different
    question. `PuctTree` does the checking -- this only normalises the shape.
    """
    raw = options.get("prior")
    if raw is None:
        return ()
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        raise ValueError(f"prior must be a list of factor names, got {type(raw).__name__}")
    return tuple(str(item) for item in raw)


def _depth(tree: PuctTree, node: Node) -> int:
    depth, cursor = 0, node
    while cursor.parent_index is not None:
        cursor = tree.nodes[cursor.parent_index]
        depth += 1
    return depth


def _default_completion(
    spec: RunSpec,
    on_usage: Optional[Callable[[CompletionUsage], None]],
    should_stop: Callable[[], bool],
) -> Callable[..., str]:
    """The mutation call, built once per run.

    Not wrapped in `agentdescent.agents.with_retries`: that helper retries a
    `prompt -> str` callable, and this one takes a per-call usage sink as a
    second argument. Retrying here would also fight the stop path — a run being
    wound down would sit through three attempts of a call whose answer is
    already being discarded. The engine's own handling is the retry: a failed
    call is a failed candidate, the node is appended, and the search continues.
    """
    return completion_for(
        spec.llm_url, spec.llm_token,
        max_tokens=spec.max_tokens_per_call,
        thinking=spec.thinking or None,
        timeout=float(spec.options.get("completion_timeout", 900.0)),
        on_usage=on_usage,
        should_stop=should_stop,
    )


def _repairer(spec: RunSpec, complete, domain) -> Callable[[str, str, int], str]:
    """One model call that fixes a candidate's own bug, or gives up quietly.

    Bounded on purpose: one attempt, this candidate's code and error only, and
    any failure returns "" so the run keeps the original verdict rather than
    stopping. A repair that cannot be had is not worth a failed search.
    """
    from .prompt import repair_prompt

    def repair(code: str, error: str, iteration: int) -> str:
        try:
            fixed, _summary = complete(repair_prompt(code, error), iteration)
        except Exception:  # noqa: BLE001 - a repair is a bonus, never a failure mode
            return ""
        return fixed or ""

    return repair
