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

"""`futs.Node` and `futs.search`'s node list, made safe for N workers.

Lifted from `examples/era/era_empirical_software.py`; see `__init__.py` for the
upstream commit. Four things here are pinned by upstream's own unit tests and
must not be "improved":

1. ``c_puct = 1.0``, the rank normalisation including the single-node 0.5 case,
   and the uniform prior ``P = 1/N``.
2. **A node is appended for every expansion, including a failed one.** Upstream
   scores a failed candidate ``-inf`` and appends it anyway; dropping it would
   change the rank denominator and the prior on every later iteration.
3. Selection is ``argmax(puct)`` over **every** node — there is no descent from
   the root, which is what "flat" names. Exploitation enters through the *rank*,
   so the exploration constant means the same thing whatever the metric's units
   are, and one candidate scoring ``-inf`` cannot swamp the term.
4. The visit is reserved at **selection**, not after execution. With one
   proposal in flight nothing can observe the tree between those two points, so
   it is the same algorithm; with N in flight it is the standard parallel
   virtual loss, and without it ``argmax(puct)`` is deterministic and every
   worker in a batch is handed the same parent.
"""

from __future__ import annotations

import math
import threading
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from agentdescent.selection import Candidate, FlatPuct, SelectionContext

from .program import Program

#: The artifact id the selection rows carry. Only ever compared with itself.
ARTIFACT_ID = "puct"

#: The share of the prior a node keeps once it is judged dead.
#:
#: Not zero. The prior is a bias on where exploration goes, and a zero makes it
#: a mask instead -- a node with no prior can be reached only by winning on rank,
#: which a dead node never does, so the subtree under it becomes unreachable for
#: the rest of the run. A tenth keeps it reachable while making the arithmetic
#: plain: ten dead nodes and one live one still leave the live one half the
#: prior mass.
DEAD_NODE_SHARE = 0.1

#: The prior factors a run may ask for, multiplied together and then normalised.
#:
#: Each answers the same question -- *before looking at how well this node
#: scored, how much of the exploration budget should it get?* -- and each was
#: chosen for carrying something the formula does not already have. That test
#: rules a lot out: the candidate's own quality is the rank, and how often it has
#: been picked is the visit count, so a factor restating either of those buys
#: nothing.
#:
#: **A prior only moves the exploration term.** ``rank`` spans the whole of
#: ``[0, 1]`` while the term this scales is worth roughly ``c_puct / sqrt(N)``
#: at one visit, so no prior overturns a clear ranking -- it decides among nodes
#: the ranking has left close together. That is PUCT working as designed, and it
#: is why `c_puct` and the prior are set together rather than one standing in for
#: the other.
PRIOR_FACTORS = ("judged", "viable", "frontier", "improvement")

#: What a judged prior spans, from a direction the model rates 0 to one it
#: rates full marks.
#:
#: Seven to one, wider than any mechanical factor, because this is the one that
#: was *asked for*: the model has read the candidate against a rubric written
#: for this task, which is more than the tree can work out for itself. Bounded
#: all the same, and for the reason `DEAD_NODE_SHARE` is not zero — a confident
#: and wrong judgement must not be able to make a subtree unreachable for the
#: rest of the run. A node nobody judged takes the midpoint.
JUDGED_FLOOR = 0.25
JUDGED_CEILING = 1.75

#: What the improvement factor spans, worst-trending lineage to best.
#:
#: Expressed as a range over the *rank* of the gain rather than the gain itself,
#: because a search may be ranking RMSE, accuracy or a judge's 0-10 and the
#: exploration term has to mean the same thing in all three -- the same reason
#: upstream ranks the score instead of using it. Three to one is deliberately
#: mild: this is a bias on where to look next, not a second opinion about which
#: candidate is better.
IMPROVEMENT_FLOOR = 0.5
IMPROVEMENT_CEILING = 1.5


def _is_dead_node(node: "Node") -> bool:
    """The tree-side reading of `search._is_dead`, from what a `Node` carries.

    Kept in step with that predicate on purpose: a node the repair loop calls
    dead and the prior calls alive would spend budget on exactly the candidates
    the repair pass already gave up on.
    """
    return (
        not node.program.valid
        or not math.isfinite(node.score)
        or node.score <= 0.0
    )


def _gain_ranks(nodes: Sequence["Node"]) -> List[float]:
    """Each node's improvement over its parent, ranked and normalised to [0, 1].

    The root and any node whose gain is not a finite number sit at the midpoint:
    the root has no parent to have improved on, and a node that crashed has no
    trend to read, so neither has earned a push either way.
    """
    count = len(nodes)
    if count <= 1:
        return [0.5] * count
    by_index = {node.index: node for node in nodes}
    gains: List[Optional[float]] = []
    for node in nodes:
        parent = by_index.get(node.parent_index) if node.parent_index is not None else None
        gain = None if parent is None else node.score - parent.score
        gains.append(gain if gain is not None and math.isfinite(gain) else None)
    known = [index for index, gain in enumerate(gains) if gain is not None]
    if len(known) <= 1:
        return [0.5] * count
    order = sorted(known, key=lambda index: gains[index])
    ranks = [0.5] * count
    for position, index in enumerate(order):
        ranks[index] = position / (len(order) - 1)
    return ranks


def prior_weights(
    nodes: Sequence["Node"],
    factors: Sequence[str],
    judged: Optional[Mapping[int, float]] = None,
) -> List[float]:
    """P(node) for the PUCT exploration term, summing to 1.

    ``()`` reproduces upstream exactly: every node gets ``1/N``, which is what
    `FlatPuct` hardcodes. The factors are multiplicative, so asking for several
    composes rather than picking a winner between them.

    * ``judged`` -- the model's own reading of how promising this direction is,
      in ``[0, 1]``, supplied by the caller in ``judged`` and keyed by node
      index. This is AlphaZero's ``P(s, a)`` with the policy network replaced by
      the model that is already writing the candidates: upstream leaves the
      prior uniform *because* there is nobody to ask, and here there is. What it
      is asked, and by what standard, is the run's own rubric rather than
      anything this file decides. A node with no entry takes the midpoint, which
      is what an unjudged node and a failed judging call both are.
    * ``viable`` -- a node whose program did not run keeps `DEAD_NODE_SHARE` of
      its share. Rank already puts it near the bottom, so this matters in one
      specific shape and not in general: a run where many candidates hard-crash
      to ``-inf`` pushes the merely-broken ones up into the middle of the rank
      order, where the exploration term is what decides.
    * ``frontier`` -- a node's share is divided by ``1 + children``, so a node
      already forked five times yields to one never forked. Visits are close to
      this and not the same thing: a visit backpropagates to every ancestor, so
      an ancestor's count reflects its whole subtree, while this counts only the
      forks taken directly off that node.
    * ``improvement`` -- a node that beat its parent gets up to
      `IMPROVEMENT_CEILING` and one that fell back as little as
      `IMPROVEMENT_FLOOR`. This is the one carrying something no other term has:
      two nodes can hold the same rank and the same visit count while one sits
      on a lineage that is climbing and the other on one that has stalled, and
      the formula cannot tell them apart.
    """
    count = len(nodes)
    if count == 0:
        return []
    weights = [1.0] * count
    if "judged" in factors:
        span = JUDGED_CEILING - JUDGED_FLOOR
        scores = judged or {}
        for index, node in enumerate(nodes):
            rating = scores.get(node.index)
            rating = 0.5 if rating is None else min(1.0, max(0.0, float(rating)))
            weights[index] *= JUDGED_FLOOR + span * rating
    if "viable" in factors:
        for index, node in enumerate(nodes):
            if _is_dead_node(node):
                weights[index] *= DEAD_NODE_SHARE
    if "frontier" in factors:
        children: Counter = Counter(
            node.parent_index for node in nodes if node.parent_index is not None
        )
        for index, node in enumerate(nodes):
            weights[index] /= 1.0 + children[node.index]
    if "improvement" in factors:
        span = IMPROVEMENT_CEILING - IMPROVEMENT_FLOOR
        for index, rank in enumerate(_gain_ranks(nodes)):
            weights[index] *= IMPROVEMENT_FLOOR + span * rank
    total = sum(weights)
    if total <= 0.0:
        return [1.0 / count] * count
    return [weight / total for weight in weights]


class PriorPuct(FlatPuct):
    """`FlatPuct` with the uniform ``1/N`` prior replaced by a supplied one.

    Upstream's loop is transcribed rather than called: `FlatPuct.select` closes
    over ``prior = 1.0 / len(rows)`` as a local, so there is no seam to override.
    `tests/test_puct_fidelity.py` pins this against `FlatPuct` for the uniform
    case -- the same picks, in the same order, over random trees -- which is what
    makes "the default is upstream" a checkable claim rather than a comment.
    """

    def __init__(self, c_puct: float = 1.0, priors: Optional[Sequence[float]] = None) -> None:
        super().__init__(c_puct)
        self.priors = priors

    def select(self, ctx: SelectionContext, n: int) -> Sequence[Candidate]:
        rows = list(ctx.candidates)
        if self.priors is None or len(rows) <= 1 or len(self.priors) != len(rows):
            return super().select(ctx, n)
        ranks = self._rank_scores(rows)
        visits = [row.selected for row in rows]
        by_version = {row.version: index for index, row in enumerate(rows)}
        picked: List[Candidate] = []
        for _ in range(n):
            total = sum(visits)
            best, best_puct = 0, -math.inf
            for index, _row in enumerate(rows):
                puct = ranks[index] + self.c_puct * self.priors[index] * math.sqrt(
                    total) / (1 + visits[index])
                if puct > best_puct:
                    best, best_puct = index, puct
            picked.append(rows[best])
            # The visit upstream backpropagates once the expansion finishes --
            # self, then every ancestor, guarded against a parent chain that
            # loops or points outside the pool.
            seen: Set[int] = set()
            node: Optional[int] = best
            while node is not None and node not in seen:
                seen.add(node)
                visits[node] += 1
                parent = rows[node].parent
                node = by_version.get(parent) if parent is not None else None
        return picked


def finite(value: Any) -> Optional[float]:
    """``-inf`` is upstream's failure sentinel and is not valid strict JSON.

    ``json.dump`` writes it as the bare token ``-Infinity``, which most parsers
    reject — so a result file carrying one is readable by exactly the tool that
    wrote it. Failure is already recorded as ``valid: false``; the score field
    carries ``None`` instead.
    """
    import math

    if value is None:
        return None
    number = float(value)
    return number if math.isfinite(number) else None

@dataclass
class Node:
    """`futs.Node`, with the program payload this port carries alongside it."""

    index: int
    parent_index: Optional[int]
    program: Program
    score: float
    num_visits: int = 0

    def summary(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "parent_index": self.parent_index,
            "program_id": self.program.program_id,
            "iteration": self.program.iteration,
            "change_summary": self.program.change_summary,
            "score": finite(self.score),
            "rmse": self.program.metrics.get("rmse"),
            "num_visits": self.num_visits,
            "valid": self.program.valid,
            "error": self.program.error,
            "code_chars": len(self.program.code),
        }


@dataclass
class PuctTree:
    """`futs.search`'s node list, made safe for N workers to expand at once.

    The only behavioural difference from upstream is *when* a visit is counted:
    upstream backpropagates after `execute_fn` returns, this reserves at
    selection. With one proposal in flight nothing else can observe the tree
    between those two points, so the visit counts every selection sees are
    identical -- `tests/test_puct_example.py` pins that against a transcription
    of upstream's loop.
    """

    c_puct: float = 1.0
    #: Which prior factors shape the exploration term. Empty is upstream's
    #: uniform ``1/N``; see `prior_weights`.
    prior_factors: Tuple[str, ...] = ()
    #: ``node index -> the model's rating of that node's direction, in [0, 1]``.
    #: Written by the engine as nodes land, because the model call belongs to
    #: the engine and this file stays free of one. Missing keys are the
    #: midpoint, so a judging call that failed costs nothing but its own tokens.
    judged: Dict[int, float] = field(default_factory=dict)
    candidate_limit: Optional[int] = None
    nodes: List[Node] = field(default_factory=list)
    _next_iteration: int = 1
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _policy: FlatPuct = field(init=False, repr=False)

    def __post_init__(self) -> None:
        unknown = [f for f in self.prior_factors if f not in PRIOR_FACTORS]
        if unknown:
            raise ValueError(
                f"unknown prior factor(s) {unknown}; expected any of {list(PRIOR_FACTORS)}"
            )
        self._policy = FlatPuct(self.c_puct)

    def seed(self, program: Program, score: float) -> Node:
        with self._lock:
            if self.nodes:
                return self.nodes[0]
            root = Node(0, None, program, score)
            self.nodes.append(root)
            return root

    def _backpropagate_locked(self, node: Node) -> None:
        """`futs.backpropagate_visit` -- the node, then every ancestor."""
        node.num_visits += 1
        if node.parent_index is not None:
            self._backpropagate_locked(self.nodes[node.parent_index])

    def select_parent(self) -> Optional[Tuple[int, Node]]:
        with self._lock:
            if not self.nodes:
                raise RuntimeError("the PUCT tree has not been seeded")
            iteration = self._next_iteration
            if self.candidate_limit is not None and iteration > self.candidate_limit:
                return None
            self._next_iteration += 1
            rows = tuple(
                Candidate(
                    artifact_id=ARTIFACT_ID,
                    version=node.index,
                    score=node.score,
                    selected=node.num_visits,
                    parent=node.parent_index,
                )
                for node in self.nodes
            )
            ctx = SelectionContext(head=rows[0], candidates=rows, n_workers=1)
            # Recomputed per selection, not cached: `viable` and `frontier` both
            # move as the tree grows, and a prior frozen at seed time is the
            # uniform one wearing a different name.
            policy: FlatPuct = (
                PriorPuct(self.c_puct, prior_weights(
                    self.nodes, self.prior_factors, self.judged))
                if self.prior_factors else self._policy
            )
            chosen = self.nodes[policy.select(ctx, 1)[0].version]
            self._backpropagate_locked(chosen)
            return iteration, chosen

    def add_node(self, program: Program, score: float, parent_index: Optional[int]) -> Node:
        """Append an expansion. A failed program is a node too, scoring -inf."""
        with self._lock:
            if parent_index is None or not 0 <= parent_index < len(self.nodes):
                parent_index = 0
            node = Node(len(self.nodes), parent_index, program, score, num_visits=1)
            self.nodes.append(node)
            return node

    def best(self) -> Node:
        with self._lock:
            if not self.nodes:
                raise RuntimeError("the PUCT tree is empty")
            return max(self.nodes, key=lambda node: node.score)

    def root(self) -> Node:
        with self._lock:
            return self.nodes[0]

    def summary(self) -> Dict[str, Any]:
        with self._lock:
            valid = [node for node in self.nodes if node.program.valid]
            depths = []
            for node in self.nodes:
                depth, cursor = 0, node
                while cursor.parent_index is not None:
                    cursor = self.nodes[cursor.parent_index]
                    depth += 1
                depths.append(depth)
            return {
                "nodes": len(self.nodes),
                "valid_nodes": len(valid),
                "max_depth": max(depths) if depths else 0,
                "root_visits": self.nodes[0].num_visits if self.nodes else 0,
                "c_puct": self.c_puct,
                "prior_factors": list(self.prior_factors),
                "judged": dict(self.judged),
                "tree": [node.summary() for node in self.nodes],
            }


