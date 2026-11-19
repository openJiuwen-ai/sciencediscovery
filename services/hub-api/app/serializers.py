"""Response shapes.

The envelope (`{"code", "message", "data"}`) is the one the reference
marketplace uses, so a client written against it can be pointed at this
service by changing the base URL.
"""

from __future__ import annotations

from .models import Asset, AssetVersion, User


def ok(data) -> dict:
    return {"code": 200, "message": "ok", "data": data}


def user_payload(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
    }


def asset_payload(asset: Asset, *, include_description: bool = False) -> dict:
    payload = {
        "id": asset.id,
        "kind": asset.kind,
        "name": asset.name,
        "display_name": asset.display_name,
        "summary": asset.summary,
        "publisher_id": asset.publisher_id,
        "publisher_name": asset.publisher_name,
        "category": asset.category,
        "tags": list(asset.tags or []),
        "visibility": asset.visibility,
        "public_latest_version": asset.public_latest_version,
        "latest_version": asset.latest_version,
        "download_count": asset.download_count,
        "created_at": asset.created_at,
        "updated_at": asset.updated_at,
    }
    if include_description:
        payload["description"] = asset.description
    return payload


def version_payload(version: AssetVersion) -> dict:
    return {
        "version": version.version,
        "filename": version.filename,
        "size": version.size,
        "sha256": version.sha256,
        "moderation_status": version.moderation_status,
        "reject_reason": version.reject_reason,
        "changelog": version.changelog,
        "created_at": version.created_at,
        "reviewed_at": version.reviewed_at,
    }
