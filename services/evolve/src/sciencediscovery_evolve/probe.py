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

import os
import math
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .engine import RunSpec
from .logging_config import get_logger
from .measurement import GATE, Dataset, DatasetError, load_dataset, shard_indices

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
    """探针：忽略输入，恒定预测。"""
    import pandas as pd

    return [0.0] * len(pd.read_csv(test_path))
'''

#: What a text candidate is damaged into. Any rubric worth running marks this
#: down; one that does not is not going to rank two real drafts.
_EMPTY_WORDS = "本工作做了一些事情，取得了一些结果，具有一定的意义。"


class ProbeError(RuntimeError):
    """The probe could not be taken, which is not the same as failing it."""


def run_probe(spec: RunSpec) -> Dict[str, Any]:
    """`{baseline, worsened, flat, label}` for one scorecard."""
    from .era_engine import _judge_spec, _mode_of, _scale_of, _default_completion

    mode = _mode_of(spec)

    if spec.packages:
        # The probe runs the starting point, and the starting point is exactly
        # what uses these — a draft that reaches for a boosting library fails
        # here first, as "起点本身就跑不起来", if the library is not there yet.
        from .provision import ProvisionError, ensure

        try:
            ensure(spec.packages)
        except ProvisionError as error:
            raise ProbeError(str(error)) from error

    if mode == "test_gate":
        return _probe_gated(spec)

    if not spec.baseline_code.strip():
        raise ProbeError("没有起点可测——判别力探针要拿它和一个故意改差的副本比")

    if mode == "custom_script":
        from .script_domain import ScriptError, script_domain

        try:
            domain = script_domain(
                scorecard=spec.scorecard, script=spec.script, capability=spec.sandbox,
                baseline_code=spec.baseline_code,
                candidate_timeout=spec.candidate_timeout_seconds,
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
        # both called "起点".
        shards = _gate_slots(spec)
        try:
            baseline, _raw, why = _measure(domain.evaluate, spec.baseline_code, shards)
        except ScriptError as error:
            raise ProbeError(f"评测脚本连起点都跑不完：{error}") from error
        if baseline is None:
            raise ProbeError(
                "起点在你的评测脚本下就不成立，搜索里每个分数都是相对它的。"
                + (f"脚本报的是：{why}" if why.strip() else "脚本没说为什么。")
            )
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
                "评测脚本扛不住坏候选——把起点函数体掏空之后它自己崩了："
                f"{error}。搜索里大多数候选都长这样，评测脚本必须把它们算作答错、"
                "而不是跟着一起挂掉。两个地方都要兜："
                "\n1) `import candidate` 本身——掏空后模块级的语句会拿到 None、"
                "抛异常，这一步在任何样例之前，per-shard 的 try/except 到不了。"
                "导入失败要记**最差**分（越大越好的评分里就是 0.0），"
                "不是满分——写反了搜索会直接收敛到装不进来的候选。"
                "\n2) 每一条样例的调用。"
                "\n注意：要健壮的是评测脚本，不是候选——候选被改坏就是这个探针的目的。"
            ) from error
        flat = worsened is not None and abs(baseline - worsened) <= TOLERANCE
        # Ordered by what each costs. The first three read numbers already paid
        # for; the last two each spend one more evaluation, so they come after
        # everything that can refuse for free.
        _refuse_saturated(spec, baseline, worsened)
        _refuse_nameless_diagnosis(damaged_why)
        _refuse_locationless_diagnosis(damaged_why)
        _refuse_rewarding_the_unimportable(domain.evaluate, shards, baseline)
        _refuse_noisy(domain.evaluate, spec.baseline_code, shards, baseline, worsened)
        return {"baseline": baseline, "flat": flat,
                "label": damage_label, "worsened": worsened}

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
        damaged, label = _EMPTY_WORDS, "内容换成空话"
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
        damaged, label = spec.baseline_code + _CONSTANT_PREDICTOR, "把返回值换成常数"

    baseline, raw, why = _measure(domain.evaluate, spec.baseline_code, shards)
    if baseline is None:
        # Two very different failures arrive here as the same `None`, and they
        # point at opposite things to fix. "Undecidable" means the candidate ran
        # perfectly — ten times — and the *judge* could not agree with itself;
        # reporting that as "起点本身就跑不起来" sends the user to rewrite a
        # starting point that was never the problem.
        if "判不出好坏" in why or "极差" in why:
            raise ProbeError(
                "这套评分自己就不稳：同一份起点评了好几次，分数散得比阈值还开"
                f"（{why}）。搜索是靠比分数排序的，噪声比差距大就排不出东西来。"
                "两条出路：把细则写得更机械一点（数得出来的东西，而不是「是否清晰」"
                "这种见仁见智的），或者把留出的评分次数加上去让中位数稳下来。"
            )
        # The starting point really failing is a different and worse problem:
        # every score in the search is expressed relative to it. Named, because
        # "先修它" without saying what is wrong is not something a user can act
        # on — and the user is usually not the one who wrote this starting
        # point, since the drafting model writes it when the workspace has none.
        raise ProbeError(
            "起点本身就跑不起来，搜索里每个分数都是相对它的，所以这次没法开始。"
            + (f"它报的是：{why}" if why.strip() else "评测那边也没给出原因。")
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
    from .era_engine import _entrypoint_of
    from .test_gate_domain import TestGateError, test_gate_domain

    if not spec.workspace_dir:
        raise ProbeError("测试判分需要一份工作区副本，探针拿不到")
    workspace = Path(spec.workspace_dir)
    entrypoint = _entrypoint_of(spec)
    if not entrypoint or not (workspace / entrypoint).is_file():
        raise ProbeError(f"工作区里没有 {entrypoint or '入口文件'}，探针无从下手")

    original = (workspace / entrypoint).read_text(encoding="utf-8")
    try:
        domain = test_gate_domain(
            scorecard=spec.scorecard, workspace=workspace, capability=spec.sandbox,
            entrypoint_path=entrypoint, candidate_timeout=spec.candidate_timeout_seconds,
        )
    except TestGateError as error:
        raise ProbeError(str(error)) from error

    groups = tuple(_gate_groups(spec))
    baseline, _raw, why = _measure(domain.evaluate, original, groups)
    if baseline is None:
        raise ProbeError(
            "项目当前的实现连测试都跑不起来，所以没有可比的起点。"
            + (f"套件报的是：{why}" if why.strip() else "套件没给出原因。")
        )
    worsened = _score(domain.evaluate, _hollow_out(original), groups)

    flat = worsened is not None and abs(baseline - worsened) <= TOLERANCE
    _refuse_saturated(spec, baseline, worsened)
    return {"baseline": baseline, "flat": flat, "label": "函数体全部掏空", "worsened": worsened}


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
        f"起点一上来就把这套评分打到了 {baseline:.4f}，已经过了「算解决」的阈值"
        f" {threshold:.3f}——搜索没有坡可以爬，跑了也只会原地结束。"
        "评分需要出得更难：样例加难、容差收紧，或者换一个更挑剔的指标。"
        "在上面的输入框里说一句「样例出难一点」就能重新设计。"
    )


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
        raise ProbeError(f"项目当前的实现无法解析：{error}") from error

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
    floor. What the user then saw was "起点本身就跑不起来，先修它" and nothing
    else — true, and useless: a syntax error, a missing entrypoint and a missing
    dependency all read the same, and none of them is something they can act on
    without being told which. The domain always knows; this is just carrying it.
    """
    valid, metrics, error = evaluate(candidate, shards)
    if not valid:
        return None, {}, error
    raw = {
        key: float(value) for key, value in metrics.items()
        if key != "score" and isinstance(value, (int, float)) and math.isfinite(float(value))
    }
    value = metrics.get("score")
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
        f"同一个起点评两次得到 {baseline:.4f} 和 {repeat:.4f}（差 {noise:.4f}），"
        f"而把它改坏只让分数动了 {signal:.4f}——抖动和真实差异一样大，"
        "搜索会在噪声上爬坡：跑完会报出一个提升，但那个数字重跑就没了。"
        "把每一片做大，或者把评分里随机的部分固定住（定住种子、取多次的中位数）"
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
        f"起点已经拿到 {baseline:.4f}，离「算解决」的 {threshold:.3f} 只剩 {headroom:.4f}，"
        f"而把起点改坏也才让分数动了 {signal:.4f}——能赢的空间比这套评分自己的分辨率还小，"
        "搜索多半会以「没有候选超过起点」收场。"
        "把样例出难一点、容差收紧，或者换一个更挑剔的指标，让起点落回 0.3–0.7 之间。"
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
        return hollowed, "函数体全部掏空"
    return _EMPTY_WORDS, "内容换成空话"


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
        f"一个连导入都失败的候选，在你的评分下拿到了 {unimportable:.4f}，"
        f"而起点是 {baseline:.4f}——评分在奖励装不进来的程序，搜索会直接收敛到它们。"
        "多半是 import 的兜底把分数写反了：候选加载不了要记**最差**分（比如 0.0），"
        "不是满分。"
    )


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
        f"评分说了坏候选抛的是什么，没说在哪一行：「{text[:120]}」。"
        "读到它的是修复这一步——候选有几百行，异常消息本身不指向任何一处，"
        "它只能整个推倒重写，而重写出来的十有八九跑不起来。"
        "把 error 写成裁剪过的 traceback.format_exc()，带上文件和行号。"
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
        f"评分对坏候选只说了异常的类名：「{text[:120]}」——没有消息、没有行号，"
        "读到它的是下一个候选的作者，它没法据此修任何东西，只会把整个方案推倒重来。"
        "把 error 写成 repr(e) 或者裁剪过的 traceback.format_exc()，"
        "至少要带上异常自己的那句话。"
    )
