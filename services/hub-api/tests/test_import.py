from __future__ import annotations

import hashlib
import json
from pathlib import Path

from fastapi.testclient import TestClient

from sqlalchemy import select

from app.config import Settings
from app.db import make_engine, make_session_factory
from app.main import create_app
from app.models import AssetVersion
from app.storage import LocalStorage, StorageError
from scripts.import_catalog import import_catalog
from tests.support import make_tar_gz, make_zip


def _write(path: Path, data: bytes) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def _fixture(tmp_path: Path):
    assets_root = tmp_path / "site"
    sessions_root = tmp_path / "sessions"

    skill = make_zip({"SKILL.md": b"# Skill\n", "scripts/search.py": b"print(1)\n"})
    (assets_root / "skills").mkdir(parents=True, exist_ok=True)
    (assets_root / "skills" / "antibody-design.md").write_text("# Antibody\n", encoding="utf-8")
    team = make_zip({"SKILL.md": b"# Team\n"})
    session = make_tar_gz({"manifest.json": b'{"files": []}', "README.md": b"# Session\n"})
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
            "hardware": "npu",
            "readme": "skills/antibody-design.md",
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
    external = make_zip({"SKILL.md": b"# Astropy\n"})
    entries.append(
        {
            "id": "astronomy/astronomical_analysis/astropy",
            "name": "astropy",
            "kind": "skill",
            "version": "1.2.3",
            "description": "External skill with a path id.",
            "category": {"domain": "astronomy", "subdomain": "astronomical_analysis"},
            "tags": [],
            "download": {"url": "packages/astropy-1.2.3.zip", **_write(assets_root / "packages/astropy-1.2.3.zip", external)},
        }
    )
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
        admin_username="admin",
        admin_password="admin-test-123",
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
    assert stats.created_assets == 6
    assert stats.created_versions == 6

    # The same settings drive the API, so this proves the catalogue is served
    # through the endpoints the site will call.
    app = create_app(settings)
    with TestClient(app) as client:
        listing = client.get("/api/v1/assets").json()["data"]
        assert listing["total"] == 6
        ids = {item["id"] for item in listing["items"]}
        assert "antibody-design" in ids
        assert "compression-algorithm-20261117" in ids

        # External skills carry a path as their id; the API must route it and
        # the encoder the site uses turns the slashes into %2F.
        encoded = "astronomy%2Fastronomical_analysis%2Fastropy"
        external_artifact = client.get(f"/api/v1/artifacts/{encoded}")
        assert external_artifact.status_code == 200, external_artifact.text
        assert external_artifact.json()["data"]["version"] == "1.2.3"

        artifact = client.get("/api/v1/artifacts/antibody-design").json()["data"]
        assert artifact["version"] == "1.0.0"
        expected = (assets_root / "packages/antibody-design-1.0.0.zip").read_bytes()
        assert client.get(artifact["url"]).content == expected

        specialist = client.get("/api/v1/artifacts/builtin-literature-searcher").json()["data"]
        assert specialist["version"] == "1.0.0"
        files = client.get(
            "/api/v1/assets/builtin-literature-searcher/versions/1.0.0/files"
        ).json()["data"]["files"]
        assert [entry["path"] for entry in files] == ["builtin-literature-searcher.json"]

        session_readme = client.get(
            "/api/v1/assets/compression-algorithm-20261117/readme"
        ).json()["data"]
        assert session_readme["text"] == "# Session\n"

        catalog = client.get("/api/v1/catalog").json()["data"]
        skill_asset = next(item for item in catalog["assets"] if item["id"] == "antibody-design")
        assert [entry["path"] for entry in skill_asset["resources"]] == ["scripts/search.py"]
        skill_tree = catalog["categories"]["skill"]
        biology = next(node for node in skill_tree if node["id"] == "biology")
        assert [child["id"] for child in biology["children"]] == ["protein"]
        specialist_asset = next(
            item for item in catalog["assets"] if item["id"] == "builtin-literature-searcher"
        )
        assert specialist_asset["download"]["text"].endswith("/readme?format=text")
        assert specialist_asset["skills"] == []
        assert [entry["path"] for entry in specialist_asset["resources"]] == [
            "builtin-literature-searcher.json"
        ]
        assert "/files/content?path=" in specialist_asset["resources"][0]["url"]
        connector_asset = next(item for item in catalog["assets"] if item["id"] == "arxiv")
        assert connector_asset["config"] == {}
        assert connector_asset["governance"] == {}
        assert connector_asset["toolCount"] == 0
        session_asset = next(
            item for item in catalog["assets"] if item["id"] == "compression-algorithm-20261117"
        )
        assert session_asset["category"] == {"source": "manual", "task": "compression"}
        session_tree = catalog["categories"]["sessionPackage"]
        assert [node["id"] for node in session_tree] == ["compression"]
        assert session_tree[0]["count"] == 1
        assert client.get("/api/v1/stats").json()["data"]["total"] == 6

        # An imported asset carries a stored category; a PATCH must refresh it
        # as well as the column, or the payload and the tree disagree. The
        # importer created the publisher without a known password, so use the
        # administrator account the app bootstraps.
        login = client.post(
            "/api/v1/auth/login", json={"username": "admin", "password": "admin-test-123"}
        )
        assert login.status_code == 200, login.text
        admin = {"Authorization": f"Bearer {login.json()['data']['token']}"}
        patched = client.patch(
            "/api/v1/assets/antibody-design",
            headers=admin,
            json={"category": "genomics/transcriptomics"},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["data"]["extra"]["category"] == {
            "domain": "genomics", "subdomain": "transcriptomics",
        }
        catalog = client.get("/api/v1/catalog").json()["data"]
        item = next(entry for entry in catalog["assets"] if entry["id"] == "antibody-design")
        assert item["category"] == {"domain": "genomics", "subdomain": "transcriptomics"}
        tree = catalog["categories"]["skill"]
        genomics = next(node for node in tree if node["id"] == "genomics")
        assert [child["id"] for child in genomics["children"]] == ["transcriptomics"]


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
    assert len(again.skipped) == 6


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


def test_reimport_repairs_a_session_wrapped_by_the_old_importer(tmp_path):
    catalog_path, assets_root, sessions_root = _fixture(tmp_path)
    settings = _settings(tmp_path)
    storage = LocalStorage(root=tmp_path / "store", base_url="http://testserver")
    import_catalog(
        catalog_path=catalog_path,
        assets_root=assets_root,
        sessions_root=sessions_root,
        publisher="hub-publisher",
        database_url=settings.database_url,
        storage=storage,
        settings=settings,
    )

    # Simulate the earlier importer: the session row points at a zip wrapper.
    engine = make_engine(settings.database_url)
    session = make_session_factory(engine)()
    try:
        row = session.scalar(
            select(AssetVersion).where(
                AssetVersion.asset_id == "compression-algorithm-20261117"
            )
        )
        old_key = "assets/session/old/wrapped.zip"
        storage.put(old_key, b"wrapped", "application/zip")
        row.filename = "wrapped.zip"
        row.storage_key = old_key
        session.commit()
    finally:
        session.close()

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

    session = make_session_factory(engine)()
    try:
        row = session.scalar(
            select(AssetVersion).where(
                AssetVersion.asset_id == "compression-algorithm-20261117"
            )
        )
        assert row.filename.endswith(".sdresearch")
        assert row.storage_key != old_key
        assert [item["path"] for item in row.manifest][:2] == ["README.md", "manifest.json"]
        from app.models import Asset

        asset = session.get(Asset, "compression-algorithm-20261117")
        assert asset.readme == "# Session\n"
    finally:
        session.close()
    try:
        storage.get(old_key)
        raise AssertionError("the wrapped object should have been deleted")
    except StorageError:
        pass
