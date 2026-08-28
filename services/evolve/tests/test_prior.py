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

"""The PUCT prior: `P(s, a)` from the model's own rating of a direction.

AlphaZero fills this slot with a policy network. A program search has none,
which is why upstream's default is a uniform ``1/N`` -- but the model writing
the candidates is somebody to ask, and it answers in the reply the search was
already paying for.

**The formula is not ours.** `FlatPuct._priors` lives in `agentdescent`
(0.4.6+) and this port supplies the number it reads. So what is checked here is
the wiring: that the rating survives the trip from the reply to `Candidate.prior`
without being invented, dropped, or turned into a zero. The one arithmetic test
below pins the property the whole design leans on -- ``prior_exponent=0`` is
upstream to the floating-point bit.
"""

from __future__ import annotations

import math

from agentdescent.selection import Candidate, FlatPuct, SelectionContext

from sciencediscovery_evolve.vendor.puct.program import Program, read_promise
from sciencediscovery_evolve.vendor.puct.search import _read_promise_op
from sciencediscovery_evolve.vendor.puct.tree import PuctTree


def _program(code: str = "x = 1", *, valid: bool = True) -> Program:
    return Program(code, 0, None, code, "", {}, valid)


# --- reading the rating out of a reply ----------------------------------------


def test_a_rating_is_read_from_the_reply_the_search_already_paid_for() -> None:
    reply = '"""Switched to a rolling hash."""\n\nx = 1\n\nPROMISE: 8'
    assert read_promise(reply) == 8.0


def test_a_reply_without_a_rating_says_nothing_rather_than_zero() -> None:
    """Absent is not zero, and the distinction is the whole design.

    `FlatPuct._priors` gives an unrated candidate the mean of the rated ones, so
    a missing number costs it nothing. A zero would bar that direction from ever
    being explored on the strength of a line the model forgot to write --
    upstream measured ratings arriving on 25 replies out of 30, so the quiet
    case is common enough to matter.
    """
    assert read_promise('"""Did a thing."""\n\nx = 1\n') is None
    assert read_promise("") is None
    assert read_promise("PROMISE: not a number") is None
    # Zero is the same case: `_priors` filters on `> 0`, so dropping it here
    # keeps the tree's own `promise` field honest about what it holds.
    assert read_promise("PROMISE: 0") is None


def test_the_rating_survives_the_ops_dict_which_is_strings_all_the_way() -> None:
    assert _read_promise_op("8.0") == 8.0
    assert _read_promise_op(repr(7.5)) == 7.5
    for empty in (None, "", "nonsense", "0", "-3", "nan"):
        assert _read_promise_op(empty) is None, empty


# --- the tree hands it to the policy ------------------------------------------


def test_the_default_is_upstream_to_the_floating_point_bit() -> None:
    """`prior_exponent=0` must be the uniform `1/N`, not an approximation of it.

    Every fidelity claim in the vendored port rests on the selection loop being
    upstream's, and the prior is the one input this port supplies to it. Checked
    against `FlatPuct` with no priors at all over trees that take each branch of
    the rank normalisation: a `None` score, a `-inf`, mixed visit counts.
    """
    import random

    rng = random.Random(20260828)
    for _ in range(200):
        count = rng.randint(2, 12)
        scores = [rng.choice([None, -math.inf, rng.uniform(-1.0, 1.0)]) for _ in range(count)]
        visits = [rng.randint(0, 5) for _ in range(count)]
        parents = [None] + [rng.randrange(i) for i in range(1, count)]
        ratings = [rng.uniform(1.0, 10.0) for _ in range(count)]

        def rows(with_prior: bool) -> tuple:
            return tuple(
                Candidate(
                    artifact_id="puct", version=index, score=scores[index],
                    selected=visits[index], parent=parents[index],
                    prior=ratings[index] if with_prior else None,
                )
                for index in range(count)
            )

        picks = rng.randint(1, 4)
        rated = rows(True)
        bare = rows(False)
        # A rating present but ignored, and no rating at all, must pick alike.
        assert [
            c.version for c in FlatPuct(1.4, 0.0).select(
                SelectionContext(head=rated[0], candidates=rated, n_workers=1), picks)
        ] == [
            c.version for c in FlatPuct(1.4).select(
                SelectionContext(head=bare[0], candidates=bare, n_workers=1), picks)
        ]


def test_a_rated_direction_gets_more_of_the_exploration_term() -> None:
    """End to end through `select_parent`, on the shape the prior exists for.

    The dull node scores *higher*, so on rank alone it wins — and that is the
    case worth pinning, because a prior that only agreed with the ranking would
    be telling the search something it already knew. What separates them is the
    model's reading of where each one leads.
    """
    def build(exponent: float) -> int:
        tree = PuctTree(c_puct=2.0, prior_exponent=exponent)
        tree.seed(_program("root"), 0.9)          # the root outranks both
        tree.add_node(_program("dull"), 0.51, 0, promise=1.0)
        tree.add_node(_program("promising"), 0.50, 0, promise=10.0)
        tree.nodes[0].num_visits = 40             # the root's own term is spent
        selection = tree.select_parent()
        assert selection is not None
        return selection[1].index

    assert build(2.0) == 2, "the rating aims the exploration past the better score"
    # And at the upstream default the rating is not consulted at all, so the
    # higher-scoring node wins the way it did before any of this existed.
    assert build(0.0) == 1


def test_an_unrated_node_is_not_starved_by_the_absence_of_a_number() -> None:
    # `_priors` gives it the mean of the rated ones. The check is that it can
    # still be selected at all: a zero here would close off every direction the
    # model happened not to rate.
    tree = PuctTree(c_puct=2.0, prior_exponent=2.0)
    tree.seed(_program("root"), 0.9)
    tree.add_node(_program("rated"), 0.5, 0, promise=5.0)
    tree.add_node(_program("unrated"), 0.5, 0)
    tree.nodes[0].num_visits = 40
    tree.nodes[1].num_visits = 30                 # the rated one is worked out

    selection = tree.select_parent()
    assert selection is not None
    assert selection[1].index == 2


def test_the_summary_records_which_prior_ran() -> None:
    # A finished run is read back from the tree summary; a search whose
    # selection rule is not recorded cannot be compared with another one.
    tree = PuctTree(c_puct=1.7, prior_exponent=2.0)
    tree.seed(_program(), 0.5)
    tree.add_node(_program("a"), 0.6, 0, promise=9.0)
    summary = tree.summary()
    assert summary["c_puct"] == 1.7
    assert summary["prior_exponent"] == 2.0
    assert summary["tree"][1]["promise"] == 9.0
