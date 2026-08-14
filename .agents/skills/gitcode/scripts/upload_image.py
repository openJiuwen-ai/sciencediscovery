#!/usr/bin/env python3
# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Upload an image to a GitCode repo and print Markdown embed URL.

Token resolution matches gitcode CLI (docs/AUTH.md):

  1. GC_TOKEN
  2. GITCODE_TOKEN
  3. ~/.config/gc/auth.json  (or $GC_CONFIG_DIR/auth.json)

Run with uv (preferred; stdlib only, no project deps):

  uv run --no-project upload_image.py -R owner/repo path/to/image.png
  uv run --no-project upload_image.py -R owner/repo image.png --url-only
  uv run --no-project upload_image.py -R owner/repo image.png --json

If `uv` is not installed: https://docs.astral.sh/uv/getting-started/installation/
  curl -LsSf https://astral.sh/uv/install.sh | sh

Stdout: embed markdown by default (ready for issue/PR body), unless --url-only / --json.
Never prints the token.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import quote


DEFAULT_HOST = "gitcode.com"
RAW_HOST = "raw.gitcode.com"
CONFIG_DIR_ENV = "GC_CONFIG_DIR"
TOKEN_ENV_PRIMARY = "GC_TOKEN"
TOKEN_ENV_SECONDARY = "GITCODE_TOKEN"
HOST_ENV = "GC_HOST"


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def config_dir() -> Path:
    override = os.environ.get(CONFIG_DIR_ENV)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".config" / "gc"


def load_auth_json() -> dict[str, Any]:
    path = config_dir() / "auth.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        eprint(f"warning: cannot read {path}: {err}")
        return {}


def resolve_host(cli_host: str | None) -> str:
    if cli_host:
        return cli_host.strip()
    env = (os.environ.get(HOST_ENV) or "").strip()
    if env:
        return env
    data = load_auth_json()
    return (data.get("default_host") or DEFAULT_HOST).strip() or DEFAULT_HOST


def resolve_token(host: str) -> tuple[str, str]:
    """Return (token, source_label). Source labels never include the secret."""
    for env_name in (TOKEN_ENV_PRIMARY, TOKEN_ENV_SECONDARY):
        val = (os.environ.get(env_name) or "").strip()
        if val:
            return val, env_name

    data = load_auth_json()
    hosts = data.get("hosts") or {}
    host_entry = hosts.get(host) or {}
    active = host_entry.get("active_user")
    users = host_entry.get("users") or {}
    if active and isinstance(users.get(active), dict):
        token = (users[active].get("token") or "").strip()
        if token:
            return token, f"config:{host}/{active}"

    # Fallback: single user under host if active_user missing
    if len(users) == 1:
        name, rec = next(iter(users.items()))
        if isinstance(rec, dict):
            token = (rec.get("token") or "").strip()
            if token:
                return token, f"config:{host}/{name}"

    eprint(
        "error: no GitCode token found. Set GC_TOKEN / GITCODE_TOKEN, "
        "or run `gitcode auth login` (writes ~/.config/gc/auth.json)."
    )
    sys.exit(4)


def parse_repo(repo: str) -> tuple[str, str]:
    """Accept owner/repo, HTTPS, or SSH URLs."""
    s = repo.strip().rstrip("/")
    m = re.match(r"^(?:https?://[^/]+/|git@[^:]+:)([^/]+)/([^/]+?)(?:\.git)?$", s)
    if m:
        return m.group(1), m.group(2)
    if re.match(r"^[^/]+/[^/]+$", s):
        owner, name = s.split("/", 1)
        return owner, name
    eprint(f"error: invalid repo {repo!r}; use owner/repo")
    sys.exit(2)


def http_json(
    method: str,
    url: str,
    token: str,
    *,
    body: dict[str, Any] | None = None,
    timeout: float = 60.0,
) -> tuple[int, Any]:
    """Send an authenticated JSON HTTP request; return (status_code, parsed body)."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            if not raw:
                return resp.status, None
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        try:
            payload: Any = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = raw
        return err.code, payload


def fetch_repo_id(host: str, owner: str, name: str, token: str) -> int:
    """Resolve numeric repo id via GitCode Contents API (api host first)."""
    # Prefer API host used by gitcode CLI (api.<host>)
    candidates = [
        f"https://api.{host}/api/v5/repos/{quote(owner)}/{quote(name)}",
        f"https://{host}/api/v5/repos/{quote(owner)}/{quote(name)}",
    ]
    last: Any = None
    for url in candidates:
        status, payload = http_json("GET", url, token)
        last = (status, payload, url)
        if status == 200 and isinstance(payload, dict) and payload.get("id") is not None:
            return int(payload["id"])
    eprint(f"error: cannot resolve repo id for {owner}/{name}: {last}")
    sys.exit(1 if last and last[0] != 404 else 3)


def upload_image(
    host: str,
    owner: str,
    name: str,
    token: str,
    image_path: Path,
    file_name: str | None,
) -> dict[str, Any]:
    """Upload a local image file; return path/uuid/file_name from the API response."""
    if not image_path.is_file():
        eprint(f"error: file not found: {image_path}")
        sys.exit(2)
    raw = image_path.read_bytes()
    if not raw:
        eprint("error: image file is empty")
        sys.exit(2)

    fname = file_name or image_path.name
    attach = base64.b64encode(raw).decode("ascii")
    url = f"https://{host}/{owner}/{name}/uploads/image_file"
    status, payload = http_json(
        "POST",
        url,
        token,
        body={"attach": attach, "file_name": fname},
        timeout=120.0,
    )
    if status not in (200, 201) or not isinstance(payload, dict) or not payload.get("success"):
        eprint(f"error: upload failed HTTP {status}: {payload}")
        sys.exit(1 if status not in (401, 403) else 4)

    path = payload.get("path") or ""
    # expected: uploads/<uuid>/<file_name>
    parts = path.strip("/").split("/")
    if len(parts) < 3 or parts[0] != "uploads":
        eprint(f"error: unexpected upload path {path!r}")
        sys.exit(1)
    uuid_part = parts[1]
    stored_name = parts[-1]
    return {
        "path": path,
        "uuid": uuid_part,
        "file_name": stored_name,
        "raw": payload,
    }


def build_embed_url(repo_id: int, uuid_part: str, file_name: str) -> str:
    # Format verified against web UI comments that render successfully.
    return (
        f"https://{RAW_HOST}/user-images/assets/"
        f"{repo_id}/{uuid_part}/{file_name}"
    )


def build_markdown(url: str, alt: str) -> str:
    # Match web UI style: ![name](url 'name')
    safe_alt = alt.replace("'", "")
    return f"![{safe_alt}]({url} '{safe_alt}')"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Upload an image to GitCode and print a Markdown embed link.",
    )
    parser.add_argument(
        "image",
        type=Path,
        help="Local image file to upload",
    )
    parser.add_argument(
        "-R",
        "--repo",
        required=True,
        help="Target repository: owner/repo (also accepts HTTPS/SSH URL)",
    )
    parser.add_argument(
        "--hostname",
        default=None,
        help=f"GitCode host (default: ${HOST_ENV} or auth.json default_host or {DEFAULT_HOST})",
    )
    parser.add_argument(
        "--file-name",
        default=None,
        help="Remote file name (default: basename of local file)",
    )
    parser.add_argument(
        "--url-only",
        action="store_true",
        help="Print only the https image URL (no Markdown)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print JSON with path, url, markdown, repo_id (no token)",
    )
    args = parser.parse_args(argv)

    host = resolve_host(args.hostname)
    token, token_source = resolve_token(host)
    owner, name = parse_repo(args.repo)
    image_path = args.image.expanduser().resolve()

    repo_id = fetch_repo_id(host, owner, name, token)
    uploaded = upload_image(host, owner, name, token, image_path, args.file_name)
    url = build_embed_url(repo_id, uploaded["uuid"], uploaded["file_name"])
    markdown = build_markdown(url, uploaded["file_name"])

    eprint(f"uploaded path={uploaded['path']} token_source={token_source} repo={owner}/{name} id={repo_id}")

    if args.json:
        print(
            json.dumps(
                {
                    "success": True,
                    "repository": f"{owner}/{name}",
                    "repo_id": repo_id,
                    "path": uploaded["path"],
                    "url": url,
                    "markdown": markdown,
                    "file_name": uploaded["file_name"],
                    "token_source": token_source,
                },
                ensure_ascii=False,
            )
        )
    elif args.url_only:
        print(url)
    else:
        print(markdown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
