from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..deps import get_db, get_settings
from ..serializers import ok

router = APIRouter(tags=["health"])


@router.get("/health")
def health(db: Session = Depends(get_db), settings=Depends(get_settings)) -> dict:
    db.execute(text("SELECT 1"))
    return ok({"status": "ok", "storage": settings.storage_backend})
