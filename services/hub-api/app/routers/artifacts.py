from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import current_user, get_db, get_settings, get_storage
from ..models import Asset, AssetVersion, User, utcnow
from ..serializers import ok
from ..storage import Storage

router = APIRouter(prefix="/artifacts", tags=["artifacts"])


@router.get("/{asset_id:path}")
def get_artifact(
    asset_id: str,
    version: str | None = Query(default=None),
    db: Session = Depends(get_db),
    storage: Storage = Depends(get_storage),
    settings=Depends(get_settings),
    user: User | None = Depends(current_user),
) -> dict:
    """Resolve a download to a short-lived URL.

    A private bucket never serves an object directly, so this is the only way
    a browser gets the bytes — the same contract as the reference
    marketplace's `/api/v1/artifacts/{id}`.
    """
    asset = db.get(Asset, asset_id)
    if asset is None or asset.status != "active":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="asset not found")

    owner_or_admin = user is not None and (
        user.role == "admin" or asset.publisher_id == user.id
    )
    if not owner_or_admin and (
        asset.visibility != "public" or asset.public_latest_version is None
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="asset not found")

    if version is None:
        if asset.public_latest_version:
            version = asset.public_latest_version
        elif owner_or_admin:
            version = asset.latest_version
        if version is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="no published version yet"
            )

    row = db.scalar(
        select(AssetVersion).where(
            AssetVersion.asset_id == asset_id, AssetVersion.version == version
        )
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="version not found")
    if row.moderation_status != "approved" and not owner_or_admin:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="version not found")

    url = storage.download_url(
        row.storage_key, row.filename, settings.presign_seconds
    )
    asset.download_count += 1
    asset.updated_at = utcnow()
    return ok(
        {
            "asset_id": asset.id,
            "version": row.version,
            "filename": row.filename,
            "size": row.size,
            "sha256": row.sha256,
            "url": url,
            "expires_in": settings.presign_seconds,
        }
    )
