from __future__ import annotations


def test_first_account_becomes_admin(client, register):
    _token, user = register("founder")
    assert user["role"] == "admin"

    response = client.post(
        "/api/v1/auth/register",
        json={"username": "second", "password": "correct-horse", "display_name": "Second"},
    )
    assert response.status_code == 200
    assert response.json()["data"]["user"]["role"] == "user"


def test_registration_closes_after_the_first_account(tmp_path):
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app

    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'closed.db'}",
        storage_backend="local",
        local_root=str(tmp_path / "store"),
        session_secret="test-secret",
        allow_registration=False,
    )
    with TestClient(create_app(settings)) as client:
        first = client.post(
            "/api/v1/auth/register",
            json={"username": "founder", "password": "correct-horse"},
        )
        assert first.status_code == 200
        second = client.post(
            "/api/v1/auth/register",
            json={"username": "someone", "password": "correct-horse"},
        )
        assert second.status_code == 403


def test_login_and_me(client, register):
    register("alice", "correct-horse")
    wrong = client.post(
        "/api/v1/auth/login", json={"username": "alice", "password": "wrong-password"}
    )
    assert wrong.status_code == 401

    login = client.post(
        "/api/v1/auth/login", json={"username": "alice", "password": "correct-horse"}
    )
    assert login.status_code == 200
    token = login.json()["data"]["token"]

    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["data"]["username"] == "alice"

    anonymous = client.get("/api/v1/auth/me")
    assert anonymous.status_code == 401


def test_tampered_token_is_rejected(client, register):
    token, _ = register()
    bad = token[:-2] + ("aa" if not token.endswith("aa") else "bb")
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {bad}"})
    assert response.status_code == 401


def test_admin_creates_accounts_while_registration_is_closed(client, register):
    _token, admin = register("founder")
    login = client.post(
        "/api/v1/auth/login", json={"username": "founder", "password": "correct-horse"}
    )
    headers = {"Authorization": f"Bearer {login.json()['data']['token']}"}

    created = client.post(
        "/api/v1/auth/users",
        headers=headers,
        json={"username": "teammate", "password": "correct-horse", "display_name": "Teammate"},
    )
    assert created.status_code == 200, created.text
    assert created.json()["data"]["role"] == "user"

    # The new account can log in.
    ok_login = client.post(
        "/api/v1/auth/login", json={"username": "teammate", "password": "correct-horse"}
    )
    assert ok_login.status_code == 200


def test_local_backend_refuses_the_committed_default_secret(tmp_path):
    import pytest

    from app.config import DEFAULT_SESSION_SECRET, Settings
    from app.main import create_app

    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'guard.db'}",
        storage_backend="local",
        local_root=str(tmp_path / "store"),
    )
    assert settings.session_secret == DEFAULT_SESSION_SECRET
    with pytest.raises(RuntimeError, match="HUB_SESSION_SECRET"):
        create_app(settings)

    empty = Settings(
        database_url=f"sqlite:///{tmp_path / 'empty.db'}",
        storage_backend="local",
        local_root=str(tmp_path / "store"),
        session_secret="",
    )
    with pytest.raises(RuntimeError, match="HUB_SESSION_SECRET"):
        create_app(empty)

    # The development opt-in is explicit and still works.
    opted_in = Settings(
        database_url=f"sqlite:///{tmp_path / 'optin.db'}",
        storage_backend="local",
        local_root=str(tmp_path / "store"),
        allow_dev_secret=True,
    )
    create_app(opted_in).state  # builds without raising
