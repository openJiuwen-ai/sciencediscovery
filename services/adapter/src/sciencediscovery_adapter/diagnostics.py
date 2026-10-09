# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Opt-in, bounded metadata-only cross-framework diagnostics.

Never pass prompts, tool arguments/results, headers, URLs or exception messages.
Field allowlisting is intentional; full model traces remain a separate facility.
"""
import json
import logging
import os
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

logger = logging.getLogger("sciencediscovery.boundary")
_handler = None
_fields = frozenset({"run_id", "agent_id", "session_id", "swarm_session", "run_tag",
    "request_id", "connection", "tool", "status", "error_type", "elapsed_ms",
    "result_chars", "tool_count", "terminal", "event_type", "tool_call_id"})


def emit(event: str, **fields) -> None:
    if os.environ.get("SCIENCE_AGENT_BOUNDARY_TRACE") != "1":
        return
    global _handler
    try:
        destination = os.environ.get("SCIENCE_AGENT_BOUNDARY_TRACE_FILE")
        if destination and _handler is None:
            path = Path(destination)
            path.parent.mkdir(parents=True, exist_ok=True)
            _handler = RotatingFileHandler(path, maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8")
            os.chmod(path, 0o600)
            _handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(_handler)
        logger.setLevel(logging.INFO)
        record = {"timestamp": datetime.now(timezone.utc).isoformat(), "event": event}
        record.update({key: value[:256] if isinstance(value, str) else value
                       for key, value in fields.items() if key in _fields
                       and (value is None or isinstance(value, (str, bool, int, float)))})
        logger.info(json.dumps(record, ensure_ascii=False))
    except Exception:
        # Observability must not change execution/approval semantics.
        logger.warning("Boundary diagnostic write failed (details omitted)")
