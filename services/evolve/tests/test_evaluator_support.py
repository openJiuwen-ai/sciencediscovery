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

"""The per-call limit a `custom_script` evaluator gets from the framework.

Two defects are pinned here, both from one Windows desktop experiment:

* a per-call limit implemented as a daemon thread plus ``queue.get(timeout=)``
  stops *waiting* and leaves the work running, so a timed-out call keeps
  competing with the cases after it;
* scoring inputs that the candidate can edit, because the evaluator measured its
  baseline before the call and the candidate's result from the same mutable
  objects afterwards — a candidate that zeroed its input scored 1.0.

Platform-neutral on purpose: no bubblewrap, no POSIX-only primitive. The
sandbox capability here is the `direct` backend, which is what Windows uses, so
the same file runs on both platforms when a Windows job picks it up.
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import time
from typing import Any, Dict, Iterator

import pytest

pytestmark = pytest.mark.science_tags(
    category='ut', os=('linux', 'windows'), arch=('amd64', 'arm64'),
)

from sciencediscovery_evolve import evaluator_support
from sciencediscovery_evolve.script_domain import script_domain
from sciencediscovery_evolve.vendor.puct.sandbox import SandboxCapability

CARD: Dict[str, Any] = {
    "aggregate": "weighted_sum",
    "constraints": [],
    "criteria": [{
        "direction": "maximize", "id": "exact_match", "name": "fraction of cases summed correctly",
        "measure": {
            "kind": "custom_script",
            "scriptCas": "sha256:script",
            "split": {"gateShards": 4, "rolloutShards": 4, "seed": 0, "shardRows": 0, "testShards": 2},
            "timeoutSeconds": 60,
        },
        "normalize": {"kind": "identity"}, "weight": 1.0,
    }],
    "hash": "sha256:script", "schemaVersion": 1, "solvedThreshold": 0.999,
}

#: The `direct` backend: no isolation, which is what Windows has. The deadline
#: facility has to work there, and on Linux, without a POSIX-only primitive.
DIRECT = SandboxCapability(backend="direct")

HONEST = "def solve(values):\n    return sum(values)\n"

#: An evaluator that keeps its own copy for the arithmetic and gives the
#: candidate another one, under a per-call deadline.
EVALUATOR = '''
"""solve(values) -> float: the sum of the numbers, as a float."""
import json, os
import candidate
import evaluator_support

CASES = [[10.0, 8.0, 6.0], [7.0, 5.0], [9.0, 4.0, 2.0], [6.0, 6.0],
         [3.0, 2.0, 1.0], [8.0, 1.0], [5.0, 5.0], [4.0, 4.0]]

shards = [int(part) for part in os.environ["SCIENCE_AGENT_SHARDS"].split(",") if part != ""]
hits, errors = 0.0, []
for index in shards:
    values = CASES[index % len(CASES)]
    try:
        answer = evaluator_support.call_with_deadline(
            candidate.solve, evaluator_support.candidate_copy(values), timeout=0.8)
    except (evaluator_support.DeadlineExceeded, evaluator_support.CallFailed) as error:
        errors.append("case %d: %s" % (index, error))
        continue
    # Scored against `values`, the evaluator's own copy. The candidate never saw it.
    hits += 1.0 if answer == sum(values) else 0.0
payload = {"valid": True, "metrics": {"exact_match": hits / max(len(shards), 1)},
           "error": "; ".join(errors)}
with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:
    json.dump(payload, handle)
'''

#: The same evaluator, minus the copy: a candidate that edits the argument it
#: was handed is still harmless here, because `call_with_deadline` transports
#: the arguments into another process. Kept as a test because that protection is
#: the point of the facility and must not quietly become "the evaluator
#: remembered to copy".
EVALUATOR_WITHOUT_A_COPY = EVALUATOR.replace("evaluator_support.candidate_copy(values)", "values")

#: A legacy evaluator: no `evaluator_support`, a daemon thread and a Queue
#: timeout. It must keep working — the framework does not require every existing
#: script to be rewritten — even though a wait timeout cannot stop the work.
LEGACY_EVALUATOR = '''
import json, os, queue, threading
import candidate

CASES = [[10.0, 8.0, 6.0], [7.0, 5.0], [9.0, 4.0, 2.0], [6.0, 6.0],
         [3.0, 2.0, 1.0], [8.0, 1.0], [5.0, 5.0], [4.0, 4.0]]

def guarded(values):
    answer = queue.Queue()
    def run():
        try:
            answer.put(("ok", candidate.solve(values)))
        except BaseException as error:
            answer.put(("error", repr(error)))
    threading.Thread(target=run, daemon=True).start()
    try:
        return answer.get(timeout=0.5)
    except queue.Empty:
        return ("timeout", None)

shards = [int(part) for part in os.environ["SCIENCE_AGENT_SHARDS"].split(",") if part != ""]
hits, errors = 0.0, []
for index in shards:
    values = list(CASES[index % len(CASES)])
    kind, value = guarded(values)
    if kind != "ok":
        errors.append("case %d: %s" % (index, kind))
        continue
    hits += 1.0 if value == sum(values) else 0.0
with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:
    json.dump({"valid": True, "metrics": {"exact_match": hits / max(len(shards), 1)},
               "error": "; ".join(errors)}, handle)
'''

#: The reported exploit, one layer up: the baseline is measured before the call
#: and the candidate's total after it, from the same list.
SCORING_FROM_THE_CANDIDATES_OWN_INPUT = '''
import json, os
import candidate

CASES = [[10.0, 8.0, 6.0], [7.0, 5.0], [9.0, 4.0, 2.0], [6.0, 6.0]]
shards = [int(part) for part in os.environ["SCIENCE_AGENT_SHARDS"].split(",") if part != ""]
hits, errors = 0.0, []
for index in shards:
    values = list(CASES[index % len(CASES)])
    baseline_total = sum(values)
    try:
        candidate.solve(values)
    except BaseException as error:
        errors.append("case %d: %r" % (index, error))
        continue
    candidate_total = sum(values)
    hits += baseline_total / (baseline_total + candidate_total + 1e-9)
with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:
    json.dump({"valid": True, "metrics": {"exact_match": hits / max(len(shards), 1)},
               "error": "; ".join(errors)}, handle)
'''

#: A candidate whose first call never returns and whose later calls answer. The
#: counter is a file, not a module global, because every call is its own process.
HANGS_ONCE = '''
import os, time

COUNTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_calls.txt")

def _next_call():
    try:
        with open(COUNTER, "r", encoding="utf-8") as handle:
            count = int(handle.read().strip() or "0")
    except (OSError, ValueError):
        count = 0
    count += 1
    with open(COUNTER, "w", encoding="utf-8") as handle:
        handle.write(str(count))
    return count

def solve(values):
    if _next_call() == 1:
        while True:
            time.sleep(0.25)
    return sum(values)
'''

#: Zeroes its input and returns the right answer anyway — the shape that scored
#: 1.0 under the reported evaluator.
DAMAGES_ITS_INPUT = '''
def solve(values):
    answer = sum(values)
    values[:] = [0] * len(values)
    return answer
'''

GATE_SHARDS = (4, 5, 6, 7)


@pytest.fixture()
def import_candidate(tmp_path, monkeypatch) -> Iterator[Any]:
    """Import a candidate from a private directory, the way the sandbox does."""
    def build(source: str):
        (tmp_path / "candidate.py").write_text(source, encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        monkeypatch.syspath_prepend(str(tmp_path))
        sys.modules.pop("candidate", None)
        return importlib.import_module("candidate")

    yield build
    sys.modules.pop("candidate", None)


def probe_spec(script: str, candidate_timeout: float = 20.0):
    """A `custom_script` RunSpec, the shape `run_probe` reads."""
    from sciencediscovery_evolve.engine import RunSpec

    return RunSpec(
        search_id="probe-test", algorithm="flat_puct", expansions=8,
        scorecard_hash="sha256:script", scorecard=CARD, statement="Sum the numbers",
        baseline_code=HONEST, script=script, candidate_timeout_seconds=candidate_timeout,
        sandbox=DIRECT,
    )


def _partial(script: str) -> str:
    """The same evaluator, scoring inside the band the probe expects.

    A starting point at 1.0 is refused as saturated before the behavioural gates
    run, which would hide what these tests are about.
    """
    return script.replace(
        '"exact_match": hits / max(len(shards), 1)',
        '"exact_match": 0.35 + 0.3 * hits / max(len(shards), 1)',
    )


def domain(script: str = EVALUATOR, observations=None):
    return script_domain(
        scorecard=CARD, script=script, capability=DIRECT,
        statement="Sum the numbers", baseline_code=HONEST, candidate_timeout=60.0,
        observations=observations,
    )


# --- the facility itself -----------------------------------------------------


def test_the_call_returns_what_the_candidate_returned(import_candidate):
    module = import_candidate("def solve(values):\n    return sum(values) * 2\n")

    assert evaluator_support.call_with_deadline(module.solve, [1, 2, 3], timeout=30) == 12


def test_the_candidate_only_ever_gets_its_own_copy(import_candidate):
    """The evaluator's objects are not reachable from the candidate.

    The call crosses a process boundary, so even a candidate that replaces its
    argument outright changes nothing the evaluator still holds. Without this the
    score can be computed from data the candidate chose.
    """
    module = import_candidate(
        "def solve(values):\n"
        "    values[:] = [0] * len(values)\n"
        "    return 1\n"
    )
    values = [3.0, 4.0]

    assert evaluator_support.call_with_deadline(module.solve, values, timeout=30) == 1
    assert values == [3.0, 4.0]

    # And the same split, made explicit for data the evaluator keeps.
    authoritative = evaluator_support.pristine({"values": [3.0, 4.0]})
    handed_over = evaluator_support.candidate_copy(authoritative)
    handed_over["values"][0] = 0.0
    assert authoritative == {"values": [3.0, 4.0]}


def test_a_call_that_never_returns_is_stopped_before_the_deadline_is_reported(import_candidate, tmp_path):
    """Not merely stopped *waiting*: nothing of the call keeps running.

    The candidate writes a heartbeat file in a loop. After the deadline is
    reported, the file must stop growing — that is what distinguishes a stopped
    call from a daemon thread whose `queue.get(timeout=...)` expired.
    """
    module = import_candidate(
        "import os, time\n"
        "HEARTBEAT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'heartbeat.txt')\n"
        "def solve(values):\n"
        "    while True:\n"
        "        with open(HEARTBEAT, 'a', encoding='utf-8') as handle:\n"
        "            handle.write('x')\n"
        "        time.sleep(0.05)\n"
    )
    heartbeat = tmp_path / "heartbeat.txt"

    started = time.monotonic()
    with pytest.raises(evaluator_support.DeadlineExceeded) as caught:
        evaluator_support.call_with_deadline(module.solve, [1], timeout=0.8)
    elapsed = time.monotonic() - started

    assert caught.value.timeout == pytest.approx(0.8)
    # Bounded: the deadline, plus the kill and reap, not the call's own patience.
    assert elapsed < 10.0
    assert heartbeat.exists(), "the candidate never ran, so the stop was not exercised"
    size = heartbeat.stat().st_size
    time.sleep(0.8)
    assert heartbeat.stat().st_size == size, "the timed-out call kept running after the deadline"


def test_the_deadline_includes_process_startup(import_candidate):
    """A deadline too small for a process start is still a deadline.

    Documented in the module: the clock starts when the child interpreter is
    launched, so startup, the candidate's import and the call are all inside the
    budget. A budget that cannot cover startup therefore expires, rather than
    being silently extended — which is the difference between "one second per
    call" and "one second per call plus whatever startup costs".
    """
    module = import_candidate(HONEST)

    with pytest.raises(evaluator_support.DeadlineExceeded):
        evaluator_support.call_with_deadline(module.solve, [1], timeout=0.001)


def test_a_raising_candidate_is_reported_with_a_line_number(import_candidate):
    """The traceback is what the next author repairs from."""
    module = import_candidate(
        "def solve(values):\n"
        "    raise ValueError('deliberate failure')\n"
    )

    with pytest.raises(evaluator_support.CallFailed) as caught:
        evaluator_support.call_with_deadline(module.solve, [1], timeout=30)

    assert "candidate.py" in caught.value.traceback
    assert "line" in caught.value.traceback
    assert "deliberate failure" in caught.value.traceback


def test_an_unpicklable_return_value_is_named_rather_than_hanging(import_candidate):
    module = import_candidate(
        "import threading\n"
        "LOCK = threading.Lock()\n"
        "def solve(values):\n"
        "    return LOCK\n"
    )

    with pytest.raises(evaluator_support.CallFailed) as caught:
        evaluator_support.call_with_deadline(module.solve, [1], timeout=30)

    assert "process boundary" in str(caught.value)


def test_a_call_without_a_positive_timeout_is_refused(import_candidate):
    module = import_candidate(HONEST)

    with pytest.raises(ValueError):
        evaluator_support.call_with_deadline(module.solve, [1], timeout=0)
    with pytest.raises(TypeError):
        evaluator_support.call_with_deadline(module.solve, [1])


def test_each_call_is_recorded_so_a_deadline_can_be_observed(import_candidate, tmp_path):
    """The observation the probe reads: a deadline, then a call that worked."""
    module = import_candidate(
        "import os, time\n"
        "COUNTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'calls.txt')\n"
        "def solve(values):\n"
        "    try:\n"
        "        count = int(open(COUNTER).read().strip() or '0')\n"
        "    except (OSError, ValueError):\n"
        "        count = 0\n"
        "    open(COUNTER, 'w').write(str(count + 1))\n"
        "    if count == 0:\n"
        "        while True:\n"
        "            time.sleep(0.25)\n"
        "    values[:] = [0] * len(values)\n"
        "    return sum(values)\n"
    )

    with pytest.raises(evaluator_support.DeadlineExceeded):
        evaluator_support.call_with_deadline(module.solve, [1.0, 2.0], timeout=0.8)
    assert evaluator_support.call_with_deadline(module.solve, [1, 2], timeout=30) == 0

    records = [
        json.loads(line)
        for line in (tmp_path / evaluator_support.OBSERVATIONS).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert [record["outcome"] for record in records] == ["deadline", "ok"]
    assert records[0]["target"] == "candidate.solve"
    assert records[1]["mutated"] is True
    assert all(record["seconds"] >= 0 for record in records)


#: A stand-in for the evaluator process: the thing `run_killable` starts and
#: kills. It makes one call and would wait for it forever.
EVALUATOR_STAND_IN = '''
import sys

sys.path.insert(0, {support_dir!r})
import candidate
import evaluator_support

print("ready", flush=True)
try:
    evaluator_support.call_with_deadline(candidate.solve, [1.0], timeout=300.0)
except evaluator_support.DeadlineExceeded:
    pass
'''

#: A candidate whose only job is to prove it is still running.
LOOPING = '''
import os, time

HEARTBEAT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "orphan-heartbeat.txt")

def solve(values):
    while True:
        with open(HEARTBEAT, "a", encoding="utf-8") as handle:
            handle.write("x")
        time.sleep(0.05)
'''


def test_the_call_dies_with_the_evaluator_that_started_it(tmp_path):
    """A stop or outer timeout must not leave the call running in the background.

    The call is a session of its own — that is what lets a deadline kill the
    whole call tree — so the killer that stops the evaluator cannot reach it.
    The child has to notice that its evaluator is gone and take its own process
    group with it. Before that guard existed, this test failed: the heartbeat
    kept growing after the evaluator was killed.
    """
    (tmp_path / "candidate.py").write_text(LOOPING, encoding="utf-8")
    support_dir = os.path.dirname(os.path.abspath(evaluator_support.__file__))
    (tmp_path / "stand_in.py").write_text(
        EVALUATOR_STAND_IN.format(support_dir=support_dir), encoding="utf-8",
    )
    heartbeat = tmp_path / "orphan-heartbeat.txt"

    evaluator = subprocess.Popen(
        [sys.executable, str(tmp_path / "stand_in.py")], cwd=str(tmp_path),
        stdout=subprocess.PIPE, text=True,
    )
    try:
        assert evaluator.stdout is not None
        assert evaluator.stdout.readline().strip() == "ready"
        deadline = time.monotonic() + 20.0
        while not heartbeat.exists() or heartbeat.stat().st_size == 0:
            assert time.monotonic() < deadline, "the call never started"
            time.sleep(0.05)

        # Exactly what the outer killer does to the evaluator: SIGKILL it. The
        # call is in its own session, so nothing reaches the child but the guard.
        evaluator.kill()
        evaluator.wait(timeout=20.0)

        # The guard polls, so it needs a moment. What matters is that the work
        # stops and stays stopped, not that it stops within the same millisecond.
        deadline = time.monotonic() + 15.0
        stopped = False
        size = 0
        while time.monotonic() < deadline:
            size = heartbeat.stat().st_size
            time.sleep(0.5)
            if heartbeat.stat().st_size == size:
                stopped = True
                break
        assert stopped, "the candidate call kept running after the evaluator was killed"
        time.sleep(1.0)
        assert heartbeat.stat().st_size == size, (
            "the candidate call resumed after it had stopped"
        )
    finally:
        if evaluator.poll() is None:
            evaluator.kill()
            evaluator.wait(timeout=20.0)


def test_a_child_whose_evaluator_is_already_gone_never_runs_the_candidate(tmp_path):
    """The startup window: the pid comes from the caller, not from `getppid()`.

    If the evaluator dies between the spawn and the child's first instruction,
    the child has already been reparented — `getppid()` then answers with init or
    a subreaper, which is alive forever, and the call would run to completion for
    an evaluator nobody is waiting for. `call_with_deadline` passes its own pid
    instead, and the child checks it before touching the job.
    """
    import pickle

    (tmp_path / "candidate.py").write_text(LOOPING, encoding="utf-8")
    job = tmp_path / "job.pkl"
    with job.open("wb") as handle:
        pickle.dump({"module": "candidate", "qualname": "solve", "args": ([1.0],), "kwargs": {}}, handle)
    result = tmp_path / "result.pkl"
    # A pid that is certainly not this test process, and certainly gone.
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()

    options = {"start_new_session": True} if os.name == "posix" else {}
    subprocess.run(
        [sys.executable, os.path.abspath(evaluator_support.__file__),
         str(job), str(result), str(gone.pid)],
        cwd=str(tmp_path), timeout=30, check=False, **options,
    )

    assert not (tmp_path / "orphan-heartbeat.txt").exists(), (
        "the candidate ran for an evaluator that was already gone"
    )
    assert not result.exists() or result.stat().st_size == 0


class _StoppedHere(BaseException):
    """What the child's exit looks like when it is intercepted in-process."""


def test_the_startup_window_check_is_one_predicate_a_test_can_ask(tmp_path, monkeypatch):
    """The property holds on every platform, including one with no runner here.

    On Windows the liveness question cannot be answered by `os.kill` and must
    not be answered by `getppid()`, so it is asked of a process handle, once,
    *before* the job is opened. That ordering is the property the new Windows
    step pins, and it is the one a guard *thread* cannot provide: the thread is
    started moments before the candidate is imported and called, so a call begun
    for an evaluator that died during startup would still run the candidate.

    Replacing this one predicate shows the ordering without needing Windows: when
    it says "gone", `_child` must stop before it opens the job, so the candidate
    cannot have run and no result can have been written.
    """
    import pickle

    (tmp_path / "candidate.py").write_text(LOOPING, encoding="utf-8")
    job = tmp_path / "job.pkl"
    with job.open("wb") as handle:
        pickle.dump(
            {"module": "candidate", "qualname": "solve", "args": ([1.0],), "kwargs": {}}, handle)
    result = tmp_path / "result.pkl"

    asked: list = []

    def gone(_pid: int) -> bool:
        asked.append(_pid)
        return True

    def stop() -> None:
        raise _StoppedHere

    monkeypatch.setattr(evaluator_support, "_evaluator_is_gone", gone)
    monkeypatch.setattr(evaluator_support, "_end_the_call", stop)
    monkeypatch.chdir(tmp_path)

    with pytest.raises(_StoppedHere):
        evaluator_support._child(str(job), str(result), 4242)

    # The question was asked about the pid it was given, exactly once, and the
    # candidate never had the chance to write its heartbeat or a result.
    assert asked == [4242]
    assert not (tmp_path / "orphan-heartbeat.txt").exists()
    assert not result.exists()


def test_the_windows_liveness_helper_reads_a_missing_process_as_gone(monkeypatch):
    """The Windows half, exercised through its declarations rather than Windows.

    Two answers must count as "gone" and are the ones an untyped ctypes call
    gets wrong: no such process (87) and a failed wait (`0xFFFFFFFF`, which reads
    as "still waiting" if it is compared without a declared result type).
    """
    ctypes = pytest.importorskip("ctypes")
    wintypes = pytest.importorskip("ctypes.wintypes")
    assert hasattr(wintypes, "HANDLE")

    class _Function:
        """A Win32 function stand-in, with the prototype attributes ctypes wants."""

        def __init__(self, call) -> None:
            self._call = call
            self.restype = None
            self.argtypes: list = []

        def __call__(self, *args):
            return self._call(*args)

    class _FakeKernel32:
        def __init__(self, handle: int, status: int, error: int) -> None:
            self.handle = handle
            self.status = status
            self.error = error
            self.closed: list = []
            self.OpenProcess = _Function(self._open)
            self.WaitForSingleObject = _Function(self._wait)
            self.CloseHandle = _Function(self._close)

        def _open(self, _access, _inherit, _pid):
            return self.handle

        def _wait(self, _handle, _milliseconds):
            return self.status

        def _close(self, handle):
            self.closed.append(handle)
            return 1

    # No handle at all: the evaluator died before the handle could be opened —
    # or the handle cannot be taken. Either way there is no way to ask whether it
    # is alive, so the answer is "gone" rather than a spin that never ends.
    for error in (87, 5):        # no such process; access denied
        missing = _FakeKernel32(handle=0, status=0, error=error)
        monkeypatch.setattr(ctypes, "WinDLL", lambda *_a, **_k: missing, raising=False)
        assert evaluator_support._windows_process_is_gone(1234, wait_ms=0) is True
        assert missing.closed == []

    # A live process: the wait times out and the handle is still closed.
    alive = _FakeKernel32(handle=77, status=0x102, error=0)
    monkeypatch.setattr(ctypes, "WinDLL", lambda *_a, **_k: alive, raising=False)
    assert evaluator_support._windows_process_is_gone(1234, wait_ms=0) is False
    assert alive.closed == [77]

    # A signalled handle: the evaluator exited.
    exited = _FakeKernel32(handle=78, status=0, error=0)
    monkeypatch.setattr(ctypes, "WinDLL", lambda *_a, **_k: exited, raising=False)
    assert evaluator_support._windows_process_is_gone(1234, wait_ms=1000) is True
    assert exited.closed == [78]

    # WAIT_FAILED is not evidence of life, so it ends the call.
    failed = _FakeKernel32(handle=79, status=0xFFFFFFFF, error=0)
    monkeypatch.setattr(ctypes, "WinDLL", lambda *_a, **_k: failed, raising=False)
    assert evaluator_support._windows_process_is_gone(1234, wait_ms=1000) is True
    assert failed.closed == [79]


#: An evaluator with no per-call limit at all: `candidate.solve` runs in its own
#: process, so a call that never returns blocks until the whole evaluation is
#: killed. This is the shape the timeout check exists to refuse.
NO_PER_CALL_LIMIT = '''
import json, os
import candidate

shards = [int(part) for part in os.environ["SCIENCE_AGENT_SHARDS"].split(",") if part]
hits = 0.0
for index in shards:
    try:
        answer = candidate.solve([1.0] * len(shards))
    except Exception:
        continue
    hits += 1.0 if answer == float(len(shards)) else 0.0
with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:
    json.dump({"valid": True, "metrics": {"exact_match": hits / max(len(shards), 1)}}, handle)
'''


def test_a_per_call_limit_below_the_bound_passes_the_check(monkeypatch):
    """The bound must not refuse a script that does have a per-call limit.

    A legitimately slow-but-sound evaluator is the case the bound could misjudge:
    it stops its own evaluation, and "the check gave up" looks exactly like "there
    is no limit". Here the bound is scaled down for the test — the same mechanism
    the probe uses — while the evaluator limits each call to half a second, well
    inside it. The run stays valid, the score repeats, and nothing is refused.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve.probe import _hostile_candidate, _measure, _refuse_ineffective_timeout

    monkeypatch.setattr(probe_module, "TIMEOUT_CHECK_SECONDS", 2.0)
    domain, limit, bound = probe_module._timeout_check_domain(
        probe_spec(EVALUATOR, candidate_timeout=20.0), [])
    assert bound == 2.0

    hostile = _hostile_candidate(HONEST, hang_first=True)
    assert hostile is not None
    first, _raw, why = _measure(domain.evaluate, hostile, list(GATE_SHARDS))
    limit.arm()
    second, _raw2, _why2 = _measure(domain.evaluate, hostile, list(GATE_SHARDS))

    # Half the cases still scored: the first call hung (a failed case, not an
    # invalid run) and the wrapper deliberately raises on the fourth. What matters
    # is that the run is a valid partial score and that it repeats.
    assert first is not None and second is not None, why
    assert first == pytest.approx(0.5)
    assert first == pytest.approx(second)

    # And the gate itself leaves it alone.
    _refuse_ineffective_timeout(domain.evaluate, HONEST, list(GATE_SHARDS),
                                limit=limit, bound=bound, baseline_seconds=0.0)


def test_the_timeout_check_is_bounded_so_a_refusal_arrives_quickly():
    """An evaluator with no per-call limit must be refused inside the request.

    The evaluator's own outer budget is `candidate_timeout + 30` seconds — 90 for
    the shipped default — which is longer than the run-creation request a probe
    refusal has to come back inside. So this check runs on a bounded domain and
    stops its own evaluation when the bound expires, instead of waiting that
    outer budget out.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve.probe import ProbeError, _refuse_ineffective_timeout

    # The cap itself: a generous spec is capped, a small one is left alone.
    capped, _limit, bound = probe_module._timeout_check_domain(
        probe_spec(NO_PER_CALL_LIMIT, candidate_timeout=60.0), [])
    assert bound == probe_module.TIMEOUT_CHECK_SECONDS
    _small, _limit, small_bound = probe_module._timeout_check_domain(
        probe_spec(NO_PER_CALL_LIMIT, candidate_timeout=1.0), [])
    assert small_bound == 1.0

    # And the refusal arrives at the bound, not at the outer budget: with a
    # one-second bound the old path would have waited 31 seconds for its kill.
    _domain, limit, bound = probe_module._timeout_check_domain(
        probe_spec(NO_PER_CALL_LIMIT, candidate_timeout=1.0), [])
    started = time.monotonic()
    with pytest.raises(ProbeError) as caught:
        _refuse_ineffective_timeout(
            _domain.evaluate, HONEST, list(GATE_SHARDS),
            limit=limit, bound=bound, baseline_seconds=0.0,
        )
    elapsed = time.monotonic() - started

    assert elapsed < 15.0, f"the refusal took {elapsed:.1f}s"
    said = str(caught.value)
    assert "1s this check allows one whole evaluation" in said
    assert "per-call limit" in said
    assert "ordinary cases are slower than this check allows" in said


#: A sound evaluator whose *own* per-case work is slow. Each candidate call is
#: stopped at a small deadline, and the scoring work after it takes longer than
#: the check's floor, so the check's bound is scaled from the starting point's
#: measured time to give it proportional room. The probe's own timing is the
#: scale, not an observation the evaluator could write.
SLOW_ORDINARY_CASES = '''
import json, os, time
import candidate
import evaluator_support

shards = [int(part) for part in os.environ["SCIENCE_AGENT_SHARDS"].split(",") if part]
hits, errors = 0.0, []
for index in shards:
    values = [1.0] * (index + 1)
    try:
        answer = evaluator_support.call_with_deadline(candidate.solve, values, timeout=2.0)
    except evaluator_support.DeadlineExceeded as error:
        errors.append("case %d: %s" % (index, error))
        time.sleep(0.6)
        continue
    except Exception:
        errors.append("case %d: candidate failed" % index)
        time.sleep(0.6)
        continue
    time.sleep(0.6)       # the evaluator's own scoring, after the call returned
    hits += 1.0 if answer == float(len(values)) else 0.0
with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:
    json.dump({"valid": True, "metrics": {"exact_match": hits / max(len(shards), 1)},
               "error": "; ".join(errors)}, handle)
'''

#: The same slow ordinary work, but with no per-call limit at all. Scaling the
#: bound by the starting point must not turn this into a pass: its non-returning
#: call is cut and refused at the scaled bound.
SLOW_NO_LIMIT = '''
import json, os, time
import candidate

shards = [int(part) for part in os.environ["SCIENCE_AGENT_SHARDS"].split(",") if part]
hits = 0.0
for index in shards:
    try:
        answer = candidate.solve([1.0] * (index + 1))
    except Exception:
        time.sleep(0.6)
        continue
    time.sleep(0.6)
    hits += 0.2 if answer == float(index + 1) else 0.0
with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:
    json.dump({"valid": True, "metrics": {"exact_match": hits / max(len(shards), 1)}}, handle)
'''

#: A legacy evaluator whose ordinary work is slow: it limits each call by
#: *waiting* on a daemon thread with a queue timeout, writes no observations,
#: and then spends time on its own scoring. The scaled bound leaves it room, so
#: it passes; its cleanup cannot be observed and the probe says so.
SLOW_LEGACY = LEGACY_EVALUATOR.replace(
    "import json, os, queue, threading",
    "import json, os, queue, threading, time",
).replace(
    "    hits += 1.0 if value == sum(values) else 0.0",
    "    time.sleep(0.6)\n    hits += 1.0 if value == sum(values) else 0.0",
)

#: A no-per-call-limit evaluator that also writes a fake deadline record. The
#: file is the evaluator's own output, so the probe must not let it decide that
#: the bound was only exceeded because of ordinary work.
FAKES_A_DEADLINE = '''
import json, os
import candidate

with open("evaluator_support.jsonl", "a", encoding="utf-8") as handle:
    handle.write('{"target": "candidate.solve", "outcome": "deadline", "seconds": 0.001}\\n')

shards = [int(part) for part in os.environ["SCIENCE_AGENT_SHARDS"].split(",") if part]
hits = 0.0
for index in shards:
    try:
        answer = candidate.solve([1.0] * len(shards))
    except Exception:
        continue
    hits += 1.0 if answer == float(len(shards)) else 0.0
with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:
    json.dump({"valid": True, "metrics": {"exact_match": hits / max(len(shards), 1)}}, handle)
'''


def _measured_baseline_seconds(script: str, candidate_timeout: float = 20.0) -> float:
    """Time the starting-point evaluation the probe already pays for."""
    from sciencediscovery_evolve.probe import _measure

    spec = probe_spec(script, candidate_timeout)
    measuring = script_domain(
        scorecard=spec.scorecard, script=spec.script, capability=spec.sandbox,
        baseline_code=spec.baseline_code, candidate_timeout=spec.candidate_timeout_seconds,
    )
    started = time.monotonic()
    baseline, _raw, why = _measure(measuring.evaluate, HONEST, list(GATE_SHARDS))
    elapsed = time.monotonic() - started
    assert baseline is not None, why
    return elapsed


def test_a_slow_but_limited_evaluator_passes_inside_the_scaled_bound():
    """The bound grows with the starting point, so slow-but-sound work fits.

    The bound is `min(budget, max(15, baseline + 15))`, timed from the starting
    point the probe already ran. A script whose per-call limit is real and whose
    ordinary work is slow finishes both check evaluations inside that scaled
    bound, so the gate leaves it alone — and its deadline, followed by a later
    case that still scores, is observed.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve.probe import _refuse_ineffective_timeout, _timeout_check_bound

    baseline_seconds = _measured_baseline_seconds(SLOW_ORDINARY_CASES)
    assert baseline_seconds >= 1.0, baseline_seconds
    expected_bound = _timeout_check_bound(20.0, baseline_seconds)
    assert expected_bound >= baseline_seconds + probe_module.TIMEOUT_CHECK_SECONDS - 0.1

    observations: list = []
    domain, limit, bound = probe_module._timeout_check_domain(
        probe_spec(SLOW_ORDINARY_CASES, candidate_timeout=20.0), observations, baseline_seconds)
    assert bound == pytest.approx(expected_bound)

    _refuse_ineffective_timeout(
        domain.evaluate, HONEST, list(GATE_SHARDS), observations,
        limit=limit, bound=bound, baseline_seconds=baseline_seconds,
    )

    assert len(observations) == 2, observations
    assert any(record.get("outcome") == "deadline" for record in observations[0]), observations


def test_a_slow_legacy_waiting_evaluator_passes_inside_the_scaled_bound(monkeypatch):
    """F16: the slow waiting-based script gets room, and its cleanup is disclosed.

    A legacy evaluator that limits each call with a queue timeout writes no
    observations, so nothing it produces could be the scale. The starting point's
    measured time gives it the same headroom an ordinary evaluation gets, both
    check runs fit, and the probe says the abandoned work's cleanup could not be
    observed instead of claiming it was.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve.probe import _refuse_ineffective_timeout, _timeout_check_bound

    assert "time.sleep(0.6)" in SLOW_LEGACY, "the slow test evaluator was not built"
    said: list = []
    monkeypatch.setattr(
        probe_module.log, "info",
        lambda message, *args: said.append(message % args if args else message),
    )

    baseline_seconds = _measured_baseline_seconds(SLOW_LEGACY)
    assert baseline_seconds >= 1.0, baseline_seconds

    observations: list = []
    domain, limit, bound = probe_module._timeout_check_domain(
        probe_spec(SLOW_LEGACY, candidate_timeout=20.0), observations, baseline_seconds)
    assert bound == pytest.approx(_timeout_check_bound(20.0, baseline_seconds))

    _refuse_ineffective_timeout(
        domain.evaluate, HONEST, list(GATE_SHARDS), observations,
        limit=limit, bound=bound, baseline_seconds=baseline_seconds,
    )

    assert observations[-1] == [], "the legacy script was expected to write no records"
    assert any("could not be observed" in message for message in said), said


def test_a_slow_no_limit_evaluator_is_still_refused(monkeypatch):
    """A slow starting point scales the bound; it does not exempt a no-limit script.

    This is the case the previous disclosure rule let through: slow ordinary work
    plus no per-call limit looked exactly like a real limit whose cases are slow.
    The scaled bound refuses it, names the three causes and reports the measured
    starting-point time.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve.probe import ProbeError, _refuse_ineffective_timeout

    monkeypatch.setattr(probe_module, "TIMEOUT_CHECK_SECONDS", 1.0)
    baseline_seconds = _measured_baseline_seconds(SLOW_NO_LIMIT)
    assert baseline_seconds >= 1.0, baseline_seconds

    observations: list = []
    domain, limit, bound = probe_module._timeout_check_domain(
        probe_spec(SLOW_NO_LIMIT, candidate_timeout=20.0), observations, baseline_seconds)
    assert bound == pytest.approx(min(20.0, baseline_seconds + 1.0))

    with pytest.raises(ProbeError) as caught:
        _refuse_ineffective_timeout(
            domain.evaluate, HONEST, list(GATE_SHARDS), observations,
            limit=limit, bound=bound, baseline_seconds=baseline_seconds,
        )

    said = str(caught.value)
    assert "no per-call limit" in said
    assert "ordinary cases are slower than this check allows" in said
    assert "starting point itself took" in said


def test_a_fake_deadline_record_cannot_prevent_the_refusal(monkeypatch):
    """The evaluator cannot forge the evidence that turns a refusal into a pass.

    `evaluator_support.jsonl` is written by the evaluator, so a script with no
    per-call limit could append a `deadline` line and claim its ordinary work was
    the reason the check did not finish. The scale uses the probe's own timing of
    the starting point instead: here that is fast, so the no-limit script is
    refused despite the fake record.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve.probe import ProbeError, _refuse_ineffective_timeout

    monkeypatch.setattr(probe_module, "TIMEOUT_CHECK_SECONDS", 2.0)
    baseline_seconds = _measured_baseline_seconds(FAKES_A_DEADLINE)
    assert baseline_seconds < 2.0, baseline_seconds

    observations: list = []
    domain, limit, bound = probe_module._timeout_check_domain(
        probe_spec(FAKES_A_DEADLINE, candidate_timeout=20.0), observations, baseline_seconds)

    with pytest.raises(ProbeError) as caught:
        _refuse_ineffective_timeout(
            domain.evaluate, HONEST, list(GATE_SHARDS), observations,
            limit=limit, bound=bound, baseline_seconds=baseline_seconds,
        )

    # The fake line was collected (so the test really exercised the bypass) and
    # was not allowed to decide anything.
    assert any(
        record.get("outcome") == "deadline"
        for record in (observations[-1] if observations else [])
    ), observations
    assert "whole evaluation of the gate shards" in str(caught.value)


def test_the_timeout_check_bound_scales_with_the_starting_point():
    """The scale itself: floor, cap, and the measured starting-point time."""
    from sciencediscovery_evolve.probe import TIMEOUT_CHECK_SECONDS, _timeout_check_bound

    assert _timeout_check_bound(180.0, 0.0) == TIMEOUT_CHECK_SECONDS
    assert _timeout_check_bound(180.0, 10.0) == 10.0 + TIMEOUT_CHECK_SECONDS
    assert _timeout_check_bound(12.0, 10.0) == 12.0
    assert _timeout_check_bound(1.0, 0.0) == 1.0


def test_a_no_limit_evaluator_is_still_refused_with_every_cause_named(monkeypatch):
    """With a fast starting point the bound still refuses, and names all three causes.

    Scaling only adds the starting point's own time; it never turns a bound
    expiry into a pass. A script with no per-call limit is refused at the bound,
    and the message names the third possibility (ordinary cases slower than the
    check) rather than blaming the limit alone.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve.probe import ProbeError, _refuse_ineffective_timeout

    monkeypatch.setattr(probe_module, "TIMEOUT_CHECK_SECONDS", 1.0)
    observations: list = []
    domain, limit, bound = probe_module._timeout_check_domain(
        probe_spec(NO_PER_CALL_LIMIT, candidate_timeout=20.0), observations, 0.0)
    assert bound == 1.0

    with pytest.raises(ProbeError) as caught:
        _refuse_ineffective_timeout(
            domain.evaluate, HONEST, list(GATE_SHARDS), observations,
            limit=limit, bound=bound, baseline_seconds=0.0,
        )

    said = str(caught.value)
    assert "no per-call limit" in said
    assert "too large to fit this check" in said
    assert "ordinary cases are slower than this check allows" in said
    assert "starting point itself took 0.00s" in said


def test_a_bound_that_cuts_the_second_evaluation_is_not_an_invalid_run(monkeypatch):
    """The probe's own clock ending the second run is the bound's refusal.

    `script_domain` reports a bound kill as `valid: false`, "the search was
    stopped" — the same shape an evaluator produces when it marks a run invalid.
    Checking `limit.expired()` before that message keeps the probe from blaming
    the evaluator for its own bound: it is the bound refusal, never "turned the
    whole evaluation invalid".
    """
    from sciencediscovery_evolve.probe import ProbeError, _SelfDeadline, _refuse_ineffective_timeout

    def stub():
        calls = {"n": 0}

        def evaluate(_candidate: str, _shards: object):
            calls["n"] += 1
            if calls["n"] == 1:
                return True, {"exact_match": 0.4, "score": 0.4}, ""
            # Still running when the bound expires; the domain reports this as
            # "the search was stopped", which is not the evaluator's diagnosis.
            time.sleep(1.0)
            return False, {"score": float("-inf")}, "the search was stopped"
        return evaluate

    with pytest.raises(ProbeError) as caught:
        _refuse_ineffective_timeout(
            stub(), HONEST, list(GATE_SHARDS), [],
            limit=_SelfDeadline(0.2), bound=0.2, baseline_seconds=0.0,
        )

    said_text = str(caught.value)
    assert "whole evaluation of the gate shards" in said_text
    assert "turned the whole evaluation invalid" not in said_text
# --- the evaluator the framework runs ---------------------------------------


def test_a_timed_out_case_fails_alone_and_the_next_case_still_scores():
    """The product-level shape of #1437: one hung call, the rest of the run intact.

    The first candidate call never returns. The case is a failure, the three
    cases after it are still measured, and the whole evaluation stays valid with
    a partial score — not an invalid run, and not a hung one. Repeating it gives
    the same number, which is what leftover work would break.
    """
    observations: list = []
    scores = []
    for _ in range(2):
        valid, metrics, error = domain(observations=observations).evaluate(HANGS_ONCE, list(GATE_SHARDS))
        assert valid, error
        scores.append(metrics["exact_match"])
        # The slot numbers are permuted to case ids, so the message names the case,
        # not the slot: exactly one timeout, in the error text the next author reads.
        assert error.count("did not return within") == 1, error

    assert scores[0] == pytest.approx(0.75)      # three of four cases measured
    assert scores[0] == pytest.approx(scores[1])

    outcomes = [record["outcome"] for record in observations[-1]]
    assert outcomes[0] == "deadline", outcomes
    assert "ok" in outcomes[1:], "no case after the timeout was observed to complete"


def test_a_candidate_that_damages_its_inputs_scores_like_an_honest_one():
    """The score is computed from the evaluator's own data, not the candidate's.

    `DAMAGES_ITS_INPUT` returns exactly what `HONEST` returns and then zeroes the
    list it was given. Under an evaluator that scores from that list it earns a
    perfect score; here the two must be equal, and the exploitable evaluator is
    included so the difference is visible rather than asserted in the abstract.
    """
    honest = domain().evaluate(HONEST, list(GATE_SHARDS))
    damaged = domain().evaluate(DAMAGES_ITS_INPUT, list(GATE_SHARDS))

    assert honest[0] and damaged[0]
    assert damaged[1]["exact_match"] == pytest.approx(honest[1]["exact_match"])

    # And without the copy it is still safe: the arguments cross a process
    # boundary, so nothing the candidate does reaches the evaluator's objects.
    without_copy = domain(EVALUATOR_WITHOUT_A_COPY).evaluate(DAMAGES_ITS_INPUT, list(GATE_SHARDS))
    assert without_copy[1]["exact_match"] == pytest.approx(honest[1]["exact_match"])

    # The defect itself, one layer up: the same candidate under an evaluator that
    # measures its baseline before the call and the candidate's total after it,
    # from the same list.
    exploitable = domain(SCORING_FROM_THE_CANDIDATES_OWN_INPUT).evaluate(
        DAMAGES_ITS_INPUT, list(GATE_SHARDS))
    assert exploitable[1]["exact_match"] == pytest.approx(1.0)


def test_a_legacy_watchdog_evaluator_still_runs_and_counts_the_timeout():
    """No `evaluator_support`, a daemon thread and a Queue timeout: still works.

    The framework does not require existing scripts to be rewritten, and this is
    the shape one real run used. What it cannot do is stop the work — so the
    deadline check in the probe verifies what is observable (the run survives,
    the score repeats) instead of pretending the thread is gone.
    """
    valid, metrics, error = domain(LEGACY_EVALUATOR).evaluate(HANGS_ONCE, [4, 5])

    assert valid, error
    assert metrics["exact_match"] == pytest.approx(0.5)   # one of the two cases measured
    assert "timeout" in error


# --- the probe's own hostile candidate --------------------------------------


def test_the_hostile_candidate_hangs_once_and_damages_what_it_is_given(import_candidate, tmp_path):
    """The probe's wrapper is what the gates exercise, so it is pinned here.

    Everything else about the probe gates can be tested with a fake `evaluate`;
    this is the one place the real wrapper runs. It has to hang exactly once (so
    the deadline fires, and the case after it can still score), and it has to
    damage the arguments it was given (so an evaluator that scores from them
    shows it).
    """
    from sciencediscovery_evolve.probe import _hostile_candidate

    module = import_candidate(
        _hostile_candidate(HONEST, hang_first=True, raise_after=None) or "",
    )

    with pytest.raises(evaluator_support.DeadlineExceeded):
        evaluator_support.call_with_deadline(module.solve, [1.0, 2.0, 3.0], timeout=0.8)
    # The call after the timed-out one answers, which is the observation the
    # probe's 'deadline, then a case that still scored' claim rests on.
    assert evaluator_support.call_with_deadline(module.solve, [1.0, 2.0, 3.0], timeout=30) == 6

    records = [
        json.loads(line)
        for line in (tmp_path / evaluator_support.OBSERVATIONS).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert [record["outcome"] for record in records] == ["deadline", "ok"]
    assert records[1]["mutated"] is True


def test_the_hostile_candidate_damages_dicts_and_immutable_containers(import_candidate):
    """Common argument shapes, not only a bare list of numbers.

    A candidate taking a dict of numbers, or a *tuple* holding the real data, used
    to come through untouched: the wrapper ran, the score did not move, and the
    probe passed without having exercised anything. The value is returned so the
    parent can see exactly what was destroyed — and what, being an immutable
    scalar, could not be.
    """
    from sciencediscovery_evolve.probe import _hostile_candidate

    module = import_candidate(
        _hostile_candidate(
            "def solve(payload):\n    return payload\n", hang_first=False, raise_after=None,
        ) or "",
    )
    assert evaluator_support.call_with_deadline(
        module.solve, {"a": 1.0, "b": 2.0}, timeout=30) == {"a": 0, "b": 0}
    # A real tuple argument: the tuple cannot change, its contents can.
    assert evaluator_support.call_with_deadline(
        module.solve, ([1.0, 2.0], 3.0), timeout=30) == ([0, 0], 3.0)
    # And a list argument behaves as before.
    assert evaluator_support.call_with_deadline(
        module.solve, [[1.0, 2.0], 3.0], timeout=30) == [[0, 0], 0]


def test_the_probe_refuses_an_evaluator_that_scores_from_the_candidates_own_input():
    """The reported defect, end to end through the real probe path.

    The evaluator measures its baseline before the call and the candidate's
    total after it, from the same list — so a candidate that returns the right
    answer and then zeroes the list scores 1.0. The probe refuses it, naming the
    copy to hand over.
    """
    from sciencediscovery_evolve.probe import ProbeError, run_probe

    with pytest.raises(ProbeError) as caught:
        run_probe(probe_spec(SCORING_FROM_THE_CANDIDATES_OWN_INPUT))

    said = str(caught.value)
    assert "1.0000" in said and "0.5000" in said
    assert "candidate_copy" in said


def test_the_probe_observes_the_deadline_and_a_later_scored_case(monkeypatch):
    """A sound evaluator passes, and the probe saw the timeout it injected."""
    from sciencediscovery_evolve import probe as probe_module

    said: list = []
    monkeypatch.setattr(
        probe_module.log, "info",
        lambda message, *args: said.append(message % args if args else message),
    )
    result = probe_module.run_probe(probe_spec(_partial(EVALUATOR)))

    assert result["flat"] is False
    assert result["baseline"] > result["worsened"]
    assert any("deadline" in message and "later candidate call" in message for message in said), said


def test_the_probe_passes_a_legacy_watchdog_and_says_cleanup_was_not_observed(monkeypatch):
    """The compatibility path: not refused, and not claimed as verified either."""
    from sciencediscovery_evolve import probe as probe_module

    said: list = []
    monkeypatch.setattr(
        probe_module.log, "info",
        lambda message, *args: said.append(message % args if args else message),
    )
    result = probe_module.run_probe(probe_spec(_partial(LEGACY_EVALUATOR)))

    assert result["flat"] is False
    assert any("could not be observed" in message for message in said), said
