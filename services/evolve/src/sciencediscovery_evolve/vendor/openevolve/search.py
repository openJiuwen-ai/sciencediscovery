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

"""OpenEvolve's loop body as a Strategy plus an Aggregator, using Domain.

Mirrors ``vendor/puct/search.py``'s structure: the same Domain interface
(``domain.prompt`` / ``domain.evaluate`` / ``domain.reward`` /
``domain.initial_program``) drives the search, and the only difference is
``OpenEvolveArchive`` (MAP-Elites + islands) instead of ``PuctTree`` (flat-PUCT).

The Domain is task-specific (scorecard / test_gate / script / judge), not
algorithm-specific. OpenEvolve wraps the domain's mutation prompt with archive
context (global best + diverse inspiration) — the ``inspires`` edge in the
search graph tracks which archive entry was in the prompt.
"""

from __future__ import annotations

import json
import math
import threading
import warnings
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from agentdescent.aggregator import AggregatorConfig, MergeOutcome, MergeReport
from agentdescent.evolvable import Diff, EvidenceCard, vv_staleness
from agentdescent.ledger import CASConflict, Ledger
from agentdescent.staleness import StaleAction, get_policy

from ..puct.domain import Domain
from .program import Program, extract_program, program_id, code_distance

#: The score key all Domain implementations use (same as PUCT's SCORE_KEY).
SCORE_KEY = "score"

#: Merge outcomes for this port.
ARCHIVE_UPDATED = "archive-updated"
NO_VALID_CANDIDATES = "no-valid-candidates"

#: What the engine calls when something happens.
OnEvent = Callable[[str, Dict[str, Any]], None]


def _noop(_kind: str, _payload: Dict[str, Any]) -> None:
    return None


#: Mutation replies that parsed to nothing.
_EMPTY_PROPOSALS = {"n": 0}


def _archive_prompt(
    domain: Domain,
    parent: Program,
    best: Program,
    inspiration: Program,
) -> str:
    """Wrap the domain's mutation prompt with OpenEvolve archive context.

    The domain provides the task-specific prompt (objective, constraints, the
    parent program). OpenEvolve adds the global best and a diverse inspiration —
    the two archive entries the ``inspires`` edge in the search graph tracks.
    """
    base = domain.prompt(parent)
    return base + "\n\n--- OpenEvolve archive context ---\n" + (
        f"GLOBAL BEST METRICS:\n{json.dumps(best.metrics, sort_keys=True)}\n\n"
        f"DIVERSE INSPIRATION PROGRAM:\n{inspiration.code}\n"
    )


class OpenEvolveStrategy:
    """One executable program, parsed through the Domain interface."""

    def __init__(self, domain: Domain) -> None:
        self.domain = domain

    def initial(self) -> Dict[str, str]:
        code = self.domain.initial_program
        return {
            "code": code,
            "program_id": program_id(code),
            "change_summary": self.domain.initial_summary,
        }

    def render(self, state: Dict[str, str]) -> str:
        return state.get("code", self.domain.initial_program)

    def keys(self) -> Sequence[str]:
        return ("code", "program_id", "change_summary", "parent_id", "island")

    def to_diff(
        self,
        state: Dict[str, str],
        proposal: str,
        author: str,
        base_version: int,
        target: str,
    ) -> Optional[Diff]:
        try:
            payload = json.loads(proposal)
            code = str(payload["code"]).strip()
            iteration = int(payload["iteration"])
            island = int(payload["island"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return None
        if not code:
            return None
        pid = program_id(code)
        return Diff(
            diff_id=f"{author}:{pid}:{iteration}:{base_version}",
            target=target,
            ops={
                "code": code,
                "program_id": pid,
                "change_summary": str(payload.get("change_summary") or ""),
                "parent_id": str(payload.get("parent_id") or ""),
                "island": str(island),
                "iteration": str(iteration),
            },
            author=author,
        )


@dataclass
class OpenEvolveArchive:
    """Thread-safe MAP-Elites and island state shared by proposers and merger."""

    archive_size: int = 20
    num_islands: int = 3
    feature_bins: int = 4
    exploitation_ratio: float = 0.7
    migration_interval: int = 4
    max_code_length: int = 20_000
    rng_seed: int = 0
    candidate_limit: Optional[int] = None
    programs: Dict[str, Program] = field(default_factory=dict)
    history: List[Program] = field(default_factory=list)
    island_cells: List[Dict[Tuple[int, int], str]] = field(default_factory=list)
    island_generations: List[int] = field(default_factory=list)
    best_id: Optional[str] = None
    baseline_id: Optional[str] = None
    migrations: int = 0
    _next_iteration: int = 1
    _last_migration_generation: int = 0
    on_event: OnEvent = field(default=_noop, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _rng: "random.Random" = field(init=False, repr=False)

    def __post_init__(self) -> None:
        import random

        self._rng = random.Random(self.rng_seed)
        self.island_cells = [dict() for _ in range(self.num_islands)]
        self.island_generations = [0 for _ in range(self.num_islands)]

    def _fitness(self, program: Program) -> float:
        return float(program.metrics.get(SCORE_KEY) or 0.0)

    def _archive_ids_locked(self) -> List[str]:
        ids = {pid for cells in self.island_cells for pid in cells.values()}
        ranked = sorted(ids, key=lambda pid: self._fitness(self.programs[pid]), reverse=True)
        return ranked[: self.archive_size]

    def _feature_cell_locked(self, code: str) -> Tuple[int, int]:
        length_ratio = math.log1p(len(code)) / math.log1p(self.max_code_length)
        complexity = min(self.feature_bins - 1, int(length_ratio * self.feature_bins))
        references = [program.code for program in self.programs.values() if program.valid]
        diversity = (
            sum(code_distance(code, other) for other in references) / len(references)
            if references
            else 0.0
        )
        diversity_bin = min(self.feature_bins - 1, int(diversity * self.feature_bins))
        return complexity, diversity_bin

    def add_program(self, program: Program, *, baseline: bool = False) -> bool:
        with self._lock:
            if program.program_id in self.programs:
                return False
            self.programs[program.program_id] = program
            self.history.append(program)
            if baseline:
                self.baseline_id = program.program_id
            if not program.valid:
                return False

            island = program.island % self.num_islands
            cell = self._feature_cell_locked(program.code)
            incumbent_id = self.island_cells[island].get(cell)
            changed = incumbent_id is None or self._fitness(program) > self._fitness(
                self.programs[incumbent_id]
            )
            if changed:
                self.island_cells[island][cell] = program.program_id
                self.on_event("inserted", {
                    "node_index": program.iteration,
                    "complexity_bin": cell[0],
                    "diversity_bin": cell[1],
                    "island": island,
                    "via": "insert",
                })
            self.island_generations[island] += 1

            if self.best_id is None or self._fitness(program) > self._fitness(
                self.programs[self.best_id]
            ):
                self.best_id = program.program_id

            if (
                max(self.island_generations) - self._last_migration_generation
                >= self.migration_interval
            ):
                self._migrate_locked()
            return changed

    def _migrate_locked(self) -> None:
        outgoing: List[Tuple[int, Tuple[int, int], str]] = []
        for island, cells in enumerate(self.island_cells):
            if not cells:
                continue
            elite_id = max(cells.values(), key=lambda pid: self._fitness(self.programs[pid]))
            target = (island + 1) % self.num_islands
            cell = self._feature_cell_locked(self.programs[elite_id].code)
            outgoing.append((target, cell, elite_id))
        for target, cell, elite_id in outgoing:
            incumbent_id = self.island_cells[target].get(cell)
            if incumbent_id is None or self._fitness(self.programs[elite_id]) > self._fitness(
                self.programs[incumbent_id]
            ):
                self.island_cells[target][cell] = elite_id
                self.migrations += 1
                elite_program = self.programs[elite_id]
                source_island = next(
                    (i for i, cells in enumerate(self.island_cells)
                     if elite_id in cells.values() and i != target),
                    target,
                )
                self.on_event("migrated", {
                    "node_index": elite_program.iteration,
                    "from_island": source_island,
                    "to_island": target,
                })
                self.on_event("inserted", {
                    "node_index": elite_program.iteration,
                    "complexity_bin": cell[0],
                    "diversity_bin": cell[1],
                    "island": target,
                    "via": "migration",
                })
        self._last_migration_generation = max(self.island_generations)

    def select_parent(self) -> Optional[Tuple[int, int, Program, Program, Program]]:
        with self._lock:
            if self.best_id is None:
                raise RuntimeError("OpenEvolve archive has not been seeded")
            iteration = self._next_iteration
            if self.candidate_limit is not None and iteration > self.candidate_limit:
                return None
            self._next_iteration += 1
            island = (iteration - 1) % self.num_islands
            island_ids = list(dict.fromkeys(self.island_cells[island].values()))
            archive_ids = self._archive_ids_locked()
            pool_ids = island_ids or archive_ids
            if not pool_ids:
                raise RuntimeError("OpenEvolve archive has no parent candidates")
            from agentdescent.selection import Candidate, SelectionContext

            if not hasattr(self, "_selection") or self._selection is None:
                self._selection = EpsilonGreedy(self._rng, self.exploitation_ratio)
            rows = [
                Candidate(artifact_id="openevolve", version=i,
                          score=self._fitness(self.programs[pid]))
                for i, pid in enumerate(pool_ids)
            ]
            sel_ctx = SelectionContext(head=rows[0], candidates=tuple(rows), n_workers=1)
            parent_id = pool_ids[self._selection.select(sel_ctx, 1)[0].version]
            parent = self.programs[parent_id]
            best = self.programs[self.best_id]
            inspiration_id = max(
                archive_ids,
                key=lambda pid: code_distance(parent.code, self.programs[pid].code),
            )
            return iteration, island, parent, best, self.programs[inspiration_id]

    def best(self) -> Program:
        with self._lock:
            if self.best_id is None:
                raise RuntimeError("OpenEvolve archive has no best program")
            return self.programs[self.best_id]

    def baseline(self) -> Program:
        with self._lock:
            if self.baseline_id is None:
                raise RuntimeError("OpenEvolve archive has no baseline program")
            return self.programs[self.baseline_id]

    def summary(self) -> Dict[str, Any]:
        with self._lock:
            archive_ids = self._archive_ids_locked()
            return {
                "programs_evaluated": len(self.history),
                "valid_programs": sum(program.valid for program in self.history),
                "archive_ids": archive_ids,
                "island_cell_counts": [len(cells) for cells in self.island_cells],
                "island_generations": list(self.island_generations),
                "migrations": self.migrations,
            }


def _program_summary(program: Program) -> Dict[str, Any]:
    return {
        "program_id": program.program_id,
        "iteration": program.iteration,
        "island": program.island,
        "parent_id": program.parent_id,
        "change_summary": program.change_summary,
        "metrics": program.metrics,
        "valid": program.valid,
        "error": program.error,
        "code_chars": len(program.code),
    }


class EpsilonGreedy:
    """OpenEvolve's in-pool parent rule at the standard selection seam."""

    def __init__(self, rng, exploitation_ratio: float) -> None:
        self.rng = rng
        self.exploitation_ratio = exploitation_ratio

    def select(self, ctx, n: int):
        candidates = list(ctx.candidates)
        if not candidates:
            return [ctx.head] * n
        if self.rng.random() < self.exploitation_ratio:
            pick = max(candidates, key=lambda c: c.score or 0.0)
        else:
            pick = self.rng.choice(candidates)
        return [pick] * n


def _evaluate(
    domain: Domain, code: str, shards: Sequence[int],
) -> Tuple[bool, Dict[str, Any], str]:
    """``domain.evaluate``, except an empty candidate never reaches it.

    Same guard as PUCT's ``_evaluate`` — a model that returned nothing should
    not crash the evaluator.
    """
    if not code.strip():
        return False, {SCORE_KEY: float("-inf")}, "this candidate had no code"
    return domain.evaluate(code, shards)


def make_propose(
    archive: OpenEvolveArchive,
    complete: Callable[[str, int], Tuple[str, str]],
    domain: Domain,
    *,
    on_event: OnEvent = _noop,
) -> Callable[[str, Any, str, float], Optional[str]]:
    """Select a parent and ask the model to rewrite it.

    Wraps ``domain.prompt(parent)`` with OpenEvolve's archive context
    (global best + diverse inspiration). The ``inspires`` edge in the search
    graph tracks which archive entry was in the prompt — recorded in the
    ``selected`` event so the ``expanded`` event can carry ``inspirationIndexes``.
    """

    def propose(rendered: str, task: Any, output: str, reward: float) -> Optional[str]:
        selection = archive.select_parent()
        if selection is None:
            return None
        iteration, island, parent, best, inspiration = selection
        on_event("selected", {
            "iteration": iteration,
            "island": island,
            "parent_id": parent.program_id,
            "best_id": best.program_id,
            "inspiration_id": inspiration.program_id,
        })
        prompt = _archive_prompt(domain, parent, best, inspiration)
        code, summary = complete(prompt, iteration)
        if not code:
            _EMPTY_PROPOSALS["n"] += 1
            if _EMPTY_PROPOSALS["n"] in (1, 5, 25):
                warnings.warn(
                    f"{_EMPTY_PROPOSALS['n']} mutation repl(y/ies) came back "
                    f"empty. On a reasoning model that is the token budget "
                    f"being spent on hidden thinking.",
                    RuntimeWarning, stacklevel=2)
        return json.dumps(
            {
                "code": code,
                "change_summary": summary,
                "iteration": iteration,
                "island": island,
                "parent_id": parent.program_id,
            },
            separators=(",", ":"),
        )

    return propose


def make_run(domain: Domain) -> Callable[[str, Any], str]:
    """One shard of the split is one rollout — same as PUCT."""

    def run(rendered: str, task: Any) -> str:
        valid, metrics, error = _evaluate(domain, rendered, (int(task.meta["shard"]),))
        return json.dumps(
            {"valid": valid, "metrics": metrics, "error": error},
            separators=(",", ":"), default=str,
        )

    return run


def make_reward(domain: Domain) -> Callable[[Any, str], float]:
    """The engine's reward, reading the payload ``make_run`` writes."""

    def reward(task: Any, output: str) -> float:
        try:
            payload = json.loads(output)
            if not payload.get("valid"):
                return 0.0
            return float(domain.reward(payload["metrics"]))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return 0.0

    return reward


class OpenEvolveAggregator:
    """OpenEvolve's MAP-Elites archive as an AgentDescent merge optimizer.

    Uses the same Domain interface as ``PuctTreeAggregator``: ``domain.evaluate``
    for scoring, ``domain.reward`` for ranking, ``domain.initial_program`` for
    seeding. The only difference is the archive (MAP-Elites + islands) instead
    of the tree (flat-PUCT).
    """

    def __init__(
        self,
        ledger: Ledger,
        verifier: Any,
        archive: OpenEvolveArchive,
        config: AggregatorConfig,
        staleness_policy: Any,
        *,
        domain: Domain,
        artifact_id: str = "openevolve_program",
        on_event: OnEvent = _noop,
    ) -> None:
        self.ledger = ledger
        self.verifier = verifier
        self.archive = archive
        self.config = config
        self.staleness_policy = staleness_policy or get_policy("guarded")
        self.domain = domain
        self.artifact_id = artifact_id
        self.on_event = on_event
        self.cards: List[EvidenceCard] = []
        self._cards_lock = threading.Lock()
        self._seeded = False

    def _held_out_shards(self) -> Tuple[int, int]:
        """Shard indices from the verifier's held-out tasks.

        In ScienceDiscovery's sidecar, tasks are created by ``_group_tasks``
        with ``meta={"shard": index}`` (not ``meta={"seed": ...}`` as upstream).
        The shard index IS the identifier the Domain's evaluate() receives.
        """
        shards = sorted(int(task.meta["shard"]) for task in self.verifier.held_out)
        if not shards:
            raise RuntimeError("OpenEvolve needs held-out evaluator shards")
        expected = list(range(shards[0], shards[0] + len(shards)))
        if shards != expected:
            raise ValueError("OpenEvolve held-out shards must be contiguous")
        return shards[0], len(shards)

    def _evaluate(self, code: str) -> Tuple[bool, Dict[str, Any], str]:
        start_shard, trials = self._held_out_shards()
        valid, metrics, error = _evaluate(
            self.domain, code, list(range(start_shard, start_shard + trials)),
        )
        return valid, metrics, error

    def seed(self) -> None:
        if self._seeded:
            return
        self._seeded = True
        head = self.ledger.snapshot(Ledger.DEV).get(self.artifact_id)
        code = head.state.get("code") if head and head.state else None
        if not code:
            code = self.domain.initial_program
        valid, metrics, error = self._evaluate(code)
        if not valid:
            raise RuntimeError(f"initial OpenEvolve program failed: {error}")
        self.archive.add_program(
            Program(
                program_id(code),
                0,
                0,
                None,
                code,
                self.domain.initial_summary,
                metrics,
                valid,
                error,
            ),
            baseline=True,
        )
        self.on_event("seeded", {"metrics": metrics, "program_id": program_id(code)})

    def ingest(self, card: EvidenceCard) -> None:
        with self._cards_lock:
            self.cards.append(card)

    def step(self) -> List[MergeReport]:
        with self._cards_lock:
            cards, self.cards = self.cards, []
        if not cards:
            return []

        snapshot = self.ledger.snapshot(Ledger.DEV)
        head = snapshot.get(self.artifact_id)
        base_vv = {self.artifact_id: snapshot.version.get(self.artifact_id, 0)}

        survivors: List[EvidenceCard] = []
        discarded: List[EvidenceCard] = []
        for card in cards:
            eta = vv_staleness(base_vv, card.base_version)
            alpha = 0 if card.diff.contract_breaking else self.config.alpha_tail
            action = self.staleness_policy.decide(
                eta, alpha, card.diff.contract_breaking
            )
            if action is StaleAction.DISCARD:
                discarded.append(card)
            else:
                survivors.append(card if eta == 0 else card.rebased_onto(base_vv))

        valid_candidates = 0
        archive_updates = 0
        for card in survivors:
            ops = card.diff.ops
            code = ops.get("code", "")
            valid, metrics, error = self._evaluate(code)
            program = Program(
                program_id(code),
                int(ops.get("iteration", "0")),
                int(ops.get("island", "0")),
                ops.get("parent_id") or None,
                code,
                ops.get("change_summary", ""),
                metrics,
                valid,
                error,
            )
            cell_changed = self.archive.add_program(program)
            archive_updates += int(cell_changed)
            valid_candidates += int(valid)
            self.on_event("node", {
                "program": program,
                "metrics": metrics,
                "valid": valid,
                "cell_changed": cell_changed,
            })

        best = self.archive.best()
        accepted: Optional[Diff] = None
        committed_version: Optional[int] = None
        category = ARCHIVE_UPDATED
        if not survivors:
            category = MergeOutcome.ALL_STALE.value
        elif not valid_candidates:
            category = NO_VALID_CANDIDATES
        if best.code != head.state.get("code"):
            accepted = Diff(
                diff_id=f"archive-best:{best.program_id}:{head.version}",
                target=self.artifact_id,
                ops={
                    "code": best.code,
                    "program_id": best.program_id,
                    "change_summary": best.change_summary,
                    "parent_id": best.parent_id or "",
                    "island": str(best.island),
                },
                author="openevolve-archive",
            )
            try:
                _, committed_version = self.ledger.commit(
                    head.apply(accepted),
                    base_vv,
                    branch=Ledger.DEV,
                    message="openevolve: commit best MAP-Elites program",
                )
                category = MergeOutcome.COMMITTED.value
                self.on_event("best", {
                    "program": best,
                    "committed_version": committed_version,
                })
            except CASConflict:
                accepted = None
                category = MergeOutcome.CAS_CONFLICT.value

        return [
            MergeReport(
                self.artifact_id,
                accepted,
                False,
                len(cards),
                len(survivors),
                len(discarded),
                0,
                float(best.metrics.get(SCORE_KEY) or 0.0),
                committed_version,
                (
                    f"valid={valid_candidates}/{len(survivors)} "
                    f"cell_updates={archive_updates} "
                    f"best={best.metrics.get(SCORE_KEY, 0.0):.6f}"
                ),
                category,
            )
        ]
