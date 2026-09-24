# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import json
import logging
import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_adapter import diagnostics


def test_disabled_diagnostics_emit_nothing(monkeypatch, caplog):
    monkeypatch.delenv("SCIENCE_AGENT_BOUNDARY_TRACE", raising=False)
    with caplog.at_level(logging.INFO, logger="sciencediscovery.boundary"):
        diagnostics.emit("test", run_id="r")
    assert not caplog.records


def test_metadata_allowlist_excludes_payloads_and_bounds_values(monkeypatch, caplog):
    monkeypatch.setenv("SCIENCE_AGENT_BOUNDARY_TRACE", "1")
    monkeypatch.delenv("SCIENCE_AGENT_BOUNDARY_TRACE_FILE", raising=False)
    with caplog.at_level(logging.INFO, logger="sciencediscovery.boundary"):
        diagnostics.emit("mcp.request.completed", run_id="r", request_id=1, tool="x" * 1000,
                         status="completed", result_chars=500000, prompt="SECRET", arguments={"key": "SECRET"},
                         api_key="SECRET", url="https://host/SECRET", headers={"Authorization": "SECRET"})
    record = json.loads(caplog.records[-1].message)
    assert record["run_id"] == "r" and record["request_id"] == 1
    assert len(record["tool"]) == 256 and record["result_chars"] == 500000
    assert "SECRET" not in caplog.text


def test_private_rotating_file(monkeypatch, tmp_path):
    monkeypatch.setenv("SCIENCE_AGENT_BOUNDARY_TRACE", "1")
    path = tmp_path / "boundary.jsonl"
    monkeypatch.setenv("SCIENCE_AGENT_BOUNDARY_TRACE_FILE", str(path))
    monkeypatch.setattr(diagnostics, "_handler", None)
    try:
        diagnostics.emit("run.started", run_id="r")
        handler = diagnostics._handler
        assert handler.maxBytes == 10 * 1024 * 1024 and handler.backupCount == 3
        assert path.stat().st_mode & 0o777 == 0o600
        assert json.loads(path.read_text())["event"] == "run.started"
    finally:
        if diagnostics._handler:
            diagnostics.logger.removeHandler(diagnostics._handler)
            diagnostics._handler.close()


def test_diagnostic_io_failure_does_not_fail_execution(monkeypatch, tmp_path):
    monkeypatch.setenv("SCIENCE_AGENT_BOUNDARY_TRACE", "1")
    monkeypatch.setenv("SCIENCE_AGENT_BOUNDARY_TRACE_FILE", str(tmp_path))
    monkeypatch.setattr(diagnostics, "_handler", None)
    diagnostics.emit("run.started", run_id="r")
