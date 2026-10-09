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

"""A stop must end a scoring process, not wait for it."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_evolve.candidates import run_candidate
from sciencediscovery_evolve.sandbox_run import RunStopped, run_killable
from sciencediscovery_evolve.vendor.puct.sandbox import SandboxCapability

SLEEP = [sys.executable, "-c", "import time; time.sleep(60)"]


def _pid_alive(pid: int) -> bool:
    """Whether the process is still running.

    Not `os.kill(pid, 0)`: that succeeds for a zombie, and in a container whose
    PID 1 does not reap children a killed process stays a zombie forever.
    """
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def test_a_finished_process_returns_its_output(tmp_path: Path) -> None:
    done = run_killable(
        [sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr)"],
        cwd=tmp_path, env=dict(os.environ), timeout=10, should_stop=lambda: False,
    )
    assert (done.returncode, done.stdout.strip(), done.stderr.strip()) == (0, "out", "err")


def test_a_stop_ends_a_running_process_within_a_second(tmp_path: Path) -> None:
    stop = threading.Event()
    threading.Timer(0.5, stop.set).start()
    started = time.monotonic()
    with pytest.raises(RunStopped):
        run_killable(SLEEP, cwd=tmp_path, env=dict(os.environ), timeout=120, should_stop=stop.is_set)
    # 0.5s until the stop, one poll to notice it. The process itself sleeps 60s.
    assert time.monotonic() - started < 3.0


def test_a_stop_kills_what_the_process_spawned(tmp_path: Path) -> None:
    """The sandbox is a wrapper around the real work; killing only it leaks the work."""
    pid_file = tmp_path / "child.pid"
    parent = (
        "import subprocess, sys, time\n"
        f"child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"open({str(pid_file)!r}, 'w').write(str(child.pid))\n"
        "time.sleep(60)\n"
    )
    stop = threading.Event()
    threading.Timer(1.0, stop.set).start()
    with pytest.raises(RunStopped):
        run_killable([sys.executable, "-c", parent], cwd=tmp_path, env=dict(os.environ),
                     timeout=120, should_stop=stop.is_set)
    child = int(pid_file.read_text())
    for _ in range(20):
        if not _pid_alive(child):
            break
        time.sleep(0.1)
    assert not _pid_alive(child), "the grandchild outlived the stop"


def test_a_stopped_search_launches_nothing(tmp_path: Path) -> None:
    marker = tmp_path / "launched"
    with pytest.raises(RunStopped):
        run_killable(
            [sys.executable, "-c", f"open({str(marker)!r}, 'w').write('x')"],
            cwd=tmp_path, env=dict(os.environ), timeout=10, should_stop=lambda: True,
        )
    assert not marker.exists()


def test_the_timeout_still_applies_and_still_kills(tmp_path: Path) -> None:
    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        run_killable(SLEEP, cwd=tmp_path, env=dict(os.environ), timeout=1.0, should_stop=lambda: False)
    assert time.monotonic() - started < 4.0


def test_without_a_stop_predicate_it_behaves_like_subprocess_run(tmp_path: Path) -> None:
    done = run_killable([sys.executable, "-c", "print('ok')"], cwd=tmp_path, env=dict(os.environ), timeout=10)
    assert done.stdout.strip() == "ok"


def test_run_candidate_reports_a_stop_as_a_stopped_candidate_not_a_crash() -> None:
    # No sandbox needed: a stopped search never gets as far as preparing one, so
    # this runs on hosts without bubblewrap, and would fail there if it did.
    payload = run_candidate(
        "def train_and_predict(train, test, rows):\n    return [0.0] * rows\n", [sys.executable, "-c", "pass"],
        capability=SandboxCapability(), timeout=10.0, should_stop=lambda: True,
    )
    assert payload["ok"] is False
    assert payload["error"] == "the search was stopped"
