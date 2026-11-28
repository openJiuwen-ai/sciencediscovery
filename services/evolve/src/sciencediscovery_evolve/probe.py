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

"""Does this scorecard have any ordering power?

Score the starting point, then score a copy that was deliberately made worse.
Two numbers that come back the same mean the scoring cannot separate a good
candidate from a bad one, and a search on flat terrain is a random walk that
looks completely normal from outside: every event fires, every candidate is
recorded, the dashboard shows a search that simply found nothing.

That is why this is worth two evaluations up front. The other pre-flight checks
catch failures that announce themselves — a wrong scale makes the engine throw,
a wrong direction is caught by the normalisation table. This one is the silent
case, and it was not hypothetical: the first judged run gave four candidates in
a row full marks, so the tree had no signal after the first expansion.

The damage is deliberately crude. Being subtle would be measuring something
else: a scorecard that cannot see a predictor replaced by a constant is not
going to separate two real candidates.
"""

from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .engine import RunSpec
from .logging_config import get_logger
from .measurement import GATE, Dataset, DatasetError, load_dataset, shard_indices
from .outcome import SCORE_KEY, raw_measurements

log = get_logger("probe")

#: How close two scores may be and still count as the same. Judged scorers
#: wobble, so exact equality would pass a scorecard that is flat in every way
#: that matters.
TOLERANCE = 0.01

#: What a program candidate is damaged into: a predictor that ignores its input.
#:
#: Appended as a second definition of the same name — Python keeps the last one
#: — rather than by saving the original to a module-level alias. The alias is
#: what this used to do, and the AST gate refuses it: a top-level assignment
#: whose value is a *name* is not a literal constant, so every damaged copy was
#: rejected before it ran. `worsened` came back `None`, `flat` is
#: `worsened is not None and ...`, and the probe therefore passed every measured
#: scorecard it was ever given without measuring anything. The gate the whole
#: design leans on was a no-op in its most common mode.
_CONSTANT_PREDICTOR = '''

def train_and_predict(train_path, test_path):
    """Probe: ignore the input, predict a constant."""
    import pandas as pd

    return [0.0] * len(pd.read_csv(test_path))
'''

#: What a text candidate is damaged into. Any rubric worth running marks this
#: down; one that does not is not going to rank two real drafts.
_EMPTY_WORDS = "This work did some things, obtained some results, and has a certain significance."


#: The floor of the per-call timeout check's bound, in seconds.
#:
#: The check stops one whole evaluation of the gate shards instead of waiting for
#: the evaluator's own outer budget (``candidate_timeout + 30``), which for the
#: shipped default is longer than the run-creation request a probe refusal has to
#: come back inside. The actual bound is
#: ``min(candidate_timeout, max(TIMEOUT_CHECK_SECONDS, baseline_seconds + TIMEOUT_CHECK_SECONDS))``:
#: the floor keeps a fast evaluator's refusal inside the request, and the measured
#: starting-point time is added so a legitimately slow script gets the same amount
#: of room for its timed check. Any bound expiry is a refusal — a slow starting
#: point is not a reason to skip it — and the evaluator's own observation file is
#: never consulted.
TIMEOUT_CHECK_SECONDS = 15.0


class ProbeError(RuntimeError):
    """The probe could not be taken, which is not the same as failing it."""


class _SelfDeadline:
    """A stop predicate the probe sets for itself, on the search's own clock.

    ``run_killable`` polls this while the evaluator runs and kills its process
    group when it turns true, so a check that has its own bound does not have to
    wait for the evaluator's outer timeout to expire.
    """

    def __init__(self, seconds: float) -> None:
        self.seconds = max(0.1, float(seconds))
        self.deadline = time.monotonic() + self.seconds

    def expired(self) -> bool:
        return time.monotonic() >= self.deadline

    def arm(self) -> None:
        """Give the next evaluation the same bound, starting now."""
        self.deadline = time.monotonic() + self.seconds


def _timeout_check_bound(candidate_timeout: float, baseline_seconds: float) -> float:
    """How long one evaluation of the per-call timeout check may run.

    Capped by the run's own whole-evaluation budget, and never below the check's
    floor. The measured starting-point evaluation is added to the floor, so a
    script whose ordinary work is slow gets the same headroom for its timed check
    that it legitimately spends on one ordinary evaluation. This is a scale, not
    an exemption: a no-per-call-limit script is still cut and refused at the
    scaled bound, however slow its starting point is.
    """
    return min(
        float(candidate_timeout),
        max(TIMEOUT_CHECK_SECONDS, float(baseline_seconds) + TIMEOUT_CHECK_SECONDS),
    )


def _timeout_check_domain(
    spec: RunSpec,
    observations: List[List[Dict[str, Any]]],
    baseline_seconds: float = 0.0,
    reference: Optional[Dict[str, float]] = None,
) -> Tuple[Any, _SelfDeadline, float]:
    """A second domain for the timeout check alone, bounded so it answers early.

    Built from the same frozen script and scorecard, with three differences: its
    candidate budget is capped, its card carries no constraints, and it carries a
    stop predicate of its own. An evaluator that a single non-returning call can
    hold open is refused in at most this bound's worth of seconds instead of the
    outer ``candidate_timeout + 30``.

    ``reference`` is the baseline mapping the main domain already filled from the
    starting point's raw measurements, and it is handed over unchanged: this
    second domain scores the same gate shards of the same script, so a
    ``relative_to_baseline`` criterion has to divide by the frozen starting point
    here as well. Left empty, every candidate in the check would be normalised
    against itself, both timed runs would read the same number for any candidate,
    and the repeatability arm of ``_refuse_ineffective_timeout`` could not see the
    leftover work it exists for.

    The card's own ``constraints`` are dropped here, and only here. This check
    asks one question — does the evaluator stay alive inside the bound and answer
    the same way twice — with a candidate that is deliberately broken, so a
    quality constraint answers a different one. With the frozen reference in
    place, a constraint relative to the baseline ("no slower than 1.5x the
    starting point") is legitimately violated by that candidate, ``script_domain``
    reports it as ``valid: false``, and ``_refuse_ineffective_timeout`` reads that
    as "one timed-out case turned the whole evaluation invalid" — refusing an
    evaluator that does keep its per-call deadline. The main domain, which scores
    real candidates, keeps the card's constraints untouched.
    """
    from .script_domain import ScriptError, script_domain

    bound = _timeout_check_bound(spec.candidate_timeout_seconds, baseline_seconds)
    limit = _SelfDeadline(bound)
    # A copy, so the scorecard the run carries is never mutated and every later
    # domain still sees the constraints it was written with.
    card = {**spec.scorecard, "constraints": []}
    try:
        domain = script_domain(
            scorecard=card, script=spec.script, capability=spec.sandbox,
            baseline_code=spec.baseline_code, candidate_timeout=bound,
            observations=observations, should_stop=limit.expired,
            baseline=reference,
        )
    except ScriptError as error:
        raise ProbeError(str(error)) from error
    return domain, limit, bound


def run_probe(spec: RunSpec) -> Dict[str, Any]:
    """`{baseline, worsened, flat, label}` for one scorecard."""
    from .puct_engine import _judge_spec, _mode_of, _scale_of, _default_completion

    mode = _mode_of(spec)

    if spec.packages:
        # The probe runs the starting point, and the starting point is exactly
        # what uses these — a draft that reaches for a boosting library fails
        # here first, as "the starting point does not run", if the library is
        # not there yet.
        from .provision import ProvisionError, ensure

        try:
            ensure(spec.packages)
        except ProvisionError as error:
            raise ProbeError(str(error)) from error

    if mode == "test_gate":
        return _probe_gated(spec)

    if not spec.baseline_code.strip():
        raise ProbeError(
            "there is no starting point to measure — the discrimination probe compares "
            "it against a deliberately damaged copy"
        )

    if mode == "custom_script":
        from .script_domain import ScriptError, script_domain

        # What the staged per-call facility recorded about each call, one entry
        # per evaluation. Filled by the domain; read by the timeout check, which
        # is the one place a probe can see "the deadline fired and the next case
        # still ran" instead of inferring it.
        observations: List[List[Dict[str, Any]]] = []
        # Held by the domain and filled in below, exactly as the engine's
        # seeding code fills it — the same gap this probe refuses to have in the
        # dataset path below. Without it a `relative_to_baseline` criterion is
        # normalised against each candidate itself, so the damaged copy and the
        # starting point both land on 0.5 and a working evaluator reads as flat.
        reference: Dict[str, float] = {}
        try:
            domain = script_domain(
                scorecard=spec.scorecard, script=spec.script, capability=spec.sandbox,
                baseline_code=spec.baseline_code,
                candidate_timeout=spec.candidate_timeout_seconds,
                observations=observations,
                baseline=reference,
            )
        except ScriptError as error:
            raise ProbeError(str(error)) from error
        # This is the mode where the probe earns its keep twice over. An
        # evaluator nobody has run before can be flat for the ordinary reason —
        # it does not measure what the goal is about — and also because a
        # candidate can write the result file the evaluator was supposed to
        # write. Both look the same from here, and both are refused: a
        # candidate that scores itself scores the same after being damaged.
        # The engine holds out the *tail* of the slot list, so every node score —
        # including the seeded baseline the run card shows — is measured on the
        # gate slots. `range(gate)` starts at 0 and lands on the first rollout
        # slots instead: with one generator per shard the two slices are
        # different problems, and a live run showed the probe saying 0.7157 for
        # a start the run then seeded at 0.2218. Two numbers for one program,
        # both called "the starting point".
        shards = _gate_slots(spec)
        # The check's bound needs to know whether the evaluator's ordinary work
        # is itself slower than the bound. The starting point is already measured
        # here, so time it: that is evidence the evaluator cannot fabricate,
        # unlike the observation file it writes itself.
        baseline_started = time.monotonic()
        try:
            baseline, raw, why = _measure(domain.evaluate, spec.baseline_code, shards)
        except ScriptError as error:
            raise ProbeError(
                f"the evaluator could not even finish on the starting point: {error}"
            ) from error
        baseline_seconds = time.monotonic() - baseline_started
        if baseline is None:
            raise ProbeError(
                "the starting point does not hold up under your evaluator, and every "
                "score in the search is measured relative to it. "
                + (f"The script reported: {why}" if why.strip() else "The script gave no reason.")
            )
        # Frozen before the damaged copy is scored, so the comparison this probe
        # exists to make is the one the search will make.
        reference.update(raw)
        damaged, damage_label = _damage(spec.baseline_code)
        try:
            worsened, _damaged_raw, damaged_why = _measure(domain.evaluate, damaged, shards)
        except ScriptError as error:
            # The damaged copy is what most candidates will look like: a
            # function that raises, or returns None. An evaluator that dies on
            # one would die partway through the search and spend the budget
            # reporting that every candidate is broken. Caught here so the fix
            # names the evaluator rather than arriving as a 502.
            raise ProbeError(
                "the evaluator does not survive a bad candidate — hollowing out the "
                f"starting point's function body made it crash: {error}. Most "
                "candidates in a search look like that, and the evaluator has to score "
                "them as wrong rather than dying with them. Guard two places:"
                "\n1) `import candidate` itself — a hollowed-out module can leave a "
                "module-level name as None or raise outright, and that happens before "
                "any case, where a per-shard try/except cannot reach it. A failed "
                "import scores **worst** (0.0 on a larger-is-better scale), not best — "
                "inverted, the search converges on candidates that do not load."
                "\n2) Each individual call."
                "\nNote: it is the evaluator that has to be robust, never the candidate "
                "— a damaged candidate is exactly what this probe is for."
            ) from error
        flat = worsened is not None and abs(baseline - worsened) <= TOLERANCE
        # Ordered by what each costs. The first three read numbers already paid
        # for; the next three each spend evaluations of their own, so they come
        # after everything that can refuse for free. Seven sandbox evaluations
        # in total, in this order: the starting point, the damaged copy, one that
        # cannot be imported, the input-mutating candidate, the non-returning one
        # twice (the second run is what says whether a timed-out case behaves the
        # same way twice), and the starting point again for the noise.
        _refuse_saturated(spec, baseline, worsened)
        _refuse_nameless_diagnosis(damaged_why)
        _refuse_locationless_diagnosis(damaged_why)
        _refuse_rewarding_the_unimportable(domain.evaluate, shards, baseline)
        _refuse_input_mutation(
            domain.evaluate, spec.baseline_code, shards, baseline,
            signal=abs(baseline - worsened) if worsened is not None else None,
        )
        # The bounded domain is built for this check alone, so a script with no
        # per-call limit is refused inside the run-creation request instead of
        # waiting out the evaluator's own outer budget.
        timeout_domain, timeout_limit, timeout_bound = _timeout_check_domain(
            spec, observations, baseline_seconds, reference=reference,
        )
        _refuse_ineffective_timeout(
            timeout_domain.evaluate, spec.baseline_code, shards, observations,
            signal=abs(baseline - worsened) if worsened is not None else None,
            limit=timeout_limit, bound=timeout_bound,
            baseline_seconds=baseline_seconds,
        )
        _refuse_noisy(domain.evaluate, spec.baseline_code, shards, baseline, worsened)
        return {"baseline": baseline, "flat": flat,
                "label": damage_label, "worsened": worsened}

    if mode == "npu_job":
        from .npu_job import NpuJobError, npu_client_from_spec, npu_domain

        try:
            client = npu_client_from_spec(spec.options, spec.candidate_timeout_seconds)
        except NpuJobError as error:
            raise ProbeError(str(error)) from error
        domain = npu_domain(
            scorecard=spec.scorecard,
            baseline_code=spec.baseline_code,
            client=client,
            statement=spec.statement,
        )
        baseline, _raw, why = _measure(domain.evaluate, spec.baseline_code, ())
        if baseline is None:
            raise ProbeError(
                "the starting point did not get an NPU score. "
                + (why.strip() or "The runner gave no reason.")
            )
        damaged, damage_label = _damage_json(spec.baseline_code, spec.scorecard.get("direction") or {})
        worsened = _score(domain.evaluate, damaged, ())
        flat = worsened is not None and abs(baseline - worsened) <= TOLERANCE
        _refuse_saturated(spec, baseline, worsened)
        return {"baseline": baseline, "flat": flat, "label": damage_label, "worsened": worsened}

    if mode == "llm_judge":
        from .judge_domain import grader, judge_domain

        domain = judge_domain(
            scorecard=spec.scorecard,
            rubric=spec.rubric,
            grade=grader(
                _default_completion(_judge_spec(spec), None, lambda: False),
                spec.rubric, _scale_of(spec), spec.source_material,
            ),
            baseline_text=spec.baseline_code,
        )
        shards = tuple(range(_gate_count(spec)))
        damaged, label = _EMPTY_WORDS, "content replaced with empty phrases"
    else:
        from .scorecard_domain import scorecard_domain

        dataset = _dataset(spec)
        # Held by the domain and filled in below, exactly as the engine's
        # seeding code fills it: a `relative_to_baseline` criterion divides by
        # this, and while it is empty the domain falls back to scoring each
        # candidate against *itself* — every measurement lands on the same
        # number and the probe calls a perfectly good scorecard flat.
        reference: Dict[str, float] = {}
        domain = scorecard_domain(
            scorecard=spec.scorecard, dataset=dataset, capability=spec.sandbox,
            baseline_code=spec.baseline_code,
            candidate_timeout=spec.candidate_timeout_seconds,
            baseline=reference,
        )
        shards = shard_indices(dataset, GATE)
        damaged, label = spec.baseline_code + _CONSTANT_PREDICTOR, "return value replaced with a constant"

    baseline, raw, why = _measure(domain.evaluate, spec.baseline_code, shards)
    if baseline is None:
        # Two very different failures arrive here as the same `None`, and they
        # point at opposite things to fix. "Undecidable" means the candidate ran
        # perfectly — ten times — and the *judge* could not agree with itself;
        # reporting that as "the starting point does not run" sends the user
        # to rewrite a
        # starting point that was never the problem.
        # Matched on the judge domain's own wording; the two move together.
        if "undecidable" in why or "spread across" in why:
            raise ProbeError(
                "the scoring is unstable on its own terms: the same starting point was "
                f"graded several times and the scores spread wider than the threshold ({why}). "
                "The search ranks candidates by comparing scores, and it cannot rank "
                "anything when the noise is larger than the differences. Two ways out: "
                "make the rubric more mechanical (things that can be counted, rather "
                "than \"is it clear\", which is a matter of opinion), or raise the number "
                "of held-out gradings so the median settles."
            )
        # The starting point really failing is a different and worse problem:
        # every score in the search is expressed relative to it. Named, because
        # "fix it first" without saying what is wrong is not something a user can act
        # on — and the user is usually not the one who wrote this starting
        # point, since the drafting model writes it when the workspace has none.
        raise ProbeError(
            "the starting point does not run, and every score in the search is measured "
            "relative to it, so this run cannot begin. "
            + (f"It reported: {why}" if why.strip() else "The evaluation gave no reason either.")
        )
    # Frozen before the damaged copy is scored, so the comparison this probe
    # exists to make is the one the search will make.
    if mode not in ("llm_judge", "test_gate"):
        reference.update(raw)
    worsened = _score(domain.evaluate, damaged, shards)

    # A damaged copy that will not run says nothing about discrimination, so it
    # is reported rather than counted as a pass.
    flat = worsened is not None and abs(baseline - worsened) <= TOLERANCE
    _refuse_saturated(spec, baseline, worsened)
    log.info("probe %s: baseline=%.4f worsened=%s flat=%s",
             spec.search_id, baseline, worsened, flat)
    return {"baseline": baseline, "flat": flat, "label": label, "worsened": worsened}


def _probe_gated(spec: RunSpec) -> Dict[str, Any]:
    """The gated probe, whose starting point is the file already in the project.

    The damage has to work on code nobody wrote for this: every top-level
    function keeps its name and its signature and loses its body. The module
    still imports, every symbol the suite reaches for is still there, and the
    answers are all wrong — which is exactly the difference a test suite is
    supposed to notice, and the one a suite that only checks "does it import"
    will not.
    """
    from .puct_engine import _entrypoint_of
    from .test_gate_domain import TestGateError, test_gate_domain

    if not spec.workspace_dir:
        raise ProbeError("test-gated scoring needs a copy of the workspace, and the probe was given none")
    workspace = Path(spec.workspace_dir)
    entrypoint = _entrypoint_of(spec)
    if not entrypoint or not (workspace / entrypoint).is_file():
        raise ProbeError(f"the workspace has no {entrypoint or 'entrypoint file'}, so the probe has nothing to start from")

    original = (workspace / entrypoint).read_text(encoding="utf-8")
    # Same wiring as the scripted probe: the gate is handed the reference map
    # the domain normalises against, and the starting point's raw measurements
    # fill it before the damaged copy is scored. Left empty, a
    # `relative_to_baseline` criterion divides the damaged copy by itself, both
    # readings land on the same number and the probe reports a working gate as
    # flat.
    reference: Dict[str, float] = {}
    try:
        domain = test_gate_domain(
            scorecard=spec.scorecard, workspace=workspace, capability=spec.sandbox,
            entrypoint_path=entrypoint, candidate_timeout=spec.candidate_timeout_seconds,
            baseline=reference,
        )
    except TestGateError as error:
        raise ProbeError(str(error)) from error

    groups = tuple(_gate_groups(spec))
    baseline, raw, why = _measure(domain.evaluate, original, groups)
    if baseline is None:
        raise ProbeError(
            "the project's current implementation does not even get the tests to run, "
            "so there is no starting point to compare against. "
            + (f"The suite reported: {why}" if why.strip() else "The suite gave no reason.")
        )
    reference.update(raw)
    worsened = _score(domain.evaluate, _hollow_out(original), groups)

    flat = worsened is not None and abs(baseline - worsened) <= TOLERANCE
    _refuse_saturated(spec, baseline, worsened)
    return {"baseline": baseline, "flat": flat, "label": "every function body hollowed out",
            "worsened": worsened}


def _refuse_saturated(spec: RunSpec, baseline: float, worsened: Optional[float] = None) -> None:
    """A starting point already at the solved threshold has nowhere to climb.

    The third way a scoring scheme can be useless, next to flat and broken —
    and the sneakiest, because everything *works*: the probe discriminates, the
    run starts, the seed is immediately "solved", and the search ends having
    done nothing. Seen live on a drafted evaluator whose integration samples
    were all easy: the fixed 5-point rule it was supposed to improve on scored
    0.9999999 out of the gate.
    """
    threshold = float(spec.scorecard.get("solvedThreshold") or 0.999)
    if baseline < threshold:
        _refuse_thin_headroom(spec, baseline, worsened, threshold)
        return
    raise ProbeError(
        f"the starting point already scores {baseline:.4f} against this scoring, past the "
        f"{threshold:.3f} solved threshold — there is no slope for the search to climb, and "
        "a run would finish where it started. The scoring has to be made harder: harder "
        "cases, tighter tolerances, or a more demanding metric. Saying \"make the cases "
        "harder\" in the box above is enough to redesign it."
    )


def _damage_json(baseline: str, direction: Any) -> Tuple[str, str]:
    """Change the first editable field, and nothing else."""
    import json

    try:
        parsed = json.loads(baseline)
    except json.JSONDecodeError as error:
        raise ProbeError("the starting point is not JSON") from error
    if not isinstance(parsed, dict):
        raise ProbeError("the starting point is not a JSON object")
    editable = direction.get("editable") if isinstance(direction, dict) else None
    if not isinstance(editable, list) or not editable:
        raise ProbeError("an NPU search has to name the editable fields")
    field = str(editable[0])
    if field not in parsed:
        raise ProbeError(f"the starting point has no field {field}")
    parsed[field] = _damaged_value(parsed[field])
    return json.dumps(parsed, separators=(",", ":"), sort_keys=True), f"changed {field}"


def _damaged_value(value: Any) -> Any:
    if isinstance(value, bool):
        return not value
    if isinstance(value, (int, float)):
        return value + 1
    if isinstance(value, str):
        return value + "-damaged"
    return "damaged"


def _hollow_out(source: str) -> str:
    """Every top-level function keeps its name and loses its body.

    Parsed rather than string-edited: a regex over `def` would break on nested
    functions, decorators and multi-line signatures, and a damaged copy that
    fails to *parse* measures the parser rather than the scorer.

    Used by both the gated and the scripted probes: neither knows what the
    candidate's entrypoint is called, and "every function still exists and
    every answer is wrong" is the damage that works without knowing.
    """
    import ast

    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        raise ProbeError(f"the project's current implementation does not parse: {error}") from error

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            node.body = [ast.Return(value=ast.Constant(value=None))]
        elif isinstance(node, ast.ClassDef):
            for member in node.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    member.body = [ast.Return(value=ast.Constant(value=None))]
    return ast.unparse(ast.fix_missing_locations(tree))


def _gate_groups(spec: RunSpec) -> List[int]:
    for criterion in spec.scorecard.get("criteria") or []:
        split = (criterion.get("measure") or {}).get("caseSplit")
        if isinstance(split, dict):
            rollout = int(split.get("rolloutGroups") or 0)
            gate = int(split.get("gateGroups") or 0)
            return list(range(rollout, rollout + gate))
    return [0]


def _score(
    evaluate: Callable[[str, Any], Tuple[bool, Dict[str, Any], str]],
    candidate: str,
    shards: Any,
) -> Optional[float]:
    return _measure(evaluate, candidate, shards)[0]


def _measure(
    evaluate: Callable[[str, Any], Tuple[bool, Dict[str, Any], str]],
    candidate: str,
    shards: Any,
) -> Tuple[Optional[float], Dict[str, float], str]:
    """`(score, the raw numbers behind it, why not)`.

    The raw half is what a `relative_to_baseline` criterion needs as its
    reference, and it is only available here — the aggregate has already
    divided by it by the time a score comes out.

    The third is the reason the domain gave, and it used to be dropped on the
    floor. What the user then saw was "the starting point does not run, fix it
    first" and nothing
    else — true, and useless: a syntax error, a missing entrypoint and a missing
    dependency all read the same, and none of them is something they can act on
    without being told which. The domain always knows; this is just carrying it.
    """
    valid, metrics, error = evaluate(candidate, shards)
    if not valid:
        return None, {}, error
    raw = {
        key: value for key, value in raw_measurements(metrics).items()
        if math.isfinite(value)
    }
    value = metrics.get(SCORE_KEY)
    return (float(value) if isinstance(value, (int, float)) else None), raw, error


def _dataset(spec: RunSpec) -> Dataset:
    try:
        return load_dataset(spec.dataset_dir or None, spec.scorecard)
    except DatasetError as error:
        raise ProbeError(str(error)) from error


def _gate_slots(spec: RunSpec) -> Tuple[int, ...]:
    """The slot positions the run itself gates on: after rollout, before test."""
    for criterion in spec.scorecard.get("criteria") or []:
        split = (criterion.get("measure") or {}).get("split")
        if isinstance(split, dict):
            rollout = max(0, int(split.get("rolloutShards") or 0))
            gate = max(1, int(split.get("gateShards") or 1))
            return tuple(range(rollout, rollout + gate))
    return (0,)


def _gate_count(spec: RunSpec) -> int:
    for criterion in spec.scorecard.get("criteria") or []:
        split = (criterion.get("measure") or {}).get("split")
        if isinstance(split, dict):
            return max(1, int(split.get("gateShards") or 1))
    return 1


def _refuse_noisy(evaluate, baseline_code: str, shards, baseline: float,
                  worsened: Optional[float]) -> None:
    """Refuse a scoring that moves as much on a re-run as it does on real damage.

    "Are the shards enough?" cannot be answered by counting them. A deterministic
    evaluator is stable on three; one that samples, times, or asks a model can be
    unstable on thirty. So it is measured: score the *same* starting point a
    second time and compare the spread against the damage signal the probe has
    already paid for.

    When the two are comparable the tree is climbing noise. Every selection
    afterwards is a coin flip, the run finishes, reports an improvement, and the
    number does not survive a re-run — the most expensive way to learn nothing.
    """
    if worsened is None:
        return
    signal = abs(baseline - worsened)
    if signal <= TOLERANCE:
        return  # Already refused as flat; a noise reading adds nothing.
    from .script_domain import ScriptError

    try:
        repeat = _score(evaluate, baseline_code, shards)
    except ScriptError:
        return  # The first measurement worked; a flaky second one is not this check's call.
    if repeat is None:
        return
    noise = abs(baseline - repeat)
    if noise < signal / 2:
        return
    raise ProbeError(
        f"the same starting point measured twice gave {baseline:.4f} and {repeat:.4f} "
        f"(a difference of {noise:.4f}), while damaging it moved the score by only "
        f"{signal:.4f} — the jitter is as large as the real difference, so the search "
        "would climb the noise: it would finish reporting an improvement, and that "
        "number would not survive a re-run. Make each shard bigger, or pin down what is "
        "random in the scoring (fix the seed, take the median of several passes)"
    )

def _refuse_thin_headroom(spec: RunSpec, baseline: float, worsened: Optional[float],
                          threshold: float) -> None:
    """Refuse a start with less room above it than the scoring can resolve.

    Past the solved threshold is the obvious case and `_refuse_saturated` has it.
    The quieter one is a start that is merely *close*: seen live on a SQL
    normaliser that began at 0.8477 against a 0.999 threshold and finished with
    `bestNodeIndex: 0` — four candidates, none of which beat the seed, because
    there was almost nothing left to win.

    Judged against the probe's own damage signal rather than a second invented
    threshold: that signal is roughly what one real change is worth on this
    scoring, so headroom smaller than a fraction of it means the search is
    working inside its own measurement error. A quarter, not a half — half would
    refuse a start at 0.7, which is inside the range the design guidance asks
    for.
    """
    if worsened is None:
        return
    signal = abs(baseline - worsened)
    headroom = threshold - baseline
    if signal <= TOLERANCE or headroom >= signal / 4:
        return
    raise ProbeError(
        f"the starting point already scores {baseline:.4f}, leaving {headroom:.4f} before the "
        f"{threshold:.3f} solved threshold, while damaging it moved the score by only "
        f"{signal:.4f} — there is less room to win than this scoring can resolve, so the run "
        "will most likely end with no candidate beating the starting point. Make the cases "
        "harder, tighten the tolerances, or pick a more demanding metric, so the starting "
        "point lands back in 0.3-0.7."
    )


def _damage(source: str) -> Tuple[str, str]:
    """A deliberately worse copy of the starting point, whatever it is made of.

    Hollowing out every function is the right damage for code and a no-op for
    anything else. `custom_script` does not promise the candidate is Python — it
    is whatever the evaluator imports and reads, and a run whose candidate was a
    piece of prose produced `0.1625 vs 0.1625`, exactly equal, three times in a
    row. That was reported as "the scoring cannot tell good from bad", and the
    author rewrote a scorer that was working correctly.

    So the hollowing is checked for having done anything, and when it has not
    the copy is replaced outright. Content that is *there* but says nothing is
    the damage that works on text the way an empty function body works on code.
    """
    try:
        hollowed = _hollow_out(source)
    except ProbeError:
        # Not parseable as code, so it was never code. Fall through to text.
        hollowed = source
    if hollowed.strip() != source.strip():
        return hollowed, "every function body hollowed out"
    return _EMPTY_WORDS, "content replaced with empty phrases"


#: A candidate that cannot be imported at all — the single commonest way a
#: generated program fails, and the one the hollowed-out copy does not reach
#: (a gutted function still imports; its body just returns None).
_UNIMPORTABLE = "raise RuntimeError('this candidate does not import')\n"


def _refuse_rewarding_the_unimportable(evaluate, shards, baseline: float) -> None:
    """Refuse a scoring that pays a candidate for failing to load.

    The evaluator is told to guard `import candidate`, because a broken module
    raises there and a per-case try/except cannot reach it. Guarding it is easy
    to get structurally right and semantically backwards, and one live run did
    exactly that::

        if _cand is None:
            return 1.0, f"import failed: {_IMP_ERR}"

    1.0 was the *best* score. The search's winner was a candidate that raised at
    import, at a perfect 1.0000 on both the rollout and the held-out gate, and
    nothing looked wrong anywhere: the probe had passed, because hollowing out
    function bodies leaves a module that still imports.

    So the probe scores one that does not. An unimportable candidate must not do
    as well as the starting point — if it does, the search converges on programs
    that do not load.
    """
    from .script_domain import ScriptError

    try:
        unimportable = _score(evaluate, _UNIMPORTABLE, shards)
    except ScriptError:
        # The evaluator died rather than scoring it. That is the other failure
        # mode, and it already has its own diagnosis on the path above.
        return
    if unimportable is None or unimportable < baseline - TOLERANCE:
        return
    raise ProbeError(
        f"a candidate that cannot even be imported scores {unimportable:.4f} under your "
        f"scoring, against {baseline:.4f} for the starting point — the scoring rewards "
        "programs that do not load, and the search will converge straight onto them. "
        "Most likely the import guard has the score inverted: a candidate that fails to "
        "load must score **worst** (0.0, say), not best."
    )


#: A candidate that misbehaves in the ways an evaluator has to survive.
#:
#: Appended to the starting point instead of written from scratch, for the same
#: reason the damaged copy is: the probe does not know what the entrypoint is
#: called or what it takes, and a from-scratch candidate would measure "did not
#: import" rather than the evaluator's own per-case handling. Every module-level
#: function keeps working - it is called first, with the arguments it was given
#: - and the wrapper adds one behaviour around it:
#:
#: * one call never returns (only when the probe asks for it), so the evaluator's
#:   per-call deadline is exercised by a call that would otherwise hold the
#:   whole evaluation open;
#: * every call then zeroes the numbers in the arguments it was given and
#:   returns the *right* answer anyway - which is exactly the shape of a
#:   candidate that scores itself by damaging the data it is scored against;
#: * from its fourth call on it raises as well, so one evaluation also covers
#:   the exception path. Not used for the input-damage run: there every case has
#:   to reach the scoring for the inflation to show at full strength.
#:
#: It works on an evaluator that calls the candidate in process as well as one
#: that uses ``evaluator_support``: both see a candidate that hangs, mutates and
#: raises.
_HOSTILE = '''

# --- injected by the discrimination probe; none of this is part of the candidate ---
import inspect as _probe_inspect
import os as _probe_os
import time as _probe_time

_PROBE_HANG_FIRST = {hang!r}
_PROBE_RAISE_AFTER = {raise_after!r}
# The call counter lives in a file beside the candidate, not in a module global:
# an evaluator that gives each call its own process (evaluator_support does)
# imports the module afresh every time, and a per-process counter would make
# every call "the first one", so the timed-out call would never be followed by a
# valid one.
_PROBE_COUNTER = _probe_os.path.join(
    _probe_os.path.dirname(_probe_os.path.abspath(__file__)), "_probe_calls.txt")


def _probe_next_call():
    try:
        with open(_PROBE_COUNTER, "r", encoding="utf-8") as _probe_handle:
            _probe_count = int(_probe_handle.read().strip() or "0")
    except (OSError, ValueError):
        _probe_count = 0
    _probe_count += 1
    try:
        with open(_PROBE_COUNTER, "w", encoding="utf-8") as _probe_handle:
            _probe_handle.write(str(_probe_count))
    except OSError:
        pass
    return _probe_count


def _probe_damage(_probe_value, _probe_depth=0):
    """Zero the numbers inside a mutable argument, keeping every length.

    Anything addressable is damaged in place: a list, a dict, a numpy array, an
    array.array. An immutable *container* cannot be changed itself, so it is
    walked and its mutable contents are damaged — a candidate entrypoint usually
    receives a tuple holding the real data. A tuple of numbers, or a string, has
    nothing mutable inside it and stays as it was; a candidate whose only
    argument is one of those cannot be exercised this way, and the guidance says
    so rather than the probe claiming the check passed.
    """
    if _probe_depth > 3:
        return
    if isinstance(_probe_value, (tuple, frozenset)):
        for _probe_item in _probe_value:
            _probe_damage(_probe_item, _probe_depth + 1)
        return
    if isinstance(_probe_value, dict):
        for _probe_key in list(_probe_value):
            _probe_item = _probe_value[_probe_key]
            if isinstance(_probe_item, bool) or _probe_item is None:
                continue
            if isinstance(_probe_item, (int, float)):
                _probe_value[_probe_key] = 0
            else:
                _probe_damage(_probe_item, _probe_depth + 1)
        return
    if not hasattr(_probe_value, "__setitem__"):
        return
    for _probe_index in range(len(_probe_value)):
        try:
            _probe_item = _probe_value[_probe_index]
        except (IndexError, KeyError, TypeError):
            continue
        if isinstance(_probe_item, bool) or _probe_item is None:
            continue
        if isinstance(_probe_item, (int, float)):
            try:
                _probe_value[_probe_index] = 0
            except (TypeError, ValueError):
                pass
            continue
        _probe_damage(_probe_item, _probe_depth + 1)


_probe_originals = {{}}


def _probe_call(_probe_name, *_probe_args, **_probe_kwargs):
    _probe_call_number = _probe_next_call()
    if _PROBE_HANG_FIRST and _probe_call_number == 1:
        while True:
            _probe_time.sleep(0.25)
    if _PROBE_RAISE_AFTER and _probe_call_number >= _PROBE_RAISE_AFTER:
        raise RuntimeError("probe: this candidate is deliberately broken on this call")
    _probe_answer = _probe_originals[_probe_name](*_probe_args, **_probe_kwargs)
    _probe_damage(list(_probe_args))
    _probe_damage(list(_probe_kwargs.values()))
    return _probe_answer


for _probe_name, _probe_value in list(globals().items()):
    if _probe_name.startswith("_probe") or isinstance(_probe_value, type):
        continue
    if not callable(_probe_value):
        continue
    if getattr(_probe_value, "__module__", None) != __name__:
        continue
    # An async entrypoint returns a coroutine, which is not a result and cannot
    # be carried back. Wrapping it would break a working evaluator, so it is
    # left exactly as it was.
    if _probe_inspect.iscoroutinefunction(_probe_value):
        continue
    _probe_originals[_probe_name] = _probe_value

# Re-defined at module level, with their own names, rather than replaced by
# closures: an evaluator that hands the call to another process can only carry a
# function that is importable by name, and a closure is not.
for _probe_name in list(_probe_originals):
    exec(
        "def " + _probe_name + "(*_probe_args, **_probe_kwargs):\\n"
        "    return _probe_call(" + repr(_probe_name) + ", *_probe_args, **_probe_kwargs)\\n",
        globals(),
    )
'''


def _hostile_candidate(source: str, *, hang_first: bool, raise_after: Optional[int] = 4) -> Optional[str]:
    """The starting point, wrapped so one call never returns -- or ``None``.

    ``None`` means the check cannot be performed on this starting point: it is
    not Python, or it has no module-level function to wrap. The caller says so
    and moves on rather than reporting a pass it did not measure.
    """
    import ast

    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    # Only a plain function is wrapped. An async entrypoint returns a coroutine
    # rather than a result — it cannot be transported, and wrapping it would
    # break an evaluator that currently works — so a starting point made only of
    # those is reported as one these checks could not be performed on.
    if not any(isinstance(node, ast.FunctionDef) for node in tree.body):
        return None
    return source + _HOSTILE.format(hang=bool(hang_first), raise_after=raise_after)


def _records_of(observations: Optional[List[List[Dict[str, Any]]]]) -> List[Dict[str, Any]]:
    """What the staged facility reported about the evaluation just scored."""
    if not observations:
        return []
    last = observations[-1]
    return last if isinstance(last, list) else []


def _refuse_input_mutation(
    evaluate: Callable[[str, Any], Tuple[bool, Dict[str, Any], str]],
    source: str,
    shards: Any,
    baseline: float,
    signal: Optional[float] = None,
) -> None:
    """Refuse a scoring whose answer changes when the candidate edits its input.

    The damaging candidate here returns the starting point's own answer and
    zeroes the numbers in the arguments it was handed. Two evaluators score it
    in two ways, and only one is sound:

    * authoritative inputs kept away from the candidate (a copy handed over, or
      a process boundary like ``call_with_deadline``) -> the score is the
      starting point's score, because nothing the candidate did reached the
      data being measured;
    * the candidate's own object reused for validation or arithmetic -> the
      score moves, usually to a perfect one. One real evaluator measured its
      baseline before the call and the candidate's makespan after it from the
      same mutable lists, and a candidate that replaced the workloads with
      zeros scored 1.0 with an empty error.

    A *lower* score is not refused. Losing points by mutating your own input is
    a bad candidate, not a broken measuring apparatus; the defect this closes
    is the reward.

    The allowance is a tenth of what damaging the candidate is worth (never
    below `TOLERANCE`), the same shape as the timeout check: a scoring that
    wobbles by a hundredth around the starting point is inside what
    `_refuse_noisy` accepts, and must not be called an integrity failure.

    Limits: arguments that are immutable (a tuple of numbers, a string) or that
    have no addressable items cannot be damaged, so for a candidate shaped only
    that way nothing is exercised — the score cannot move and the gate cannot
    tell "the evaluator copied" from "the damage did nothing". The guidance
    states that limit rather than the probe claiming a check it did not make.
    """
    from .script_domain import ScriptError

    # No raising calls here: every case has to reach the scoring for the
    # inflation to show at full strength, and an exception path is already
    # covered by the damaged copy and by the timeout candidate's later calls.
    hostile = _hostile_candidate(source, hang_first=False, raise_after=None)
    if hostile is None:
        log.info("probe: the input-integrity check was not performed - the starting "
                  "point is not Python with a module-level function to wrap")
        return
    try:
        score = _score(evaluate, hostile, shards)
    except ScriptError:
        # An evaluator that dies on a misbehaving candidate is the other
        # failure, and the damaged-copy path already names it.
        return
    allowance = max(TOLERANCE, 0.1 * float(signal or 0.0))
    if score is None or score <= baseline + allowance:
        return
    raise ProbeError(
        f"a candidate that returns the starting point's own answer while zeroing the "
        f"inputs it was given scores {score:.4f}, above the {baseline:.4f} the starting "
        f"point itself scores — so the score is being computed from data the candidate "
        "changed. Give the candidate a copy (`evaluator_support.candidate_copy`, or a "
        "call through `evaluator_support.call_with_deadline`) and validate and score "
        "against the evaluator's own copy; a candidate may damage its own input, but "
        "never the data it is graded on."
    )


def _refuse_ineffective_timeout(
    evaluate: Callable[[str, Any], Tuple[bool, Dict[str, Any], str]],
    source: str,
    shards: Any,
    observations: Optional[List[List[Dict[str, Any]]]] = None,
    signal: Optional[float] = None,
    limit: Optional["_SelfDeadline"] = None,
    bound: Optional[float] = None,
    baseline_seconds: Optional[float] = None,
) -> None:
    """Refuse an evaluator that a single non-returning call can take down.

    One call of the candidate never returns. What the evaluator does next is the
    whole question: a per-call deadline makes that case a per-case failure and
    the evaluation continues, while an evaluator with only an outer timeout
    either never finishes (the probe sees the outer timeout as a refusal) or
    counts the call as success once a wait expires — the shape #1437 reports,
    where a daemon thread plus `queue.get(timeout=...)` left the timed-out work
    running.

    So the starting point is wrapped into a candidate whose first call never
    returns and whose fourth raises, and it is scored twice:

    * an evaluator that cannot finish inside the check's bound is refused: it has
      no per-call limit, one too large to fit, or ordinary cases slower than the
      bound — and none of those leaves the search safe from one slow candidate.
      The bound is scaled from the starting point's own measured evaluation, so a
      legitimately slow script gets proportional room; a bound expiry is still a
      refusal, never a reason to skip the check;
    * an evaluator that reports the whole evaluation invalid is refused: a
      timed-out case is a per-case failure, not an invalid run, and marking it
      invalid throws away every other case's score;
    * the two runs must agree. A timed-out case that scores differently the
      second time means the leftover work is still competing with the next
      case, which is the residual-contention part of #1437. This is checked on
      a *timed* candidate rather than on the fast baseline, because repeating a
      fast baseline says nothing about the timing that actually goes wrong. The
      allowance is a tenth of what damaging the candidate is worth (never below
      `TOLERANCE`), so ordinary jitter in a scoring that already discriminates
      is not mistaken for leftover work.

    The check runs on its own bounded domain: the evaluator's outer budget is
    ``candidate_timeout + 30`` seconds, which for the shipped default is longer
    than the run-creation request a refusal has to come back inside, so the check
    stops at its bound instead. The bound is
    ``min(candidate_timeout, max(TIMEOUT_CHECK_SECONDS, baseline_seconds + TIMEOUT_CHECK_SECONDS))``:
    the floor keeps a fast evaluator's refusal inside the request, and the
    starting point's own measured time is added so a slow script's timed check has
    room proportional to its ordinary work. The bound covers one *whole*
    evaluation of the same gate shards. `baseline_seconds` is timed by the probe
    and never read from the observation file the evaluator writes, which a script
    with no limit could forge. The bound ending an evaluation is never reported as
    the evaluator marking the run invalid.

    What cannot be observed: whether a script that waits on a thread with a
    timeout — without using `evaluator_support` — actually stopped that thread.
    Nothing outside the process can tell "the thread is gone" from "the thread
    is still sleeping", so the probe checks what it can (the run survives, the
    run repeats) and the observations recorded by the staged facility are used
    where they exist. That limit is stated in the generated guidance as well,
    rather than being papered over.

    The domain this is handed is the bounded one built by
    `_timeout_check_domain`, whose card carries no constraints: the candidate here
    is deliberately broken, so a quality constraint would answer a different
    question and its `valid: false` would look like the invalid run below.
    """
    from .script_domain import ScriptError

    hostile = _hostile_candidate(source, hang_first=True)
    if hostile is None:
        log.info("probe: the per-call timeout check was not performed - the starting "
                  "point is not Python with a module-level function to wrap")
        return
    if limit is not None:
        # The check owns this clock: it may have been built a moment ago, or the
        # caller may hand over a limit that has already been armed elsewhere, and
        # neither may shorten the first evaluation.
        limit.arm()
    try:
        first = _score(evaluate, hostile, shards)
        first_records = _records_of(observations)
        if first is None and _cut_by_the_bound(limit, bound):
            # The bound is the check's own clock, so this is a refusal whether the
            # script has no per-call limit or one too large for the room its own
            # starting point earned. The evaluator's observation file is not read.
            raise _bounded_timeout_refusal(bound, baseline_seconds)
        if limit is not None:
            # The second run gets its own allowance: the first one may have spent
            # most of the bound on the hung case, and a sound evaluator must not
            # lose its repeatability reading to the first run's clock.
            limit.arm()
        second = _score(evaluate, hostile, shards)
        second_records = _records_of(observations)
        if second is None and _cut_by_the_bound(limit, bound):
            # The probe's own clock ended the second evaluation, so this is the
            # bound's refusal — never the invalid-run message below.
            raise _bounded_timeout_refusal(bound, baseline_seconds)
    except ScriptError as error:
        raise ProbeError(
            "the evaluator did not survive a candidate whose call never returns: "
            f"{error}. One non-returning call currently holds the whole evaluation "
            "open until the outer timeout, so a single slow candidate would burn the "
            "run's budget. Give each candidate call its own hard limit — "
            "`evaluator_support.call_with_deadline(candidate.solve, ..., timeout=...)` "
            "stops the work and reaps its process when the deadline passes — and "
            "count that case as failed, then carry on with the next one. A wait with "
            "a timeout (`queue.get(timeout=...)`, `thread.join(timeout=...)`) stops "
            "waiting but leaves the work running, which is not a limit."
        ) from error

    if first is None or second is None:
        raise ProbeError(
            "one candidate call that never returns turned the whole evaluation invalid. "
            "A timed-out case is a failed case, not a failed run: score it as the worst "
            "case and keep the score the other cases earned, so the search still sees a "
            "(lower) number for this candidate instead of losing the measurement."
        )

    _report_timeout_observations(first_records, second_records)

    # Relative to what one real change is worth, with the flat threshold as the
    # floor: an evaluator whose scores wobble by a hundredth is not necessarily
    # leaving work behind.
    allowance = max(TOLERANCE, 0.1 * float(signal or 0.0))
    if abs(first - second) > allowance:
        raise ProbeError(
            f"a candidate whose first call never returns scored {first:.4f} on one "
            f"evaluation and {second:.4f} on the next, with nothing else changed — the "
            "handling of a timed-out case is not repeatable, which is what leftover "
            "work from the first one looks like from outside. Stop the timed-out call "
            "rather than abandoning the wait on it: "
            "`evaluator_support.call_with_deadline` kills and reaps its process before "
            "the case is counted as failed, so the next case starts clean."
        )


def _cut_by_the_bound(limit: Optional["_SelfDeadline"], bound: Optional[float]) -> bool:
    """Whether the check's own clock, not the evaluator, ended an evaluation."""
    return limit is not None and bound is not None and limit.expired()


def _bounded_timeout_refusal(
    bound: float, baseline_seconds: Optional[float] = None,
) -> ProbeError:
    """What to say when the check's own bound ended the evaluation.

    Three scripts produce this observation and the bound alone cannot tell them
    apart: one with no per-call limit at all, one whose per-call limit is too
    large to fit the bound, and one whose per-call limit is real but whose
    ordinary cases leave no room inside the bound. So the message says what was
    observed (the bound, and the starting point's own time when it was measured),
    names all three possibilities, and states the pattern the guidance asks for —
    about a second per call, well under the bound — rather than asserting one of
    them as a fact. The numbers are what let the author tell which applies.
    """
    measured = (
        f" (the starting point itself took {baseline_seconds:.2f}s)"
        if baseline_seconds is not None else ""
    )
    return ProbeError(
        f"a candidate whose first call never returns did not finish within the "
        f"{bound:.0f}s this check allows one whole evaluation of the gate shards"
        f"{measured}. That means either the evaluator has no per-call limit — it "
        "waits for the whole-evaluation timeout, and one slow candidate holds every "
        "case open — or its limit is too large to fit this check, or its ordinary "
        f"cases are slower than this check allows. The guidance's pattern is a limit "
        f"of about a second per call, so a whole evaluation stays well inside "
        f"{bound:.0f}s. Give each call its own hard limit with "
        "`evaluator_support.call_with_deadline(candidate.solve, ..., timeout=1.0)`, "
        "which stops the work and reaps its process when the deadline passes, and "
        "count that case as failed while the other cases keep their scores. A wait "
        "with a timeout (`queue.get(timeout=...)`, `thread.join(timeout=...)`) stops "
        "waiting but leaves the work running, which is not a limit."
    )


def _report_timeout_observations(
    first: List[Dict[str, Any]], second: List[Dict[str, Any]],
) -> None:
    """Record what could and could not be observed about the timed-out call.

    Not a refusal: an evaluator that never touched the staged facility is a
    legacy script, not a broken one, and the score checks above already cover
    what is observable from outside. But "we did not check this" has to be said
    somewhere, and this is where.
    """
    if not first and not second:
        log.info("probe: the evaluator does not use evaluator_support, so whether the "
                  "timed-out call was stopped could not be observed; the run surviving "
                  "it and repeating the same score were checked")
        return
    deadline_at = next(
        (index for index, record in enumerate(first) if record.get("outcome") == "deadline"),
        None,
    )
    if deadline_at is None:
        log.info("probe: the per-call deadline never fired during the timeout check, so "
                  "the call was survived some other way and its cleanup was not observed")
        return
    later = [record for record in first[deadline_at + 1:] if record.get("outcome") == "ok"]
    if not later:
        log.info("probe: a deadline fired but no later candidate call completed, so "
                  "'timeout, then another case still scored' was not observed")
        return
    log.info("probe: deadline %s fired, then %d later candidate call(s) completed",
             first[deadline_at].get("target"), len(later))


def _refuse_locationless_diagnosis(said: str) -> None:
    """Refuse a crash report that says what broke but never where.

    Stricter than the gate below it, and for the reader that gate exists to
    protect. `repr(e)` clears "nameless" — ``ValueError('byte must be in
    range(0, 256)')`` is a real message — and is still not enough to repair
    from: the candidate is 245 lines and the value is appended in one of a
    dozen places. Measured on a live compression run: five candidates crashed,
    the repair fired four times and landed once, and every diagnosis it worked
    from named an exception with no file and no line. Two of those failures
    were literally the same one-line bug (`bytearray.append` of a value wider
    than a byte), rediscovered from scratch each time.

    Only fires when the text names an exception. A semantic failure — "round
    trip does not match", "3 of 6 over budget" — has no location to give, and
    demanding one would refuse the evaluators that report best.
    """
    import re

    text = (said or "").strip()
    if not text:
        return
    # `ValueError(`, `IndexError(`, and `error(` — what `repr` of a
    # `struct.error` renders as.
    if not re.search(r"\b\w*(?:error|exception)\s*\(", text, flags=re.IGNORECASE):
        return
    if re.search(r'(?:\bline\s+\d+|\.py[\"\']?[,:]\s*\d+|\bFile\s+")', text, flags=re.IGNORECASE):
        return
    raise ProbeError(
        f"the scoring says what a bad candidate raised but not where: \"{text[:120]}\". "
        "What reads it is the repair step — a candidate is hundreds of lines and the "
        "message on its own points at none of them, so the repair can only tear the "
        "whole thing down and rewrite it, and a rewrite usually does not run. Write "
        "`error` as a trimmed traceback.format_exc(), carrying a file and a line."
    )


def _refuse_nameless_diagnosis(said: str) -> None:
    """Refuse a scoring whose failure text names the exception and nothing else.

    The contract asks the evaluator to fill `error`, and one live run filled it
    with ``f"text{i}: exc {type(e).__name__}"``. Structurally compliant, and the
    reflector then received six identical "IndexError"s with no message, no line
    and no traceback — nothing to fix. What it did instead was re-roll the whole
    approach every expansion (LZ77, then PPM-D, then BWT+MTF+RLE, then a
    multi-strategy coder), each with a fresh bug, and five of six candidates
    landed on exactly 0.000.

    The rule is conservative: strip the case labels, the word `exc`, and the
    exception class names, and if nothing but punctuation is left then the text
    carried no reason at all.
    """
    import re

    text = (said or "").strip()
    if not text:
        return  # Empty is handled where the process tail is appended.
    residue = re.sub(r"\b\w*(?:Error|Exception|Warning)\b", " ", text)
    residue = re.sub(r"\b(?:exc|exception|error|shard|case|text|item)\s*\d*\b", " ", residue,
                     flags=re.IGNORECASE)
    residue = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", residue)
    if residue:
        return
    raise ProbeError(
        f"the scoring reports only the exception's class name for a bad candidate: "
        f"\"{text[:120]}\" — no message, no line number. What reads it is whoever writes "
        "the next candidate, and it cannot fix anything from that; it will discard the "
        "whole approach and start again. Write `error` as repr(e) or a trimmed "
        "traceback.format_exc(), carrying at least the exception's own sentence."
    )
