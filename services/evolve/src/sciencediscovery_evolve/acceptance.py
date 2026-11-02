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

"""Whether a run's held-out score is evidence that it improved anything.

`bestTestScore` is one evaluation of one candidate on cases the search never
saw. That is a number, not a result: a candidate that passes 5 of 8 cases and a
baseline that passes 5 of 8 report the same "improvement" as one that passes 8
of 8 against a baseline at 3, and the payload cannot tell them apart. The
missing piece is the baseline on the *same cases*, and a statistic over the
pairs.

**The test is the exact paired sign test, and nothing is invented.** Cases land
in three buckets by pairing on case id: the candidate passes where the baseline
fails (a win), fails where the baseline passes (a loss), or both agree (a tie).
Ties say nothing about direction and drop out. Under the null that a win and a
loss are equally likely, the number of wins is Binomial(decided, 1/2), and the
two-sided p-value is exact -- `math.comb`, no normal approximation, no rank
invention.

**The p-value alone is not the verdict.** It is two-sided, so 0 wins and 6
losses is exactly as extreme as 6 wins and 0 losses. `established` is a claim
about improvement and needs `pValue <= alpha` *and* `wins > losses`; a
significant result in the other direction is `not established`, with the
direction always readable from the `wins`/`losses`/`pValue` fields.

**Fewer than six decided cases is `insufficient`.** The smallest possible
two-sided p-value with five decided cases is 0.0625, above alpha 0.05, so no
outcome of five or fewer pairs can support the claim; reporting "not
established" there would blame the candidate for a gate that never had the
power to say otherwise. A perfectly balanced split (as many wins as losses) is
the same kind of silence for a different reason: the exact p-value is 1.0 by
construction, so nothing about that run supports an improvement claim.

**The p-value is optimistic when cases correlate.** Cases from one suite share
fixtures, imports and runners, so one broken import can decide many of them at
once. The verdict is evidence at a stated alpha, never a guarantee; a later
change may replace this statistic with a cluster-aware one if suites show
correlation.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Mapping

#: The alpha the verdict is stated at.
DEFAULT_ALPHA = 0.05

#: Below this many decided cases no outcome can reach alpha two-sided
#: (the smallest possible p-value with five is 0.0625), so the gate is silent.
MIN_DECIDED = 6


def paired_evidence(
    baseline: Mapping[str, bool],
    candidate: Mapping[str, bool],
    alpha: float = DEFAULT_ALPHA,
) -> Dict[str, Any]:
    """Compare two runs of the same gate, case by case.

    ``baseline`` and ``candidate`` map a case id to whether that case passed.
    Only ids present in both maps take part: a case one side did not run is not
    comparable, and counting it would pad `n` with a result nobody measured.
    """
    wins = losses = ties = 0
    for case, candidate_passed in candidate.items():
        baseline_passed = baseline.get(case)
        if baseline_passed is None:
            continue
        if candidate_passed and not baseline_passed:
            wins += 1
        elif baseline_passed and not candidate_passed:
            losses += 1
        else:
            ties += 1

    decided = wins + losses
    p_value = _two_sided_sign_p(wins, losses)
    if decided < MIN_DECIDED or wins == losses:
        # A balanced split is the gate saying nothing: the exact p-value is 1.0
        # by construction and more cases of the same shape cannot move it. No
        # verdict other than `insufficient` is possible here.
        verdict = "insufficient"
    elif p_value <= alpha and wins > losses:
        # Significant *and* in the candidate's favour. The p-value is two-sided,
        # so a candidate that lost every case is exactly as extreme as one that
        # won every case; `established` is a claim about improvement, never
        # about a difference, and the direction lives in wins/losses/pValue.
        verdict = "established"
    else:
        verdict = "not established"

    return {
        "wins": wins,
        "losses": losses,
        "ties": ties,
        "n": wins + losses + ties,
        "pValue": p_value,
        "alpha": alpha,
        "verdict": verdict,
    }


def _two_sided_sign_p(wins: int, losses: int) -> float:
    """Exact two-sided sign-test p-value; 1.0 when nothing was decided."""
    decided = wins + losses
    if decided == 0:
        return 1.0
    tail = sum(math.comb(decided, k) for k in range(min(wins, losses) + 1)) / 2 ** decided
    return min(1.0, 2.0 * tail)
