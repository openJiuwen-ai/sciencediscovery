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

"""What a `custom_script` evaluator uses for a hard per-call limit.

The framework stages this file into the scratch directory beside the evaluator,
so an evaluator gets it with ``import evaluator_support`` and no installation
step. It is stdlib only and it works on Windows, which has neither ``signal``
alarm nor a fork that can be thrown away cheaply.

Two things the evaluator cannot do for itself with threads:

**A wait timeout is not a stop.** The shape a drafting model reaches for on
Windows is a daemon thread plus ``queue.get(timeout=...)``. That stops
*waiting*; the worker keeps running, keeps its CPU, its file handles and its
memory, and keeps competing with the next case. Three scored candidates of one
real run carried per-case timeout errors while the timed-out threads were still
alive in the same process. Here the candidate call runs in a child process that
is killed and reaped before the timeout is reported, so nothing the call owned
is still running when the next case starts.

**The score must not be computable from what the candidate touched.** A
candidate that edits the list it was handed changes the data the evaluator is
about to score against, and one real evaluator turned that into a perfect
score: it measured the baseline before the call and the candidate's makespan
after it, from the same mutable objects. ``call_with_deadline`` sends the
arguments over a process boundary, so the candidate only ever owns a copy;
``pristine``/``candidate_copy`` make the same split explicit for the data the
evaluator keeps.

Deadline accounting: the clock starts when the child interpreter is launched,
so interpreter startup, the candidate's import and the call itself are all
inside the budget. That makes a deadline an *end-to-end* bound rather than a
bound on the call alone -- allow for a few hundred milliseconds of startup when
the candidate is genuinely near its limit, and measure it once with a trivial
call rather than guessing.

Limits, stated rather than implied:

* the candidate function has to be a plain module-level function
  (``candidate.solve``); its arguments and its return value have to be
  picklable. A candidate returning an unpicklable object is reported as such,
  with the remedy, instead of hanging or crashing the evaluator;
* a process the *candidate itself* spawns is killed with the child on POSIX
  (the child is a session of its own) but not on Windows, where only the direct
  child is terminated — and when the call ends, by deadline or because the
  evaluator disappeared, only that child goes: a candidate that spawned
  grandchildren leaves them on Windows, where the POSIX branch has a process
  group to take with it;
* the child watches whether the evaluator that started it is still alive and
  takes its own process group with it when that answer is no, so a user stop or
  the outer timeout cannot leave a call running in the background. On Windows
  that question is answered on a process handle rather than by ``getppid()``,
  and it is asked once *before* the candidate is loaded as well as in the guard
  thread, because an evaluator that died between the spawn and the child's first
  instruction must not get a call at all;
* a candidate can still write files in the scratch directory, including the
  file a result crosses in. The guard against a candidate scoring itself is the
  discrimination probe, not this module -- exactly as before.
"""

from __future__ import annotations

import copy
import json
import os
import pickle
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from typing import Any, Dict, Tuple

__all__ = [
    "CallFailed",
    "DeadlineExceeded",
    "OBSERVATIONS",
    "REAP_SECONDS",
    "call_with_deadline",
    "candidate_copy",
    "pristine",
]

#: How long a killed child gets to disappear before the kill is escalated and
#: how long the escalation gets before cleanup is reported as impossible. Short:
#: a process that has been SIGKILLed or ``TerminateProcess``-ed is gone in
#: milliseconds, and this only bounds the pathology.
REAP_SECONDS = 10.0

#: How often a call child checks that the evaluator which started it is still
#: there. It is a session of its own — that is what lets the deadline path kill
#: the whole call tree — so the evaluator's own stop cannot reach it and it has
#: to notice for itself.
_PARENT_POLL_SECONDS = 0.2

#: Every call leaves one JSON line here, in the evaluator's working directory.
#: The framework reads it back out of the scratch directory, so the probe can
#: observe that a deadline fired and that a later case still ran, instead of
#: taking the evaluator's word for it. Best effort: an unwritable directory is
#: not a reason to fail a call.
OBSERVATIONS = "evaluator_support.jsonl"

#: The child's own file name, so both halves of the protocol live in one file.
_HELPER = os.path.abspath(__file__)


class DeadlineExceeded(TimeoutError):
    """The call did not return in time, and it is not running any more.

    A ``TimeoutError``, which is what code around a subprocess already catches,
    so a caller can catch one family and handle both. The call's process has been
    stopped and reaped by the time this is raised: the case is a per-case
    failure, and the case after it starts clean.
    """

    def __init__(self, timeout: float, target: str) -> None:
        super().__init__(
            f"{target} did not return within {timeout:g}s; the call was stopped and its "
            "process reaped before this was raised"
        )
        self.timeout = timeout
        self.target = target


class CallFailed(RuntimeError):
    """The call ran and failed, or could not be transported back.

    Carries ``traceback`` text from the child when the candidate raised, so an
    evaluator that puts ``str(error)`` in its ``error`` field hands the next
    author a file and a line rather than an exception class name.
    """

    def __init__(self, message: str, *, traceback_text: str = "") -> None:
        super().__init__(message)
        self.traceback = traceback_text


def pristine(value: Any) -> Any:
    """A copy to validate and score from -- never the object the candidate sees.

    Scoring against the candidate's own object is how a candidate that replaces
    its input with zeros turns a real score into 1.0. Keep one copy for the
    evaluator's arithmetic and hand the other to the call::

        cases = build_cases()
        for case in cases:
            try:
                answer = call_with_deadline(candidate.solve, case.args, timeout=1.0)
            except (DeadlineExceeded, CallFailed) as error:
                failures.append((case, error))
                continue
            score_case(case.args, answer)   # `case.args` was never given to the candidate
    """
    return copy.deepcopy(value)


def candidate_copy(value: Any) -> Any:
    """A copy to hand to the candidate, so the evaluator's data stays its own.

    ``call_with_deadline`` already transports the arguments, which copies them;
    this is for the data an evaluator passes to the candidate through some other
    route, and it makes the split visible in the evaluator's own code.
    """
    return copy.deepcopy(value)


def call_with_deadline(func: Any, *args: Any, timeout: float, **kwargs: Any) -> Any:
    """Call ``func(*args, **kwargs)`` under a hard ``timeout`` in seconds.

    ``func`` is a module-level function -- ``candidate.solve`` and not the
    result of calling it. Returns whatever it returned, or raises:

    * :class:`DeadlineExceeded` when the deadline passed. The child has been
      killed and reaped before this is raised.
    * :class:`CallFailed` when the candidate raised (``.traceback`` holds the
      child's traceback text) or when the arguments or the return value cannot
      cross the process boundary.

    The deadline covers interpreter startup, the candidate's import and the call
    itself, because the clock starts before the child is launched.
    """
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise ValueError(
            f"call_with_deadline needs a positive timeout in seconds, not {timeout!r}: "
            "a call with no limit is what lets one slow candidate hold the whole "
            "evaluation open"
        )
    module, qualname = _reference(func)
    target = f"{module}.{qualname}"

    work = tempfile.mkdtemp(prefix="sd-call-")
    job_path = os.path.join(work, "job.pkl")
    result_path = os.path.join(work, "result.pkl")
    try:
        try:
            with open(job_path, "wb") as handle:
                pickle.dump(
                    {"module": module, "qualname": qualname, "args": args, "kwargs": kwargs},
                    handle,
                )
        except Exception as error:  # noqa: BLE001 - any pickling failure is the caller's data
            raise CallFailed(
                f"the arguments handed to {target} have to cross a process boundary and "
                f"cannot be pickled: {error!r}. Pass plain data (lists, numbers, strings, "
                "arrays) and keep anything else on the evaluator's side"
            ) from error

        # The evaluator's own pid, passed explicitly. The child must not read
        # `getppid()`: if this process dies between the spawn and the child's
        # first instruction, the child has already been reparented and `getppid()`
        # answers with init or a subreaper, which is alive forever.
        argv = [sys.executable, _HELPER, job_path, result_path, str(os.getpid())]
        options: Dict[str, Any] = {"cwd": os.getcwd(), "stdin": subprocess.DEVNULL}
        if os.name == "posix":
            # Its own session, so a kill reaches the child and anything the
            # candidate started under it. Windows has no such handle; the child
            # is terminated directly there.
            options["start_new_session"] = True
        started = time.monotonic()
        process = subprocess.Popen(argv, **options)
        try:
            process.wait(timeout=max(0.0, started + float(timeout) - time.monotonic()))
        except subprocess.TimeoutExpired:
            # Stopped and reaped first, observed second: a record saying the
            # deadline fired must never describe work that is still running.
            _stop(process)
            _observe(target, "deadline", started, timeout=float(timeout))
            raise DeadlineExceeded(float(timeout), target) from None
        except BaseException:
            _stop(process)
            _observe(target, "failed", started)
            raise

        try:
            value, mutated = _result_of(process, result_path, target)
        except CallFailed:
            _observe(target, "failed", started)
            raise
        _observe(target, "ok", started, mutated=mutated)
        return value
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _observe(target: str, outcome: str, started: float, **extra: Any) -> None:
    """Record what this call did, beside the evaluator and nowhere else.

    The framework collects these back into the run's diagnostics, so "the
    deadline fired and the next case still ran" is an observation rather than a
    claim. Deliberately best effort: a read-only working directory is not a
    reason for a candidate call to fail.
    """
    record = {"target": target, "outcome": outcome,
              "seconds": round(time.monotonic() - started, 3)}
    record.update(extra)
    try:
        with open(os.path.join(os.getcwd(), OBSERVATIONS), "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError:
        pass


def _reference(func: Any) -> Tuple[str, str]:
    """``(module, qualname)`` for a function that can be imported by the child."""
    module = getattr(func, "__module__", None)
    qualname = getattr(func, "__qualname__", None)
    if not isinstance(module, str) or not module or not isinstance(qualname, str):
        raise TypeError(
            f"call_with_deadline needs a module-level function such as candidate.solve; "
            f"{func!r} is not one. Pass the candidate's function itself rather than the "
            "result of calling it, or wrap it in one"
        )
    if "<" in qualname or "." in qualname:
        raise TypeError(
            f"call_with_deadline can only transport {func!r} by name, and {qualname!r} is "
            "not an importable module-level name. A nested function, a lambda or a method "
            "of an object cannot be called in the child; pass candidate.<name>"
        )
    return module, qualname


def _stop(process: "subprocess.Popen[bytes]") -> None:
    """Kill ``process`` and reap it. Returns only when it is gone."""
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                process.kill()
        else:
            process.kill()
    except OSError:
        pass
    for _attempt in range(2):
        try:
            process.wait(timeout=REAP_SECONDS)
            return
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except OSError:
                pass
    raise RuntimeError(
        "a timed-out candidate call could not be stopped or reaped, so the evaluation "
        "cannot safely continue; this is a framework fault rather than a candidate one"
    )


def _result_of(process: "subprocess.Popen[bytes]", result_path: str, target: str) -> Tuple[Any, bool]:
    """``(value, whether the call changed its arguments)``, or a named failure."""
    try:
        with open(result_path, "rb") as handle:
            data = handle.read()
    except OSError:
        data = b""
    if not data:
        raise CallFailed(
            f"the child process running {target} exited with code {process.returncode} "
            "without returning a value -- it was killed or the interpreter died before "
            "the call completed. Its output is on the evaluator's own stderr"
        )
    try:
        message = pickle.loads(data)
    except Exception as error:  # noqa: BLE001 - an unreadable result is a candidate fault
        raise CallFailed(f"the value returned by {target} could not be read back: {error!r}") from error
    status = message.get("status")
    if status == "ok":
        return message.get("value"), bool(message.get("mutated"))
    if status == "unpicklable":
        raise CallFailed(
            f"{target} returned a value that cannot cross a process boundary: "
            f"{message.get('error', 'unpicklable')}. Convert it to plain data (a list, a "
            "dict of numbers and strings) before returning it from the candidate"
        )
    raise CallFailed(
        f"{target} raised",
        traceback_text=str(message.get("error") or ""),
    )


def _snapshot(value: Any) -> Any:
    """A deep copy for spotting that the candidate changed what it was given."""
    try:
        return copy.deepcopy(value)
    except Exception:  # noqa: BLE001 - un-copyable data cannot be compared
        return _UNCOMPARABLE


_UNCOMPARABLE = object()


def _mutated(before: Any, args: Any, kwargs: Any) -> bool:
    """Whether the call changed its arguments. False when it cannot be told."""
    after = _snapshot((args, kwargs))
    if before is _UNCOMPARABLE or after is _UNCOMPARABLE:
        return False
    try:
        return bool(before != after)
    except Exception:  # noqa: BLE001 - numpy arrays answer `==` with an array
        return False


def _write(path: str, message: Dict[str, Any]) -> None:
    """Hand the message to the parent, atomically enough for a killed child."""
    temporary = f"{path}.{os.getpid()}"
    with open(temporary, "wb") as handle:
        pickle.dump(message, handle)
    os.replace(temporary, path)


def _evaluator_is_gone(parent: int) -> bool:
    """Whether the evaluator that started this call is already gone.

    The synchronous half of the guard, and the only liveness question ``_child``
    asks before it loads the job: the guard *thread* cannot answer it in time,
    because it is started moments before the candidate is imported and called,
    so a call for an evaluator that died during startup would still run the
    candidate first.

    One module-level predicate rather than a branch inside ``_child``, so the
    property is testable on a host with no Windows runner: a test replaces this
    and asserts the candidate never runs.
    """
    if parent <= 0:
        return False
    if os.name == "nt":
        return _windows_process_is_gone(parent, wait_ms=0)
    return not _parent_alive(parent)


def _windows_process_is_gone(pid: int, *, wait_ms: int) -> bool:
    """Ask a Windows process handle whether ``pid`` has exited.

    ``wait_ms=0`` answers now (the startup window); a positive value waits that
    long and answer whether it exited within it (the guard thread's poll). Every
    prototype is declared: a ``HANDLE`` is pointer-sized and would be truncated
    by ctypes' default result type, and ``WaitForSingleObject`` answers
    ``0xFFFFFFFF`` on failure — which an untyped comparison reads as "still
    waiting", i.e. exactly the wrong answer, for ever.

    ``True`` means *gone*, including every case with no evidence it is alive: a
    pid that cannot be opened at all (no such process, or a handle this process
    is not allowed to take — ``get_last_error()`` saying "no such process" and
    saying "access denied" are equally unusable here), and a wait that failed.
    A live evaluator's deadline still stops the call, so ending early is the safe
    direction; a wait that never ends is not.
    """
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    synchronize = 0x00100000
    wait_object_0 = 0x00000000
    wait_timeout = 0x00000102
    wait_failed = 0xFFFFFFFF

    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        # No handle, so no way to ask whether the evaluator is alive: "no such
        # process" and "access denied" are equally unusable answers. Treating
        # only the first as gone left the guard thread spinning on a failed open
        # for as long as the call ran, and never ending the call at all.
        return True
    try:
        status = kernel32.WaitForSingleObject(handle, wait_ms)
    finally:
        kernel32.CloseHandle(handle)
    if status == wait_timeout:
        return False
    # WAIT_OBJECT_0 is "exited"; WAIT_FAILED means the handle could not be
    # waited on, which is not evidence of life.
    return status in (wait_object_0, wait_failed)


def _guard_against_an_orphaned_call(parent: int) -> None:
    """End this call when the evaluator that started it is gone.

    `_stop` kills the child's own process group, which is right for a deadline:
    the candidate's descendants go with it. The cost is that the child sits
    outside the group ``run_killable`` kills when the user stops the search or
    the evaluator's outer timeout fires, so a stop mid-call would leave the call
    running. Nothing outside can tell that a call has been orphaned, so the call
    checks the parent itself and takes its own process group with it.
    """
    try:
        if os.name == "nt":
            _end_with_the_windows_parent(parent)
            return
        while True:
            if not _parent_alive(parent):
                _end_the_call()
            time.sleep(_PARENT_POLL_SECONDS)
    except BaseException:  # noqa: BLE001 - a guard that cannot work must not crash a call
        return


def _parent_alive(pid: int) -> bool:
    """Whether ``pid`` is still the live evaluator that started this call."""
    if pid <= 0:
        return True
    if os.name == "nt":
        # Never `os.kill` on Windows: with a signal other than the console
        # events it *terminates* the named process, so as a liveness probe it
        # would kill the evaluator it is checking. The Windows guard waits on a
        # process handle instead.
        return True
    if os.getppid() != pid:
        # Reparented to init or a subreaper: gone, whatever a signal probe says.
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def _end_with_the_windows_parent(pid: int) -> None:
    """Windows half of the guard thread: wait on the evaluator's handle.

    The blocking wait belongs in the thread; the one-off check before the job is
    loaded lives in ``_evaluator_is_gone``, on the same helper.
    """
    while not _windows_process_is_gone(pid, wait_ms=1000):
        pass
    _end_the_call()


def _end_the_call() -> None:
    """Die and, on POSIX, take anything the candidate started with this process.

    Windows has no process group to signal from here, so only this process ends:
    a candidate that started grandchildren leaves them behind, exactly as it
    would on the deadline path. Stated here as well as in the module docstring
    because this is where the difference is.
    """
    if os.name == "posix":
        try:
            os.killpg(os.getpgid(0), signal.SIGKILL)
        except OSError:
            pass
    os._exit(0)


def _child(job_path: str, result_path: str, parent: int) -> None:
    """The child's whole life: import, call, send back, leave immediately."""
    if _evaluator_is_gone(parent):
        # Already orphaned: the evaluator died between the spawn and this
        # process's first instruction. Do not run the candidate at all — on
        # every platform, and before the job is even opened.
        _end_the_call()
    try:
        threading.Thread(
            target=_guard_against_an_orphaned_call, args=(parent,), daemon=True,
        ).start()
    except RuntimeError:  # noqa: BLE001 - no thread available is not a reason to fail
        pass
    try:
        with open(job_path, "rb") as handle:
            job = pickle.load(handle)
        # The evaluator's working directory holds the candidate. The child is
        # started with the same one; put it on the path explicitly because the
        # helper is the script being run and only its own directory is added.
        sys.path.insert(0, os.getcwd())
        target = __import__(job["module"], fromlist=["_"])
        for part in str(job["qualname"]).split("."):
            target = getattr(target, part)
        args, kwargs = job["args"], job["kwargs"]
    except BaseException:  # noqa: BLE001 - reported as a failed call, not a crash
        _write(result_path, {"status": "error", "error": traceback.format_exc()})
        os._exit(0)

    before = _snapshot((args, kwargs))
    try:
        value = target(*args, **kwargs)
    except BaseException:  # noqa: BLE001 - the candidate is allowed to raise
        _write(result_path, {"status": "error", "error": traceback.format_exc()})
        os._exit(0)

    message: Dict[str, Any] = {"status": "ok", "value": value, "mutated": _mutated(before, args, kwargs)}
    try:
        _write(result_path, message)
    except Exception as error:  # noqa: BLE001 - usually an unpicklable return value
        _write(result_path, {"status": "unpicklable", "error": repr(error)})
    # Leave without waiting for anything the candidate started: a non-daemon
    # thread of its own would otherwise hold this process open until the parent
    # kills it, and the parent has already been given the answer.
    os._exit(0)


if __name__ == "__main__":
    _child(sys.argv[1], sys.argv[2], int(sys.argv[3]))
