from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import get_db, require_admin
from ..models import Asset, AssetVersion, AuditLog, User, utcnow
from ..schemas import ReviewRequest
from ..serializers import ok, version_payload

router = APIRouter(prefix="/admin/reviews", tags=["review"])


@router.get("")
def pending_reviews(
    state: str = Query(default="pending", pattern="^(pending|approved|rejected)$"),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    rows = db.execute(
        select(AssetVersion, Asset)
        .join(Asset, Asset.id == AssetVersion.asset_id)
        .where(AssetVersion.moderation_status == state)
        .order_by(AssetVersion.created_at.asc())
        .limit(200)
    ).all()
    items = []
    for version, asset in rows:
        payload = version_payload(version)
        payload.update(
            {
                "asset_id": asset.id,
                "asset_kind": asset.kind,
                "asset_name": asset.name,
                "publisher_name": asset.publisher_name,
            }
        )
        items.append(payload)
    return ok({"items": items})


@router.post("/{asset_id:path}/{version}")
def decide(
    asset_id: str,
    version: str,
    body: ReviewRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    asset = db.get(Asset, asset_id)
    row = db.scalar(
        select(AssetVersion).where(
            AssetVersion.asset_id == asset_id, AssetVersion.version == version
        )
    )
    if asset is None or row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="version not found")
    if row.moderation_status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"this version is already {row.moderation_status}",
        )

    row.reviewed_by = admin.id
    row.reviewed_at = utcnow()
    if body.decision == "approve":
        row.moderation_status = "approved"
        row.reject_reason = ""
        # Flush first: the session runs with autoflush off, so the query below
        # would otherwise still see this row as pending.
        db.flush()
        # Publish the newest approved version. Comparing creation time, not
        # version strings: "1.10" and "1.9" do not sort lexicographically.
        approved = db.scalars(
            select(AssetVersion)
            .where(AssetVersion.asset_id == asset_id, AssetVersion.moderation_status == "approved")
            .order_by(AssetVersion.created_at.desc())
        ).first()
        if approved is not None:
            asset.public_latest_version = approved.version
    else:
        row.moderation_status = "rejected"
        row.reject_reason = body.reason
    asset.updated_at = utcnow()
    db.add(
        AuditLog(
            actor_id=admin.id,
            action=f"review.{body.decision}",
            asset_id=asset_id,
            version=version,
            detail=body.reason,
        )
    )
    db.flush()
    return ok(version_payload(row))
