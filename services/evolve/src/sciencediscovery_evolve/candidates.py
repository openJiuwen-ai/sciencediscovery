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

"""Running one candidate, and keeping its source where the control plane can
find it.

Two responsibilities, both deliberately small:

* **Execute** a candidate under the sandbox and return the one JSON object its
  runner prints. Everything that can go wrong here — the gate refusing the
  source, a timeout, a runner that printed nothing — comes back as a payload
  with `ok: False` and a readable reason, never as an exception, because a
  candidate failing is the normal case and a node is appended for it either way.
* **Store** the source under its own content hash. The event stream carries only
  the hash (graph = directory, CAS = warehouse); the body lands here so the
  control plane can copy it into the real CAS when the user saves an artifact.
  Writing Node's CAS layout from Python would duplicate knowledge that has one
  owner.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

from .logging_config import get_logger
from .vendor.puct.program import validate_source
from .vendor.puct.sandbox import (
    SandboxCapability,
    SandboxUnavailable,
    cpu_seconds_for,
    sandbox_command,
)

log = get_logger("candidates")

#: How long after the candidate's own budget the harness waits before giving up
#: on the process. The runner enforces `RLIMIT_CPU` from inside; this is the
#: outer bound for a process that ignored it.
_GRACE_SECONDS = 10.0


class CandidateStore:
    """Candidate sources, addressed by the hash of their content.

    Content-addressed rather than indexed by node: an identical candidate
    proposed twice is one file, and the hash in the event stream is enough to
    find it without a lookup table that could disagree with the log.
    """

    def __init__(self, root: Path) -> None:
        self.root = root

    def path_for(self, search_id: str, code_hash: str) -> Path:
        return self.root / search_id / f"{code_hash.removeprefix('sha256:')}.py"

    def put(self, search_id: str, code: str) -> str:
        digest = hashlib.sha256(code.encode("utf-8")).hexdigest()
        path = self.path_for(search_id, digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(code, encoding="utf-8")
        return f"sha256:{digest}"

    def get(self, search_id: str, code_hash: str) -> Optional[str]:
        path = self.path_for(search_id, code_hash)
        return path.read_text(encoding="utf-8") if path.exists() else None


def run_candidate(
    code: str,
    inner_args: Sequence[str],
    *,
    capability: SandboxCapability,
    timeout: float,
    max_length: int = 20_000,
    nproc_limit: int = 64,
) -> Dict[str, Any]:
    """Execute one candidate and return its runner payload.

    `inner_args` is the runner invocation minus the candidate path, which is
    appended here — the caller decides *what* measures the candidate, this
    decides *how* it is confined.
    """
    valid, reason = validate_source(code, max_length=max_length)
    if not valid:
        # The gate is not the boundary (the sandbox is), but it turns the
        # ordinary accidents into a readable message instead of a sandbox kill.
        return {"ok": False, "error": f"gate: {reason}", "seconds": 0.0}

    with tempfile.TemporaryDirectory(prefix="evolve-candidate-") as scratch_dir:
        scratch = Path(scratch_dir)
        candidate = scratch / "candidate.py"
        candidate.write_text(code, encoding="utf-8")
        inner = [*inner_args, str(candidate), "--cpu-seconds", str(cpu_seconds_for(timeout)),
                 "--nproc-limit", str(nproc_limit)]
        try:
            command, env = sandbox_command(scratch, inner, capability=capability, timeout=timeout)
        except SandboxUnavailable:
            # Never swallowed into a candidate failure: "we could not confine
            # this" is a run-level fault, not a bad candidate.
            raise

        started = time.monotonic()
        try:
            completed = subprocess.run(
                command, capture_output=True, text=True,
                timeout=timeout + _GRACE_SECONDS, env=env, cwd=str(scratch),
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"timeout after {timeout + _GRACE_SECONDS:.0f}s",
                    "seconds": time.monotonic() - started}

        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        if not lines:
            tail = (completed.stderr or "").strip()[-300:]
            return {"ok": False, "error": f"no runner output (rc={completed.returncode}): {tail}",
                    "seconds": time.monotonic() - started}
        try:
            return json.loads(lines[-1])
        except json.JSONDecodeError:
            return {"ok": False, "error": f"unparseable runner output: {lines[-1][:200]}",
                    "seconds": time.monotonic() - started}
