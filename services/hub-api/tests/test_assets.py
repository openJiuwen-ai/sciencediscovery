from __future__ import annotations

import hashlib
import os

from tests.support import make_zip


def _create_asset(client, headers, **overrides):
    body = {
        "kind": "skill",
        "name": "literature-searcher",
        "display_name": "Literature Searcher",
        "summary": "Search PubMed and arXiv",
        "description": "A skill that searches literature.",
        "category": "biology",
        "tags": ["literature"],
        **overrides,
    }
    response = client.post("/api/v1/assets", json=body, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _upload(client, headers, asset_id, version="1.0.0", payload=None):
    data = payload if payload is not None else make_zip(
        {"SKILL.md": b"# Skill\n", "scripts/search.py": b"print('hi')\n"}
    )
    return client.post(
        f"/api/v1/assets/{asset_id}/versions",
        headers=headers,
        data={"version": version, "changelog": "first"},
        files={"file": (f"package-{version}.zip", data, "application/zip")},
    )


def test_uploaded_version_is_hidden_until_reviewed(client, register):
    token, _ = register("publisher")
    headers = {"Authorization": f"Bearer {token}"}
    asset = _create_asset(client, headers)

    upload = _upload(client, headers, asset["id"])
    assert upload.status_code == 201, upload.text
    body = upload.json()["data"]
    assert body["moderation_status"] == "pending"

    public_list = client.get("/api/v1/assets").json()["data"]
    assert public_list["total"] == 0

    mine = client.get("/api/v1/assets?mine=true", headers=headers).json()["data"]
    assert mine["total"] == 1
    assert mine["items"][0]["latest_version"] == "1.0.0"
    assert mine["items"][0]["public_latest_version"] is None


def test_approval_publishes_and_serves_the_bytes(client, register):
    token, user = register("publisher")
    headers = {"Authorization": f"Bearer {token}"}
    asset = _create_asset(client, headers)
    payload = make_zip({"SKILL.md": b"# Skill\n"})
    assert _upload(client, headers, asset["id"], payload=payload).status_code == 201

    # Same account is an admin because it was the first registered user.
    review = client.post(
        f"/api/v1/admin/reviews/{asset['id']}/1.0.0",
        headers=headers,
        json={"decision": "approve"},
    )
    assert review.status_code == 200, review.text

    public_list = client.get("/api/v1/assets").json()["data"]
    assert public_list["total"] == 1
    assert public_list["items"][0]["public_latest_version"] == "1.0.0"

    artifact = client.get(f"/api/v1/artifacts/{asset['id']}")
    assert artifact.status_code == 200
    data = artifact.json()["data"]
    assert data["version"] == "1.0.0"
    assert data["sha256"] == hashlib.sha256(payload).hexdigest()
    assert data["url"].endswith(".zip")

    # The save dialog reads the same bytes from the same-origin endpoint.
    streamed = client.get(f"/api/v1/artifacts/{asset['id']}/content")
    assert streamed.status_code == 200
    assert streamed.content == payload
    assert "attachment" in streamed.headers["content-disposition"]

    # The local backend serves the exact bytes the manifest promised.
    download = client.get(data["url"])
    assert download.status_code == 200
    assert download.content == payload
    assert "attachment" in download.headers["content-disposition"]


def test_rejection_keeps_the_version_private(client, register):
    token, _ = register("publisher")
    headers = {"Authorization": f"Bearer {token}"}
    asset = _create_asset(client, headers)
    assert _upload(client, headers, asset["id"]).status_code == 201

    reject = client.post(
        f"/api/v1/admin/reviews/{asset['id']}/1.0.0",
        headers=headers,
        json={"decision": "reject", "reason": "missing SKILL.md"},
    )
    assert reject.status_code == 200
    assert reject.json()["data"]["moderation_status"] == "rejected"
    assert reject.json()["data"]["reject_reason"] == "missing SKILL.md"

    assert client.get("/api/v1/assets").json()["data"]["total"] == 0
    assert client.get(f"/api/v1/artifacts/{asset['id']}").status_code == 404

    # A rejected version can be re-uploaded? No: the version string is taken.
    again = _upload(client, headers, asset["id"])
    assert again.status_code == 409


def test_only_the_owner_can_upload(client, register):
    token, _ = register("owner")
    other_token, _ = register("intruder")
    owner = {"Authorization": f"Bearer {token}"}
    other = {"Authorization": f"Bearer {other_token}"}
    asset = _create_asset(client, owner)
    attempt = _upload(client, other, asset["id"])
    assert attempt.status_code == 403


def test_files_tab_lists_the_package_and_previews_text(client, register):
    token, _ = register("publisher")
    headers = {"Authorization": f"Bearer {token}"}
    asset = _create_asset(client, headers)
    payload = make_zip(
        {"SKILL.md": "# Hello\n", "assets/icon.png": b"\x89PNG\r\n\x1a\n\x00"}
    )
    assert _upload(client, headers, asset["id"], payload=payload).status_code == 201
    client.post(
        f"/api/v1/admin/reviews/{asset['id']}/1.0.0",
        headers=headers,
        json={"decision": "approve"},
    )

    listing = client.get(f"/api/v1/assets/{asset['id']}/versions/1.0.0/files")
    assert listing.status_code == 200
    files = listing.json()["data"]["files"]
    assert [item["path"] for item in files] == ["SKILL.md", "assets/icon.png"]

    text = client.get(
        f"/api/v1/assets/{asset['id']}/versions/1.0.0/files",
        params={"with_content": "SKILL.md"},
    ).json()["data"]
    assert text["content"] == "# Hello\n"

    binary = client.get(
        f"/api/v1/assets/{asset['id']}/versions/1.0.0/files",
        params={"with_content": "assets/icon.png"},
    ).json()["data"]
    assert binary["content"] is None


def test_upload_limits_are_enforced(client, register):
    token, _ = register("publisher")
    headers = {"Authorization": f"Bearer {token}"}
    asset = _create_asset(client, headers)

    not_a_zip = _upload(client, headers, asset["id"], payload=b"plain text")
    assert not_a_zip.status_code == 400

    traversal = _upload(
        client, headers, asset["id"], payload=make_zip({"../escape.txt": b"x"})
    )
    assert traversal.status_code == 400
    assert "traversal" in traversal.json()["detail"]

    oversized = _upload(
        client, headers, asset["id"], payload=make_zip({"big.bin": os.urandom(3 * 1024 * 1024)})
    )
    assert oversized.status_code == 400
