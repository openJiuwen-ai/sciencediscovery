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


def _restrict_to_owner(path: Path) -> None:
    """0600 equivalent; runs inside emit()'s guard so failures never change semantics.

    [windows-desktop] reason: F3.3 —— NTFS 无 POSIX 权限位，os.chmod 在 Windows
    只影响只读属性；等价物是去掉继承 + 仅当前用户的 ACL（icacls 系统自带）。
    """
    if os.name != "nt":
        os.chmod(path, 0o600)
        return
    import subprocess
    principal = f"{os.environ.get('USERDOMAIN', '')}\\{os.environ.get('USERNAME', '')}".strip("\\")
    if not principal:
        return
    subprocess.run(
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"{principal}:F"],
        capture_output=True, timeout=10, check=False,
    )


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
            _restrict_to_owner(path)
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
