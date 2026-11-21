from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import current_user, get_db, get_settings, get_storage
from ..models import Asset, AssetVersion, User, utcnow
from ..serializers import ok
from ..filenames import content_disposition
from ..storage import Storage, StorageError


router = APIRouter(prefix="/artifacts", tags=["artifacts"])


def _resolve(
    db: Session,
    asset_id: str,
    version: str | None,
    user: User | None,
) -> tuple[Asset, AssetVersion]:
    """Apply the visibility rules once, for both the URL and the bytes."""
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
    return asset, row


@router.get("/{asset_id:path}/content")
def download_content(
    asset_id: str,
    version: str | None = Query(default=None),
    db: Session = Depends(get_db),
    storage: Storage = Depends(get_storage),
    user: User | None = Depends(current_user),
):
    """Stream the bytes through the API.

    The browser's save dialog writes to a file handle, which needs the bytes
    to be readable by the page. A presigned bucket URL is a different origin
    and would need a bucket CORS rule; this endpoint is same-origin by
    construction, so the dialog works without one. Direct downloads still use
    the presigned URL, which keeps the bucket's bandwidth off the server.
    """
    asset, row = _resolve(db, asset_id, version, user)
    try:
        chunks, size = storage.open_stream(row.storage_key)
    except StorageError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="object missing")
    asset.download_count += 1
    asset.updated_at = utcnow()
    headers = {"Content-Disposition": content_disposition(row.filename)}
    if size:
        headers["Content-Length"] = str(size)
    return StreamingResponse(
        chunks, media_type="application/octet-stream", headers=headers
    )


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
    asset, row = _resolve(db, asset_id, version, user)
    url = storage.download_url(row.storage_key, row.filename, settings.presign_seconds)
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
