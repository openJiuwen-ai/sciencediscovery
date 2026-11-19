from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        storage_backend="local",
        local_root=str(tmp_path / "store"),
        public_base_url="http://testserver",
        session_secret="test-secret",
        session_ttl_seconds=3600,
        max_package_bytes=2 * 1024 * 1024,
        max_uncompressed_bytes=8 * 1024 * 1024,
        allow_registration=True,
    )
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def register(client):
    def _register(username: str = "alice", password: str = "correct-horse"):
        response = client.post(
            "/api/v1/auth/register",
            json={"username": username, "password": password, "display_name": username},
        )
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        return data["token"], data["user"]

    return _register


@pytest.fixture
def auth_headers(register):
    token, _user = register()
    return {"Authorization": f"Bearer {token}"}
