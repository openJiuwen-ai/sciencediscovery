# 2F1 fixture

`points.json` holds the evaluation points and the frozen reference values for
`test/desktop-evolve-hyp2f1-real.spec.ts`, the real-run case whose problem
statement asks the design to reproduce a recorded double-precision `2F1`
search. The case seeds the file into the Session's workspace, so the design
reads the truth from there instead of trying to rebuild it.

## Why the truth is a file

The problem forbids `mpmath`, `decimal` and `fractions` at evaluation time: the
candidate program has to reach twelve correct digits with `math`, `cmath`,
`numpy` and `scipy` alone. The reference values therefore have to be fixed
before the search starts — that is the contract the statement describes, and
this file is the fixed side of it.

## Shape

| key | value |
| --- | --- |
| `interface` | `hyp2f1(a, b, c, z) -> float` |
| `rows.gate`, `rows.rollout`, `rows.test` | 1000 rows each, `8 shards x 125` |
| a row | `[a, b, c, z, exact]`, `exact` a 30-significant-digit decimal string |
| `shards`, `shard_rows`, `seed` | `8`, `125`, `0` |

A split's shard `i` is the contiguous run `rows[i * 125:(i + 1) * 125]`, which
is how the design's evaluator slices it. Splits are cut from one sampled stream
in `gate`, `rollout`, `test` order, so the three sets are disjoint and each is a
sample of the same distribution.

## Sampling and exclusions

Straight from the problem statement: `a, b, c ~ U(-30, 30)` independently,
`z ~ U(-40, 0.999)`, dropping a point when

- `c` is within `1e-3` of a non-positive integer (the series has a pole there),
- `|2F1| < 1e-250`, or
- the 30-dps and 60-dps evaluations disagree beyond `1e-25` relative.

`exact` is the 60-dps value printed to 30 significant digits, so it is at least
five digits better than the twelve the scoring caps at.

## Regenerating

```sh
python3 -m pip install mpmath
python3 test/fixtures/hyp2f1/generate.py --out test/fixtures/hyp2f1/points.json
```

The generator prints how many points it accepted and why it rejected the rest,
which is the quickest way to notice that mpmath's version changed the
distribution of workable points. Regenerating with the same seed reproduces the
file byte for byte on the same mpmath version.
