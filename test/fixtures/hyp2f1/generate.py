#!/usr/bin/env python3
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
"""Write `points.json` for the 2F1 double-precision search case.

The case's problem statement fixes the sampling distribution, the exclusions
and the scoring, and says the reference values are frozen ahead of time with
mpmath at 30 and 60 dps. This script is that freezing step: it samples exactly
the documented distribution, drops the points the statement excludes, keeps
only values the two precisions agree on to 25 digits, and writes three splits
of 8 shards x 125 rows.

    python3 generate.py --out points.json

mpmath is a build-time dependency only; the evaluator the design writes runs
without it.
"""

from __future__ import annotations

import argparse
import json
import random
import sys

import mpmath as mp

# The statement's numbers, not tunables: 3000 evaluation points, aligned to the
# search's split (8 shards x 125 rows per split).
SPLITS = ("gate", "rollout", "test")
SHARDS = 8
SHARD_ROWS = 125
ROWS_PER_SPLIT = SHARDS * SHARD_ROWS
SEED = 0
# Points are accepted while |truth| >= 1e-250, and the two precisions must
# agree to 1e-25 relative before the value is written down.
MIN_ABS = mp.mpf("1e-250")
AGREEMENT = mp.mpf("1e-25")
# A hard stop so a distribution that mostly gets rejected cannot loop forever.
MAX_ATTEMPTS = 60_000


def sample(rng: random.Random) -> tuple[float, float, float, float]:
    """a, b, c ~ U(-30, 30); z ~ U(-40, 0.999), independently."""
    return (
        rng.uniform(-30.0, 30.0),
        rng.uniform(-30.0, 30.0),
        rng.uniform(-30.0, 30.0),
        rng.uniform(-40.0, 0.999),
    )


def excluded(a: float, b: float, c: float, z: float, v30, v60) -> str | None:
    """Why this point is dropped, or None to keep it.

    The reasons are separate so the summary can report them: a run that
    rejects mostly on one rule is a different distribution than one that
    rejects evenly.
    """
    # c within 1e-3 of a non-positive integer: 2F1 is undefined or has a pole
    # there, and a point next to the pole is noise rather than a test.
    if c <= 0 and abs(c - round(c)) < 1e-3:
        return "c_near_nonpositive_integer"
    if not (mp.isfinite(v30) and mp.isfinite(v60)):
        return "not_finite"
    # Below 60 dps the *comparison itself* would be rounded to 15 digits and
    # accept a point whose two evaluations only agree to ~1e-17.
    with mp.workdps(60):
        if abs(v60) < MIN_ABS:
            return "too_small"
        if abs(v30 - v60) > AGREEMENT * abs(v60):
            return "precisions_disagree"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="points.json")
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    rejected: dict[str, int] = {}
    splits: dict[str, list[list]] = {name: [] for name in SPLITS}
    order = [name for name in SPLITS for _ in range(ROWS_PER_SPLIT)]
    attempts = 0

    while order and attempts < MAX_ATTEMPTS:
        attempts += 1
        a, b, c, z = sample(rng)
        # Two mpmath contexts instead of two global precision switches: the
        # point is the agreement between independent evaluations, not between
        # one evaluation and itself.
        with mp.workdps(30):
            v30 = mp.hyp2f1(mp.mpf(a), mp.mpf(b), mp.mpf(c), mp.mpf(z))
        with mp.workdps(60):
            v60 = mp.hyp2f1(mp.mpf(a), mp.mpf(b), mp.mpf(c), mp.mpf(z))
        reason = excluded(a, b, c, z, v30, v60)
        if reason is not None:
            rejected[reason] = rejected.get(reason, 0) + 1
            continue
        splits[order.pop()].append([a, b, c, z, mp.nstr(v60, 30)])

    if order:
        print(f"only {sum(len(v) for v in splits.values())} points after {attempts} attempts", file=sys.stderr)
        return 1

    # Shards are contiguous runs of 125 rows, which is how the evaluator reads
    # them: split[i * SHARD_ROWS:(i + 1) * SHARD_ROWS].
    document = {
        "interface": "hyp2f1(a, b, c, z) -> float",
        "units": "a, b, c ~ U(-30, 30); z ~ U(-40, 0.999); value is 2F1(a, b, c, z)",
        "precision": "mpmath 30 and 60 dps, agreeing to 25 digits",
        "rows": {name: splits[name] for name in SPLITS},
        "shards": SHARDS,
        "shard_rows": SHARD_ROWS,
        "seed": args.seed,
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=0)
        handle.write("\n")
    summary = {
        "points": {name: len(splits[name]) for name in SPLITS},
        "attempts": attempts,
        "rejected": rejected,
        "out": args.out,
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
