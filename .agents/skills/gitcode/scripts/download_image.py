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

"""Download an image from raw.gitcode.com using an authenticated request.

raw.gitcode.com user-images URLs require auth (anonymous GET returns 403).
Verified auth schemes:

  - ``Authorization: Bearer <token>``  -> 200 image/png
  - ``Authorization: token <token>``   -> 200 image/png
  - anonymous                          -> 403 no access right
  - ``PRIVATE-TOKEN: <token>``         -> 403 (not supported by raw host)

This script uses ``Authorization: Bearer <token>``. Token resolution matches
gitcode CLI (docs/AUTH.md):

  1. GC_TOKEN
  2. GITCODE_TOKEN
  3. ~/.config/gc/auth.json  (or $GC_CONFIG_DIR/auth.json)

Run with uv (preferred; stdlib only, no project deps):

  uv run --no-project download_image.py <url> [-o out.png]
  uv run --no-project download_image.py <url> -o .tmp/img.png --json
  uv run --no-project download_image.py '![alt](https://raw.gitcode.com/...)'

Accepts either a bare raw.gitcode.com URL or a Markdown image embed
(`![alt](url 'title')`). Stdout on success: saved path by default, or one
JSON object with --json (no progress line). Errors go to stderr only.
Never prints the token.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse


DEFAULT_HOST = "gitcode.com"
RAW_HOST = "raw.gitcode.com"
CONFIG_DIR_ENV = "GC_CONFIG_DIR"
TOKEN_ENV_PRIMARY = "GC_TOKEN"
TOKEN_ENV_SECONDARY = "GITCODE_TOKEN"
HOST_ENV = "GC_HOST"

# Supported image content-type prefix; raw host returns image/png, image/jpeg, ...
IMAGE_CONTENT_TYPE = "image/"
# raw.gitcode.com only accepts Bearer / token schemes. PRIVATE-TOKEN returns 403.
SUPPORTED_AUTH_SCHEMES = ("Bearer", "token")


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


_MD_EMBED_RE = re.compile(
    r"!\[[^\]]*\]\((?P<url>https?://[^\s)]+)(?:\s+['\"][^'\"]*['\"])?\)"
)


def extract_url(arg: str) -> str:
    """Accept a bare URL or a Markdown image embed; return the bare URL."""
    s = arg.strip()
    m = _MD_EMBED_RE.search(s)
    if m:
        return m.group("url")
    if s.startswith(("http://", "https://")):
        return s
    eprint(f"error: not a URL or Markdown image embed: {arg!r}")
    sys.exit(2)


def suggest_filename(url: str) -> str:
    """Derive a local filename from the URL path (last path segment, decoded)."""
    path = urlparse(url).path
    name = unquote(path.rsplit("/", 1)[-1]) if path else ""
    if not name:
        name = "image.png"
    # Guard against path traversal / odd chars; keep it a single filename.
    name = name.replace("/", "_").replace("\\", "_")
    return name


def download(url: str, token: str, out_path: Path) -> tuple[int, str, int, str]:
    """Download URL with Bearer auth; return (status, content_type, size, error)."""
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "image/*")
    try:
        with urllib.request.urlopen(req, timeout=60.0) as resp:
            data = resp.read()
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(data)
            return resp.status, resp.headers.get("Content-Type", ""), len(data), ""
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")[:200]
        return err.code, err.headers.get("Content-Type", "") if err.headers else "", 0, body
    except urllib.error.URLError as err:
        return 0, "", 0, str(err)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Download a raw.gitcode.com image with auth and save it locally.",
    )
    parser.add_argument(
        "url",
        help="Image URL (https://raw.gitcode.com/...) or Markdown embed ![alt](url 'title')",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Output file path (default: filename from URL in cwd or .tmp/)",
    )
    parser.add_argument(
        "--hostname",
        default=None,
        help=f"GitCode host (default: ${HOST_ENV} or auth.json default_host or {DEFAULT_HOST})",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print JSON with url, status, content_type, size, path (no token)",
    )
    args = parser.parse_args(argv)

    host = resolve_host(args.hostname)
    token, token_source = resolve_token(host)
    url = extract_url(args.url)

    out_path = args.output
    if out_path is None:
        # Default to .tmp/ if it exists (skill convention), else cwd.
        tmp_dir = Path(".tmp")
        base_dir = tmp_dir if tmp_dir.is_dir() else Path.cwd()
        out_path = base_dir / suggest_filename(url)
    out_path = out_path.expanduser().resolve()

    status, content_type, size, err = download(url, token, out_path)

    if status != 200 or not content_type.startswith(IMAGE_CONTENT_TYPE):
        # 403 typically means anonymous access blocked or token invalid/expired.
        hint = ""
        if status == 403:
            hint = " (403: raw.gitcode.com requires Bearer/token auth; check token validity)"
        eprint(
            f"error: download failed HTTP {status} content_type={content_type!r}"
            f"{hint} body={err!r}"
        )
        # Clean up a partial/empty file if we created one.
        if out_path.exists() and out_path.stat().st_size == 0:
            out_path.unlink(missing_ok=True)
        return 1 if status not in (401, 403) else 4

    # Success: stdout is only the machine- or user-facing result (no progress).
    if args.json:
        print(
            json.dumps(
                {
                    "success": True,
                    "url": url,
                    "status": status,
                    "content_type": content_type,
                    "size": size,
                    "path": str(out_path),
                    "token_source": token_source,
                },
                ensure_ascii=False,
            )
        )
    else:
        print(str(out_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
