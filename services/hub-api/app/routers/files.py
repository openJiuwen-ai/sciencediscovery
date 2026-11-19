from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response

from ..deps import get_storage
from ..storage import LocalStorage, Storage, StorageError

router = APIRouter(prefix="/files", tags=["files"])


@router.get("/{key:path}")
def download_local(key: str, storage: Storage = Depends(get_storage)) -> Response:
    """Development-only byte server for the local storage backend.

    In production the bucket is private and the browser downloads from the
    presigned URL instead; this endpoint then answers 404, so it cannot
    become a way around the bucket policy.
    """
    if not isinstance(storage, LocalStorage):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    try:
        data = storage.get(key)
    except StorageError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    filename = key.rsplit("/", 1)[-1]
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
