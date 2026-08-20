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

"""Size-rotated, redacted operational logging for the gateway service."""

from __future__ import annotations

import logging
import os
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Mapping

_LOGGER_NAME = "science_agent_gateway"
_SENSITIVE_ASSIGNMENT = re.compile(
    r'''\b(authorization|api[-_]?key|token|password|secret)\b["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s,;"'}]+''',
    re.IGNORECASE,
)
_BEARER_VALUE = re.compile(r"\bbearer\s+[a-z0-9._~+/=-]+", re.IGNORECASE)


def redact_text(value: object, max_length: int = 500) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ").replace("\t", " ")
    text = _SENSITIVE_ASSIGNMENT.sub(r"\1=[REDACTED]", text)
    text = _BEARER_VALUE.sub("Bearer [REDACTED]", text)
    return text[:max_length]


class _RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact_text(super().format(record), max_length=4_000)


def _positive_integer(raw: str | None, default: int) -> int:
    try:
        value = int(raw or "")
    except ValueError:
        return default
    return value if value > 0 else default


def configure_logging(
    env: Mapping[str, str] | None = None,
    *,
    data_dir: Path | None = None,
) -> logging.Logger:
    values = os.environ if env is None else env
    runtime_dir = data_dir or Path(values.get("SCIENCE_AGENT_DATA_DIR", "data"))
    configured_dir = values.get("SCIENCE_AGENT_LOG_DIR", "").strip()
    log_dir = Path(configured_dir) if configured_dir else runtime_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    level_name = values.get("SCIENCE_AGENT_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    handler = RotatingFileHandler(
        log_dir / "gateway.log",
        maxBytes=_positive_integer(values.get("SCIENCE_AGENT_LOG_MAX_BYTES"), 10 * 1024 * 1024),
        backupCount=_positive_integer(values.get("SCIENCE_AGENT_LOG_BACKUP_COUNT"), 5),
        encoding="utf-8",
    )
    handler.setLevel(level)
    handler.setFormatter(
        _RedactingFormatter(
            "%(asctime)s %(levelname)s [gateway] %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )

    logger = logging.getLogger(_LOGGER_NAME)
    for existing in logger.handlers[:]:
        logger.removeHandler(existing)
        existing.close()
    logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False
    return logger
