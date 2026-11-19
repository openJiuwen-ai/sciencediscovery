from __future__ import annotations

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..deps import current_user, get_db, get_settings, get_storage, require_user
from ..models import Asset, AssetVersion, AuditLog, User, utcnow
from ..schemas import CreateAssetRequest, UpdateAssetRequest
from ..serializers import asset_payload, ok, version_payload
from ..storage import Storage, package_key
from ..validation import PackageError, read_member, validate_package

router = APIRouter(prefix="/assets", tags=["assets"])


def _visible_to(asset: Asset, user: User | None) -> bool:
    if user is not None and (user.role == "admin" or asset.publisher_id == user.id):
        return True
    return asset.visibility == "public" and asset.public_latest_version is not None


def _get_asset(db: Session, asset_id: str) -> Asset:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="asset not found")
    return asset


def _owned(asset: Asset, user: User) -> bool:
    return user.role == "admin" or asset.publisher_id == user.id


@router.get("")
def list_assets(
    kind: str | None = Query(default=None),
    q: str | None = Query(default=None),
    category: str | None = Query(default=None),
    mine: bool = Query(default=False),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User | None = Depends(current_user),
) -> dict:
    query = select(Asset).where(Asset.status == "active")
    if mine:
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="login required")
        query = query.where(Asset.publisher_id == user.id)
    elif user is None or user.role != "admin":
        # The public list is the approved, public catalogue. A logged-in
        # publisher sees their own drafts through `mine=true`.
        query = query.where(
            Asset.visibility == "public", Asset.public_latest_version.is_not(None)
        )
    if kind:
        query = query.where(Asset.kind == kind)
    if category:
        query = query.where(Asset.category == category)
    if q:
        pattern = f"%{q}%"
        query = query.where(
            or_(
                Asset.name.ilike(pattern),
                Asset.display_name.ilike(pattern),
                Asset.summary.ilike(pattern),
            )
        )

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.scalars(
        query.order_by(Asset.updated_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return ok(
        {
            "items": [asset_payload(row) for row in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    )


@router.post("")
def create_asset(
    body: CreateAssetRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    duplicate = db.scalar(
        select(Asset).where(
            Asset.publisher_id == user.id,
            Asset.kind == body.kind,
            Asset.name == body.name,
        )
    )
    if duplicate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="you already publish an asset with that kind and name",
        )
    asset = Asset(
        kind=body.kind,
        name=body.name,
        display_name=body.display_name,
        summary=body.summary,
        description=body.description,
        publisher_id=user.id,
        publisher_name=user.display_name or user.username,
        category=body.category,
        tags=body.tags,
        visibility=body.visibility,
    )
    db.add(asset)
    db.flush()
    db.add(AuditLog(actor_id=user.id, action="asset.create", asset_id=asset.id))
    return ok(asset_payload(asset))


@router.patch("/{asset_id:path}")
def update_asset(
    asset_id: str,
    body: UpdateAssetRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_user),
) -> dict:
    asset = _get_asset(db, asset_id)
    if not _owned(asset, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not the owner")
    for field in ("display_name", "summary", "description", "category", "visibility"):
        value = getattr(body, field)
        if value is not None:
            setattr(asset, field, value)
    if body.tags is not None:
        asset.tags = body.tags
    asset.updated_at = utcnow()
    db.add(AuditLog(actor_id=user.id, action="asset.update", asset_id=asset.id))
    return ok(asset_payload(asset, include_description=True))


@router.get("/{asset_id:path}/versions")
def list_versions(
    asset_id: str,
    db: Session = Depends(get_db),
    user: User | None = Depends(current_user),
) -> dict:
    asset = _get_asset(db, asset_id)
    if not _visible_to(asset, user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="asset not found")
    query = select(AssetVersion).where(AssetVersion.asset_id == asset_id)
    if user is None or not _owned(asset, user):
        query = query.where(AssetVersion.moderation_status == "approved")
    rows = db.scalars(query.order_by(AssetVersion.created_at.desc())).all()
    return ok({"items": [version_payload(row) for row in rows]})


@router.get("/{asset_id:path}/versions/{version}")
def get_version(
    asset_id: str,
    version: str,
    db: Session = Depends(get_db),
    user: User | None = Depends(current_user),
) -> dict:
    asset = _get_asset(db, asset_id)
    if not _visible_to(asset, user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="asset not found")
    row = db.scalar(
        select(AssetVersion).where(
            AssetVersion.asset_id == asset_id, AssetVersion.version == version
        )
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="version not found")
    if row.moderation_status != "approved" and (user is None or not _owned(asset, user)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="version not found")
    payload = version_payload(row)
    payload["manifest"] = row.manifest
    return ok(payload)


@router.get("/{asset_id:path}/versions/{version}/files")
def read_version_files(
    asset_id: str,
    version: str,
    with_content: str | None = Query(default=None),
    db: Session = Depends(get_db),
    storage: Storage = Depends(get_storage),
    user: User | None = Depends(current_user),
) -> dict:
    asset = _get_asset(db, asset_id)
    if not _visible_to(asset, user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="asset not found")
    row = db.scalar(
        select(AssetVersion).where(
            AssetVersion.asset_id == asset_id, AssetVersion.version == version
        )
    )
    if row is None or (
        row.moderation_status != "approved" and (user is None or not _owned(asset, user))
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="version not found")

    content = None
    if with_content:
        try:
            data = storage.get(row.storage_key)
            raw = read_member(data, with_content)
        except PackageError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
        if raw is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="file not in package"
            )
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            # Binaries have no text preview; the client says so in place of
            # rendering garbage, as the static site already does.
            content = None
    return ok({"files": row.manifest, "content_path": with_content, "content": content})


@router.get("/{asset_id:path}")
def get_asset(
    asset_id: str,
    db: Session = Depends(get_db),
    user: User | None = Depends(current_user),
) -> dict:
    asset = _get_asset(db, asset_id)
    if not _visible_to(asset, user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="asset not found")
    return ok(asset_payload(asset, include_description=True))


@router.post("/{asset_id:path}/versions", status_code=status.HTTP_201_CREATED)
async def upload_version(
    asset_id: str,
    version: str = Form(min_length=1, max_length=32),
    changelog: str = Form(default=""),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    storage: Storage = Depends(get_storage),
    settings=Depends(get_settings),
    user: User = Depends(require_user),
) -> dict:
    asset = _get_asset(db, asset_id)
    if not _owned(asset, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not the owner")

    data = await file.read()
    # Read then check: the client's Content-Length is advisory only.
    try:
        info = validate_package(
            data,
            max_bytes=settings.max_package_bytes,
            max_uncompressed=settings.max_uncompressed_bytes,
        )
    except PackageError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    duplicate = db.scalar(
        select(AssetVersion).where(
            AssetVersion.asset_id == asset_id, AssetVersion.version == version
        )
    )
    if duplicate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="that version already exists"
        )

    try:
        key = package_key(
            kind=asset.kind,
            publisher_id=asset.publisher_id,
            asset_id=asset.id,
            version=version,
            filename=file.filename or "package.zip",
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    storage.put(key, data, content_type="application/octet-stream")
    row = AssetVersion(
        asset_id=asset.id,
        version=version,
        filename=file.filename or "package.zip",
        storage_key=key,
        sha256=info.sha256,
        size=info.size,
        manifest=info.manifest,
        changelog=changelog,
        moderation_status="pending",
    )
    db.add(row)
    asset.latest_version = version
    asset.updated_at = utcnow()
    db.add(
        AuditLog(
            actor_id=user.id,
            action="version.upload",
            asset_id=asset.id,
            version=version,
            detail=info.sha256,
        )
    )
    db.flush()
    return ok(version_payload(row))
