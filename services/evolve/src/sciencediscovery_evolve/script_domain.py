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

"""Scoring by a program the drafting model wrote.

The other three modes each assume something about the goal: that there is a
table with a column to predict, that there is a suite whose pass rate is the
answer, that there is prose a second model can mark. Plenty of real goals have
none of those. "Write a function that splits Chinese addresses into four
fields, as accurately as possible" has an obvious deterministic score — run it
over labelled examples and count exact matches — and no home in any of the
three. Asked to design that search, the drafting model said so itself: *工作区
为空、我无法创建文件，因此用 llm_judge*, and fell back to the one non-
deterministic, most gameable mode for a goal that did not need it.

So this mode's answer is: the model writes the evaluator. Same `Domain` seam,
so the engine, the tree and the aggregator are untouched — what is new is a
second program in the sandbox.

**The contract is four lines, because a contract a model gets wrong is a run
that fails at the end.** The evaluator is run with its working directory set to
a throwaway copy; the candidate is beside it; three environment variables say
where things are; and it writes one JSON object.

    SCIENCE_AGENT_CANDIDATE   候选程序的文件名
    SCIENCE_AGENT_SHARDS      要评的分片号，逗号分隔
    SCIENCE_AGENT_RESULT      把结果 JSON 写到这个路径

    {"valid": true, "metrics": {"<判据 id>": 0.83}, "error": ""}

**The result is a file, not stdout.** A candidate that prints is ordinary; a
candidate whose print lands in the middle of the result is a run that fails for
a reason nobody can see. The file also survives a noisy dependency.

**The shards are not decoration.** The evaluator is given which slice to score
and is expected to use it — that is what makes the gate a held-out gate rather
than a second look at the same examples. An evaluator that ignores them turns
the gate into a copy of the rollout, and nothing downstream can tell.

**What stops a candidate from scoring itself.** Nothing, inside one process:
the evaluator imports the candidate, so the candidate can in principle write
the result file too. The guard is the discrimination probe, and it is a real
one — it damages the candidate and requires the score to move. A candidate that
reports its own score reports the same number after being damaged, which is
exactly the shape the probe refuses to start.
"""

from __future__ import annotations

import os
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Mapping, MutableMapping, Optional, Sequence, Tuple

from .logging_config import get_logger
from .prompt import mutation_prompt
from .scorecard import evaluate_constraints, score_candidate
from .vendor.era.domain import Domain
from .vendor.era.program import Program
from .vendor.era.sandbox import SandboxCapability, sandbox_command
from .shard_roles import cases_for, total_slots
from .vendor.era.tree import finite as _finite

log = get_logger("script")

SCORE_KEY = "score"

#: The three names the evaluator reads. Environment rather than argv because a
#: candidate imported into the same process sees both, and the environment is
#: the one every language spells the same way.
CANDIDATE_ENV = "SCIENCE_AGENT_CANDIDATE"
SHARDS_ENV = "SCIENCE_AGENT_SHARDS"
RESULT_ENV = "SCIENCE_AGENT_RESULT"

#: What the candidate is written as. Named rather than guessed so an evaluator
#: can `import candidate` without the drafting model having to invent a
#: convention that this side would then have to match.
CANDIDATE_FILE = "candidate.py"
EVALUATOR_FILE = "evaluate.py"
_SHIM_FILE = "_entry.py"

#: Why there is a shim at all: the sandbox runs the interpreter with ``-I``,
#: which since 3.11 implies ``-P`` — the script's own directory is *not* put on
#: ``sys.path``. So the most natural line an evaluator can contain,
#: ``import candidate``, raises ImportError, and the drafting model would have
#: to know that to write a working evaluator. Requiring it to is a trap; four
#: lines here is not.
_SHIM = """import os, runpy, sys
sys.path.insert(0, os.getcwd())
runpy.run_path({evaluator!r}, run_name="__main__")
"""


class ScriptError(RuntimeError):
    """The evaluator could not be run at all, which is a run-level fault."""


def script_domain(
    *,
    scorecard: Mapping[str, Any],
    script: str,
    capability: SandboxCapability,
    statement: str = "",
    baseline_code: str = "",
    candidate_timeout: float = 120.0,
    baseline: Optional[MutableMapping[str, float]] = None,
) -> Domain:
    """Build a domain that scores a candidate by running the drafted evaluator."""
    reference: MutableMapping[str, float] = {} if baseline is None else baseline
    criteria = list(scorecard.get("criteria") or [])
    if not criteria:
        raise ScriptError("这张评分卡没有判据")
    criterion = criteria[0]
    metric_id = str(criterion.get("id") or SCORE_KEY)
    # Slots are positional (the engine holds out by tail); the case behind a slot
    # is not. See `shard_roles` — without this the search trains on one end of
    # the evaluator's case list and gates on the other.
    _split = (criterion.get("measure") or {}).get("split") or {}
    _total = total_slots(_split)
    _seed = int(_split.get("seed") or 0)
    if not script.strip():
        raise ScriptError("这张评分卡说要用评测脚本打分，但脚本是空的")

    def evaluate(code: str, shards: Sequence[int]) -> Tuple[bool, Dict[str, Any], str]:
        try:
            payload = _run_evaluator(
                code, script, cases_for(shards, _total, _seed),
                capability=capability, timeout=candidate_timeout,
            )
        except ScriptError:
            # A broken evaluator is not a bad candidate. Raised so the run
            # stops and says which of the two is wrong, rather than reporting
            # every candidate as invalid until the budget runs out.
            raise

        if not payload.get("valid", False):
            # The failure text is what the reflector learns from and what the
            # user reads on the candidate card. An evaluator that writes
            # valid:false with no error produces "判这个候选不成立" and nothing
            # else — seen on a real run, on a card, saying nothing anyone could
            # act on. Whatever the evaluator *did* say (metrics it still
            # reported, its stdout) is better than that.
            reason = str(payload.get("error") or "").strip()
            if not reason:
                reported = payload.get("metrics")
                detail = (
                    f"它报的数值是 {json.dumps(reported, ensure_ascii=False)[:200]}"
                    if isinstance(reported, dict) and reported
                    else "而且没有说原因——细则里让它在 error 字段里写为什么会更好改"
                )
                reason = f"评测脚本判这个候选不成立，{detail}"
            return False, {SCORE_KEY: float("-inf")}, reason

        values = payload.get("metrics")
        if not isinstance(values, dict) or metric_id not in values:
            # Named precisely: "the evaluator returned nothing useful" is the
            # kind of message that sends a user to read a hundred lines of
            # someone else's Python.
            raise ScriptError(
                f"评测脚本没有报出判据 {metric_id}——它给的是 "
                f"{sorted(values) if isinstance(values, dict) else type(values).__name__}"
            )

        raw = {key: value for key, value in values.items() if isinstance(value, (int, float))}
        scored = score_candidate(scorecard, raw, reference or raw)
        metrics: Dict[str, Any] = {**raw, SCORE_KEY: scored.reward}

        violations = evaluate_constraints(scorecard, raw, reference or raw)
        if violations:
            metrics[SCORE_KEY] = float("-inf")
            metrics["violated"] = violations[0].constraint_id
            return False, metrics, violations[0].detail
        return True, metrics, _diagnosis(payload)

    def reward(metrics: Mapping[str, Any]) -> float:
        value = metrics.get(SCORE_KEY)
        if not isinstance(value, (int, float)):
            return 0.0
        return max(0.0, min(1.0, float(value)))

    contract = _contract_of(script)

    def prompt(program: Program) -> str:
        return mutation_prompt(
            statement=statement,
            scorecard=scorecard,
            parent_code=program.code,
            parent_score=_finite(program.metrics.get(SCORE_KEY)),
            best_score=None,
            recent=(),
            script_contract=contract,
            feedback=program.error,
        )

    return Domain(
        name=str(scorecard.get("hash") or "custom-script"),
        entrypoint=CANDIDATE_FILE,
        metric_key=metric_id,
        metric_better="higher",
        initial_program=baseline_code,
        initial_summary="起点程序",
        evaluate=evaluate,
        reward=reward,
        prompt=prompt,
        task_prompt=lambda shard: f"在分片 {shard} 上评测这个程序",
        test_shards=_test_shards(criterion.get("measure") or {}),
        data_summary={"mode": "custom_script"},
    )


def _contract_of(script: str) -> str:
    """What the evaluator requires of a candidate, in the evaluator's words.

    The module docstring, because that is where the drafting guidance tells the
    model to state the interface — and it is the part of the script worth
    showing. The whole script would also show the sample list, and a candidate
    that has read the answer key optimises for reciting it; the docstring shows
    the contract and keeps the answers out of the prompt.

    A script with no docstring falls back to its head — a wrong contract is a
    zero on every candidate, which is worse than a leaky prompt.
    """
    import ast

    try:
        doc = ast.get_docstring(ast.parse(script))
    except SyntaxError:
        doc = None
    if doc and doc.strip():
        return doc.strip()
    return "\n".join(script.splitlines()[:40])


def _run_evaluator(
    code: str,
    script: str,
    shards: Sequence[int],
    *,
    capability: SandboxCapability,
    timeout: float,
) -> Dict[str, Any]:
    """Materialise both programs in a throwaway directory and read the result.

    A fresh copy per candidate, so an evaluator a candidate managed to damage is
    damaged for exactly one evaluation and the next one starts from the text the
    user approved.
    """
    with tempfile.TemporaryDirectory(prefix="evolve-script-") as scratch_dir:
        scratch = Path(scratch_dir)
        (scratch / CANDIDATE_FILE).write_text(code, encoding="utf-8")
        (scratch / EVALUATOR_FILE).write_text(script, encoding="utf-8")
        (scratch / _SHIM_FILE).write_text(
            _SHIM.format(evaluator=EVALUATOR_FILE), encoding="utf-8",
        )
        result = scratch / "result.json"

        extra = {
            CANDIDATE_ENV: CANDIDATE_FILE,
            RESULT_ENV: str(result),
            SHARDS_ENV: ",".join(str(int(shard)) for shard in shards),
        }
        # Through the sandbox seam, never merged into `subprocess.run(env=...)`:
        # bubblewrap clears the inherited environment and re-adds only what is
        # --setenv-ed, so a merge works on macOS and silently vanishes on Linux
        # — which is exactly how it shipped.
        argv, env = sandbox_command(
            scratch, [_SHIM_FILE], capability=capability, timeout=timeout,
            extra_env=extra,
        )
        try:
            completed = subprocess.run(
                argv, capture_output=True, text=True, cwd=str(scratch),
                env=env, timeout=timeout + 30,
            )
        except subprocess.TimeoutExpired as error:
            raise ScriptError(f"评测脚本跑了超过 {timeout + 30:.0f} 秒还没结束") from error

        if result.exists():
            try:
                payload = json.loads(result.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ScriptError(f"评测脚本写出的不是可解析的 JSON：{error}") from error
            if not isinstance(payload, dict):
                raise ScriptError("评测脚本写出的 JSON 不是一个对象")
            # What the candidate itself printed while dying. An evaluator that
            # wraps each case in try/except — which it is told to do — usually
            # records that the case failed and not why, so this is the only
            # place the traceback survives. Carried, not merged: only used when
            # the evaluator's own diagnosis turns out to say nothing.
            payload["_processTail"] = ((completed.stderr or "") + (completed.stdout or "")).strip()[-400:]
            return payload

        # No file, but the answer may still be right there. The contract says
        # write the file and says it twice, and a real model printed the correct
        # object to stdout anyway — refusing a correct answer for arriving in
        # the wrong envelope is the same mistake as refusing a drafted plan that
        # came back as prose. The file stays preferred; this is the fallback.
        printed = _last_result(completed.stdout or "")
        if printed is not None:
            log.info("evaluator printed its result instead of writing %s", RESULT_ENV)
            return printed

        tail = ((completed.stderr or "") + (completed.stdout or "")).strip()[-400:]
        raise ScriptError(
            f"评测脚本既没有写出 {RESULT_ENV} 指的结果文件，输出里也没有结果 JSON。"
            + (f"它说：{tail}" if tail else _silent_death(completed.returncode))
        )


def _silent_death(returncode: int) -> str:
    """What to say when a process died without a byte of output.

    The exit code is the only witness left, and the negative ones are signals —
    each pointing somewhere different. Seen live: an evaluator integrating
    near-singular functions was SIGKILLed with empty stdout and stderr, and
    "它说：（没有输出）" gave the user nothing to act on and us nothing to
    debug. The code was in `completed.returncode` the whole time; it was just
    never printed.
    """
    if returncode == -9:
        return (
            "它一个字都没输出就被强制结束了（SIGKILL）——"
            "多半是内存耗尽被系统杀掉，或超出 CPU 配额。"
            "让评测脚本别一次性算所有样例、控制数组规模，通常能避开"
        )
    if returncode == -11:
        return "它没有输出，段错误退出了（SIGSEGV）——多半是某个二进制依赖在沙箱里崩了"
    if returncode < 0:
        return f"它没有输出，被信号 {-returncode} 终止了"
    return f"它没有输出，退出码 {returncode}"


def _last_result(stdout: str) -> Optional[Dict[str, Any]]:
    """The last line that parses as a result object.

    The *last*, and only whole lines: a candidate prints too, and taking the
    first JSON-looking thing would let ordinary debug output decide the score.
    The evaluator runs after the candidate is imported, so its line comes last —
    and a candidate that wanted to forge one would have to be the final printer,
    which is the same exposure the discrimination probe already covers.
    """
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("{") or "valid" not in line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and "valid" in payload:
            return payload
    return None


def _test_shards(measure: Mapping[str, Any]) -> Tuple[int, ...]:
    """The shards the search never sees.

    Positional, like every other mode: the framework holds out by index, so the
    ordering is what makes the last few shards the held-out ones.
    """
    split = measure.get("split") or {}
    rollout = int(split.get("rolloutShards") or 0)
    gate = int(split.get("gateShards") or 0)
    count = int(split.get("testShards") or 0)
    return tuple(range(rollout + gate, rollout + gate + count))


def _diagnosis(payload: Mapping[str, Any]) -> str:
    """What the reflector is told about this candidate.

    The evaluator's own text when it carries a reason. When it does not — the
    shape seen on a real run was every case reporting `err=None, nfev=0`, which
    says the candidate never ran but not why — the process output is appended,
    because that is where the traceback went. Without it the reflector is told
    "score 0" seven times and keeps proposing variants of the same broken idea.
    """
    said = str(payload.get("error") or "").strip()
    tail = str(payload.get("_processTail") or "").strip()
    if not tail:
        return said
    # "Says nothing" is not the same as "is empty": a line of `err=None` for
    # every case is text, and it is still no reason.
    uninformative = not said or ("err=None" in said and "Traceback" not in said)
    if not uninformative:
        return said
    return (said + "\n" if said else "") + f"候选进程的输出：{tail}"

