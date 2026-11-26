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

"""Why a run is ending, and how cancelled work is told apart from broken work.

A stop used to be one thing: a bare ``threading.Event`` the control plane set,
with no record of why. That was enough while "stopped" only had to end the
search. It is not enough now, because two stops want opposite things from the
work already in flight:

* a **token or cost budget** ran out. The candidates already generated and paid
  for are still worth scoring on the held-out shards — that number is the one
  thing the run never optimised against, and losing it turns a search that spent
  its budget into a search that produced no evidence of anything.
* a **user stop** or a **wall-clock limit** is a request to stop spending now.
  Extending the run for one more evaluation would be doing the opposite of what
  was asked.

So the cause travels with the flag, and a bounded final evaluation is allowed
only for the first kind. The same vocabulary names a candidate that was never
evaluated: it is not a candidate that failed, and saying so is what keeps a
cancelled run from reading as a search whose programs were all broken.

**The flag stays a predicate.** Every layer below already takes a
``should_stop`` callable — the sandbox runner, the completion client, the
domains — and none of them needed a new signature: a :class:`StopGate` is
callable, so it is still that predicate, and the cause is read from it by the
few places that have to branch on it.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager, nullcontext
from typing import Any, Callable, Dict, Iterator, Mapping, Optional

#: The budget ran out (tokens or cost). The only cause whose already-generated
#: candidates are still worth a bounded held-out evaluation.
BUDGET = "budget"
#: A hard wall-clock ceiling. Prompt by definition: it exists to bound wall time.
WALL_CLOCK = "wall_clock"
#: A person (or the agent acting for them) pressed stop.
USER = "user"
#: The control plane hung up: the stream closed while the engine was still running.
DISCONNECT = "disconnect"
#: The stream ended normally after the engine finished; recorded so a late
#: reader cannot mistake "nobody said why" for a cancellation cause.
FINISHED = "finished"

#: The causes under which a bounded held-out evaluation may still run.
FINALIZABLE = frozenset({BUDGET})

#: Every cause this side knows. Anything else is treated as a user stop, which
#: is the safe default: not finalizing can be corrected by running again, while
#: extending a run nobody asked to extend cannot be taken back.
KNOWN_CAUSES = frozenset({BUDGET, WALL_CLOCK, USER, DISCONNECT, FINISHED})


def normalize_cause(cause: str) -> str:
    """One of :data:`KNOWN_CAUSES`, or :data:`USER` for anything unrecognised.

    A request from an older or newer control plane must still stop the search:
    refusing the body with 422 would leave the run spending while the caller
    believes it asked for a stop.
    """
    normalized = str(cause or "").strip()
    return normalized if normalized in KNOWN_CAUSES else USER

#: Keys a domain puts in its metrics so the reporter can classify a node as
#: never evaluated rather than as a program that would not run. Metrics rather
#: than the error text: both clients derive a candidate's verdict from
#: `valid`/`category`, never from the sentence.
CANCELLED = "cancelled"
CANCEL_REASON = "cancelReason"

#: What to call the cause when the control plane sent no sentence with it. Each
#: is a noun phrase, because every caller reads it after "cancelled by".
CAUSE_TEXT: Dict[str, str] = {
    BUDGET: "the search budget",
    WALL_CLOCK: "the wall-clock limit",
    USER: "a user stop",
    DISCONNECT: "the control plane disconnecting",
    FINISHED: "a stop request",
    "": "a stop request",
}


def cancelled_text(reason: str) -> str:
    """The one sentence a cancelled piece of work is described with.

    "not evaluated" first, because that is the fact a reader needs: the
    candidate is neither good nor bad, it was never measured. The cause follows
    so the sentence still says what to change.
    """
    return f"not evaluated: cancelled by {reason}" if reason else "not evaluated: cancelled"


def stop_reason_of(should_stop: Optional[Callable[[], bool]]) -> str:
    """Why the run was stopped, in words, or ``""`` when nothing stopped it.

    A plain predicate — a bare ``Event.is_set`` in a test, or an engine driven
    by something other than the control plane — has no cause to report. The
    empty string is that answer, and callers fall back to a neutral sentence
    rather than inventing one.
    """
    if should_stop is None:
        return ""
    reason = getattr(should_stop, "reason", "")
    return str(reason).strip() if reason else ""


def stop_cause_of(should_stop: Optional[Callable[[], bool]]) -> str:
    if should_stop is None:
        return ""
    return str(getattr(should_stop, "cause", "") or "")


def stop_allows_finalization(should_stop: Optional[Callable[[], bool]]) -> bool:
    """Whether this stop still permits one bounded, already-paid evaluation.

    Only a token/cost budget does. An unknown cause — an older control plane, a
    bare predicate, a cause this side has not heard of — is treated like a user
    stop: stopping promptly is the safe default, and extending a run nobody
    asked to extend is the failure that is hard to take back.
    """
    return stop_cause_of(should_stop) in FINALIZABLE


@contextmanager
def relax_stop(should_stop: Optional[Callable[[], bool]]) -> Iterator[None]:
    """Run one bounded evaluation with the budget stop ignored, on this thread.

    Thread-local rather than clearing the flag, because workers abandoned by the
    same stop are still winding down: a global clear would let a model call that
    was already paid for start its retries again, which is precisely the spend
    the budget gate exists to end.
    """
    relax = getattr(should_stop, "relaxed", None)
    if relax is None:
        with nullcontext():
            yield
        return
    with relax():
        yield


def mark_cancelled(metrics: Dict[str, Any], reason: str) -> Dict[str, Any]:
    """Stamp a domain's metrics so the reporter files this as unevaluated.

    Mutates and returns the same dict: the domains build it in place and every
    caller of ``evaluate`` passes it straight on to the tree.
    """
    metrics[CANCELLED] = True
    if reason:
        metrics[CANCEL_REASON] = reason
    return metrics


def is_cancelled(metrics: Optional[Mapping[str, Any]]) -> bool:
    return bool(isinstance(metrics, Mapping) and metrics.get(CANCELLED))


def cancelled_reason(metrics: Optional[Mapping[str, Any]]) -> str:
    if not isinstance(metrics, Mapping):
        return ""
    return str(metrics.get(CANCEL_REASON) or "")


class StopGate:
    """The run's stop flag, the cause it was set with, and one bounded exception.

    Callable, so it is still the ``should_stop`` predicate every layer already
    takes. The first cause wins: a user stop that arrives after a budget gate
    fired was not what ended the run, and rewriting the reason afterwards would
    make the record disagree with the work that was actually skipped.
    """

    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._cause = ""
        self._reason = ""
        self._local = threading.local()

    # -- the predicate ---------------------------------------------------------

    def __call__(self) -> bool:
        return self._event.is_set() and not getattr(self._local, "relaxed", False)

    def is_set(self) -> bool:
        """The flag itself, ignoring a relaxation. What ``finish`` branches on:
        a relaxed evaluation must not make the run look un-stopped."""
        return self._event.is_set()

    def stop(self, reason: str = "", cause: str = "") -> bool:
        """Record the cause and set the flag. Returns whether this call set it."""
        with self._lock:
            if self._event.is_set():
                return False
            self._cause = str(cause or "")
            self._reason = str(reason or "").strip()
            self._event.set()
            return True

    @property
    def cause(self) -> str:
        return self._cause

    @property
    def reason(self) -> str:
        """What to show the reader: the control plane's own sentence when it
        sent one, and the cause's noun phrase otherwise."""
        if self._reason:
            return self._reason
        return CAUSE_TEXT.get(self._cause, CAUSE_TEXT[""])

    @contextmanager
    def relaxed(self) -> Iterator[None]:
        """Ignore the budget stop on this thread for one bounded evaluation."""
        previous = getattr(self._local, "relaxed", False)
        self._local.relaxed = True
        try:
            yield
        finally:
            self._local.relaxed = previous
