"""Tables.

The shape follows the reference marketplace: an asset row carries what the
site shows, a version row carries what a download serves, and review state
lives on the version so one asset can have several versions in different
states. Unlike the reference, a version here is a plain uploaded package
(zip or `.sdresearch`) plus a manifest inventory; there is no plugin-specific
schema, because the hub publishes five kinds that share one lifecycle.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> int:
    return int(datetime.now(timezone.utc).timestamp())


KINDS = ("skill", "team", "specialist", "connector", "session")
VISIBILITIES = ("public", "private")
REVIEW_STATES = ("pending", "approved", "rejected")
ROLES = ("user", "admin")


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="user")
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False, default=utcnow)


class Asset(Base):
    __tablename__ = "assets"

    # External skills use a path as their id
    # (`chemistry_and_materials/real_world_workstations/...`), so this is wider
    # than a uuid.
    id: Mapped[str] = mapped_column(String(191), primary_key=True, default=new_id)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    summary: Mapped[str] = mapped_column(String(4096), nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    publisher_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id"), nullable=False
    )
    publisher_name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    visibility: Mapped[str] = mapped_column(String(16), nullable=False, default="public")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")

    # The newest version whose review passed. What the public site lists and
    # what a download resolves to without an explicit version.
    public_latest_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    latest_version: Mapped[str | None] = mapped_column(String(32), nullable=True)

    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    download_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False, default=utcnow)
    updated_at: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=utcnow, onupdate=utcnow
    )

    versions: Mapped[list[AssetVersion]] = relationship(
        back_populates="asset", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("publisher_id", "kind", "name", name="uk_publisher_kind_name"),
        Index("idx_assets_kind", kind),
        Index("idx_assets_public", visibility, public_latest_version),
    )


class AssetVersion(Base):
    __tablename__ = "asset_versions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    asset_id: Mapped[str] = mapped_column(
        String(191), ForeignKey("assets.id"), nullable=False
    )
    version: Mapped[str] = mapped_column(String(32), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Every entry in the package, with its own digest. The Files tab renders
    # this without unpacking anything in the browser.
    manifest: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    changelog: Mapped[str] = mapped_column(Text, nullable=False, default="")

    moderation_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending"
    )
    reject_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    reviewed_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reviewed_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False, default=utcnow)

    asset: Mapped[Asset] = relationship(back_populates="versions")

    __table_args__ = (
        UniqueConstraint("asset_id", "version", name="uk_asset_version"),
        Index("idx_versions_review", moderation_status, created_at),
    )


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    actor_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    asset_id: Mapped[str | None] = mapped_column(String(191), nullable=True)
    version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    detail: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False, default=utcnow)
