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

"""Shared output utilities for literature-searcher scripts.

Provides:
- get_output_dir(): detect JiuwenSwarm team-workspace directory via 4-layer priority.
- write_result_to_file(): write full JSON to artifacts/literature_search/ and return metadata.
- handle_output(): unified stdout metadata output for the 4 search scripts.

All literature-searcher scripts import from this module to avoid code duplication.
The file intermediary pattern prevents massive JSON from overwhelming the model context.
"""

import json
import os
import sys
from datetime import datetime


LITERATURE_SEARCH_SUBDIR = "artifacts/literature_search"


def get_output_dir() -> str:
    """Detect the JiuwenSwarm team-workspace directory for writing search results.

    Priority order:
    1. JIUWEN_TEAM_WORKSPACE env var (set by JiuwenSwarm harness)
    2. .team symlink in cwd (each agent workspace has .team/{session_id} -> team-workspace)
    3. ~/.jiuwenswarm/.agent_teams scan (find most recent session)
    4. cwd fallback (for standalone usage outside JiuwenSwarm)

    Returns:
        Absolute path to the detected team-workspace directory.
    """
    env_dir = os.environ.get("JIUWEN_TEAM_WORKSPACE", "")
    if env_dir and os.path.isdir(env_dir):
        return env_dir

    cwd = os.getcwd()
    team_link = os.path.join(cwd, ".team")
    if os.path.isdir(team_link):
        for entry in os.listdir(team_link):
            target = os.path.join(team_link, entry)
            if os.path.isdir(target) and os.path.islink(target):
                real = os.path.realpath(target)
                if os.path.isdir(real) and "team-workspace" in real:
                    return real

    home_agent_teams = os.path.expanduser("~/.jiuwenswarm/.agent_teams")
    if os.path.isdir(home_agent_teams):
        sessions = [
            d for d in os.listdir(home_agent_teams)
            if d.startswith("jiuwen_team_sess") and os.path.isdir(os.path.join(home_agent_teams, d))
        ]
        if sessions:
            recent = max(sessions, key=lambda d: os.path.getmtime(os.path.join(home_agent_teams, d)))
            tw = os.path.join(home_agent_teams, recent, "team-workspace")
            if os.path.isdir(tw):
                return tw

    return cwd


def write_result_to_file(result: dict, output_dir: str, filename: str) -> dict:
    """Write full search result JSON to the artifacts directory and return metadata.

    Args:
        result: The full search result dict (sources, total_results, etc.)
        output_dir: Base directory (typically team-workspace)
        filename: Output filename (e.g., "results_arxiv_20260701_143022.json")

    Returns:
        Metadata dict with file_path, file_size, result_count, etc.
        This dict should be printed to stdout as the script's only output.
    """
    subdir = os.path.join(output_dir, LITERATURE_SEARCH_SUBDIR)
    os.makedirs(subdir, exist_ok=True)
    full_path = os.path.join(subdir, filename)

    with open(full_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    file_size = os.path.getsize(full_path)

    metadata = {
        "file_path": full_path,
        "file_size_bytes": file_size,
        "file_size_human": f"{file_size / 1024:.1f}KB",
        "result_count": result.get("total_results", 0),
        "database": result.get("database", ""),
        "query": result.get("query", ""),
        "api_call_verified": result.get("api_call_verified", False),
        "error": result.get("error"),
    }
    return metadata


def handle_output(result: dict, args) -> None:
    """Handle output for a search script: write to file and print metadata to stdout.

    This function implements the unified output logic for all 4 search scripts.
    It handles three modes:
    1. --output specified: write to that exact path, print metadata to stdout.
    2. --output-dir specified or auto-detected: write to auto-generated path, print metadata.
    3. Both above: --output overrides --output-dir.

    Args:
        result: The full search result dict.
        args: argparse Namespace with --output and --output-dir fields.
    """
    if args.output:
        output_path = args.output
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
        file_size = os.path.getsize(output_path)
        metadata = {
            "file_path": output_path,
            "file_size_bytes": file_size,
            "file_size_human": f"{file_size / 1024:.1f}KB",
            "result_count": result.get("total_results", 0),
            "database": result.get("database", ""),
            "query": result.get("query", ""),
            "api_call_verified": result.get("api_call_verified", False),
            "error": result.get("error"),
        }
    else:
        base_dir = args.output_dir or get_output_dir()
        db = result.get("database", "unknown")
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"results_{db}_{timestamp}.json"
        metadata = write_result_to_file(result, base_dir, filename)

    print(json.dumps(metadata, indent=2, ensure_ascii=False))

    SERVICE_SKIP_ERRORS = {"api_key_missing"}
    error = result.get("error")
    if not result.get("sources") and error and error not in SERVICE_SKIP_ERRORS:
        sys.exit(1)
