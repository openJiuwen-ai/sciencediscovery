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

"""Logger for the memory-graph service (Python sidecar).

Writes to the unified ``<data-dir>/logs/memory-graph.log``,
the same file the Node-API side (``memory-graph-log.ts``) appends to. Every
line carries a ``[service]`` source tag so the two sides can be told apart.
Summary-level by default (one line per request in/out + result). Flip to
debug with ``SCIENCE_AGENT_MEMORY_GRAPH_LOG_LEVEL=debug``.
"""

from __future__ import annotations

import logging
import os
import re
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

_LOGGER_NAME = "sciencediscovery_memory_graph"
_DEFAULT_FILENAME = "memory-graph.log"
_SENSITIVE_ASSIGNMENT = re.compile(
    r'''\b(authorization|api[-_]?key|token|password|secret)\b["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s,;"'}]+''',
    re.IGNORECASE,
)
_BEARER_VALUE = re.compile(r"\bbearer\s+[a-z0-9._~+/=-]+", re.IGNORECASE)


class _RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        message = super().format(record)
        message = _SENSITIVE_ASSIGNMENT.sub(r"\1=[REDACTED]", message)
        return _BEARER_VALUE.sub("Bearer [REDACTED]", message)


def _resolve_log_path() -> Path:
    """Resolve the category file beneath the configured runtime data root."""
    data_dir = Path(os.environ.get("SCIENCE_AGENT_DATA_DIR") or ".sciencediscovery-data")
    configured_dir = os.environ.get("SCIENCE_AGENT_LOG_DIR", "").strip()
    logs_dir = Path(configured_dir) if configured_dir else data_dir / "logs"
    path = logs_dir / _DEFAULT_FILENAME
    try:
        logs_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        # Fall back to stderr-only if the logs dir isn't writable yet.
        return Path(os.devnull)
    return path


def _is_disabled() -> bool:
    """The sidecar is always enabled now — the on/off toggle lives in the
    Node control API, which gates sink writes/reads before they reach this
    process. The file logger is therefore always active; this hook is kept
    only so callers that once branched on it keep a stable shape."""
    return False


def get_logger(name: str | None = None) -> logging.Logger:
    logger = logging.getLogger(_LOGGER_NAME if name is None else f"{_LOGGER_NAME}.{name}")
    if logger.handlers:
        return logger

    level_name = os.environ.get(
        "SCIENCE_AGENT_MEMORY_GRAPH_LOG_LEVEL",
        os.environ.get("SCIENCE_AGENT_LOG_LEVEL", "INFO"),
    ).upper()
    logger.setLevel(getattr(logging, level_name, logging.INFO))
    logger.propagate = False  # never bubble to uvicorn's root logger

    fmt = _RedactingFormatter(
        "%(asctime)s %(levelname)s [service]  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # When the memory graph is disabled, emit to stderr only (startup banner +
    # any skip notices stay visible in the terminal, but nothing hits disk).
    path = _resolve_log_path()
    if _is_disabled() or str(path) == os.devnull:
        handler: logging.Handler = logging.StreamHandler(sys.stderr)
    else:
        try:
            max_bytes = int(os.environ.get("SCIENCE_AGENT_LOG_MAX_BYTES", "10485760"))
        except ValueError:
            max_bytes = 10485760
        try:
            backup_count = int(os.environ.get("SCIENCE_AGENT_LOG_BACKUP_COUNT", "5"))
        except ValueError:
            backup_count = 5
        handler = RotatingFileHandler(
            path,
            maxBytes=max_bytes if max_bytes > 0 else 10485760,
            backupCount=backup_count if backup_count > 0 else 5,
            encoding="utf-8",
        )
    handler.setFormatter(fmt)
    logger.addHandler(handler)
    return logger
