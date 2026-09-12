#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["esdk-obs-python==3.25.8"]
# ///
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

"""Upload a CI layer's results, logs and artifacts to OBS.

Generic on purpose: it takes paths and a key prefix, and mirrors whatever it is
given. A layer decides what is worth publishing; this script only moves bytes
and prints where they landed.

    uv run .ci/obs-upload.py --prefix sciencediscovery/ci/<commit>/<run>/st \\
        .tmp/ci-results/st

Credentials come from the environment and from nowhere else:

    OBS_ACCESS_KEY_ID       required
    OBS_SECRET_ACCESS_KEY   required

Nothing here reads a credential file or embeds a key, and neither value is ever
printed. The reference for the bucket, the endpoint and the key layout is
.agents/skills/ci/references/codearts-obs.md; the defaults below match it.

Why the SDK rather than curl: journey report directories carry non-ASCII names,
so every object key needs correct percent-encoding in the request line while the
stored key stays unchanged. Hand-rolling that, together with a V2 signature, is
exactly the kind of detail that breaks on one file in two hundred.

An upload must never decide a layer's verdict. Run this after the layer has
recorded its exit code, and let the caller keep that code.
"""

from __future__ import annotations

import argparse
import mimetypes
import os
import sys
from pathlib import Path
from urllib.parse import quote

from obs import ObsClient, PutObjectHeader

DEFAULT_BUCKET = "openjiuwen-ci"
DEFAULT_ENDPOINT = "obs.cn-north-4.myhuaweicloud.com"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="obs-upload.py",
        description="Upload files and directories to an OBS key prefix.",
    )
    parser.add_argument(
        "--prefix",
        required=True,
        help="Object key prefix, with no leading slash. Include the commit and "
        "the run id so reruns cannot overwrite one another.",
    )
    parser.add_argument("--bucket", default=os.environ.get("OBS_BUCKET", DEFAULT_BUCKET))
    parser.add_argument(
        "--endpoint", default=os.environ.get("OBS_ENDPOINT", DEFAULT_ENDPOINT)
    )
    parser.add_argument(
        "--max-file-size",
        type=int,
        default=int(os.environ.get("OBS_MAX_FILE_SIZE", "0")),
        help="Skip files larger than this many bytes, reporting each one. "
        "0, the default, uploads everything.",
    )
    parser.add_argument(
        "--verbose", action="store_true", help="Print one line per object."
    )
    parser.add_argument(
        "paths",
        nargs="+",
        help="Files or directories. A directory is mirrored below the prefix, "
        "keeping the paths relative to the directory itself.",
    )
    return parser.parse_args(argv)


def collect(paths: list[str]) -> list[tuple[Path, str]]:
    """Pair every readable file with the key suffix it keeps below the prefix."""
    pairs: list[tuple[Path, str]] = []
    for raw in paths:
        path = Path(raw)
        if path.is_file():
            pairs.append((path, path.name))
        elif path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file():
                    pairs.append((child, child.relative_to(path).as_posix()))
        else:
            print(f"obs-upload: no such file or directory: {path}", file=sys.stderr)
    return pairs


def public_url(bucket: str, endpoint: str, key: str) -> str:
    # The stored key is unchanged; only its HTTP representation is encoded. A
    # key that is not encoded here can answer 403 even though the object exists.
    return f"https://{bucket}.{endpoint}/{quote(key)}"


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    access_key = os.environ.get("OBS_ACCESS_KEY_ID", "").strip()
    secret_key = os.environ.get("OBS_SECRET_ACCESS_KEY", "").strip()
    if not access_key or not secret_key:
        print(
            "obs-upload: OBS_ACCESS_KEY_ID and OBS_SECRET_ACCESS_KEY must both be "
            "set; refusing to continue.",
            file=sys.stderr,
        )
        return 2

    prefix = args.prefix.strip("/")
    if not prefix:
        print("obs-upload: --prefix must not be empty", file=sys.stderr)
        return 2

    pairs = collect(args.paths)
    if not pairs:
        print("obs-upload: nothing to upload")
        return 0

    client = ObsClient(
        access_key_id=access_key,
        secret_access_key=secret_key,
        server=args.endpoint,
    )

    uploaded = 0
    skipped = 0
    failed = 0
    total_bytes = 0
    try:
        for path, suffix in pairs:
            size = path.stat().st_size
            key = f"{prefix}/{suffix}"

            if args.max_file_size and size > args.max_file_size:
                print(f"obs-upload: skipping {suffix} ({size} bytes, over limit)")
                skipped += 1
                continue

            # Without a content type an HTML report downloads instead of
            # rendering, which makes the Playwright output useless in a browser.
            content_type = mimetypes.guess_type(path.name)[0]
            headers = PutObjectHeader(contentType=content_type) if content_type else None

            try:
                resp = client.putFile(args.bucket, key, str(path), headers=headers)
            except Exception as exc:  # noqa: BLE001 - report and keep going
                print(f"obs-upload: FAILED {key}: {type(exc).__name__}: {exc}",
                      file=sys.stderr)
                failed += 1
                continue

            if resp.status >= 300:
                print(
                    f"obs-upload: FAILED {key}: status={resp.status} "
                    f"{getattr(resp, 'errorMessage', '')}",
                    file=sys.stderr,
                )
                failed += 1
                continue

            uploaded += 1
            total_bytes += size
            if args.verbose:
                print(public_url(args.bucket, args.endpoint, key))
    finally:
        client.close()

    print(
        f"obs-upload: {uploaded} uploaded, {skipped} skipped, {failed} failed, "
        f"{total_bytes} bytes"
    )
    print(f"obs-upload: prefix {public_url(args.bucket, args.endpoint, prefix + '/')}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
