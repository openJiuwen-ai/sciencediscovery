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

"""Sandbox capability, re-exported from the ERA port.

OpenEvolve and ERA confine candidates with the same backends (Bubblewrap on
Linux, Seatbelt on macOS) and the same resource-limit plumbing
(``setrlimit`` in ``runner.py``). The container corrections
(``--disable-userns``, procfs fallback) are knowledge this repository has
paid for once; asking twice is how two answers disagree.

The only thing that differs between the two ports is the AST gate
(``program.py``), which is what a candidate may import. What confines a
candidate — the sandbox profile, the CPU/memory/fd limits — is the same.
"""

from __future__ import annotations

from ..puct.sandbox import (
    SandboxCapability,
    SandboxUnavailable,
    cpu_seconds_for,
    detect_local_capability,
    sandbox_command,
)

__all__ = [
    "SandboxCapability",
    "SandboxUnavailable",
    "cpu_seconds_for",
    "detect_local_capability",
    "sandbox_command",
]
