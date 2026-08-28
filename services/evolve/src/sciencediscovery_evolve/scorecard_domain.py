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

"""The user's scorecard, as a PUCT :class:`Domain`.

Upstream cut this seam so a second task could run on `futs.search` without a
second copy of the loop: a domain is "the four things the search cannot invent —
the program it starts from, the way a program is scored, the prompt that
rewrites one, and the name of the number being reported". A scorecard is
precisely those four, supplied by the user instead of hard-coded, so this is the
seam being used for what it is for rather than worked around.

Two things this has to get right, and both are about `metrics`.

**`metrics["score"]` is what the tree ranks on, and it must already be oriented
so larger is better.** The scorecard's normalisation is what does that turning —
every criterion produces higher-is-better before it is weighed — so the
aggregate drops straight in. A domain that handed the tree a raw RMSE would have
the search climbing away from the goal, and nothing downstream would say so.

**A constraint violation is `valid=False`, not a low score.** Under PUCT there is
no per-candidate statistical gate to hang a veto on: every candidate becomes a
node, the tree's rank ordering is the whole of the selection pressure, and the
ledger only ever publishes the best node. So an illegal candidate has to be the
same kind of thing as one that would not run — it enters the tree, it scores
`-inf`, and it can never be the best. That is not "scoring it zero": zero would
tie every violator with every other and flatten the ranking the tree exploits,
while `valid=False` plus the constraint's own name stays distinguishable all the
way to the dashboard.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, MutableMapping, Optional, Sequence, Tuple

from .logging_config import get_logger
from .measurement import Dataset, Measurement, measure_shards, shard_indices, TEST
from .prompt import mutation_prompt
from .scorecard import evaluate_constraints, score_candidate
from .vendor.puct.domain import Domain
from .vendor.puct.program import Program
from .vendor.puct.sandbox import SandboxCapability
from .vendor.puct.tree import finite as _finite

log = get_logger("domain")

#: The key the tree ranks on. Upstream's contract, and the reason the scorecard's
#: aggregate has to be oriented before it lands here.
SCORE_KEY = "score"


def scorecard_domain(
    *,
    scorecard: Mapping[str, Any],
    dataset: Dataset,
    capability: SandboxCapability,
    statement: str = "",
    baseline_code: str = "",
    candidate_timeout: float = 60.0,
    baseline: Optional[MutableMapping[str, float]] = None,
) -> Domain:
    """Build the domain for one search.

    ``baseline`` is what the criteria are normalised against, and the caller
    owns it: it is empty until the root has been measured, and the seeding code
    fills it in place. Passed in rather than returned so there is exactly one of
    it — the tree, the strategy and the aggregator all hold this domain by then,
    and handing half of them a rebuilt one is how two baselines start to
    disagree.
    """
    reference: MutableMapping[str, float] = {} if baseline is None else baseline

    def evaluate(code: str, shards: Sequence[int]) -> Tuple[bool, Dict[str, Any], str]:
        result: Measurement = measure_shards(
            code, dataset, shards, capability=capability, timeout=candidate_timeout,
        )
        if not result.ok:
            return False, {SCORE_KEY: float("-inf")}, result.error

        raw = dict(result.values)
        scored = score_candidate(scorecard, raw, reference or raw)
        metrics: Dict[str, Any] = {
            **raw,
            SCORE_KEY: scored.reward,
            "seconds": result.seconds,
        }

        violations = evaluate_constraints(scorecard, raw, reference or raw)
        if violations:
            # Illegal, not merely bad. `-inf` keeps it out of `best()` the same
            # way a crash does, and the constraint's id survives to the event.
            metrics[SCORE_KEY] = float("-inf")
            metrics["violated"] = violations[0].constraint_id
            return False, metrics, violations[0].detail
        return True, metrics, ""

    def reward(metrics: Mapping[str, Any]) -> float:
        value = metrics.get(SCORE_KEY)
        if not isinstance(value, (int, float)):
            return 0.0
        # The engine's reward is a rate in [0, 1]; `-inf` is the tree's sentinel
        # and has no meaning here.
        return max(0.0, min(1.0, float(value)))

    def prompt(program: Program) -> str:
        return mutation_prompt(
            statement=statement,
            scorecard=scorecard,
            parent_code=program.code,
            parent_score=_finite(program.metrics.get(SCORE_KEY)),
            best_score=None,
            recent=(),
        )

    def task_prompt(shard: int) -> str:
        return f"evaluate this program on shard {shard}"

    return Domain(
        name=str(scorecard.get("hash") or "scorecard"),
        entrypoint="train_and_predict",
        metric_key=_primary_metric(scorecard),
        # The scorecard's normalisation has already turned every criterion so
        # that larger is better; the aggregate inherits that.
        metric_better="higher",
        # No fallback: a run with no starting point is refused upstream (the
        # proposal validator, then the engine's seed check). Substituting a
        # canned program here would make "forgot the baseline" run a search on
        # something nobody asked about — and the canned text was verbatim
        # upstream code the OSS scanner rightly flagged.
        initial_program=baseline_code,
        initial_summary="the baseline program",
        evaluate=evaluate,
        reward=reward,
        prompt=prompt,
        task_prompt=task_prompt,
        test_shards=shard_indices(dataset, TEST),
        data_summary={"criteria": [c.get("id") for c in scorecard.get("criteria") or []]},
    )


def _primary_metric(scorecard: Mapping[str, Any]) -> str:
    criteria = scorecard.get("criteria") or []
    if not criteria:
        return SCORE_KEY
    heaviest = max(criteria, key=lambda c: float(c.get("weight", 0)))
    return str(heaviest.get("id") or SCORE_KEY)
