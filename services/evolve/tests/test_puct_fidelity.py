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

"""Fidelity of the vendored port, pinned against upstream's own fixtures.

Moved here from `agentdescent/tests/test_puct_example.py` together with the code
it checks. **Vendoring the port without these would discard the only thing that
makes vendoring better than re-implementing**: the claim that this is the same
algorithm, checkable rather than asserted.

The first two use the fixtures from google-research/era's `futs_test.py`. The
third is the one that matters most: it drives this port's tree and a line-by-line
transcription of upstream's `futs.search` with the same mock generator and
executor, and asserts they expand the same node at every step and end with the
same visit vector.
"""

from __future__ import annotations

import math
from typing import List, Optional, Tuple

import pytest
from agentdescent.selection import Candidate, FlatPuct, SelectionContext

from sciencediscovery_evolve.vendor.puct import (
    PuctTree,
    Program,
    extract_program,
    validate_source,
)


# --------------------------------------------------------------------------
# A transcription of google-research/era @ b836730 implementation/futs.py
# --------------------------------------------------------------------------


class _UpstreamNode:
    def __init__(self, index, parent_index, program, score):
        self.index = index
        self.parent_index = parent_index
        self.program = program
        self.score = score
        self.num_visits = 0
        self.rank_score = 0.5
        self.puct = 0.5


def _upstream_rank_scores(nodes):
    if len(nodes) == 1:
        nodes[0].rank_score = 0.5
        return
    for rank, node in enumerate(sorted(nodes, key=lambda n: n.score)):
        node.rank_score = rank / (len(nodes) - 1)


def _upstream_pucts(nodes, c_puct):
    prior = 1 / len(nodes)
    total = sum(n.num_visits for n in nodes)
    for node in nodes:
        node.puct = node.rank_score + c_puct * prior * math.sqrt(total) / (1 + node.num_visits)


def _upstream_backpropagate(nodes, node):
    node.num_visits += 1
    if node.parent_index is not None:
        _upstream_backpropagate(nodes, nodes[node.parent_index])


def _upstream_search(initial_program, initial_score, generate, execute,
                     num_iterations, c_puct=1.0):
    """`futs.search`, returning the expansion trace as well as the winner."""
    nodes = [_UpstreamNode(0, None, initial_program, initial_score)]
    trace = []
    for _ in range(num_iterations):
        _upstream_rank_scores(nodes)
        _upstream_pucts(nodes, c_puct)
        best = max(nodes, key=lambda n: n.puct)
        program = generate(best.program, best.score)
        score = execute(program)
        node = _UpstreamNode(len(nodes), best.index, program, score)
        nodes.append(node)
        _upstream_backpropagate(nodes, node)
        trace.append((best.index, program, score))
    winner = max(nodes, key=lambda n: n.score)
    return trace, winner.program, winner.score, [n.num_visits for n in nodes]


# --------------------------------------------------------------------------
# The selection rule
# --------------------------------------------------------------------------


def _rows(spec):
    return tuple(
        Candidate(artifact_id="era", version=i, score=score, selected=visits, parent=parent)
        for i, (score, visits, parent) in enumerate(spec)
    )


def test_rank_scores_match_the_upstream_unit_test():
    # futs_test.py::test_compute_rank_scores
    ranks = FlatPuct._rank_scores(_rows([(1.0, 0, None), (3.0, 0, 0), (2.0, 0, 0)]))
    assert ranks == [0.0, 1.0, 0.5]


def test_a_lone_node_ranks_one_half():
    assert FlatPuct._rank_scores(_rows([(1.0, 0, None)])) == [0.5]


def test_puct_matches_the_upstream_unit_test():
    # futs_test.py::test_compute_pucts -- same nodes, same expected values.
    rows = _rows([(1.0, 1, None), (3.0, 4, 0), (2.0, 0, 0)])
    ranks = [0.0, 1.0, 0.5]
    total, prior = 5, 1 / 3
    expected = [
        ranks[i] + prior * math.sqrt(total) / (1 + visits)
        for i, visits in enumerate((1, 4, 0))
    ]
    assert FlatPuct._rank_scores(rows) == ranks
    policy = FlatPuct(1.0)
    assert expected[2] == pytest.approx(0.5 + prior * math.sqrt(5))
    assert policy.select(SelectionContext(head=rows[0], candidates=rows), 1)[0].version == (
        max(range(3), key=lambda i: expected[i]))


def test_a_second_pick_reserves_a_visit_up_the_parent_chain():
    """Upstream is serial, so `n > 1` is this port's generalisation.

    The reservation is what stops N workers from all being sent to the same node
    on evidence that has not arrived yet.
    """
    rows = _rows([(1.0, 1, None), (3.0, 1, 0), (2.0, 1, 0)])
    policy = FlatPuct(10.0)
    ctx = SelectionContext(head=rows[0], candidates=rows)
    picked = [candidate.version for candidate in policy.select(ctx, 2)]

    first = policy.select(ctx, 1)[0].version
    bumped = list(rows)
    cursor: Optional[int] = first
    while cursor is not None:
        row = bumped[cursor]
        bumped[cursor] = Candidate(artifact_id=row.artifact_id, version=row.version,
                                   score=row.score, selected=row.selected + 1,
                                   parent=row.parent)
        cursor = bumped[cursor].parent
    second = policy.select(
        SelectionContext(head=bumped[0], candidates=tuple(bumped)), 1)[0].version

    assert picked == [first, second]
    assert picked[0] != picked[1]


def test_serial_tree_reproduces_upstream_futs():
    """The port's tree and upstream's loop expand the same node every time."""

    def generate(program, _score):
        return f"v{int(program[1:]) + 1}"

    def execute(program):
        # Non-monotone on purpose: a version number alone would make every new
        # node the best one and hide any selection difference.
        return float((int(program[1:]) * 7) % 11)

    trace, best_program, best_score, visits = _upstream_search(
        "v0", 0.0, generate, execute, num_iterations=12)

    tree = PuctTree(c_puct=1.0, candidate_limit=12)
    tree.seed(Program("root", 0, None, "v0", "", {"rmse": None}, True), 0.0)
    ours: List[Tuple[int, str, float]] = []
    while True:
        selection = tree.select_parent()
        if selection is None:
            break
        _, parent = selection
        program = generate(parent.program.code, parent.score)
        score = execute(program)
        tree.add_node(
            Program(program, 0, parent.program.program_id, program, "", {"rmse": None}, True),
            score,
            parent.index,
        )
        ours.append((parent.index, program, score))

    assert ours == trace
    assert tree.best().program.code == best_program
    assert tree.best().score == best_score
    assert [node.num_visits for node in tree.nodes] == visits


def test_a_failed_expansion_is_still_a_node():
    """Upstream returns `-inf` from a failed execution and appends the node
    anyway. Dropping it would change the rank denominator and the prior on every
    later iteration, so this is fidelity rather than tidiness."""
    tree = PuctTree(c_puct=1.0)
    tree.seed(Program("root", 0, None, "v0", "", {}, True), 0.5)
    tree.add_node(Program("bad", 1, "root", "", "", {}, False), float("-inf"), 0)

    assert len(tree.nodes) == 2
    assert tree.nodes[1].score == float("-inf")
    assert tree.best().index == 0, "a failed candidate can never be the best"
    # And it never reaches a caller as `-inf`: not valid strict JSON.
    assert tree.nodes[1].summary()["score"] is None
    assert tree.nodes[1].summary()["valid"] is False


# --------------------------------------------------------------------------
# The gate and the parser
# --------------------------------------------------------------------------


def test_gate_accepts_an_ordinary_baseline_and_rejects_unsafe_code():
    """The gate is not the security boundary — the sandbox is — but it is what
    makes the ordinary accidents fail in-process with a readable message."""
    # Our own minimal baseline, not upstream's verbatim text (which the OSS
    # scanner flagged and nothing shipped needs): the point is that the gate
    # admits an ordinary sklearn program, not any particular wording of one.
    baseline = (
        "import pandas as pd\n"
        "from sklearn.linear_model import LinearRegression\n\n"
        "def train_and_predict(train_path, test_path):\n"
        "    train = pd.read_csv(train_path)\n"
        "    test = pd.read_csv(test_path)\n"
        "    model = LinearRegression()\n"
        "    model.fit(train.iloc[:, :-1], train.iloc[:, -1])\n"
        "    return model.predict(test)\n"
    )
    assert validate_source(baseline)[0]
    assert not validate_source("import subprocess\ndef train_and_predict(a, b): return []")[0]
    assert not validate_source(
        "def train_and_predict(a, b):\n    return open('/etc/passwd').read()\n")[0]
    assert not validate_source("import pandas as pd\ndef helper(a, b): return []")[0]


def test_the_gate_admits_what_is_installed_and_names_what_is_not() -> None:
    """The list this replaced was a guess, and it was wrong where it cost most.

    It named thirteen modules and none of the gradient-boosting libraries a
    model reaches for on a tabular task, so real runs lost candidates to it —
    and once lost a whole run, when a drafted starting point imported
    ``catboost`` and the probe reported that the starting point would not run.
    The gate is not the isolation boundary (the sandbox is), so refusing an
    installed package was never a security decision; it was a false claim that
    the import would not work.
    """
    body = "\n\n\ndef train_and_predict(train_path, test_path):\n    return []\n"

    # Installed and not reaching outside: admitted, whether or not anyone
    # thought to write it down.
    assert validate_source("import sklearn" + body)[0]

    # Not installed here. Refused — but as a deployment fact, not a verdict on
    # the candidate, because the two need opposite fixes.
    ok, why = validate_source("import definitely_not_installed_xyz" + body)
    assert not ok
    assert "not installed" in why

    # Reaches outside the process. Refused whatever the venv holds: it would die
    # against the sandbox profile anyway, and an in-process message is readable.
    ok, why = validate_source("import socket" + body)
    assert not ok
    assert "outside the sandbox" in why


def test_the_prompt_names_packages_this_deployment_actually_has() -> None:
    from sciencediscovery_evolve.vendor.puct.program import available_imports

    names = available_imports()
    assert "pandas" in names and "sklearn" in names
    # Probed, not listed: a prompt that promises a package the venv lacks turns
    # every candidate that takes it up into a failed one.
    import importlib.util

    assert all(importlib.util.find_spec(name) is not None for name in names)
    assert not validate_source("import xgboost\ndef train_and_predict(a, b): return []")[0]


def test_extract_program_prefers_the_longest_fenced_block():
    reply = (
        "Here is the idea:\n```python\nprint('short')\n```\n"
        "and the solution:\n```python\n\"\"\"Gradient boosting on ratios.\"\"\"\n"
        "import pandas as pd\n\n\ndef train_and_predict(a, b):\n    return []\n```\n"
    )
    code, summary = extract_program(reply)
    assert "train_and_predict" in code and "short" not in code
    assert summary == "Gradient boosting on ratios."


def test_extract_program_falls_back_to_the_whole_reply():
    code, summary = extract_program("def train_and_predict(a, b):\n    return []\n")
    assert code.startswith("def train_and_predict")
    assert summary == ""


def test_the_prompt_gives_versions_not_just_package_names() -> None:
    """Names alone cost a whole run.

    `scipy` is installed, so the prompt said `scipy` — and three of four
    candidates on a peak-detection search reached for `scipy.signal.cwt` and
    `ricker`, which every tutorial written before 2025 uses and which SciPy
    removed in 1.15. Two crashed mid-run, one failed at import. A model told
    `scipy 1.18.0` can know that; a model told `scipy` cannot.

    Same rule as the names themselves: probed here, never written down.
    """
    import re

    from sciencediscovery_evolve.vendor.puct.program import available_imports_text

    text = available_imports_text()
    assert re.search(r"\bnumpy \d+\.\d+", text), text
    assert re.search(r"\bscipy \d+\.\d+", text), text
    # Ships as `scikit-learn`, imported as `sklearn`: the mapping is read, not
    # guessed, and getting it wrong silently drops the version.
    assert re.search(r"\bsklearn \d+\.\d+", text), text
    # Stdlib has no version to give and must not be dressed up with one.
    assert re.search(r"\bmath(?:、|$)", text), text

    # And the prompt has to actually use it. Testing the helper alone passes
    # whether or not anything calls it — the first version of this test did
    # exactly that, and unwiring the prompt left it green.
    from sciencediscovery_evolve.prompt import mutation_prompt

    for kwargs in ({"script_contract": "f(x)"}, {"frozen": ["tests/**"]}, {}):
        rendered = mutation_prompt(
            statement="s", scorecard={}, parent_code="x=1",
            parent_score=0.5, best_score=0.5, **kwargs,
        )
        assert re.search(r"scipy \d+\.\d+", rendered), kwargs


def test_a_repair_may_replace_something_that_does_not_exist() -> None:
    """The repair prompt used to forbid the only possible fix.

    "不要换方法" is right for an off-by-one and wrong for `cannot import name
    'cwt'`, where the method itself is what is missing. Watched the repair fire
    three times on that error and land none of them.
    """
    from sciencediscovery_evolve.prompt import repair_prompt

    text = repair_prompt("x = 1", "ImportError: cannot import name 'cwt'")

    assert "不要换方法" not in text
    assert "不存在" in text and "等价" in text
    # Still narrow everywhere else: a redesign is what the ordinary expansion
    # already does.
    assert "不要重新设计" in text
