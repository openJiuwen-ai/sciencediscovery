# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License");
import hashlib
import json
import asyncio

import httpx
import pytest

from sciencediscovery_adapter.app import create_app
from sciencediscovery_adapter.config import Settings
from sciencediscovery_adapter.configuration_capabilities import configuration_capabilities, deployment_evidence

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))


def test_CFG_T26_legacy_adapter_does_not_claim_unimplemented_host_guarantees(monkeypatch):
    monkeypatch.delenv("JIUWENSWARM_SRC", raising=False)
    capabilities = configuration_capabilities()
    assert capabilities["protocolVersion"] == 1
    assert capabilities["baseline"] == {"workswarmCommit": None, "coreCommit": None, "patches": []}
    assert not any(capabilities["control"].values())
    assert not any(capabilities["runtime"].values())
    assert capabilities["settings"] == []


def test_CFG_T26_patch_evidence_is_not_reported_if_installed_file_has_changed(tmp_path):
    package = tmp_path / "jiuwenswarm"
    package.mkdir()
    (package / "file.py").write_text("original")
    (tmp_path / ".sciencediscovery-patches.json").write_text(json.dumps({
        "tag": "workswarm0.2.6", "patches": {"compat.patch": "a" * 64},
        "files": {"jiuwenswarm/file.py": hashlib.sha256(b"original").hexdigest()},
    }))
    assert deployment_evidence(str(tmp_path))["patches"] == ["compat.patch"]
    (package / "file.py").write_text("changed")
    assert deployment_evidence(str(tmp_path))["patches"] == []


def test_CFG_T26_capability_handshake_is_authenticated_and_has_no_gateway_side_effect(monkeypatch):
    monkeypatch.delenv("JIUWENSWARM_SRC", raising=False)
    app = create_app(Settings(host="127.0.0.1", port=1, legacy_url="http://legacy.invalid", agent_token="agent-token", api_token="api-token"))
    # ASGITransport without lifespan: capability inspection must not start or call JiuwenSwarm.
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
            assert (await client.get("/agent/configuration/capabilities")).status_code == 401
            result = await client.get("/agent/configuration/capabilities", headers={"authorization": "Bearer api-token"})
            assert result.status_code == 200
            assert result.json()["runtime"]["exactResume"] is False
    asyncio.run(check())
