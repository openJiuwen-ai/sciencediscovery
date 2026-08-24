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

"""Load the repository's authoritative external URL configuration."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

_CONFIG_RELATIVE_PATH = Path("config/external-urls.json")


def _candidate_paths() -> list[Path]:
    candidates: list[Path] = []
    configured = os.environ.get("SCIENCE_AGENT_EXTERNAL_URLS_PATH", "").strip()
    if configured:
        candidates.append(Path(configured).expanduser().resolve())
    candidates.append((Path.cwd() / _CONFIG_RELATIVE_PATH).resolve())
    for parent in Path(__file__).resolve().parents:
        candidates.append(parent / _CONFIG_RELATIVE_PATH)
    return list(dict.fromkeys(candidates))


@lru_cache(maxsize=1)
def _load_config() -> dict[str, Any]:
    path = next((candidate for candidate in _candidate_paths() if candidate.is_file()), None)
    if path is None:
        raise RuntimeError(
            "External URL configuration not found; set SCIENCE_AGENT_EXTERNAL_URLS_PATH "
            f"or provide {_CONFIG_RELATIVE_PATH}"
        )
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Failed to load external URL configuration at {path}: {error}") from error
    if not isinstance(config, dict):
        raise RuntimeError(f"External URL configuration at {path} must contain a JSON object")
    return config


def _config_value(key: str) -> Any:
    value: Any = _load_config()
    for segment in key.split("."):
        if not isinstance(value, dict) or segment not in value:
            raise RuntimeError(f"External URL configuration is missing required key: {key}")
        value = value[segment]
    return value


def external_url(key: str) -> str:
    value = _config_value(key)
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"External URL configuration key {key} must be a non-empty string")
    return value


def external_url_list(key: str) -> tuple[str, ...]:
    value = _config_value(key)
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise RuntimeError(f"External URL configuration key {key} must be an array of non-empty strings")
    return tuple(value)


def format_external_url(key: str, **parameters: str | int) -> str:
    template = external_url(key)
    try:
        return template.format_map(parameters)
    except KeyError as error:
        raise RuntimeError(f"External URL template {key} requires parameter: {error.args[0]}") from error
