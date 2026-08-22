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

"""Download openJiuwen org issue/PR templates into a local gitignored cache.

Source (no git clone):
  https://gitcode.com/openJiuwen/.gitcode  (default ref: master)
  tree: .gitcode/
    ISSUE_TEMPLATE.zh/*.yml          Chinese issue forms (default for this repo)
    ISSUE_TEMPLATE.en/*.yml          English issue forms (+ config.yml)
    PULL_REQUEST_TEMPLATE.md         PR template (Chinese)
    PULL_REQUEST_TEMPLATE.zh-CN.md
    PULL_REQUEST_TEMPLATE.en.md

Token resolution matches gitcode CLI:
  1. GC_TOKEN
  2. GITCODE_TOKEN
  3. ~/.config/gc/auth.json (or $GC_CONFIG_DIR/auth.json)

Usage:
  uv run --no-project fetch_openjiuwen_templates.py
  uv run --no-project fetch_openjiuwen_templates.py --force
  uv run --no-project fetch_openjiuwen_templates.py --ref master --out /path/to/cache

Never prints the token.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import quote

DEFAULT_HOST = "gitcode.com"
DEFAULT_OWNER = "openJiuwen"
DEFAULT_REPO = ".gitcode"
DEFAULT_REF = "master"
DEFAULT_TREE = ".gitcode"  # path inside the templates repo
CONFIG_DIR_ENV = "GC_CONFIG_DIR"
TOKEN_ENV_PRIMARY = "GC_TOKEN"
TOKEN_ENV_SECONDARY = "GITCODE_TOKEN"
HOST_ENV = "GC_HOST"

# Skill layout: scripts/ -> parent is skill root; cache next to scripts/
SKILL_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CACHE = SKILL_ROOT / "cache" / "openjiuwen-org-templates"


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
    if len(users) == 1:
        name, rec = next(iter(users.items()))
        if isinstance(rec, dict):
            token = (rec.get("token") or "").strip()
            if token:
                return token, f"config:{host}/{name}"

    eprint(
        "error: no GitCode token. Set GC_TOKEN / GITCODE_TOKEN, "
        "or run `gitcode auth login`."
    )
    sys.exit(4)


def http_json(url: str, token: str, timeout: float = 60.0) -> Any:
    """GET URL with Bearer token and return parsed JSON body."""
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        eprint(f"error: HTTP {err.code} for {url}: {body[:300]}")
        sys.exit(1 if err.code not in (401, 403) else 4)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
        eprint(f"error: request failed for {url}: {err}")
        sys.exit(1)


def contents_url(host: str, owner: str, repo: str, path: str, ref: str) -> str:
    # api.<host>/api/v5/repos/owner/repo/contents/path?ref=
    base = f"https://api.{host}/api/v5/repos/{quote(owner)}/{quote(repo)}/contents"
    if path:
        base = f"{base}/{quote(path, safe='/')}"
    return f"{base}?ref={quote(ref)}"


def download_tree(
    host: str,
    owner: str,
    repo: str,
    ref: str,
    tree_path: str,
    dest: Path,
    token: str,
) -> list[str]:
    """Recursively download tree_path into dest / tree_path. Returns written relative paths."""
    written: list[str] = []

    def walk(path: str) -> None:
        url = contents_url(host, owner, repo, path, ref)
        data = http_json(url, token)
        if isinstance(data, dict) and data.get("type") == "file":
            _write_file(path, data, dest, token, written)
            return
        if not isinstance(data, list):
            eprint(f"error: unexpected contents payload for {path!r}")
            sys.exit(1)
        for item in data:
            p = item.get("path") or ""
            t = item.get("type")
            if t == "dir":
                walk(p)
            elif t == "file":
                # listing may omit content; fetch file entry
                file_url = contents_url(host, owner, repo, p, ref)
                meta = http_json(file_url, token)
                _write_file(p, meta, dest, token, written)

    walk(tree_path)
    return written


def _write_file(
    path: str,
    meta: dict[str, Any],
    dest: Path,
    token: str,
    written: list[str],
) -> None:
    """Write one Contents API file entry under dest and record its relative path."""
    out = dest / path
    out.parent.mkdir(parents=True, exist_ok=True)
    raw: bytes
    if meta.get("encoding") == "base64" and meta.get("content"):
        raw = base64.b64decode(meta["content"])
    elif meta.get("download_url"):
        req = urllib.request.Request(meta["download_url"])
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    else:
        eprint(f"error: cannot download file content for {path!r}")
        sys.exit(1)
    out.write_bytes(raw)
    written.append(path)
    eprint(f"  wrote {path} ({len(raw)} bytes)")


def survey_cache(cache: Path, tree_path: str = DEFAULT_TREE) -> dict[str, Any]:
    """Describe the cached template layout.

    openJiuwen splits issue forms per locale (`ISSUE_TEMPLATE.zh`,
    `ISSUE_TEMPLATE.en`), so match the `ISSUE_TEMPLATE*` prefix rather than a
    single `ISSUE_TEMPLATE/` directory. Complete means: at least one locale
    directory holding `*.yml` forms, plus at least one PR template.
    """
    root = cache / tree_path
    issue_dirs: dict[str, list[str]] = {}
    if root.is_dir():
        for entry in sorted(root.iterdir()):
            if entry.is_dir() and entry.name.startswith("ISSUE_TEMPLATE"):
                ymls = sorted(p.name for p in entry.glob("*.yml"))
                if ymls:
                    issue_dirs[entry.name] = ymls
    pr_templates = (
        sorted(p.name for p in root.glob("PULL_REQUEST_TEMPLATE*.md"))
        if root.is_dir()
        else []
    )
    return {
        "issue_template_dirs": issue_dirs,
        "pr_templates": pr_templates,
        "complete": bool(issue_dirs) and bool(pr_templates),
    }


def cache_looks_complete(cache: Path, tree_path: str = DEFAULT_TREE) -> bool:
    return bool(survey_cache(cache, tree_path)["complete"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fetch openJiuwen org .gitcode issue/PR templates into a local cache (no git clone).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_CACHE,
        help=f"Cache directory (default: {DEFAULT_CACHE})",
    )
    parser.add_argument("--ref", default=DEFAULT_REF, help=f"Git ref (default: {DEFAULT_REF})")
    parser.add_argument(
        "--tree",
        default=DEFAULT_TREE,
        help=f"Path inside openJiuwen/.gitcode to download (default: {DEFAULT_TREE})",
    )
    parser.add_argument(
        "--owner",
        default=DEFAULT_OWNER,
        help=f"Org/user (default: {DEFAULT_OWNER})",
    )
    parser.add_argument(
        "--repo",
        default=DEFAULT_REPO,
        help=f"Templates repo name (default: {DEFAULT_REPO})",
    )
    parser.add_argument(
        "--hostname",
        default=None,
        help=f"GitCode host (default: ${HOST_ENV} / auth.json / {DEFAULT_HOST})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Delete existing cache and re-download",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print summary JSON on stdout",
    )
    args = parser.parse_args(argv)

    out: Path = args.out.expanduser().resolve()
    host = resolve_host(args.hostname)

    if out.exists() and not args.force and cache_looks_complete(out, args.tree):
        eprint(f"cache already present: {out} (use --force to refresh)")
        if args.json:
            meta_path = out / "FETCH_META.json"
            if meta_path.is_file():
                print(meta_path.read_text(encoding="utf-8"), end="")
            else:
                print(json.dumps({"cache": str(out), "skipped": True}))
        else:
            print(out)
        return 0

    token, token_source = resolve_token(host)
    eprint(
        f"fetching {args.owner}/{args.repo}@{args.ref} tree={args.tree} "
        f"-> {out} (token_source={token_source})"
    )

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    written = download_tree(
        host, args.owner, args.repo, args.ref, args.tree, out, token
    )
    # optional README at repo root (context only)
    try:
        readme_meta = http_json(
            contents_url(host, args.owner, args.repo, "README.md", args.ref), token
        )
        if isinstance(readme_meta, dict):
            _write_file("README.md", readme_meta, out, token, written)
    except SystemExit:
        pass  # optional

    survey = survey_cache(out, args.tree)
    meta = {
        "source_web": f"https://{host}/{args.owner}/{args.repo}/tree/{args.ref}/{args.tree}",
        "source_repo": f"{args.owner}/{args.repo}",
        "ref": args.ref,
        "tree": args.tree,
        "host": host,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "token_source": token_source,
        "files": sorted(written),
        "cache": str(out),
        "method": "GitCode Contents API (no git clone)",
        **survey,
    }
    (out / "FETCH_META.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    eprint(f"done: {len(written)} files -> {out}")
    for name, ymls in survey["issue_template_dirs"].items():
        eprint(f"  {name}: {len(ymls)} yml file(s)")
    eprint(f"  PR templates: {', '.join(survey['pr_templates']) or '(none)'}")

    if not survey["complete"]:
        eprint(
            "warning: cache may be incomplete (expected ISSUE_TEMPLATE.zh / "
            "ISSUE_TEMPLATE.en with *.yml plus PULL_REQUEST_TEMPLATE*.md)"
        )

    if args.json:
        print(json.dumps(meta, ensure_ascii=False))
    else:
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
