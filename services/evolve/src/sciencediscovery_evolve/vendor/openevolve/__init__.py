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

"""Vendored OpenEvolve port from AgentDescent.

Uses the same Domain interface as PUCT (``vendor/puct/``): ``domain.prompt`` /
``domain.evaluate`` / ``domain.reward`` / ``domain.initial_program``. The only
difference is ``OpenEvolveArchive`` (MAP-Elites + islands + ring migration)
instead of ``PuctTree`` (flat-PUCT). Both algorithms share the four scoring
modes (scorecard / test_gate / custom_script / llm_judge) through the Domain
seam, exactly as issue #43 requires.

The function-minimization evaluator (``evaluator.py``) is kept as the upstream
benchmark task — it is one possible Domain implementation, not the only one.
"""

from .program import (
    ALLOWED_IMPORTS,
    FORBIDDEN_CALLS,
    GLOBAL_MIN_VALUE,
    GLOBAL_MIN_X,
    GLOBAL_MIN_Y,
    INITIAL_PROGRAM,
    Program,
    code_distance,
    extract_program,
    program_id,
    validate_source,
)
from .evaluator import (
    BOUNDS,
    combined_metrics,
    evaluate_source,
    framework_score,
    objective_value,
)
from .runner import main as runner_main
from .sandbox import (
    SandboxCapability,
    SandboxUnavailable,
    cpu_seconds_for,
    detect_local_capability,
    sandbox_command,
)
from .search import (
    ARCHIVE_UPDATED,
    NO_VALID_CANDIDATES,
    SCORE_KEY,
    OnEvent,
    EpsilonGreedy,
    OpenEvolveAggregator,
    OpenEvolveArchive,
    OpenEvolveStrategy,
    _noop,
    make_propose,
    make_run,
    make_reward,
)

__all__ = [
    "ALLOWED_IMPORTS",
    "ARCHIVE_UPDATED",
    "FORBIDDEN_CALLS",
    "GLOBAL_MIN_VALUE",
    "GLOBAL_MIN_X",
    "GLOBAL_MIN_Y",
    "INITIAL_PROGRAM",
    "NO_VALID_CANDIDATES",
    "OnEvent",
    "Program",
    "SandboxCapability",
    "SandboxUnavailable",
    "SCORE_KEY",
    "EpsilonGreedy",
    "OpenEvolveAggregator",
    "OpenEvolveArchive",
    "OpenEvolveStrategy",
    "code_distance",
    "cpu_seconds_for",
    "detect_local_capability",
    "extract_program",
    "make_propose",
    "make_run",
    "make_reward",
    "program_id",
    "runner_main",
    "sandbox_command",
    "validate_source",
    "_noop",
]
