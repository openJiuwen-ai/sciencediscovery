from __future__ import annotations

import hmac
import time

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response

from ..deps import get_settings, get_storage
from ..filenames import content_disposition
from ..storage import LocalStorage, Storage, StorageError, local_signature

router = APIRouter(prefix="/files", tags=["files"])


@router.get("/{key:path}")
def download_local(
    key: str,
    expires: int = Query(default=0),
    signature: str = Query(default=""),
    storage: Storage = Depends(get_storage),
    settings=Depends(get_settings),
) -> Response:
    """Development-only byte server for the local storage backend.

    The URL is signed and short-lived, exactly like the bucket's presigned
    URL, because the key alone must not grant access: a rejected version or a
    private asset of the same publisher would otherwise stay downloadable from
    a guessed key. In production this route answers 404, so it cannot become a
    way around the bucket policy.
    """
    if not isinstance(storage, LocalStorage):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    expected = local_signature(settings.session_secret, key, expires)
    if expires < time.time() or not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid or expired link")

    try:
        data = storage.get(key)
    except StorageError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    filename = key.rsplit("/", 1)[-1]
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": content_disposition(filename)},
    )
