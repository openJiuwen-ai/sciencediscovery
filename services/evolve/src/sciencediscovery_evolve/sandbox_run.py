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

"""Run a sandboxed process that a stop can end.

Scoring a candidate launches a confined process, and one of those can take a
couple of minutes. ``subprocess.run`` gives the caller nothing to interrupt it
with, so pressing stop meant waiting out every evaluation already in flight and
then every one the workers started after the flag was set: two minutes of
"stopping…" with the process still burning CPU on the box.

This is the one place those processes are launched from. It polls the search's
stop predicate while the process runs, ends the whole process group when it
turns true, and refuses to start one at all once the search is stopped.
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Callable, Mapping, Optional, Sequence

log = logging.getLogger("sciencediscovery.evolve.sandbox_run")

#: How often a running process is checked against the stop flag. Short enough
#: that a stop feels immediate, long enough that the loop costs nothing.
_POLL_SECONDS = 0.25

#: How long a killed process gets to be reaped before we stop waiting for it.
_REAP_SECONDS = 5.0

StopCheck = Optional[Callable[[], bool]]


class RunStopped(RuntimeError):
    """The search was stopped while this process ran, or before it could start."""


def run_killable(
    argv: Sequence[str],
    *,
    cwd: "str | Path",
    env: Optional[Mapping[str, str]],
    timeout: float,
    should_stop: StopCheck = None,
) -> "subprocess.CompletedProcess[str]":
    """``subprocess.run(capture_output=True, text=True)`` that a stop can cut short.

    Raises ``subprocess.TimeoutExpired`` after ``timeout`` seconds, as
    ``subprocess.run`` does, and ``RunStopped`` when ``should_stop()`` turns
    true. Either way the whole process group is killed before the exception
    leaves, so nothing the candidate spawned outlives the call.
    """
    if should_stop is not None and should_stop():
        raise RunStopped("the search was stopped")

    process = subprocess.Popen(
        list(argv), cwd=str(cwd), env=dict(env) if env is not None else None,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        # Its own group, so a kill reaches the sandbox and everything under it
        # without touching this service.
        start_new_session=True,
    )
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        try:
            stdout, stderr = process.communicate(timeout=max(0.0, min(_POLL_SECONDS, remaining)))
        except subprocess.TimeoutExpired:
            if should_stop is not None and should_stop():
                _kill(process)
                raise RunStopped("the search was stopped") from None
            if time.monotonic() >= deadline:
                _kill(process)
                raise subprocess.TimeoutExpired(list(argv), timeout) from None
            continue
        return subprocess.CompletedProcess(list(argv), process.returncode, stdout, stderr)


def _kill(process: "subprocess.Popen[str]") -> None:
    """End the process group and reap it. Never raises: the caller is already leaving."""
    try:
        if hasattr(os, "killpg"):
            os.killpg(process.pid, signal.SIGKILL)
        else:  # pragma: no cover - non-POSIX
            process.kill()
    except (ProcessLookupError, PermissionError):
        pass
    try:
        process.communicate(timeout=_REAP_SECONDS)
    except Exception:  # noqa: BLE001 - reaping is best effort
        log.warning("a killed sandbox process did not exit within %.0fs", _REAP_SECONDS)
