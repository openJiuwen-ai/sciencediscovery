"""Runtime configuration.

Every setting comes from the environment so the same image runs in a
developer's shell, in CI and on the deployment host. Defaults are the
development profile: SQLite and a local directory standing in for OBS.

The production profile is the one this service is built for, and it mirrors
the reference implementation (openJiuwen Agentic Hub): a private S3-compatible
bucket, presigned download URLs, and a database that holds every piece of
metadata the site shows.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


DEFAULT_SESSION_SECRET = "dev-only-change-me"


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:  # fail loudly: a typo here changes limits
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    database_url: str = field(
        default_factory=lambda: os.getenv("HUB_DATABASE_URL", "sqlite:///./.hub-api.db")
    )

    # "local" keeps packages in a directory (development, tests). "s3" talks to
    # OBS or any S3-compatible store and hands out presigned URLs.
    storage_backend: str = field(
        default_factory=lambda: os.getenv("HUB_STORAGE_BACKEND", "local")
    )
    local_root: str = field(
        default_factory=lambda: os.getenv("HUB_LOCAL_STORAGE_ROOT", "./.hub-storage")
    )

    s3_endpoint: str = field(default_factory=lambda: os.getenv("HUB_S3_ENDPOINT", ""))
    s3_region: str = field(default_factory=lambda: os.getenv("HUB_S3_REGION", ""))
    s3_bucket: str = field(default_factory=lambda: os.getenv("HUB_S3_BUCKET", ""))
    s3_access_key: str = field(
        default_factory=lambda: os.getenv("HUB_S3_ACCESS_KEY", "")
    )
    s3_secret_key: str = field(
        default_factory=lambda: os.getenv("HUB_S3_SECRET_KEY", "")
    )
    presign_seconds: int = field(
        default_factory=lambda: _int("HUB_PRESIGN_SECONDS", 600)
    )

    # Used only by the local backend to build a download URL a browser can
    # reach. In production the URL comes from the storage service itself.
    public_base_url: str = field(
        default_factory=lambda: os.getenv("HUB_PUBLIC_BASE_URL", "http://127.0.0.1:8100")
    )

    session_secret: str = field(
        default_factory=lambda: os.getenv("HUB_SESSION_SECRET", DEFAULT_SESSION_SECRET)
    )
    session_ttl_seconds: int = field(
        default_factory=lambda: _int("HUB_SESSION_TTL_SECONDS", 7 * 24 * 3600)
    )

    max_package_bytes: int = field(
        default_factory=lambda: _int("HUB_MAX_PACKAGE_BYTES", 50 * 1024 * 1024)
    )
    # Refuse archives that expand far beyond their compressed size (zip bomb).
    max_uncompressed_bytes: int = field(
        default_factory=lambda: _int("HUB_MAX_UNCOMPRESSED_BYTES", 512 * 1024 * 1024)
    )
    # A single file previewed in the Files tab; a browser cannot render more
    # than a token amount of text and the server should not inflate more.
    preview_max_bytes: int = field(
        default_factory=lambda: _int("HUB_PREVIEW_MAX_BYTES", 2 * 1024 * 1024)
    )

    # Explicit opt-in for running with the committed default/empty session
    # secret. Only a development machine should set this.
    allow_dev_secret: bool = field(
        default_factory=lambda: _bool("HUB_ALLOW_DEV_SECRET", False)
    )

    # Development-only: this host's clock may drift; sign with a corrected
    # time. Never set this in production, where NTP keeps the clock right.
    clock_offset_seconds: int = field(
        default_factory=lambda: _int("HUB_CLOCK_OFFSET_SECONDS", 0)
    )

    # Off by default: a public server should not let anyone create an account.
    # The first account can always register, which is how a fresh deployment
    # gets its administrator.
    allow_registration: bool = field(
        default_factory=lambda: _bool("HUB_ALLOW_REGISTRATION", False)
    )

    # Optional first administrator, created at startup when both are set.
    admin_username: str = field(
        default_factory=lambda: os.getenv("HUB_ADMIN_USERNAME", "")
    )
    admin_password: str = field(
        default_factory=lambda: os.getenv("HUB_ADMIN_PASSWORD", "")
    )


def get_settings() -> Settings:
    """Read settings from the environment.

    Deliberately not cached: tests build several apps in one process and must
    be able to change the environment between them.
    """
    return Settings()
