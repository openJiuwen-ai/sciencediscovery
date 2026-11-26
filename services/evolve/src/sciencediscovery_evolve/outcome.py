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

"""One evaluated candidate: its raw measurements, its normalised criteria, its
aggregate — three different numbers that used to share one flat dict.

A scorecard may name a criterion anything, and the names this side reserves are
ordinary words a user can pick: `score` is the aggregate the tree ranks on,
`seconds` is how long the measurement took. A criterion literally called `score`
is a legitimate raw measurement, and building ``{**raw, "score": reward}`` is how
the evaluator's 0.6 disappeared behind its own normalised 0.3 — and how the
baseline reference that `relative_to_baseline` divides by stayed empty, so every
candidate was normalised against itself.

So the shape is explicit::

    {
      "score": 0.3,                   # the aggregate; the only number ranked on
      "criteria": {"score": 0.3},     # normalised per criterion (the event's payload)
      "rawCriteria": {"score": 0.6},  # the evaluator's measurements, untouched
      "seconds": 1.2,                 # reserved auxiliary measurements
      "accuracy": 0.6,                # raw, flat, for readers that predate rawCriteria
    }

Three rules hold it together:

* A key this outcome itself writes always means what it says. `score` is the
  aggregate even when a criterion shares the name, and a domain that reports a
  wall time keeps `seconds` for it even when a criterion shares *that* name.
  The criterion's own number is then in ``rawCriteria`` rather than flat.
* Every criterion's raw measurement is in ``rawCriteria`` under its own id,
  whatever it is called. That is what the engine's baseline seeding and the
  probe's relative reference read, so a colliding id still gets a reference.
* Every other raw measurement is also written flat under its id, because that
  is the shape stored runs, add-on readers and older tests already index. It is
  a copy, never the only place the value lives.

The three live here, next to the names, rather than in each domain and each
reporter: the duplication is what let one of them keep filtering ``score`` out
of the criteria it published.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

from .scorecard import CandidateScore

#: The aggregate the tree ranks on. A Domain's ``reward`` is this number, and
#: the scorecard's normalisation is what put it in [0, 1].
SCORE_KEY = "score"

#: Normalised per-criterion values, keyed by criterion id. This is what
#: ``evaluated.criteria`` carries, and what `packages/schema` documents it as.
CRITERIA_KEY = "criteria"

#: The evaluator's own measurements, keyed by criterion id, before any
#: normalisation. The only place a criterion called `score` keeps its value.
RAW_CRITERIA_KEY = "rawCriteria"

#: Auxiliary measurements a domain may attach. Reserved because they occupy the
#: same flat namespace a criterion id does.
SECONDS_KEY = "seconds"
VIOLATED_KEY = "violated"
CASE_COUNT_KEY = "cases"
FAILED_KEY = "failed"
CASE_RESULTS_KEY = "caseResults"
GRADINGS_KEY = "gradings"
SPREAD_KEY = "spread"
UNDECIDABLE_KEY = "undecidable"

#: Names a domain writes for its own purposes, and therefore names a criterion
#: may collide with. ``build_outcome`` only blocks the ones an outcome actually
#: carries; this set is for readers of stored metrics that cannot tell.
RESERVED_KEYS = frozenset({
    SCORE_KEY,
    CRITERIA_KEY,
    RAW_CRITERIA_KEY,
    SECONDS_KEY,
    VIOLATED_KEY,
    CASE_COUNT_KEY,
    FAILED_KEY,
    CASE_RESULTS_KEY,
    GRADINGS_KEY,
    SPREAD_KEY,
    UNDECIDABLE_KEY,
})


def _numbers(values: Mapping[str, Any]) -> Dict[str, float]:
    return {
        str(key): float(value)
        for key, value in values.items()
        if isinstance(value, (int, float))
    }


def build_outcome(
    *,
    raw: Mapping[str, Any],
    scored: CandidateScore,
    extra: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """One domain outcome, in the shared shape described in the module docstring.

    ``extra`` holds a domain's auxiliary measurements — seconds, per-case
    results, gradings — under their reserved names. Those names, plus the three
    this function writes, keep their meaning in the flat dict; a criterion with
    one of them is not refused, it keeps its measurement in ``rawCriteria``.
    A name a domain does not use stays available to an evaluator that reports a
    metric under it (the scripted evaluator's own ``cases`` count, for example).
    """
    measurements = _numbers(raw)
    taken = {SCORE_KEY, CRITERIA_KEY, RAW_CRITERIA_KEY} | set(extra or {})
    metrics: Dict[str, Any] = {
        key: value for key, value in measurements.items() if key not in taken
    }
    metrics[RAW_CRITERIA_KEY] = measurements
    metrics[CRITERIA_KEY] = _numbers(scored.criteria)
    if extra:
        metrics.update(extra)
    metrics[SCORE_KEY] = float(scored.reward)
    return metrics


def raw_measurements(metrics: Mapping[str, Any]) -> Dict[str, float]:
    """Every criterion's raw measurement by id, reserved names included.

    Falls back to the flat dict for metrics produced before ``rawCriteria``
    existed (a replayed log, a stored run, a test double): those reserve
    ``score`` for the aggregate, so it is still excluded there.
    """
    stored = metrics.get(RAW_CRITERIA_KEY)
    if isinstance(stored, Mapping):
        return _numbers(stored)
    return {
        key: value for key, value in _numbers(metrics).items()
        if key not in RESERVED_KEYS
    }


def normalized_criteria(metrics: Mapping[str, Any]) -> Dict[str, float]:
    """Per-criterion normalised values, keyed by criterion id.

    For metrics that predate ``criteria`` there is no normalised half to
    recover; the raw measurements are the closest honest answer, and they are
    what the reporter published before, minus the reserved aggregate.
    """
    stored = metrics.get(CRITERIA_KEY)
    if isinstance(stored, Mapping):
        return _numbers(stored)
    return raw_measurements(metrics)
