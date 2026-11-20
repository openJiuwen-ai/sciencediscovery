from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..deps import get_db
from ..models import Asset
from ..serializers import ok

router = APIRouter(tags=["catalog"])


@router.get("/stats")
def stats(db: Session = Depends(get_db)) -> dict:
    """Counts per kind for the public catalogue, as the tabs show them."""
    rows = db.execute(
        select(Asset.kind, func.count())
        .where(Asset.status == "active", Asset.visibility == "public", Asset.public_latest_version.is_not(None))
        .group_by(Asset.kind)
    ).all()
    by_kind = {kind: count for kind, count in rows}
    return ok(
        {
            "total": sum(by_kind.values()),
            "kinds": [
                {"kind": kind, "count": by_kind.get(kind, 0)}
                for kind in ("skill", "team", "specialist", "connector", "session")
            ],
        }
    )


@router.get("/categories")
def categories(kind: str | None = Query(default=None), db: Session = Depends(get_db)) -> dict:
    """The category tree of the public catalogue.

    `assets.category` is a slash path (`biology/protein_structure`); this builds
    the same nested nodes the static exporter emitted, with counts that include
    descendants. Only ids and counts are returned — the site owns the labels.
    """
    query = (
        select(Asset.category, func.count())
        .where(
            Asset.status == "active",
            Asset.visibility == "public",
            Asset.public_latest_version.is_not(None),
            Asset.category.is_not(None),
        )
        .group_by(Asset.category)
    )
    if kind:
        query = query.where(Asset.kind == kind)

    if kind == "session":
        rows = db.scalars(
            select(Asset).where(
                Asset.status == "active",
                Asset.visibility == "public",
                Asset.public_latest_version.is_not(None),
                Asset.kind == "session",
            )
        ).all()
        return ok({"tree": _session_tree(rows)})

    roots: dict[str, dict] = {}
    for path, count in db.execute(query).all():
        segments = [segment for segment in str(path).split("/") if segment]
        parent = None
        for depth, segment in enumerate(segments):
            node_id = "/".join(segments[: depth + 1])
            node = roots.setdefault(node_id, {"id": node_id, "count": 0, "children": []})
            node["count"] += count
            if parent is not None and node not in parent["children"]:
                parent["children"].append(node)
            parent = node

    def finalise(node: dict) -> dict:
        node["children"].sort(key=lambda child: child["id"])
        return node

    tree = [finalise(roots[node_id]) for node_id in sorted(roots) if "/" not in node_id]
    return ok({"tree": tree})


KIND_TO_CATALOG = {
    "skill": "skill",
    "team": "team-skill",
    "specialist": "specialist",
    "connector": "connector",
    "session": "session-package",
}


def _public_rows(db: Session):
    return db.scalars(
        select(Asset)
        .where(
            Asset.status == "active",
            Asset.visibility == "public",
            Asset.public_latest_version.is_not(None),
        )
        .order_by(Asset.updated_at.desc())
    ).all()


def _category_object(asset: Asset) -> dict:
    stored = (asset.extra or {}).get("category")
    if isinstance(stored, dict):
        return stored
    kind, path = asset.kind, asset.category
    parts = [part for part in str(path or "").split("/") if part]
    if kind in ("skill", "team"):
        return {"domain": parts[0] if parts else "", "subdomain": parts[1] if len(parts) > 1 else ""}
    if kind == "connector":
        return {"function": parts[0] if parts else ""}
    if kind == "session":
        return {
            "domain": parts[0] if parts else "",
            "source": parts[-1] if parts else "",
            "task": parts[1] if len(parts) > 1 else "",
        }
    return {}


def _catalog_asset(asset: Asset, version_row) -> dict:
    extra = dict(asset.extra or {})
    download = {
        "sha256": version_row.sha256 if version_row else None,
        "size": version_row.size if version_row else None,
        "url": f"/api/v1/artifacts/{asset.id}/content",
    }
    payload = {
        "id": asset.id,
        "kind": KIND_TO_CATALOG[asset.kind],
        "name": asset.display_name or asset.name,
        "description": asset.summary,
        "version": asset.public_latest_version,
        "source": extra.get("source", "builtin"),
        "author": extra.get("author"),
        "tags": list(asset.tags or []),
        "category": _category_object(asset),
        "download": download,
        "readme": f"/api/v1/assets/{asset.id}/readme?format=text",
        "related": extra.get("related"),
    }
    if asset.kind in ("skill", "team"):
        manifest = version_row.manifest if version_row else []
        payload["resources"] = [
            {
                "path": item["path"],
                "size": item["size"],
                "url": (
                    f"/api/v1/assets/{asset.id}/versions/{asset.public_latest_version}"
                    f"/files/content?path={item['path']}"
                ),
            }
            for item in manifest
            if item.get("path", "").lower().endswith((".md", ".json", ".yaml", ".yml", ".txt", ".py"))
        ]
        payload["readme"] = f"/api/v1/assets/{asset.id}/readme?format=text"
    for key in ("hardware", "type", "members", "runtime", "instructions", "tools", "kinds", "publisher", "benchmark", "contents", "run", "connectors", "skills"):
        if key in extra:
            payload[key] = extra[key]
    return payload


def _session_tree(rows) -> list[dict]:
    """Sessions group task → domain, the shape the site's sessions tab uses."""
    tasks: dict[str, dict] = {}
    for asset in rows:
        category = (asset.extra or {}).get("category") or {}
        task = str(category.get("task") or "uncategorized")
        domain = category.get("domain")
        node = tasks.setdefault(task, {"id": task, "count": 0, "children": []})
        node["count"] += 1
        if domain:
            child = next((item for item in node["children"] if item["id"] == domain), None)
            if child is None:
                child = {"id": str(domain), "count": 0, "children": []}
                node["children"].append(child)
            child["count"] += 1
    for node in tasks.values():
        node["children"].sort(key=lambda child: child["id"])
    return [tasks[key] for key in sorted(tasks)]


def _tree(rows) -> list[dict]:
    roots: dict[str, dict] = {}
    for asset in rows:
        segments = [part for part in str(asset.category or "").split("/") if part]
        parent = None
        for depth, segment in enumerate(segments):
            node_id = "/".join(segments[: depth + 1])
            node = roots.setdefault(node_id, {"id": node_id, "count": 0, "children": []})
            node["count"] += 1
            if parent is not None and node not in parent["children"]:
                parent["children"].append(node)
            parent = node
    for node in roots.values():
        node["children"].sort(key=lambda child: child["id"])
    return [roots[node_id] for node_id in sorted(roots) if "/" not in node_id]


@router.get("/catalog")
def catalog(db: Session = Depends(get_db)) -> dict:
    """The browse payload the site used to read from `catalog.json`.

    The database is the source; this assembles the same shape so the site reads
    one API response instead of a build artifact.
    """
    from sqlalchemy import select as _select

    from ..models import AssetVersion

    rows = _public_rows(db)
    public_ids = [row.id for row in rows]
    versions = {
        (version.asset_id, version.version): version
        for version in db.scalars(
            _select(AssetVersion).where(
                AssetVersion.moderation_status == "approved",
                AssetVersion.asset_id.in_(public_ids),
            )
        ).all()
    }
    assets = [
        _catalog_asset(row, versions.get((row.id, row.public_latest_version)))
        for row in rows
    ]
    skills = [row for row in rows if row.kind == "skill"]
    connectors = [row for row in rows if row.kind == "connector"]
    sessions = [row for row in rows if row.kind == "session"]
    return ok(
        {
            "schemaVersion": 1,
            "generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
            "assets": assets,
            "categories": {
                "skill": _tree(skills),
                "connector": _tree(connectors),
                "sessionPackage": _session_tree(sessions),
            },
            "sources": {},
        }
    )
