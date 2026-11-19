"""Import the static catalogue into the database and the bucket.

The static exporter writes `catalog.json` plus one artifact per asset. This
script turns that into rows (`assets`, `asset_versions`) and objects, preserving
the catalogue's ids so a page that links to `/skills/antibody-design` still
resolves after the switch. Every imported version is approved as it is written:
these are assets the repository already published, so review has already
happened in the merge.

Specialists and connectors ship a single JSON file rather than an archive; the
importer wraps those in a zip so the service has exactly one artifact shape.

Usage:

    cd services/hub-api
    .venv/bin/python -m scripts.import_catalog \
        --catalog ../../apps/hub/public/catalog.json \
        --assets-root ../../apps/hub/public \
        --sessions-root /srv/hub/sessions \
        --publisher hub-publisher

Run it once against the development profile first (`--dry-run` validates
without writing), then against MySQL and OBS.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import Base, make_engine, make_session_factory
from app.models import Asset, AssetVersion, AuditLog, User, utcnow
from app.security import hash_password
from app.storage import Storage, build_storage, package_key
from app.validation import PackageError, validate_package

KIND_MAP = {
    "skill": "skill",
    "team-skill": "team",
    "specialist": "specialist",
    "connector": "connector",
    "session-package": "session",
}


@dataclass
class Artifact:
    data: bytes
    # For a single file wrapped into an archive, the catalogue's digest is of
    # the file, not of the archive we build around it.
    original_sha256: str | None = None
    # What the downloaded file should be called. A wrapped single file gets a
    # .zip name because the bytes really are an archive.
    package_name: str | None = None


@dataclass
class ImportStats:
    created_assets: int = 0
    updated_assets: int = 0
    created_versions: int = 0
    skipped: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)

    def report(self) -> str:
        lines = [
            f"assets: {self.created_assets} created, {self.updated_assets} updated",
            f"versions: {self.created_versions} imported",
        ]
        if self.skipped:
            lines.append(f"skipped ({len(self.skipped)}):")
            lines.extend(f"  - {item}" for item in self.skipped)
        if self.failed:
            lines.append(f"failed ({len(self.failed)}):")
            lines.extend(f"  - {item}" for item in self.failed)
        return "\n".join(lines)


def _flatten_category(category) -> str | None:
    if not category:
        return None
    if isinstance(category, str):
        return category
    if not isinstance(category, dict):
        return None
    parts = [category.get(key) for key in ("domain", "subdomain", "source", "task", "function")]
    values = [str(part) for part in parts if part]
    return "/".join(values) or None


def _artifact_bytes(entry: dict, assets_root: Path, sessions_root: Path) -> Artifact | None:
    url = str(entry.get("download", {}).get("url", ""))
    if not url:
        return None
    if url.startswith(("http://", "https://")):
        # Session packages are stored outside the site prefix. Resolve them by
        # file name under the sessions root; a miss is reported, not invented.
        path = sessions_root / Path(url).name
    else:
        path = assets_root / url
    if not path.is_file():
        return None
    data = path.read_bytes()
    if data[:2] == b"PK":
        return Artifact(data=data, package_name=path.name)
    # A single JSON file (specialist, connector) becomes a one-entry archive so
    # every version has the same shape and the Files tab always has something
    # to list.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(path.name, data)
    return Artifact(
        data=buffer.getvalue(),
        original_sha256=hashlib.sha256(data).hexdigest(),
        package_name=f"{path.stem}.zip",
    )


def _get_publisher(db: Session, username: str) -> User:
    user = db.scalar(select(User).where(User.username == username))
    if user is not None:
        return user
    user = User(
        username=username,
        password_hash=hash_password(f"import-{username}-{utcnow()}"),
        display_name=username,
        role="user",
    )
    db.add(user)
    db.flush()
    return user


def import_catalog(
    *,
    catalog_path: Path,
    assets_root: Path,
    sessions_root: Path,
    publisher: str,
    database_url: str,
    storage: Storage,
    settings,
    dry_run: bool = False,
    force: bool = False,
) -> ImportStats:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    entries = catalog.get("assets") or []
    stats = ImportStats()

    engine = make_engine(database_url)
    Base.metadata.create_all(engine)
    factory = make_session_factory(engine)
    session = factory()
    try:
        user = _get_publisher(session, publisher)
        for entry in entries:
            asset_id = entry.get("id")
            kind = KIND_MAP.get(entry.get("kind", ""))
            if not asset_id or kind is None:
                stats.skipped.append(f"{asset_id or '<no id>'}: unknown kind {entry.get('kind')!r}")
                continue

            version = str(entry.get("version") or "1.0.0")
            asset = session.get(Asset, asset_id)
            if asset is None:
                asset = Asset(
                    id=asset_id,
                    kind=kind,
                    name=asset_id,
                    display_name=entry.get("name") or asset_id,
                    summary="",
                    description="",
                    publisher_id=user.id,
                    publisher_name=user.display_name or user.username,
                    category=_flatten_category(entry.get("category")),
                    tags=list(entry.get("tags") or []),
                    visibility="public",
                )
                session.add(asset)
                stats.created_assets += 1
            else:
                asset.display_name = entry.get("name") or asset.display_name
                asset.category = _flatten_category(entry.get("category")) or asset.category
                asset.tags = list(entry.get("tags") or asset.tags or [])
                stats.updated_assets += 1

            asset.summary = str(entry.get("description") or "")[:4096]
            asset.description = str(entry.get("description") or "")
            asset.updated_at = utcnow()

            existing = session.scalar(
                select(AssetVersion).where(
                    AssetVersion.asset_id == asset_id, AssetVersion.version == version
                )
            )
            if existing is not None and not force:
                asset.latest_version = asset.latest_version or version
                asset.public_latest_version = asset.public_latest_version or version
                stats.skipped.append(f"{asset_id}@{version}: already imported")
                continue

            artifact = _artifact_bytes(entry, assets_root, sessions_root)
            if artifact is None:
                stats.skipped.append(f"{asset_id}@{version}: artifact not found on disk")
                continue
            try:
                info = validate_package(
                    artifact.data,
                    max_bytes=settings.max_package_bytes,
                    max_uncompressed=settings.max_uncompressed_bytes,
                )
            except PackageError as exc:
                stats.failed.append(f"{asset_id}@{version}: {exc}")
                continue

            expected = entry.get("download", {}).get("sha256")
            actual = artifact.original_sha256 or info.sha256
            if expected and expected != actual:
                stats.failed.append(
                    f"{asset_id}@{version}: sha256 {actual} does not match catalog {expected}"
                )
                continue

            if dry_run:
                stats.created_versions += 1
                continue

            filename = artifact.package_name or Path(entry["download"]["url"]).name
            key = package_key(
                kind=kind,
                publisher_id=user.id,
                asset_id=asset_id,
                version=version,
                filename=filename,
            )
            storage.put(key, artifact.data, content_type="application/octet-stream")

            if existing is not None and force:
                existing.storage_key = key
                existing.filename = filename
                existing.sha256 = info.sha256
                existing.size = info.size
                existing.manifest = info.manifest
                existing.moderation_status = "approved"
                existing.reviewed_at = utcnow()
                row = existing
            else:
                row = AssetVersion(
                    asset_id=asset_id,
                    version=version,
                    filename=filename,
                    storage_key=key,
                    sha256=info.sha256,
                    size=info.size,
                    manifest=info.manifest,
                    changelog="Imported from the static catalogue.",
                    moderation_status="approved",
                    reviewed_at=utcnow(),
                )
                session.add(row)
                stats.created_versions += 1

            asset.latest_version = version
            asset.public_latest_version = version
            session.add(
                AuditLog(
                    action="catalog.import",
                    asset_id=asset_id,
                    version=version,
                    detail=info.sha256,
                )
            )

        if dry_run:
            session.rollback()
        else:
            session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--assets-root", required=True, type=Path)
    parser.add_argument("--sessions-root", type=Path, default=None)
    parser.add_argument("--publisher", default="hub-publisher")
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)

    settings = get_settings()
    database_url = args.database_url or settings.database_url
    storage = build_storage(settings)
    sessions_root = args.sessions_root or args.assets_root

    stats = import_catalog(
        catalog_path=args.catalog,
        assets_root=args.assets_root,
        sessions_root=sessions_root,
        publisher=args.publisher,
        database_url=database_url,
        storage=storage,
        settings=settings,
        dry_run=args.dry_run,
        force=args.force,
    )
    print(stats.report())
    return 1 if stats.failed else 0


if __name__ == "__main__":
    sys.exit(main())
