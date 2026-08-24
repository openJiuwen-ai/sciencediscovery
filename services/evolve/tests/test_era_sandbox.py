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

"""What confines a candidate, checked against the kernel.

The gate allows scikit-learn, so the gate cannot be the boundary — which makes
the first test here the one that decides whether any of this is safe to run.
It does not read the profile back and agree with itself; it runs a probe under
the real profile and asserts the operating system refused what the profile
claims to refuse.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from sciencediscovery_evolve.candidates import CandidateStore, run_candidate
from sciencediscovery_evolve.vendor.era.sandbox import (
    SandboxCapability,
    SandboxUnavailable,
    cpu_seconds_for,
    detect_local_capability,
    sandbox_command,
)

needs_sandbox = pytest.mark.skipif(
    not detect_local_capability().available,
    reason="needs Bubblewrap (Linux) or sandbox-exec (macOS)",
)


@needs_sandbox
def test_the_sandbox_blocks_the_writes_and_network_it_claims_to_block(tmp_path):
    """Run a probe under the real profile and assert the kernel agreed."""
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    outside = tmp_path / "outside.txt"
    probe = scratch / "probe.py"
    probe.write_text(
        "import json, socket\n"
        "result = {}\n"
        "try:\n"
        f"    open({str(outside)!r}, 'w').write('x')\n"
        "    result['outside_write'] = 'allowed'\n"
        "except Exception as exc:\n"
        "    result['outside_write'] = type(exc).__name__\n"
        "try:\n"
        f"    open({str(scratch / 'inside.txt')!r}, 'w').write('x')\n"
        "    result['inside_write'] = 'allowed'\n"
        "except Exception as exc:\n"
        "    result['inside_write'] = type(exc).__name__\n"
        "try:\n"
        "    socket.create_connection(('1.1.1.1', 53), timeout=3)\n"
        "    result['network'] = 'allowed'\n"
        "except Exception as exc:\n"
        "    result['network'] = type(exc).__name__\n"
        "print(json.dumps(result))\n",
        encoding="utf-8",
    )

    command, env = sandbox_command(
        scratch, [str(probe)], capability=detect_local_capability(), timeout=30.0,
    )
    completed = subprocess.run(command, capture_output=True, text=True,
                               timeout=90, env=env, cwd=str(scratch))
    payload = json.loads(completed.stdout.strip().splitlines()[-1])

    assert payload["outside_write"] != "allowed"
    assert payload["inside_write"] == "allowed", "a candidate must be able to use its scratch"
    assert payload["network"] != "allowed"
    assert not outside.exists(), "and the write really did not land"


@needs_sandbox
def test_the_candidate_cannot_see_the_host_environment(tmp_path):
    """The thread pinning is not advisory: it is what stops `RLIMIT_CPU` —
    which counts CPU seconds across threads — from killing a candidate for
    being fast."""
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    probe = scratch / "probe.py"
    probe.write_text(
        "import json, os\n"
        "print(json.dumps({\n"
        "  'omp': os.environ.get('OMP_NUM_THREADS'),\n"
        "  'openblas': os.environ.get('OPENBLAS_NUM_THREADS'),\n"
        "  'secret': os.environ.get('SCIENCE_AGENT_EVOLVE_SANDBOX_PROBE_SECRET'),\n"
        "}))\n",
        encoding="utf-8",
    )
    command, env = sandbox_command(
        scratch, [str(probe)], capability=detect_local_capability(), timeout=30.0,
    )
    completed = subprocess.run(
        command, capture_output=True, text=True, timeout=90,
        env={**env, "SCIENCE_AGENT_EVOLVE_SANDBOX_PROBE_SECRET": "leaked"},
        cwd=str(scratch),
    )
    payload = json.loads(completed.stdout.strip().splitlines()[-1])

    assert payload["omp"] == "1"
    assert payload["openblas"] == "1"


def test_no_backend_refuses_rather_than_running_unconfined(tmp_path):
    """The refusal *is* the feature. Upstream ships `Sandbox.run` as a
    NotImplementedError reading "Must provide a sandbox for executing untrusted
    code"; running model-written Python because the sandbox is missing would be
    the wrong way to make anything portable."""
    with pytest.raises(SandboxUnavailable, match="no candidate isolation"):
        sandbox_command(tmp_path, ["x.py"], capability=SandboxCapability(), timeout=10.0)


def test_the_container_corrections_reach_the_command(tmp_path):
    """`--disable-userns` and the procfs fallback come from the control plane's
    probe, not from a second `which bwrap` in this process."""
    plain = SandboxCapability(backend="bwrap", bwrap_path="/usr/bin/bwrap")
    command, _ = sandbox_command(tmp_path, ["x.py"], capability=plain, timeout=10.0)
    assert "--disable-userns" not in command
    assert command[command.index("--proc") + 1] == "/proc"

    contained = SandboxCapability(
        backend="bwrap", bwrap_path="/usr/bin/bwrap", disable_userns=True, proc_mode="bind",
    )
    command, _ = sandbox_command(tmp_path, ["x.py"], capability=contained, timeout=10.0)
    assert "--disable-userns" in command
    assert "--proc" not in command, "a host that refuses a fresh procfs gets the bind fallback"

    # Whatever the corrections, these never change.
    for flag in ("--unshare-net", "--die-with-parent", "--clearenv"):
        assert flag in command


def test_a_cpu_budget_is_never_below_two_seconds():
    # One second is spent before an interpreter has finished importing pandas.
    assert cpu_seconds_for(0.1) == 2
    assert cpu_seconds_for(60.0) == 60
    assert cpu_seconds_for(60.4) == 61


def test_the_gate_refuses_before_anything_is_executed(tmp_path):
    """A gate refusal must not depend on having a sandbox: it is the cheap
    check, and it reports a readable reason rather than a kill."""
    payload = run_candidate(
        "import subprocess\ndef train_and_predict(a, b): return []",
        ["runner.py"],
        capability=SandboxCapability(),   # deliberately unavailable
        timeout=5.0,
    )
    assert payload["ok"] is False
    assert payload["error"].startswith("gate:")


@needs_sandbox
def test_a_candidate_that_prints_nothing_is_a_failure_not_a_crash(tmp_path):
    """Every way a candidate can go wrong comes back as a payload: a node is
    appended for a failed expansion either way, and an exception here would lose
    the run instead of the candidate."""
    payload = run_candidate(
        "def train_and_predict(train_path, test_path):\n    return []\n",
        ["-c", "pass"],
        capability=detect_local_capability(),
        timeout=5.0,
    )
    assert payload["ok"] is False
    assert "no runner output" in payload["error"]


def test_candidate_sources_are_addressed_by_content(tmp_path):
    store = CandidateStore(tmp_path)
    first = store.put("run-1", "print(1)\n")
    again = store.put("run-1", "print(1)\n")
    other = store.put("run-1", "print(2)\n")

    assert first == again, "an identical candidate proposed twice is one file"
    assert first != other
    assert store.get("run-1", first) == "print(1)\n"
    assert store.get("run-1", "sha256:" + "0" * 64) is None
    # The event stream carries this hash and nothing else; the body stays here
    # until the control plane copies it into CAS.
    assert first.startswith("sha256:")


def test_an_engine_that_executes_code_is_refused_without_isolation():
    """The refusal lives with the engine, not with the caller: an engine that
    runs model-written code declares it, and one that does not (the stub) is
    unaffected."""
    import importlib

    from fastapi.testclient import TestClient

    from sciencediscovery_evolve.engine import RunSpec

    module = importlib.import_module("sciencediscovery_evolve.server")
    importlib.reload(module)

    class _Executing:
        name = "executing"
        requires_sandbox = True

        def run(self, spec: RunSpec, emit, should_stop) -> None:  # pragma: no cover - never reached
            raise AssertionError("must not start without isolation")

    module.ENGINES["executing"] = _Executing()
    client = TestClient(module.app)
    try:
        refused = client.post("/runs", json={
            "search_id": "run-nosandbox", "scorecard_hash": "sha256:card",
            "engine": "executing", "expansions": 1, "sandbox": {},
        })
        assert refused.status_code == 400
        assert refused.json()["detail"]["code"] == "sandbox_unavailable"

        allowed = client.post("/runs", json={
            "search_id": "run-stub", "scorecard_hash": "sha256:card", "expansions": 1,
        })
        assert allowed.status_code == 200, "the stub executes nothing and needs no sandbox"
    finally:
        module.ENGINES.pop("executing", None)


def test_the_sandbox_binary_is_not_looked_up_on_the_candidate_s_path(monkeypatch, tmp_path) -> None:
    """A bare `bwrap` must resolve against this process's PATH, not the minimal
    one the candidate is given.

    `sandbox_command` narrows the child's `PATH` to `/usr/bin:/bin` to constrain
    what a candidate can exec — and `subprocess.run(env=...)` resolves the
    executable against that same PATH. On a host with two bubblewraps (a new one
    in `/usr/local/bin`, the distro's older one in `/usr/bin`) the control plane
    probes one and the candidate is confined by the other. That is not
    hypothetical: it happened on a real deployment, where the older binary has
    no `--clearenv` and the run reported that the *baseline program* would not
    run.
    """
    import shutil as shutil_module

    from sciencediscovery_evolve.vendor.era import sandbox as sandbox_module

    monkeypatch.setattr(
        sandbox_module.shutil, "which",
        lambda name: "/usr/local/bin/bwrap" if name == "bwrap" else shutil_module.which(name),
    )
    capability = SandboxCapability(backend="bwrap", bwrap_path="bwrap")

    command, env = sandbox_command(tmp_path, ["-c", "pass"], capability=capability, timeout=5.0)

    assert command[0] == "/usr/local/bin/bwrap"
    # The narrow PATH is still what the candidate gets; it is just not what
    # decided which binary confines it.
    assert env["PATH"] == "/usr/bin:/bin"


def test_an_absolute_backend_path_is_used_as_given(tmp_path) -> None:
    capability = SandboxCapability(backend="bwrap", bwrap_path="/opt/custom/bwrap")
    command, _ = sandbox_command(tmp_path, ["-c", "pass"], capability=capability, timeout=5.0)
    assert command[0] == "/opt/custom/bwrap"


def test_disabling_nested_user_namespaces_carries_its_prerequisite(tmp_path) -> None:
    """`--disable-userns` without `--unshare-user` is refused by bubblewrap.

    "The sandbox may not create further user namespaces" is only enforceable
    from inside one, so the two flags travel together — and the control plane's
    probe pairs them, which means that pairing is what it verified works on this
    host. Sending half of it runs a profile nobody probed. That is exactly how
    this failed on a real deployment, reported as "the baseline program will not
    run".
    """
    hardened = SandboxCapability(backend="bwrap", bwrap_path="/usr/bin/bwrap", disable_userns=True)
    command, _ = sandbox_command(tmp_path, ["-c", "pass"], capability=hardened, timeout=5.0)

    assert "--disable-userns" in command
    assert command[command.index("--disable-userns") - 1] == "--unshare-user"

    plain = SandboxCapability(backend="bwrap", bwrap_path="/usr/bin/bwrap", disable_userns=False)
    plain_command, _ = sandbox_command(tmp_path, ["-c", "pass"], capability=plain, timeout=5.0)
    assert "--disable-userns" not in plain_command
    assert "--unshare-user" not in plain_command
