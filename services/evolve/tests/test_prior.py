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

"""The PUCT prior: what shapes the exploration term before the rank is read.

Upstream leaves ``P(s, a)`` uniform because there is no policy network to ask
which sibling looks promising. That is a statement about policy networks, not
about the tree -- the tree does know two things worth acting on, and this is
where they are checked.

The first test is the load-bearing one. ``prior_factors=()`` has to be upstream
*exactly*, or "the default is unchanged" is a comment rather than a fact, and
every fidelity claim in the vendored port rests on the same selection loop.
"""

from __future__ import annotations

import math
import random
from typing import List

import pytest
from agentdescent.selection import Candidate, FlatPuct, SelectionContext

from sciencediscovery_evolve.vendor.puct.program import Program
from sciencediscovery_evolve.vendor.puct.tree import (
    DEAD_NODE_SHARE,
    IMPROVEMENT_CEILING,
    IMPROVEMENT_FLOOR,
    Node,
    PriorPuct,
    PuctTree,
    prior_weights,
)


def _program(code: str = "x = 1", *, valid: bool = True) -> Program:
    return Program(code, 0, None, code, "", {}, valid)


def _node(index: int, parent: int | None, score: float, *, valid: bool = True) -> Node:
    return Node(index, parent, _program(f"v{index}", valid=valid), score)


# --- The default has to be upstream -------------------------------------------


def test_a_uniform_prior_picks_exactly_what_upstream_picks() -> None:
    """`PriorPuct` transcribes `FlatPuct.select`; this is what says so.

    Not a spot check: upstream's prior is a closed-over local, so the only way
    to supply a different one was to copy the loop, and a copy diverges silently.
    Random trees, mixed visit counts, a `None` score and a `-inf` in the pool --
    each of which takes a different branch of the rank normalisation.
    """
    rng = random.Random(20260828)
    for _ in range(200):
        count = rng.randint(2, 12)
        rows = tuple(
            Candidate(
                artifact_id="puct",
                version=index,
                score=rng.choice([None, -math.inf, rng.uniform(-1.0, 1.0)]),
                selected=rng.randint(0, 5),
                parent=None if index == 0 else rng.randrange(index),
            )
            for index in range(count)
        )
        ctx = SelectionContext(head=rows[0], candidates=rows, n_workers=1)
        picks = rng.randint(1, 4)
        uniform = [1.0 / count] * count
        assert [c.version for c in PriorPuct(1.4, uniform).select(ctx, picks)] == [
            c.version for c in FlatPuct(1.4).select(ctx, picks)
        ]


def test_no_factors_leaves_the_tree_on_upstreams_own_policy() -> None:
    """The default path does not merely compute a uniform prior -- it never
    builds one, and runs `FlatPuct` itself. That keeps "unchanged by default"
    true even if `PriorPuct` were to drift."""
    tree = PuctTree(c_puct=1.0)
    tree.seed(_program(), 0.5)
    assert tree.prior_factors == ()
    assert type(tree._policy) is FlatPuct


# --- prior_weights ------------------------------------------------------------


def test_the_weights_are_a_distribution() -> None:
    nodes = [_node(0, None, 0.5), _node(1, 0, 0.0, valid=False), _node(2, 0, 0.7)]
    for factors in [(), ("viable",), ("frontier",), ("viable", "frontier")]:
        weights = prior_weights(nodes, factors)
        assert len(weights) == len(nodes)
        assert all(weight > 0.0 for weight in weights)
        assert math.isclose(sum(weights), 1.0)


def test_no_factors_is_one_over_n() -> None:
    nodes = [_node(0, None, 0.5), _node(1, 0, 0.9), _node(2, 0, 0.1)]
    assert prior_weights(nodes, ()) == pytest.approx([1 / 3, 1 / 3, 1 / 3])


def test_viable_starves_the_node_that_did_not_run() -> None:
    # The three ways a node reads as dead, each on its own: the evaluator never
    # returned, the reward is at its floor, and the score is upstream's `-inf`
    # failure sentinel. All three cost the same share, because from the next
    # expansion's side they are the same situation -- nothing runnable to edit.
    nodes = [
        _node(0, None, 0.6),
        _node(1, 0, 0.0, valid=False),
        _node(2, 0, 0.0),
        _node(3, 0, -math.inf),
    ]
    weights = prior_weights(nodes, ("viable",))
    assert weights[0] == pytest.approx(1.0 / (1.0 + 3 * DEAD_NODE_SHARE))
    assert weights[1] == weights[2] == weights[3]
    assert weights[1] == pytest.approx(weights[0] * DEAD_NODE_SHARE)


def test_a_dead_node_keeps_a_share_rather_than_being_masked() -> None:
    # Zero would make the subtree under a dead node unreachable for the rest of
    # the run: it can only be selected on rank, and a dead node never wins on
    # rank. A floor keeps the prior a bias.
    nodes = [_node(0, None, 0.6)] + [_node(i, 0, 0.0) for i in range(1, 11)]
    weights = prior_weights(nodes, ("viable",))
    assert weights[5] > 0.0
    assert weights[0] == pytest.approx(0.5, abs=1e-9)


def test_frontier_yields_to_the_parent_nobody_has_forked() -> None:
    # Node 1 has been expanded three times, node 2 not at all. Flat selection
    # gives the over-forked node no penalty of its own -- its rank does not move
    # when a child lands -- so without this the same parent keeps winning.
    nodes = [
        _node(0, None, 0.5),
        _node(1, 0, 0.6),
        _node(2, 0, 0.6),
        _node(3, 1, 0.4),
        _node(4, 1, 0.4),
        _node(5, 1, 0.4),
    ]
    weights = prior_weights(nodes, ("frontier",))
    assert weights[2] > weights[1]
    assert weights[1] == pytest.approx(weights[2] / 4.0)


def test_the_factors_compose_rather_than_override() -> None:
    nodes = [_node(0, None, 0.5), _node(1, 0, 0.0), _node(2, 0, 0.6), _node(3, 1, 0.4)]
    both = prior_weights(nodes, ("viable", "frontier"))
    # Node 1 is dead *and* already forked once: it pays both.
    raw = [1.0 / 3.0, DEAD_NODE_SHARE / 2.0, 1.0, 1.0]
    assert both == pytest.approx([value / sum(raw) for value in raw])


def test_an_all_dead_tree_falls_back_to_uniform() -> None:
    # Cannot happen through the front door -- the probe refuses a starting point
    # that does not run, so the root is always alive -- but a zero denominator
    # would be a division by zero rather than a bad search, so it is answered.
    nodes = [_node(0, None, -math.inf), _node(1, 0, -math.inf)]
    assert prior_weights(nodes, ("viable",)) == pytest.approx([0.5, 0.5])
    assert prior_weights([], ("viable",)) == []


# --- Through the tree ---------------------------------------------------------


def test_the_prior_moves_as_the_tree_grows() -> None:
    """A prior computed once at seed time is the uniform one under another name.

    Selection reads it fresh, so a node that was the frontier stops being one as
    soon as it has children.
    """
    tree = PuctTree(c_puct=1.0, prior_factors=("frontier",))
    tree.seed(_program("root"), 0.5)
    tree.add_node(_program("a"), 0.6, 0)
    before = prior_weights(tree.nodes, tree.prior_factors)
    tree.add_node(_program("b"), 0.6, 1)
    after = prior_weights(tree.nodes, tree.prior_factors)
    assert after[1] < before[1]


def test_an_unknown_factor_is_refused_at_construction() -> None:
    # The value arrives from a model-drafted proposal. Ignoring an unknown name
    # would run the search with a prior nobody asked for and report success.
    with pytest.raises(ValueError, match="unknown prior factor"):
        PuctTree(prior_factors=("promising",))


def test_the_summary_reports_which_prior_ran() -> None:
    # The tree summary is what a finished run is read back from; a search whose
    # selection rule is not recorded cannot be compared with another one.
    tree = PuctTree(c_puct=1.7, prior_factors=("viable",))
    tree.seed(_program(), 0.5)
    summary = tree.summary()
    assert summary["c_puct"] == 1.7
    assert summary["prior_factors"] == ["viable"]


def test_viable_bites_where_the_exploration_term_decides() -> None:
    """End to end through `select_parent`, in the one shape where it matters.

    A dead node ranks below every live one, so on rank alone it is never a
    contender. Two things put it in play together, and both are ordinary
    mid-run states: most candidates hard-crashed to `-inf`, which lifts the
    merely-broken one into the middle of the rank order, and everything above it
    has been selected many times already, which is what drains their exploration
    term. Rebuilt from a live compression run where seven of ten candidates
    crashed. Under the uniform prior the dead node wins the next selection; with
    `viable` the budget goes back to a node that runs.
    """
    def build(factors: tuple[str, ...]) -> int:
        tree = PuctTree(c_puct=1.0, prior_factors=factors)
        tree.seed(_program("root"), 0.30)
        tree.add_node(_program("broken"), 0.0, 0)      # 1: dead, middling rank
        tree.add_node(_program("alive"), 0.02, 0)      # 2: alive, ranked above it
        for index in range(6):                          # hard crashes, ranked below
            tree.add_node(_program(f"crash{index}"), -math.inf, 0)
        tree.nodes[0].num_visits = 20                   # both live nodes are worked out
        tree.nodes[2].num_visits = 20
        selection = tree.select_parent()
        assert selection is not None
        return selection[1].index

    assert build(()) == 1
    assert build(("viable",)) != 1


# --- improvement --------------------------------------------------------------


def test_improvement_separates_two_nodes_the_formula_cannot_tell_apart() -> None:
    # Same score, so the same rank; same visit count. The only difference is the
    # lineage: node 2 gained on its parent, node 4 fell back. Nothing else in the
    # PUCT term sees that.
    nodes = [
        _node(0, None, 0.50),
        _node(1, 0, 0.40),
        _node(2, 1, 0.60),   # climbed 0.20
        _node(3, 0, 0.70),
        _node(4, 3, 0.60),   # fell 0.10
    ]
    weights = prior_weights(nodes, ("improvement",))
    assert weights[2] > weights[4]
    assert nodes[2].score == nodes[4].score


def test_improvement_is_bounded_and_unit_free() -> None:
    # The spread is fixed by rank, so multiplying every score by 1000 -- a
    # different metric, same ordering -- must not change the prior at all.
    small = [_node(0, None, 0.5), _node(1, 0, 0.51), _node(2, 0, 0.49), _node(3, 0, 0.60)]
    large = [_node(0, None, 500.0), _node(1, 0, 510.0), _node(2, 0, 490.0), _node(3, 0, 600.0)]
    assert prior_weights(small, ("improvement",)) == pytest.approx(
        prior_weights(large, ("improvement",)))
    ratio = max(prior_weights(small, ("improvement",))) / min(
        prior_weights(small, ("improvement",)))
    assert ratio == pytest.approx(IMPROVEMENT_CEILING / IMPROVEMENT_FLOOR)


def test_a_node_with_no_readable_trend_sits_at_the_midpoint() -> None:
    # The root has no parent, and a crashed node's gain is not a number. Neither
    # has earned a push in either direction, so both take the middle.
    nodes = [_node(0, None, 0.5), _node(1, 0, -math.inf), _node(2, 0, 0.6), _node(3, 0, 0.4)]
    weights = prior_weights(nodes, ("improvement",))
    midpoint = (IMPROVEMENT_FLOOR + IMPROVEMENT_CEILING) / 2
    total = sum([midpoint, midpoint, IMPROVEMENT_CEILING, IMPROVEMENT_FLOOR])
    assert weights[0] == pytest.approx(midpoint / total)
    assert weights[1] == pytest.approx(midpoint / total)


def test_one_measurable_gain_is_not_enough_to_rank() -> None:
    # A single known gain has nothing to be ranked against; dividing by
    # `len(known) - 1` there would be a division by zero.
    nodes = [_node(0, None, 0.5), _node(1, 0, 0.6), _node(2, 0, -math.inf)]
    assert prior_weights(nodes, ("improvement",)) == pytest.approx([1 / 3, 1 / 3, 1 / 3])
