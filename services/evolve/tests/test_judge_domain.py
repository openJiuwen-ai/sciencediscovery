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

"""Scoring by a model, which is the only non-deterministic mode there is.

Every test here is one of the five things that follow from that, and each one
fails quietly if it is left out: a single sample read as a measurement, noise
recorded as a bad candidate, or a judge told which version it is looking at.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from sciencediscovery_evolve.judge_domain import grader, judge_domain
from sciencediscovery_evolve.text_candidate import extract_text

RUBRIC = "结论是否在开头；论证是否有据；有无冗余。每项 0-3 分，满分 9。"

CARD: Dict[str, Any] = {
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
            "varianceThreshold": 0.2,
        },
        "normalize": {"kind": "identity"}, "weight": 1.0,
    }],
    "hash": "sha256:judge", "schemaVersion": 1, "solvedThreshold": 0.85,
}


def domain(scores: List[Optional[float]], card: Optional[Dict[str, Any]] = None):
    """A judge that returns these numbers in order, cycling."""
    calls: List[str] = []

    def grade(candidate: str, seed: int) -> Optional[float]:
        calls.append(candidate)
        return scores[min(len(calls) - 1, len(scores) - 1)]

    built = judge_domain(
        scorecard=card or CARD, rubric=RUBRIC, grade=grade,
        statement="把这段写得更好", baseline_text="初稿",
    )
    return built, calls


def test_the_median_decides_not_a_single_sample() -> None:
    # One sample of a noisy scorer is a coin flip that the tree would treat as a
    # measurement.
    built, calls = domain([5.4, 4.5, 4.5, 4.5])
    valid, metrics, error = built.evaluate("候选", (0, 1, 2, 3))

    assert valid, error
    assert len(calls) == 4
    assert metrics["gradings"] == 4
    # Median of 0.6, 0.5, 0.5, 0.5 → 0.5. Believing the first call would have
    # recorded 0.6, and the tree would have ranked on a coin flip.
    assert metrics["quality"] == pytest.approx(0.5)


def test_a_spread_too_wide_is_undecidable_rather_than_bad() -> None:
    # Recording it as a low score would turn the judge's noise into a ranking
    # signal and poison the denominator for every later iteration.
    built, _ = domain([0.0, 9.0, 0.0, 9.0])
    valid, metrics, error = built.evaluate("候选", (0, 1, 2, 3))

    assert not valid
    assert metrics["undecidable"] is True
    assert metrics["score"] == float("-inf")
    # And it says which it is: "could not tell" is not "is bad".
    assert "判不出好坏" in error
    assert "不是判成差" in error


def test_a_judge_that_does_not_answer_is_not_a_zero() -> None:
    # A judge that failed to reply says nothing about the candidate; scoring it
    # would say something.
    built, _ = domain([None, None, None, None])
    valid, metrics, error = built.evaluate("候选", (0, 1, 2, 3))

    assert not valid
    assert "有效评分" in error
    assert metrics["score"] == float("-inf")


def test_an_empty_candidate_is_a_failure_before_any_call_is_paid_for() -> None:
    built, calls = domain([5.0])
    valid, _metrics, error = built.evaluate("   ", (0, 1, 2, 3))

    assert not valid
    assert "空的" in error
    assert calls == [], "an empty candidate is not worth four model calls"


def test_the_judge_is_shown_the_rubric_and_the_candidate_and_nothing_else() -> None:
    # Tell a judge this is version 7 and the previous scored 0.8, and "newer is
    # better" becomes a self-fulfilling ranking.
    seen: List[str] = []

    def complete(prompt: str) -> str:
        seen.append(prompt)
        return "7"

    grade = grader(complete, RUBRIC, {"max": 9, "min": 0})
    assert grade("候选正文", seed=3) == pytest.approx(7.0)

    prompt = seen[0]
    assert RUBRIC in prompt
    assert "候选正文" in prompt
    for leak in ("迭代", "父", "上一轮", "version", "0.8"):
        assert leak not in prompt, leak


def test_two_identical_candidates_can_be_graded_to_the_same_number() -> None:
    # The seed comes from the shard and the repetition, not from the text: a
    # seed derived from the candidate would make identical candidates
    # ungradable to the same score, and the tree would rank noise.
    seeds: List[int] = []

    def grade(candidate: str, seed: int) -> Optional[float]:
        seeds.append(seed)
        return 6.0

    built = judge_domain(scorecard=CARD, rubric=RUBRIC, grade=grade, baseline_text="")
    built.evaluate("一样的文本", (0, 1))
    first = list(seeds)
    seeds.clear()
    built.evaluate("一样的文本", (0, 1))

    assert seeds == first


def test_the_scale_is_normalised_into_zero_to_one() -> None:
    built, _ = domain([9.0, 9.0, 9.0, 9.0])
    _valid, metrics, _error = built.evaluate("候选", (0, 1, 2, 3))
    # Full marks on a 0-9 rubric is 1.0, not 9.
    assert metrics["quality"] == pytest.approx(1.0)

    built, _ = domain([0.0, 0.0, 0.0, 0.0])
    _valid, metrics, _error = built.evaluate("候选", (0, 1, 2, 3))
    assert metrics["quality"] == pytest.approx(0.0)


def test_a_reply_that_is_not_a_number_is_no_answer_rather_than_zero() -> None:
    grade = grader(lambda prompt: "这段写得不错", RUBRIC, {"max": 9, "min": 0})
    assert grade("候选", seed=0) is None


def test_a_judge_answering_outside_the_scale_is_clamped_not_believed() -> None:
    high = grader(lambda prompt: "42", RUBRIC, {"max": 9, "min": 0})
    assert high("候选", seed=0) == pytest.approx(9.0)
    low = grader(lambda prompt: "-5", RUBRIC, {"max": 9, "min": 0})
    assert low("候选", seed=0) == pytest.approx(0.0)


def test_the_mutation_prompt_carries_the_rubric_rather_than_the_program_contract() -> None:
    from sciencediscovery_evolve.vendor.era.program import Program

    built, _ = domain([5.0])
    prompt = built.prompt(Program("p", 1, None, "当前正文", "上一次改动", {}, True))

    assert RUBRIC in prompt
    assert "当前正文" in prompt
    # None of the program contract applies to a paragraph.
    assert "train_and_predict" not in prompt
    assert "import" not in prompt


# --- reading the rewritten text back -------------------------------------------


def test_a_fenced_rewrite_keeps_its_summary_line() -> None:
    candidate, summary = extract_text("把结论提到开头。\n\n```\n新的正文\n第二段\n```")
    assert candidate == "新的正文\n第二段"
    assert summary == "把结论提到开头。"


def test_an_unfenced_reply_is_the_candidate_rather_than_being_discarded() -> None:
    # Losing a perfectly good rewrite over formatting is the worse failure.
    candidate, summary = extract_text("就这一段，没有围栏。")
    assert candidate == "就这一段，没有围栏。"
    assert summary == ""


def test_the_longest_block_wins_so_an_explanation_is_not_adopted() -> None:
    reply = "改了开头。\n\n```\n短的说明\n```\n\n```\n这才是完整的新正文，长得多，应该被采纳。\n```"
    candidate, _summary = extract_text(reply)
    assert "完整的新正文" in candidate
