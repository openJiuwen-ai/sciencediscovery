from __future__ import annotations

import hashlib
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.db import make_engine, make_session_factory
from app.main import create_app
from app.storage import LocalStorage
from scripts.import_catalog import import_catalog
from tests.support import make_zip


def _write(path: Path, data: bytes) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def _fixture(tmp_path: Path):
    assets_root = tmp_path / "site"
    sessions_root = tmp_path / "sessions"

    skill = make_zip({"SKILL.md": b"# Skill\n"})
    team = make_zip({"SKILL.md": b"# Team\n"})
    session = make_zip({"manifest.json": b'{"files": []}'})
    specialist = b'{"name": "literature-searcher"}'
    connector = b'{"id": "arxiv"}'

    entries = [
        {
            "id": "antibody-design",
            "name": "Antibody Design",
            "kind": "skill",
            "version": "1.0.0",
            "description": "Design antibodies.",
            "category": {"domain": "biology", "subdomain": "protein"},
            "tags": ["protein"],
            "download": {"url": "packages/antibody-design-1.0.0.zip", **_write(assets_root / "packages/antibody-design-1.0.0.zip", skill)},
        },
        {
            "id": "idea-tree-team",
            "name": "Idea Tree Team",
            "kind": "team-skill",
            "version": "4.0.0",
            "description": "A team.",
            "category": {"domain": "research"},
            "tags": [],
            "download": {"url": "packages/idea-tree-team-4.0.0.zip", **_write(assets_root / "packages/idea-tree-team-4.0.0.zip", team)},
        },
        {
            "id": "builtin-literature-searcher",
            "name": "Literature Searcher",
            "kind": "specialist",
            "version": None,
            "description": "Search literature.",
            "tags": [],
            "download": {"url": "specialists/builtin-literature-searcher.json", **_write(assets_root / "specialists/builtin-literature-searcher.json", specialist)},
        },
        {
            "id": "arxiv",
            "name": "arXiv",
            "kind": "connector",
            "version": "1.0.0",
            "description": "Preprints.",
            "category": {"function": "literature"},
            "tags": [],
            "download": {"url": "connectors/arxiv.json", **_write(assets_root / "connectors/arxiv.json", connector)},
        },
        {
            "id": "compression-algorithm-20261117",
            "name": "Compression session",
            "kind": "session-package",
            "version": "unknown",
            "description": "A session.",
            "category": {"source": "manual", "task": "compression"},
            "tags": [],
            "download": {"url": "http://example.test/sessions/compression-algorithm-20261117.sdresearch", **_write(sessions_root / "compression-algorithm-20261117.sdresearch", session)},
        },
    ]
    catalog = {"schemaVersion": 1, "generatedAt": "2026-11-19T00:00:00Z", "assets": entries}
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
    return catalog_path, assets_root, sessions_root


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        database_url=f"sqlite:///{tmp_path / 'import.db'}",
        storage_backend="local",
        local_root=str(tmp_path / "store"),
        public_base_url="http://testserver",
        session_secret="test-secret",
    )


def test_import_preserves_ids_and_publishes_every_kind(tmp_path):
    catalog_path, assets_root, sessions_root = _fixture(tmp_path)
    settings = _settings(tmp_path)
    storage = LocalStorage(root=tmp_path / "store", base_url="http://testserver")

    stats = import_catalog(
        catalog_path=catalog_path,
        assets_root=assets_root,
        sessions_root=sessions_root,
        publisher="hub-publisher",
        database_url=settings.database_url,
        storage=storage,
        settings=settings,
    )

    assert stats.failed == []
    assert stats.created_assets == 5
    assert stats.created_versions == 5

    # The same settings drive the API, so this proves the catalogue is served
    # through the endpoints the site will call.
    app = create_app(settings)
    with TestClient(app) as client:
        listing = client.get("/api/v1/assets").json()["data"]
        assert listing["total"] == 5
        ids = {item["id"] for item in listing["items"]}
        assert "antibody-design" in ids
        assert "compression-algorithm-20261117" in ids

        artifact = client.get("/api/v1/artifacts/antibody-design").json()["data"]
        assert artifact["version"] == "1.0.0"
        assert client.get(artifact["url"]).content == make_zip({"SKILL.md": b"# Skill\n"})

        specialist = client.get("/api/v1/artifacts/builtin-literature-searcher").json()["data"]
        assert specialist["version"] == "1.0.0"
        files = client.get(
            "/api/v1/assets/builtin-literature-searcher/versions/1.0.0/files"
        ).json()["data"]["files"]
        assert [entry["path"] for entry in files] == ["builtin-literature-searcher.json"]

    # Running it again changes nothing.
    again = import_catalog(
        catalog_path=catalog_path,
        assets_root=assets_root,
        sessions_root=sessions_root,
        publisher="hub-publisher",
        database_url=settings.database_url,
        storage=storage,
        settings=settings,
    )
    assert again.created_versions == 0
    assert len(again.skipped) == 5


def test_import_refuses_a_checksum_mismatch(tmp_path):
    catalog_path, assets_root, sessions_root = _fixture(tmp_path)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    catalog["assets"][0]["download"]["sha256"] = "0" * 64
    catalog_path.write_text(json.dumps(catalog), encoding="utf-8")

    settings = _settings(tmp_path)
    stats = import_catalog(
        catalog_path=catalog_path,
        assets_root=assets_root,
        sessions_root=sessions_root,
        publisher="hub-publisher",
        database_url=settings.database_url,
        storage=LocalStorage(root=tmp_path / "store", base_url="http://testserver"),
        settings=settings,
    )
    assert any("does not match catalog" in item for item in stats.failed)

    engine = make_engine(settings.database_url)
    session = make_session_factory(engine)()
    try:
        from app.models import Asset

        assert session.get(Asset, "antibody-design").public_latest_version is None
    finally:
        session.close()
