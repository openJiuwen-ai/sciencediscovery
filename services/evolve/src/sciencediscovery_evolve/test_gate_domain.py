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

"""Scoring by a test suite — for code whose correctness is defined by tests
rather than by a number.

**Freezing has to be two layers, and neither is optional.** Upstream's own note
puts it plainly: *without it the shortest path to a high score is to weaken the
thing measuring it.*

| layer | stops |
|---|---|
| the proposal filter (`frozen` globs, in the prompt) | the model *proposing* a change to the tests |
| the pristine overlay, here | the candidate *rewriting* the tests as it runs |

The second is the one that cannot be skipped. A candidate is executed, and a
candidate that can write to `tests/` will eventually discover that deleting an
assertion is cheaper than satisfying it. So every frozen path is restored from
the original copy **after** the candidate is materialised and **before**
anything runs.

**A group is a set of test ids, not a separate execution.** The suite runs once
and its results are sharded by a hash of each test's id, so a candidate costs
one run rather than one per group — and it cannot tell the groups apart, because
the seed never leaves this process. That is what keeps the gate groups
meaningful: the search sees the rollout groups' pass rate and never the gate's.

**A failing suite is a score of zero and a message, not a crash.** "You broke the
tests" is the single most useful thing a reflector can be told, so the failure
text is carried back rather than swallowed.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ElementTree
from pathlib import Path
from typing import Any, Dict, List, Mapping, MutableMapping, Optional, Sequence, Set, Tuple

from .logging_config import get_logger
from .prompt import mutation_prompt
from .scorecard import evaluate_constraints, score_candidate
from .vendor.puct.domain import Domain
from .vendor.puct.program import Program
from .vendor.puct.sandbox import SandboxCapability, sandbox_command
from .vendor.puct.tree import finite as _finite

log = get_logger("test-gate")

SCORE_KEY = "score"

#: Where the suite is expected to write its results. Passed in the environment
#: rather than appended to the command, because "how do I emit JUnit XML" is a
#: different flag on every runner and guessing it wrong is a silent zero.
JUNIT_ENV = "SCIENCE_AGENT_JUNIT_XML"


class TestGateError(RuntimeError):
    """The suite could not be run at all, which is a run-level fault."""


def test_gate_domain(
    *,
    scorecard: Mapping[str, Any],
    workspace: Path,
    capability: SandboxCapability,
    statement: str = "",
    entrypoint_path: str = "",
    candidate_timeout: float = 300.0,
    baseline: Optional[MutableMapping[str, float]] = None,
) -> Domain:
    """Build a domain that scores a candidate by running the project's tests.

    ``workspace`` is the pristine copy: it is never written to, and every run
    happens in a throwaway clone of it.
    """
    reference: MutableMapping[str, float] = {} if baseline is None else baseline
    criteria = list(scorecard.get("criteria") or [])
    if not criteria:
        raise TestGateError("this scorecard has no criteria")
    criterion = criteria[0]
    measure = criterion.get("measure") or {}
    frozen: Sequence[str] = tuple(measure.get("frozen") or ())
    test_cmd: Sequence[str] = tuple(measure.get("testCmd") or ())
    setup_cmd: Sequence[str] = tuple(measure.get("setupCmd") or ())
    if not test_cmd:
        raise TestGateError("this scorecard gives no test command")
    if not frozen:
        # Upstream's note, and it is not a style preference: the shortest path
        # to a high score is to weaken the thing measuring it.
        raise TestGateError(
            "test-gated scoring must freeze the test files, or the shortest path to a "
            "higher score is to weaken the tests"
        )

    target = entrypoint_path or _sole_python(workspace)

    def evaluate(code: str, groups: Sequence[int]) -> Tuple[bool, Dict[str, Any], str]:
        outcomes = _run_suite(
            code, workspace, target, frozen, setup_cmd, test_cmd,
            capability=capability, timeout=candidate_timeout,
        )
        if outcomes is None:
            return False, {SCORE_KEY: float("-inf")}, "the test suite produced no readable result"

        wanted = set(groups)
        seed = int((measure.get("caseSplit") or {}).get("seed") or 0)
        total = _group_count(measure)
        selected = {
            test: passed for test, passed in outcomes.items()
            if _group_of(test, seed, total) in wanted
        }
        if not selected:
            return False, {SCORE_KEY: float("-inf")}, (
                f"these groups ({sorted(wanted)}) hold no cases at all — the number of "
                f"groups does not match the number of cases"
            )

        rate = sum(1 for passed in selected.values() if passed) / len(selected)
        failed = [test for test, passed in selected.items() if not passed]
        raw = {criterion["id"]: rate}
        scored = score_candidate(scorecard, raw, reference or raw)
        metrics: Dict[str, Any] = {
            criterion["id"]: rate,
            "cases": len(selected),
            "failed": len(failed),
            SCORE_KEY: scored.reward,
        }

        violations = evaluate_constraints(scorecard, raw, reference or raw)
        if violations:
            metrics[SCORE_KEY] = float("-inf")
            metrics["violated"] = violations[0].constraint_id
            return False, metrics, violations[0].detail
        # A candidate that fails tests is scored, not refused: the pass rate is
        # the signal, and "you broke three of them" is what the search learns
        # from. Only an unrunnable suite is invalid.
        return True, metrics, ("；".join(failed[:5]) if failed else "")

    def reward(metrics: Mapping[str, Any]) -> float:
        value = metrics.get(SCORE_KEY)
        if not isinstance(value, (int, float)):
            return 0.0
        return max(0.0, min(1.0, float(value)))

    def prompt(program: Program) -> str:
        return mutation_prompt(
            statement=statement,
            scorecard=scorecard,
            parent_code=program.code,
            parent_score=_finite(program.metrics.get(SCORE_KEY)),
            best_score=None,
            recent=(),
            frozen=frozen,
            feedback=program.error,
        )

    return Domain(
        name=str(scorecard.get("hash") or "test-gate"),
        entrypoint=target,
        metric_key=str(criterion["id"]),
        metric_better="higher",
        initial_program=(workspace / target).read_text(encoding="utf-8") if target else "",
        initial_summary="the current implementation",
        evaluate=evaluate,
        reward=reward,
        prompt=prompt,
        task_prompt=lambda group: f"case group {group}",
        test_shards=tuple(_roles(measure)["test"]),
        data_summary={"mode": "test_gate", "frozen": list(frozen)},
    )


def _run_suite(
    code: str,
    workspace: Path,
    target: str,
    frozen: Sequence[str],
    setup_cmd: Sequence[str],
    test_cmd: Sequence[str],
    *,
    capability: SandboxCapability,
    timeout: float,
) -> Optional[Dict[str, bool]]:
    """Materialise, re-freeze, run, and read the results back."""
    with tempfile.TemporaryDirectory(prefix="evolve-suite-") as scratch_dir:
        scratch = Path(scratch_dir) / "work"
        shutil.copytree(workspace, scratch, symlinks=False)

        if target:
            (scratch / target).write_text(code, encoding="utf-8")

        # **After** the candidate is written, so a candidate that touched a
        # frozen path — deliberately or by rewriting a whole directory — finds
        # it restored before anything runs.
        restored = _restore_frozen(workspace, scratch, frozen)
        if restored:
            log.info("restored %d frozen path(s) before running the suite", restored)

        junit = scratch / ".junit.xml"
        env_extra = {JUNIT_ENV: str(junit)}

        if setup_cmd:
            ok, why = _run(setup_cmd, scratch, capability, timeout, env_extra)
            if not ok:
                raise TestGateError(f"the setup command failed before any test ran: {why}")
        _ran, why = _run(test_cmd, scratch, capability, timeout, env_extra)

        if not junit.exists():
            # No report at all means the runner never got as far as writing one,
            # and its own output is the only thing that says why.
            raise TestGateError(
                f"the test suite produced no JUnit report. The command "
                f"{' '.join(test_cmd)} said: {why or '(no output)'}"
            )
        return _read_junit(junit)


def _restore_frozen(pristine: Path, scratch: Path, frozen: Sequence[str]) -> int:
    """Copy every frozen path back over the candidate's copy.

    Deletions count: a candidate that removes `tests/test_hard.py` has weakened
    the measurement exactly as much as one that edits it, and only restoring
    files that still exist would miss that.
    """
    restored = 0
    for source in sorted(_frozen_files(pristine, frozen)):
        destination = scratch / source.relative_to(pristine)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        restored += 1
    return restored


def _frozen_files(pristine: Path, frozen: Sequence[str]) -> Set[Path]:
    """Every file a frozen pattern covers.

    A directory match is expanded to everything under it, because `tests/**` is
    the pattern the design itself gives as the example and `pathlib` matches
    only the *directory* with it. Read literally, the documented way to freeze a
    test suite would freeze nothing — and nothing about the run would say so.
    """
    files: Set[Path] = set()
    for pattern in frozen:
        for match in pristine.glob(pattern):
            if match.is_file():
                files.add(match)
            elif match.is_dir():
                files.update(path for path in match.rglob("*") if path.is_file())
    return files


def _run(
    command: Sequence[str],
    cwd: Path,
    capability: SandboxCapability,
    timeout: float,
    env_extra: Mapping[str, str],
) -> Tuple[bool, str]:
    """`(succeeded, why not)`.

    The reason is carried out because the two ways this fails read identically
    from the outside and need opposite fixes: a suite that fails because the
    candidate is wrong is the signal, and a suite that fails because its runner
    is not installed is a deployment problem being reported as "your code is
    broken".
    """
    # `env_extra` goes through the sandbox seam, never merged into
    # `subprocess.run(env=...)`: bubblewrap clears the inherited environment,
    # so a merge works on macOS and silently vanishes on Linux. Here that meant
    # the suite could not see $SCIENCE_AGENT_JUNIT_XML on the server.
    argv, env = sandbox_command(
        cwd, list(command), capability=capability, timeout=timeout, extra_env=env_extra,
    )
    # The sandbox builds the argv around `sys.executable`; a test command is its
    # own program, so the interpreter prefix is dropped and the command runs as
    # given inside the same confinement.
    argv = [part for part in argv if part not in ("-I",)]
    try:
        completed = subprocess.run(
            argv, capture_output=True, text=True, cwd=str(cwd),
            env=env, timeout=timeout + 30,
        )
    except subprocess.TimeoutExpired:
        return False, f"the command ran for over {timeout + 30:.0f}s without finishing"
    if completed.returncode == 0:
        return True, ""
    tail = ((completed.stderr or "") + (completed.stdout or "")).strip()[-400:]
    log.info("suite command %s exited %d: %s", command[0], completed.returncode, tail[-300:])
    return False, tail


def _read_junit(path: Path) -> Dict[str, bool]:
    """`{test id: passed}` from a JUnit XML report.

    JUnit rather than a runner's own format because every runner emits it and
    none of them emits the same thing otherwise. A test is passed unless it
    carries a `failure` or an `error`; skipped counts as passed, because a
    skipped test says nothing about the candidate.
    """
    try:
        tree = ElementTree.parse(path)
    except ElementTree.ParseError as error:
        raise TestGateError(f"the test result is not parsable JUnit XML: {error}") from error

    outcomes: Dict[str, bool] = {}
    for case in tree.iter("testcase"):
        name = f"{case.get('classname', '')}::{case.get('name', '')}"
        broken = case.find("failure") is not None or case.find("error") is not None
        outcomes[name] = not broken
    return outcomes


def _group_of(test_id: str, seed: int, groups: int) -> int:
    """Which group a test belongs to.

    A hash of the id rather than its position: the split has to survive a test
    being added or renamed, or every group changes membership and two runs stop
    being comparable. The seed never leaves this process, so a candidate cannot
    tell which group it is being graded on.
    """
    digest = hashlib.sha256(f"{seed}:{test_id}".encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % max(1, groups)


def _roles(measure: Mapping[str, Any]) -> Dict[str, List[int]]:
    split = measure.get("caseSplit") or {}
    rollout = int(split.get("rolloutGroups") or 0)
    gate = int(split.get("gateGroups") or 0)
    test = int(split.get("testGroups") or 0)
    return {
        "gate": list(range(rollout, rollout + gate)),
        "rollout": list(range(rollout)),
        "test": list(range(rollout + gate, rollout + gate + test)),
    }


def _group_count(measure: Mapping[str, Any]) -> int:
    roles = _roles(measure)
    return max(1, len(roles["rollout"]) + len(roles["gate"]) + len(roles["test"]))


def _sole_python(workspace: Path) -> str:
    """The file a candidate replaces, when the goal did not name one."""
    candidates = [path for path in sorted(workspace.rglob("*.py"))
                  if "test" not in path.name and path.is_file()]
    if len(candidates) == 1:
        return str(candidates[0].relative_to(workspace))
    return ""
