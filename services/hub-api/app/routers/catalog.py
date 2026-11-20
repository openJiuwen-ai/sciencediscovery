from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..categories import parse_category_object, parse_session_category
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
    """The category tree of the public catalogue, in the shape its tab uses.

    Skills are domain → subdomain, connectors are functions, sessions are
    task → domain. Node ids are the bare segment, because that is what the site
    puts in `?domain=`/`?sub=` and compares against the asset's category.
    """
    rows = db.scalars(
        select(Asset).where(
            Asset.status == "active",
            Asset.visibility == "public",
            Asset.public_latest_version.is_not(None),
        )
    ).all()
    if kind:
        rows = [row for row in rows if row.kind == kind]
    if kind == "session":
        tree = _session_tree(rows)
    elif kind in ("skill", "team"):
        tree = _skill_tree(rows)
    elif kind == "connector":
        tree = _connector_tree(rows)
    else:
        tree = _path_tree(rows)
    return ok({"tree": tree})


def _path_tree(rows) -> list[dict]:
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
    return parse_category_object(asset.kind, asset.category)


def _catalog_asset(asset: Asset, version_row) -> dict:
    extra = dict(asset.extra or {})
    version = asset.public_latest_version
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
        "version": version,
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
                    f"/api/v1/assets/{asset.id}/versions/{version}"
                    f"/files/content?path={item['path']}"
                ),
            }
            for item in manifest
            if item.get("path") != "SKILL.md"
        ]
        payload["hardware"] = extra.get("hardware")
        payload["type"] = extra.get("type")
        if asset.kind == "team":
            payload["members"] = extra.get("members", [])
    elif asset.kind == "specialist":
        download["text"] = f"/api/v1/assets/{asset.id}/readme?format=text"
        manifest = version_row.manifest if version_row else []
        payload["resources"] = [
            {
                "path": item["path"],
                "size": item["size"],
                "url": (
                    f"/api/v1/assets/{asset.id}/versions/{version}"
                    f"/files/content?path={item['path']}"
                ),
            }
            for item in manifest
        ]
        payload["connectors"] = extra.get("connectors", [])
        payload["instructions"] = extra.get("instructions", "")
        payload["runtime"] = extra.get("runtime")
        payload["skills"] = extra.get("skills", [])
    elif asset.kind == "connector":
        tools = extra.get("tools", [])
        payload["config"] = extra.get("config", {})
        payload["governance"] = extra.get("governance", {})
        payload["kinds"] = extra.get("kinds", [])
        payload["publisher"] = extra.get("publisher", "")
        payload["tools"] = tools
        payload["toolCount"] = extra.get("toolCount", len(tools))
    elif asset.kind == "session":
        payload["benchmark"] = extra.get("benchmark") or {
            "caseId": asset.name, "name": "", "score": None, "runAt": None,
        }
        payload["contents"] = extra.get("contents") or {
            "artifacts": 0, "executions": 0, "files": 0,
            "memoryNodes": 0, "messages": 0, "trajectory": "summary",
        }
        payload["run"] = extra.get("run")
    return payload


def _session_tree(rows) -> list[dict]:
    tasks: dict[str, dict] = {}
    for asset in rows:
        category = _category_object(asset)
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


def _skill_tree(rows) -> list[dict]:
    roots: dict[str, dict] = {}
    for asset in rows:
        category = _category_object(asset)
        domain = str(category.get("domain") or "")
        subdomain = category.get("subdomain")
        if not domain:
            continue
        node = roots.setdefault(domain, {"id": domain, "count": 0, "children": []})
        node["count"] += 1
        if subdomain:
            child = next((item for item in node["children"] if item["id"] == subdomain), None)
            if child is None:
                child = {"id": str(subdomain), "count": 0, "children": []}
                node["children"].append(child)
            child["count"] += 1
    for node in roots.values():
        node["children"].sort(key=lambda child: child["id"])
    return [roots[key] for key in sorted(roots)]


def _connector_tree(rows) -> list[dict]:
    roots: dict[str, dict] = {}
    for asset in rows:
        function = str(_category_object(asset).get("function") or "")
        if not function:
            continue
        node = roots.setdefault(function, {"id": function, "count": 0, "children": []})
        node["count"] += 1
    return [roots[key] for key in sorted(roots)]


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
                "skill": _skill_tree(skills),
                "connector": _connector_tree(connectors),
                "sessionPackage": _session_tree(sessions),
            },
            "sources": {},
        }
    )
