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

"""The ERA search, with the model and the measurement substituted.

Everything between them is the shipping path and is not mocked: `EraTree`,
`EraStrategy`, `EraTreeAggregator`, a real `Ledger` (a real git repo), and
`evolve` / `async_evolve` themselves. What these tests are for is the contract
the rest of the system reads — which events come out, in what order, carrying
what — and that it survives being driven by the framework rather than by a loop
of ours.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import pytest

from sciencediscovery_evolve.completion import CompletionUsage
from sciencediscovery_evolve.engine import RunSpec
from sciencediscovery_evolve.era_engine import EraEngine
from sciencediscovery_evolve.vendor.era.domain import Domain
from sciencediscovery_evolve.vendor.era.program import Program
from sciencediscovery_evolve.vendor.era.sandbox import SandboxCapability

BASELINE = '''"""基线。"""


def train_and_predict(train_path, test_path):
    return [0.0]
'''

CANDIDATE = '''```python
"""换成梯度提升。"""


def train_and_predict(train_path, test_path):
    return [1.0]
```'''

SCORECARD: Dict[str, Any] = {
    "aggregate": "weighted_sum",
    "constraints": [],
    "criteria": [{
        "direction": "maximize", "id": "acc", "name": "准确率",
        "measure": {
            "datasetCas": ["sha256:d"], "kind": "dataset_metric",
            "metric": {"direction": "maximize", "name": "accuracy"},
            "split": {"gateShards": 4, "rolloutShards": 4, "seed": 0,
                      "shardRows": 4, "testShards": 2, "trainRows": None},
            "target": "y",
        },
        "normalize": {"kind": "identity"}, "weight": 1.0,
    }],
    "hash": "sha256:card", "schemaVersion": 1, "solvedThreshold": 0.999,
}


def spec(**overrides: Any) -> RunSpec:
    base: Dict[str, Any] = {
        "algorithm": "era", "expansions": 2, "scorecard": SCORECARD,
        "scorecard_hash": "sha256:card", "search_id": "run-1",
        "statement": "把准确率做上去", "dataset_dir": "/staged",
        "baseline_code": BASELINE, "workers": 1,
        "llm_url": "http://127.0.0.1:4310/x", "llm_token": "run-token",
        "sandbox": SandboxCapability(backend="seatbelt"),
        "options": {"mode": "serial"},
    }
    base.update(overrides)
    return RunSpec(**base)


class Harness:
    """A fake model and a fake measurement; everything between them is real."""

    def __init__(
        self,
        replies: Optional[List[str]] = None,
        scores: Optional[List[float]] = None,
        *,
        capped: bool = False,
        completion_tokens: int = 300,
        violate_from: Optional[int] = None,
        test_shards: Tuple[int, ...] = (8, 9),
    ) -> None:
        self.replies = replies if replies is not None else [CANDIDATE] * 12
        self.scores = scores or [0.4, 0.6, 0.7, 0.8, 0.9]
        self.capped = capped
        self.completion_tokens = completion_tokens
        self.violate_from = violate_from
        self.test_shards = test_shards
        self.prompts: List[str] = []
        self.events: List[Dict[str, Any]] = []
        self.evaluated: List[Tuple[str, Tuple[int, ...]]] = []
        self._reply = 0
        self._score = 0
        #: Set to make the injected model report that the call never returned,
        #: as opposed to returning an empty string.
        self.call_failure = ""
        #: Whether this domain scores an empty candidate as an ordinary zero,
        #: the way three of the four real ones do.
        self.scores_empty_as_zero = False

    # -- injected model --------------------------------------------------------
    def completion_factory(self, run_spec: RunSpec, on_usage: Any, should_stop: Any):
        def complete(
            prompt: str,
            sink: Optional[Callable[[CompletionUsage], None]] = None,
            on_failure: Any = None,
        ) -> str:
            self.prompts.append(prompt)
            reply = self.replies[min(self._reply, len(self.replies) - 1)]
            self._reply += 1
            if sink is not None:
                sink(CompletionUsage(total=1_000, completion=self.completion_tokens,
                                     capped=self.capped))
            if self.call_failure and on_failure is not None:
                on_failure(self.call_failure)
            return reply
        return complete

    # -- injected measurement --------------------------------------------------
    def domain_factory(self, **_kwargs: Any) -> Domain:
        def evaluate(code: str, shards: Sequence[int]) -> Tuple[bool, Dict[str, Any], str]:
            self.evaluated.append((code, tuple(shards)))
            if not code.strip():
                if self.scores_empty_as_zero:
                    # What the judged, gated and scripted domains all do: an
                    # empty candidate is a blank page to mark, an emptied
                    # entrypoint to test, a module with nothing in it to import.
                    # Each of them comes back a perfectly ordinary zero.
                    return True, {"acc": 0.0, "score": 0.0, "seconds": 0.1}, ""
                # And what the measured domain does, only because its AST gate
                # happens to refuse an empty source.
                return False, {"score": float("-inf")}, "gate: empty source"
            if "0.0" in code and "1.0" not in code:      # the baseline
                return True, {"acc": 0.3, "score": 0.3, "seconds": 1.0}, ""
            index = self._score
            self._score += 1
            value = self.scores[min(index, len(self.scores) - 1)]
            if value < 0:
                return False, {"score": float("-inf")}, "候选执行失败：ZeroDivisionError"
            if self.violate_from is not None and index >= self.violate_from:
                return False, {"acc": value, "score": float("-inf"), "violated": "too-slow"}, \
                    "训练时长 412s 超过否决项上限 300s"
            return True, {"acc": value, "score": value, "seconds": 1.0}, ""

        return Domain(
            name="test", entrypoint="train_and_predict", metric_key="acc",
            metric_better="higher", initial_program=BASELINE, initial_summary="基线程序",
            evaluate=evaluate,
            reward=lambda metrics: max(0.0, min(1.0, float(metrics.get("score") or 0.0))),
            prompt=lambda program: f"改进这个程序：{program.change_summary}",
            task_prompt=lambda shard: f"分片 {shard}",
            test_shards=self.test_shards,
        )

    def run(self, run_spec: Optional[RunSpec] = None,
            stop: Callable[[], bool] = lambda: False) -> List[Dict[str, Any]]:
        engine = EraEngine(
            completion_factory=self.completion_factory,
            domain_factory=self.domain_factory,
            store_root=Path(self._store),
        )
        engine.run(run_spec or spec(), self.events.append, stop)
        return self.events

    _store = "/tmp"

    def of(self, kind: str) -> List[Dict[str, Any]]:
        return [event for event in self.events if event["type"] == kind]

    def types(self) -> List[str]:
        return [event["type"] for event in self.events]


@pytest.fixture(autouse=True)
def staged(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The dataset and the candidate runtime are other files' contracts."""
    from sciencediscovery_evolve import era_engine
    from sciencediscovery_evolve.measurement import CriterionPlan, Dataset, Shard

    shards = tuple(
        Shard(index=index, role=role, train=tmp_path / "t.csv",
              test=tmp_path / "x.csv", truth=(1.0,))
        for index, role in [(0, "rollout"), (1, "rollout"), (2, "rollout"), (3, "rollout"),
                            (4, "gate"), (5, "gate"), (6, "gate"), (7, "gate"),
                            (8, "test"), (9, "test")]
    )
    dataset = Dataset((CriterionPlan("acc", "accuracy", shards),))
    monkeypatch.setattr(era_engine, "load_dataset", lambda root, card: dataset)
    monkeypatch.setattr(era_engine, "missing_candidate_runtime", lambda: [])
    Harness._store = str(tmp_path / "candidates")


# --- The event sequence -------------------------------------------------------


def test_a_search_emits_the_sequence_the_rest_of_the_system_reads() -> None:
    harness = Harness()
    harness.run(spec(expansions=2))

    kinds = harness.types()
    assert kinds[0] == "search_started"
    assert "seeded" in kinds
    assert kinds[-1] == "search_finished"
    assert len(harness.of("expanded")) == 2
    # One selection per expansion: a search that emits two nodes for one
    # selection has a tree the graph cannot draw.
    assert len(harness.of("selected")) == len(harness.of("expanded"))
    assert harness.of("search_finished")[0]["status"] == "succeeded"


def test_the_held_out_shards_are_the_scorecard_s_gate_shards() -> None:
    # The engine splits its task list by *position*, so ordering rollout before
    # gate is what makes its held-out set exactly the gate shards rather than an
    # arbitrary fraction. Getting this wrong would score every node on shards
    # the search had already optimised against, silently.
    harness = Harness()
    harness.run(spec(expansions=1))

    scored = [shards for _, shards in harness.evaluated if len(shards) > 1]
    assert scored, "nodes are scored on a shard set, not one shard at a time"
    assert all(set(shards) == {4, 5, 6, 7} for shards in scored[:-1]), scored


def test_the_winner_is_measured_once_on_shards_that_took_no_part() -> None:
    harness = Harness(test_shards=(8, 9))
    harness.run(spec(expansions=1))

    assert harness.evaluated[-1][1] == (8, 9)
    # The only number in the run the search never optimised against.
    assert harness.of("search_finished")[0]["bestTestScore"] is not None


# --- What a node's fate means under ERA ---------------------------------------


def test_becoming_the_best_is_what_acceptance_means_here() -> None:
    # There is no per-candidate statistical gate in ERA: every candidate becomes
    # a node, the tree's rank ordering is the selection pressure, and the ledger
    # publishes the best. So "accepted" is "this node became the best".
    harness = Harness(scores=[0.9, 0.5])
    harness.run(spec(expansions=2))

    merged = harness.of("merged")
    assert merged[0]["accepted"] is True
    assert merged[1]["accepted"] is False
    assert merged[1]["category"] == "below-threshold"


def test_a_failed_candidate_still_enters_the_tree() -> None:
    harness = Harness(scores=[-1.0, 0.7])
    harness.run(spec(expansions=2))

    expanded = harness.of("expanded")
    # Upstream scores a failure -inf and appends it anyway: dropping it would
    # change the rank denominator and the prior on every later iteration.
    assert expanded[0]["valid"] is False
    assert expanded[0]["score"] is None
    assert len(expanded) == 2
    assert harness.of("merged")[0]["category"] == "candidate-failed"


def test_a_constraint_violation_is_a_refusal_that_names_the_constraint() -> None:
    # A veto is a wall, not a cost: the candidate scored well and is refused
    # anyway. Under ERA that has to look like a failed node — `-inf` keeps it out
    # of `best()` the same way a crash does — but it stays distinguishable.
    harness = Harness(violate_from=0)
    harness.run(spec(expansions=1))

    merged = harness.of("merged")[0]
    assert merged["accepted"] is False
    assert merged["category"] == "constraint-violated"
    assert merged["rejectedBy"] == "too-slow"


def test_an_empty_reply_cut_off_by_the_thinking_budget_says_so() -> None:
    harness = Harness(replies=[""], capped=True, completion_tokens=16_001)
    harness.run(spec(expansions=1, max_tokens_per_call=16_000))

    error = harness.of("expanded")[0]["error"]
    assert "16001" in error and "思考" in error


def test_a_call_that_never_returned_is_not_reported_as_an_empty_reply() -> None:
    # Measured on a real endpoint: a thinking-enabled whole-program rewrite ran
    # 900 seconds without the provider sending a response header, the proxy's
    # ceiling cut it off, and the search recorded "模型返回了空回复" — which
    # sends the reader looking for output that was never produced. The two need
    # opposite fixes: one is the provider or the ceiling, one is the prompt.
    harness = Harness(replies=[""])
    harness.call_failure = "fetch failed"
    harness.run(spec(expansions=1))

    error = harness.of("expanded")[0]["error"]
    assert "没有返回" in error and "fetch failed" in error


def test_a_thinking_cutoff_is_not_overwritten_by_the_generic_empty_reply() -> None:
    # The capped-thinking explanation is the more specific one and arrives
    # second; the generic note must not clobber it, and neither must it clobber
    # a call that failed outright.
    harness = Harness(replies=[""], capped=True, completion_tokens=16_001)
    harness.run(spec(expansions=1, max_tokens_per_call=16_000))

    assert "思考" in harness.of("expanded")[0]["error"]


def test_an_empty_reply_is_an_invalid_node_not_a_node_that_scored_zero() -> None:
    """A model call that returned nothing produced no program.

    Three of the four scoring modes would score that as an ordinary zero — the
    judge marks a blank page, the suite fails against an emptied entrypoint, the
    drafted evaluator imports a module with nothing in it — and a zero-scoring
    valid node is the search claiming it tried this direction and it was
    worthless. It tried nothing, and the tree would rank accordingly.
    """
    harness = Harness(replies=[""])
    # A domain that would happily score the blank page, like three of the four
    # real ones. The guard has to be above the domain, or each of them needs its
    # own copy of it and one will be forgotten.
    harness.scores_empty_as_zero = True
    harness.run(spec(expansions=1))

    expanded = harness.of("expanded")[0]
    assert expanded["valid"] is False
    assert expanded["score"] is None


def test_a_run_whose_scores_never_moved_says_so_out_loud() -> None:
    """Watched live: nine candidates, every score 0.6666667, "succeeded".

    The mutation prompt was describing a different contract than the evaluator
    was calling, so no edit ever touched the thing being measured — and nothing
    in the run said so. A flat score set is a scoring problem, and it has to be
    named before the status line frames the run as an achievement.
    """
    harness = Harness(replies=["```python\ndef train_and_predict(a, b):\n    return [0.5]\n```"] * 4,
                      scores=[0.3, 0.3, 0.3, 0.3])
    harness.run(spec(expansions=4))

    message = " ".join(event.get("message", "") for event in harness.of("log"))
    assert "分数全都一样" in message


def test_a_run_whose_scores_did_move_is_not_nagged(): 
    harness = Harness(replies=["```python\ndef train_and_predict(a, b):\n    return [0.5]\n```"] * 4,
                      scores=[0.3, 0.5, 0.6, 0.7])
    harness.run(spec(expansions=4))

    message = " ".join(event.get("message", "") for event in harness.of("log"))
    assert "分数全都一样" not in message


def test_a_search_in_which_nothing_ran_is_a_failure_not_a_success() -> None:
    harness = Harness(replies=[""])
    harness.run(spec(expansions=2))

    assert harness.of("search_finished")[0]["status"] == "failed"
    message = " ".join(event.get("message", "") for event in harness.of("log"))
    assert "没有一个候选跑起来" in message


# --- Refusals -----------------------------------------------------------------


def test_a_resumed_search_is_refused_rather_than_renumbering_nodes() -> None:
    harness = Harness()
    harness.run(spec(resume_from_sequence=42))

    assert harness.of("search_finished")[0]["status"] == "failed"
    assert harness.of("search_started") == []
    assert any("续跑" in event.get("message", "") for event in harness.of("log"))


def test_a_search_without_a_scorecard_is_refused() -> None:
    harness = Harness()
    harness.run(spec(scorecard={}))
    assert harness.of("search_finished")[0]["status"] == "failed"


def test_a_normalisation_this_side_does_not_implement_refuses_the_run() -> None:
    carded = json.loads(json.dumps(SCORECARD))
    carded["criteria"][0]["normalize"] = {"kind": "linear"}
    harness = Harness()
    harness.run(spec(scorecard=carded))

    assert harness.of("search_finished")[0]["status"] == "failed"
    assert any("linear" in event.get("message", "") for event in harness.of("log"))


# --- Counters -----------------------------------------------------------------


def test_visits_are_absolute_and_backpropagate_to_the_root() -> None:
    harness = Harness()
    harness.run(spec(expansions=3))

    for event in harness.of("selected"):
        assert event["ancestorVisits"][-1]["nodeIndex"] == 0, "the chain must reach the root"
    root = [event["ancestorVisits"][-1]["visits"] for event in harness.of("selected")]
    # Absolute counters, monotonically rising — a replayed delta double-counts.
    assert root == sorted(root)


def test_cost_reports_absolute_tokens_and_leaves_price_to_the_control_plane() -> None:
    harness = Harness()
    harness.run(spec(expansions=2))

    tokens = [event["tokens"] for event in harness.of("cost")]
    assert tokens == sorted(tokens)
    assert tokens[-1] == 2_000
    # No price table exists anywhere in this system; a fabricated cents figure
    # would be shown to the user as fact.
    assert all(event["cents"] == 0 for event in harness.of("cost"))


# --- What the framework buys ---------------------------------------------------


@pytest.mark.parametrize("mode", ["serial", "sync", "async"])
def test_every_mode_runs_the_same_search(mode: str) -> None:
    """`serial`, `sync` and `async` are one set of plug-ins under three drivers.

    Upstream runs all three to show the parallel ones are the same search rather
    than a different one that happens to be faster. Here it also means a real
    engine can be driven single-threaded for a reproduction, without falling
    back to the stub.
    """
    harness = Harness(scores=[0.5, 0.6, 0.7, 0.8])
    harness.run(spec(expansions=2, workers=2, options={"mode": mode}))

    assert harness.of("search_finished")[0]["status"] == "succeeded"
    assert len(harness.of("expanded")) == 2
    # Every node hangs off a parent that exists, whichever driver produced it.
    indices = {event["nodeIndex"] for event in harness.of("expanded")} | {0}
    for event in harness.of("expanded"):
        assert event["parentIndex"] in indices


def test_parallel_workers_do_not_collide_on_sequence_or_parent() -> None:
    # The tree reserves a visit at *selection* — upstream's virtual loss — so N
    # workers in flight get different parents rather than all being handed the
    # root. Without it `argmax(puct)` is deterministic and a wave is N copies of
    # one expansion.
    harness = Harness(scores=[0.5, 0.6, 0.7, 0.8, 0.9, 0.95])
    harness.run(spec(expansions=4, workers=2, options={"mode": "async"}))

    expanded = harness.of("expanded")
    assert len(expanded) == 4
    # Node indices are assigned by one thread (the merger), so they are unique
    # and contiguous however many workers produced them.
    assert sorted(event["nodeIndex"] for event in expanded) == [1, 2, 3, 4]
    # Root visits only ever rise, and every selection reserved one.
    root = [event["ancestorVisits"][-1]["visits"] for event in harness.of("selected")]
    assert root == sorted(root)
    assert len(set(root)) == len(root), "two selections must not report the same count"


# --- the judged mode, through the whole engine -----------------------------------

JUDGED_CARD: Dict[str, Any] = {
    "aggregate": "weighted_sum",
    "constraints": [],
    "criteria": [{
        "direction": "maximize", "id": "quality", "name": "质量",
        "measure": {
            "blind": True, "judgeModelId": "judge-1", "kind": "llm_judge",
            "rubricCas": "sha256:r", "samplesPerCandidate": 1,
            "scale": {"max": 9, "min": 0},
            "split": {"gateShards": 4, "rolloutShards": 4, "seed": 0,
                      "shardRows": 1, "testShards": 0, "trainRows": None},
            "varianceThreshold": 0.3,
        },
        "normalize": {"kind": "identity"}, "weight": 1.0,
    }],
    "hash": "sha256:judge", "schemaVersion": 1, "solvedThreshold": 0.85,
}


class JudgeHarness(Harness):
    """The real judge domain, with only the two model calls faked.

    Deliberately *not* injecting the domain: the bug this covers was that the
    domain worked and the wiring around it did not — a judged run has no staged
    dataset, so the task list has to come from the scorecard instead, and
    nothing that stubbed the domain would have noticed.
    """

    def __init__(self, marks: List[float], replies: Optional[List[str]] = None) -> None:
        super().__init__(replies=replies or ["改得更具体。\n\n```\n新的摘要正文\n```"] * 12)
        self.marks = marks
        self._mark = 0
        self.judge_prompts: List[str] = []

    def completion_factory(self, run_spec: RunSpec, on_usage: Any, should_stop: Any):
        def complete(prompt: str, sink: Any = None, on_failure: Any = None) -> str:
            # Both prompts carry the rubric — the mutator should know what it
            # is aiming at — so the grader is told apart by its own opening.
            if prompt.startswith("按下面这份评分细则给这段内容打分"):
                self.judge_prompts.append(prompt)
                mark = self.marks[min(self._mark, len(self.marks) - 1)]
                self._mark += 1
                return str(mark)
            self.prompts.append(prompt)
            reply = self.replies[min(self._reply, len(self.replies) - 1)]
            self._reply += 1
            if sink is not None:
                sink(CompletionUsage(total=1_000, completion=300, capped=False))
            return reply
        return complete


def judged_spec(**overrides: Any) -> RunSpec:
    base: Dict[str, Any] = {
        "scorecard": JUDGED_CARD,
        "rubric": "结论是否在开头（0-3）；论证是否有据（0-3）；有无冗余（0-3）",
        "baseline_code": "这是一段很空洞的初稿。",
        "judge_url": "http://127.0.0.1:4310/x",
        "judge_token": "judge-token",
        "dataset_dir": "",
    }
    base.update(overrides)
    return spec(**base)


def test_a_judged_search_runs_without_a_dataset() -> None:
    # The mode exists for searches that have none. The task list has to come
    # from the scorecard's shard counts instead of from staged shards.
    harness = JudgeHarness(marks=[3, 3, 3, 3, 7, 7, 7, 7, 7, 7, 7, 7])
    harness.run(judged_spec(expansions=1))

    assert harness.of("search_finished")[0]["status"] == "succeeded", \
        " ".join(event.get("message", "") for event in harness.of("log"))
    assert len(harness.of("expanded")) == 1
    assert harness.of("expanded")[0]["valid"] is True


def test_more_gradings_are_asked_for_when_the_card_asks_for_more() -> None:
    # The shard counts are the only place a judged search says how many
    # independent gradings it wants, so they have to reach the judge.
    lean = JudgeHarness(marks=[5] * 60)
    lean.run(judged_spec(expansions=1))
    assert lean.judge_prompts, "the judge was never called"

    thorough_card = json.loads(json.dumps(JUDGED_CARD))
    thorough_card["criteria"][0]["measure"]["split"]["gateShards"] = 8
    thorough = JudgeHarness(marks=[5] * 60)
    thorough.run(judged_spec(expansions=1, scorecard=thorough_card))

    assert len(thorough.judge_prompts) > len(lean.judge_prompts)


def test_the_judge_never_sees_which_candidate_it_is_marking() -> None:
    harness = JudgeHarness(marks=[6] * 40)
    harness.run(judged_spec(expansions=2))

    for prompt in harness.judge_prompts:
        for leak in ("nodeIndex", "父节点", "迭代", "上一版", "#1", "#2"):
            assert leak not in prompt, leak


def test_a_judged_run_without_a_rubric_is_refused_before_anything_is_spent() -> None:
    harness = JudgeHarness(marks=[5] * 8)
    harness.run(judged_spec(rubric="   "))

    assert harness.of("search_finished")[0]["status"] == "failed"
    assert any("评分细则" in event.get("message", "") for event in harness.of("log"))
    assert harness.judge_prompts == []


def test_a_judged_run_without_a_judge_token_is_refused_rather_than_silent() -> None:
    harness = JudgeHarness(marks=[5] * 8)
    harness.run(judged_spec(judge_token=""))

    assert harness.of("search_finished")[0]["status"] == "failed"
    assert any("评审模型" in event.get("message", "") for event in harness.of("log"))


def test_too_few_gradings_is_refused_with_the_number() -> None:
    thin = json.loads(json.dumps(JUDGED_CARD))
    thin["criteria"][0]["measure"]["split"]["gateShards"] = 2
    harness = JudgeHarness(marks=[5] * 8)
    harness.run(judged_spec(scorecard=thin))

    assert harness.of("search_finished")[0]["status"] == "failed"
    # The unit is now "group" for both modes — a repeated grading here, a set of
    # test ids under a test gate — so the message says group.
    assert any("2 组" in event.get("message", "") for event in harness.of("log"))


def test_a_crash_inside_the_domain_is_not_a_successful_run() -> None:
    """Found by breaking an import while deduplicating helpers.

    The framework catches whatever a worker raises, so a `NameError` in our own
    code becomes "no proposals" — and a run that produced nothing at all must
    not report success. The distinction matters because the two have opposite
    fixes: a search that found nothing is a hard problem, and a search that
    crashed is a bug in this repository.
    """
    class Broken(Harness):
        def domain_factory(self, **kwargs: Any) -> Domain:
            built = super().domain_factory(**kwargs)
            from dataclasses import replace

            def explode(program: Any) -> str:
                raise NameError("_finite is not defined")

            return replace(built, prompt=explode)

    harness = Broken()
    harness.run(spec(expansions=2))

    assert harness.of("search_finished")[0]["status"] == "failed"
    assert harness.of("expanded") == []


def test_the_framework_s_stop_reason_reaches_the_run() -> None:
    """A search that stops at 7 of 24 has to say why.

    `stop_reason` / `error` / `retired_workers` come back on the framework's
    result and were being dropped on the floor: the status line then read
    "succeeded" for a run whose workers had died on their second call, with
    nothing anywhere to contradict it.
    """
    from sciencediscovery_evolve.era_engine import _Reporter

    class _Tree:
        nodes = [object()] * 8   # seed + 7 expansions

    emitted: List[Dict[str, Any]] = []
    reporter = _Reporter.__new__(_Reporter)
    reporter.tree = _Tree()
    reporter.emit = emitted.append

    class _Outcome:
        stop_reason = "patience"
        error = ""
        retired_workers = 3

    reporter.note_outcome(_Outcome(), planned=24)

    said = " ".join(json.dumps(event, ensure_ascii=False) for event in emitted)
    assert "3 个 worker" in said          # the workers that died
    assert "24" in said and "7" in said   # planned versus actual
    assert "patience" in said             # the framework's own word for it


def test_a_run_that_spent_its_budget_says_nothing_extra() -> None:
    """max_iters is the ordinary ending; narrating it would be noise."""
    from sciencediscovery_evolve.era_engine import _Reporter

    class _Tree:
        nodes = [object()] * 25

    emitted: List[Dict[str, Any]] = []
    reporter = _Reporter.__new__(_Reporter)
    reporter.tree = _Tree()
    reporter.emit = emitted.append

    class _Outcome:
        stop_reason = "max_iters"
        error = ""
        retired_workers = 0

    reporter.note_outcome(_Outcome(), planned=24)

    assert emitted == []
    # Quiet in the log, but still on the record: a run that stops at 8 of 20
    # has to be answerable afterwards, and staying quiet is not the same as
    # throwing the reason away.
    assert reporter._stop_reason == "max_iters"


def test_the_stop_reason_survives_onto_the_finish_event() -> None:
    """Where the reason is actually recoverable from, after the run.

    A live run planned 20 expansions and made 8. The framework had said why;
    the reporter declined to log the ordinary reasons and kept no field, so
    the only account of it was gone by the time anyone asked.
    """
    from sciencediscovery_evolve import events

    event = events.search_finished(
        "succeeded", 2, 9, best_test_score=0.5708,
        stop_reason="max_iters", expansions_planned=20,
    )

    assert event["stopReason"] == "max_iters"
    assert event["expansionsPlanned"] == 20
    assert event["candidates"] == 9      # planned versus actual, side by side


def test_a_failed_candidate_gets_one_repair_on_its_own_error() -> None:
    """Seven of ten candidates never ran on a live compression search.

    Each failure was discarded and the next expansion wrote the whole program
    again from the parent — a fresh design with a fresh bug. Most of those
    failures were one visible line: an import that raises, an index off by one.
    """
    from sciencediscovery_evolve.vendor.era.search import EraTreeAggregator

    asked = []

    def repair(code, error, iteration):
        asked.append((code, error, iteration))
        return "def solve():\n    return 1\n"

    scored = []

    def evaluate(code, shards):
        scored.append(code)
        if "return 1" in code:
            return True, {"score": 0.8}, ""
        return False, {"score": float("-inf")}, "IndexError: list index out of range"

    aggregator = EraTreeAggregator.__new__(EraTreeAggregator)
    aggregator.repair = repair
    aggregator.domain = type("D", (), {
        "evaluate": staticmethod(evaluate),
        "reward": staticmethod(lambda m: max(0.0, float(m["score"]))),
    })()
    aggregator._held_out_shards = lambda: (0, 1)
    aggregator.on_event = lambda *args: None

    # The shape `step()` runs per surviving card.
    code = "def solve():\n    return [][0]\n"
    valid, metrics, error = _run_one(aggregator, code, {"iteration": "7"})

    assert asked, "a failed candidate was discarded without a repair attempt"
    assert asked[0][1].startswith("IndexError")      # its own error, nothing else
    assert asked[0][2] == 7                          # billed to its own expansion
    assert valid and metrics["score"] == 0.8         # the repaired one is kept


def test_a_candidate_that_crashed_on_every_shard_is_repaired_too() -> None:
    """The case the first version of this missed, found in a live run.

    An evaluator that catches its own exceptions — the shape every mode here
    asks for — reports a *successful measurement of a broken candidate*:
    `valid: true` with a score of 0. Gating the repair on `not valid` therefore
    never fired for the failures it was built for. On a compression run seven
    candidates crashed on every shard, all arrived valid, and the run made nine
    model calls: not one repair among them.
    """
    from sciencediscovery_evolve.vendor.era.search import EraTreeAggregator

    asked = []

    def repair(code, error, iteration):
        asked.append(error)
        return "def solve():\n    return 1\n"

    def evaluate(code, shards):
        if "return 1" in code:
            return True, {"score": 0.8}, ""
        # Valid: the evaluator ran and measured. Zero: nothing worked.
        return True, {"score": 0.0}, "round-trip mismatch"

    aggregator = EraTreeAggregator.__new__(EraTreeAggregator)
    aggregator.repair = repair
    aggregator.domain = type("D", (), {
        "evaluate": staticmethod(evaluate),
        "reward": staticmethod(lambda m: float(m["score"])),
    })()
    aggregator._held_out_shards = lambda: (0, 1)
    aggregator.on_event = lambda *args: None

    valid, metrics, _ = _run_one(aggregator, "def solve():\n    return None\n", {"iteration": "3"})

    assert asked == ["round-trip mismatch"], "a valid-but-zero candidate was never repaired"
    assert metrics["score"] == 0.8


def test_a_working_but_worse_candidate_is_left_alone() -> None:
    """Repair is for candidates that did not run, not for ones that ran badly.

    Making it worse is what the search is for; spending a model call to "fix" a
    candidate that works would buy a second draw from the same distribution at
    the price of the diversity between siblings.
    """
    from sciencediscovery_evolve.vendor.era.search import EraTreeAggregator

    asked = []

    aggregator = EraTreeAggregator.__new__(EraTreeAggregator)
    aggregator.repair = lambda *args: asked.append(args) or "x"
    aggregator.domain = type("D", (), {
        "evaluate": staticmethod(lambda code, shards: (True, {"score": 0.11}, "slow on 2 of 8")),
        "reward": staticmethod(lambda m: float(m["score"])),
    })()
    aggregator._held_out_shards = lambda: (0, 1)
    aggregator.on_event = lambda *args: None

    _run_one(aggregator, "def solve():\n    return 2\n", {"iteration": "3"})

    assert asked == [], "a candidate that ran was sent for repair"


def test_a_repair_that_did_not_help_is_thrown_away() -> None:
    """Watched live, one level below the trigger bug and the same shape.

    Keeping the repair was gated on `fixed`, which is `valid`, which an
    evaluator that catches its own exceptions reports for everything — so the
    repaired version replaced the original unconditionally, including when it
    scored the same 0. The panel said 修好了 twice, both at 0.0000.
    """
    from sciencediscovery_evolve.vendor.era.search import EraTreeAggregator

    from sciencediscovery_evolve.vendor.era.search import EraTreeAggregator

    def evaluate(code, shards):
        # Both measure fine, both score nothing — the repair changed the bug,
        # not the outcome.
        if "repaired" in code:
            return True, {"score": 0.0}, "从修复版来的：还是对不上"
        return True, {"score": 0.0}, "从原版来的：往返对不上"

    aggregator = EraTreeAggregator.__new__(EraTreeAggregator)
    aggregator.repair = lambda code, error, iteration: "def solve():\n    return 'repaired'\n"
    aggregator.domain = type("D", (), {
        "evaluate": staticmethod(evaluate),
        "reward": staticmethod(lambda m: float(m["score"])),
    })()
    aggregator._held_out_shards = lambda: (0, 1)
    aggregator.on_event = lambda *args: None

    _, _, error = _run_one(aggregator, "def solve():\n    return None\n", {"iteration": "1"})

    assert error.startswith("从原版来的"), "没变好的修复顶掉了原版"


def _run_one(aggregator, code, ops):
    """Evaluate, then hand the result to the real `_repair_once`.

    Nothing about the repair is restated here. Two earlier versions of this
    helper spelled the decision out themselves — first `if not valid`, then the
    acceptance check — and each went on passing after the original was
    corrected, proving only that the copy worked. `step()` calls the same
    method, and `test_step_itself_asks_for_the_repair` pins that it still does.
    """
    from sciencediscovery_evolve.vendor.era.search import _evaluate

    valid, metrics, error = _evaluate(aggregator.domain, code, aggregator._held_out_shards())
    _, valid, metrics, error = aggregator._repair_once(code, ops, valid, metrics, error)
    return valid, metrics, error


def test_step_itself_asks_for_the_repair() -> None:
    """The tests above drive `_repair_once`; this pins that `step()` still does.

    Exercising a method the real path stopped calling passes just as happily,
    which is the way a test like that quietly stops meaning anything.
    """
    import inspect

    from sciencediscovery_evolve.vendor.era.search import EraTreeAggregator

    source = inspect.getsource(EraTreeAggregator.step)
    assert "self._repair_once(" in source


def test_the_seed_carries_its_source_so_a_diff_has_a_before() -> None:
    """Every diff in a run rendered as pure addition, nothing ever removed.

    `expanded` carried `codeHash`; `seeded` did not. The detail view diffs a
    candidate against `parent.codeHash`, and a flat tree — ERA's normal shape,
    ten of eleven nodes forking from the root on one live run — means almost
    every parent *is* the root. With no hash there, the "before" side was
    empty and the whole candidate showed as new.
    """
    from sciencediscovery_evolve import events

    event = events.seeded(0, 0.5417, code_hash="sha256:abc", code_chars=5498)

    assert event["codeHash"] == "sha256:abc"
    assert event["codeChars"] == 5498
    # An older run that stored no seed source stays valid rather than carrying
    # a hash that resolves to nothing.
    assert "codeHash" not in events.seeded(0, 0.5417)


def test_the_engine_stores_the_seed_before_announcing_it() -> None:
    """A hash on the event is only useful if the source is fetchable by it."""
    import inspect

    from sciencediscovery_evolve.era_engine import _Reporter

    source = inspect.getsource(_Reporter.on_event)
    seeded_block = source[source.index('kind == "seeded"'):source.index('kind == "node"')]
    assert "self.store.put(" in seeded_block
    assert "code_hash=seed_hash" in seeded_block


def test_each_repair_attempt_sees_what_the_last_one_produced() -> None:
    """One shot cannot debug: the second fix has to read the first fix's error.

    Over two live runs eight one-shot repairs landed two, and the six that
    failed were each handed the original traceback with no view of what their
    own change had done.
    """
    from sciencediscovery_evolve.vendor.era.search import EraTreeAggregator

    saw = []
    fixes = iter(["def f():\n    return 'second'\n", "def f():\n    return 'third'\n"])

    def repair(code, error, iteration):
        saw.append(error)
        return next(fixes)

    def evaluate(code, shards):
        if "third" in code:
            return True, {"score": 0.7}, ""            # finally works
        if "second" in code:
            return True, {"score": 0.0}, "第二次的错：还是不行"
        return True, {"score": 0.0}, "第一次的错：原版坏了"

    aggregator = EraTreeAggregator.__new__(EraTreeAggregator)
    aggregator.repair = repair
    aggregator.domain = type("D", (), {
        "evaluate": staticmethod(evaluate),
        "reward": staticmethod(lambda m: float(m["score"])),
    })()
    aggregator._held_out_shards = lambda: (0, 1)
    aggregator.on_event = lambda *args: None

    valid, metrics, _ = _run_one(aggregator, "def f():\n    return None\n", {"iteration": "2"})

    assert saw == ["第一次的错：原版坏了", "第二次的错：还是不行"], saw
    assert metrics["score"] == 0.7, "第二次修好了，却没被采纳"


def test_debugging_stops_as_soon_as_the_candidate_works() -> None:
    """Every attempt is a model call. A working candidate ends the loop."""
    from sciencediscovery_evolve.vendor.era.search import EraTreeAggregator

    calls = []
    aggregator = EraTreeAggregator.__new__(EraTreeAggregator)
    aggregator.repair = lambda code, error, iteration: (
        calls.append(error) or "def f():\n    return 'fixed'\n")
    aggregator.domain = type("D", (), {
        "evaluate": staticmethod(lambda code, shards:
                                 (True, {"score": 0.6}, "") if "fixed" in code
                                 else (True, {"score": 0.0}, "坏了")),
        "reward": staticmethod(lambda m: float(m["score"])),
    })()
    aggregator._held_out_shards = lambda: (0, 1)
    aggregator.on_event = lambda *args: None

    _run_one(aggregator, "def f():\n    return None\n", {"iteration": "1"})

    assert len(calls) == 1, f"候选已经能跑了还在继续修：{len(calls)} 次"


def test_a_later_attempt_cannot_displace_a_better_earlier_one() -> None:
    """Accepted against the original, so the loop never returns a regression."""
    from sciencediscovery_evolve.vendor.era.search import EraTreeAggregator

    fixes = iter(["def f():\n    return 'good'\n", "def f():\n    return 'worse'\n"])
    scores = {"good": 0.0001, "worse": 0.0}     # both still dead, one less so

    def evaluate(code, shards):
        for tag, value in scores.items():
            if tag in code:
                return True, {"score": value}, f"{tag} 的错"
        return True, {"score": 0.0}, "原版的错"

    aggregator = EraTreeAggregator.__new__(EraTreeAggregator)
    aggregator.repair = lambda code, error, iteration: next(fixes)
    aggregator.domain = type("D", (), {
        "evaluate": staticmethod(evaluate),
        "reward": staticmethod(lambda m: float(m["score"])),
    })()
    aggregator._held_out_shards = lambda: (0, 1)
    aggregator.on_event = lambda *args: None

    _, metrics, _ = _run_one(aggregator, "def f():\n    return None\n", {"iteration": "1"})

    assert metrics["score"] == 0.0001, "更差的第二次顶掉了更好的第一次"


def test_the_repair_is_told_what_the_environment_actually_has() -> None:
    """Replacing what does not exist needs knowing what does.

    Three candidates in one peak-detection run reached for `scipy.signal.cwt`,
    removed in SciPy 1.15. The repair was told to replace it and given no way
    to know what with; none of the three landed.
    """
    import re

    from sciencediscovery_evolve.prompt import repair_prompt

    text = repair_prompt("x = 1", "ImportError: cannot import name 'cwt'")

    assert re.search(r"scipy \d+\.\d+", text), text


def test_max_iters_is_a_rollout_budget_not_an_expansion_count() -> None:
    """A run of 20 stopped at 5, and the two units are why.

    Upstream increments its counter once per clean rollout but calls `propose`
    only when that rollout scored below `solved_threshold` — a task it already
    solves needs no proposal. Measured: a linkage search whose shards held one
    record each scored 0 or 1 with nothing between, 11 of 16 shards came out at
    1.0, and 20 rollouts bought 5 expansions.
    """
    from sciencediscovery_evolve.era_engine import _rollout_budget

    # Enough headroom that the planned expansions stay reachable even when most
    # rollouts are solved-skips: at the 75% observed, 20 expansions need 80.
    assert _rollout_budget(20) >= 80
    assert _rollout_budget(1) >= 1          # never zero, which would stop at once


def test_the_engine_passes_the_rollout_budget_not_the_raw_expansions() -> None:
    """Pins the call site: the fix is worthless if `max_iters` is still fed
    `spec.expansions`, and a test on the helper alone would not notice."""
    import inspect

    from sciencediscovery_evolve.era_engine import EraEngine

    source = inspect.getsource(EraEngine._search)
    assert "max_iters=_rollout_budget(spec.expansions)" in source
    assert "max_iters=spec.expansions" not in source


def test_a_summary_copied_from_the_parent_is_blanked() -> None:
    """Sixteen nodes all read "Lossless text compression: …" on a live run.

    The incremental-edit instruction ("其余部分原样保留") had the model keep
    the seed's spec-style docstring header verbatim, and the header doubles as
    the node label. An empty label is honest about carrying no information;
    sixteen identical ones actively claim the candidates are the same thing.
    """
    import json as jsonlib

    from sciencediscovery_evolve.vendor.era.search import make_propose
    from sciencediscovery_evolve.vendor.era.program import Program
    from sciencediscovery_evolve.vendor.era.tree import EraTree

    seed_code = '"""Lossless text compression: compress(text)->bytes."""\n\nx = 1\n'
    tree = EraTree(c_puct=1.0)
    tree.seed(Program("p0", 0, None, seed_code, "基线", {"score": 0.5}, True, ""), 0.5)

    class _Domain:
        @staticmethod
        def prompt(program):
            return "改进它"

    def complete(prompt, iteration):
        # The model returns new code but keeps the parent's docstring line.
        return ('"""Lossless text compression: compress(text)->bytes."""\n\nx = 2\n',
                "Lossless text compression: compress(text)->bytes.")

    propose = make_propose(tree, complete, _Domain())
    payload = jsonlib.loads(propose("", _task(), "", 0.0))
    assert payload["change_summary"] == ""

    # A genuinely new line survives untouched.
    def complete_fresh(prompt, iteration):
        return ('"""换成 LZ77 滑窗匹配。"""\n\nx = 3\n', "换成 LZ77 滑窗匹配。")

    propose2 = make_propose(tree, complete_fresh, _Domain())
    payload2 = jsonlib.loads(propose2("", _task(), "", 0.0))
    assert payload2["change_summary"] == "换成 LZ77 滑窗匹配。"


def _task():
    from agentdescent.evolution import Task

    return Task(id="t0", prompt="p", meta={"shard": 0})
