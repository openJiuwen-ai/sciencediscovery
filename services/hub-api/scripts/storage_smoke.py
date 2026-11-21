"""Prove the bucket and the credentials before anything depends on them.

Writes a few random bytes, asks the service for a presigned URL, downloads it
anonymously, compares the bytes, then deletes the object when the credential
is allowed to. It answers the four questions that otherwise surface only after
a deployment:

    credentials valid?  region/endpoint right?  presign works?  private bucket?

Run with the service's environment (`.env` is read by the shell, not by the
program, so export it first):

    set -a; . ./.env; set +a
    .venv/bin/python -m scripts.storage_smoke
"""

from __future__ import annotations

import datetime
import email.utils
import hashlib
import os
import sys
import urllib.error
import urllib.request

from app.config import get_settings
from app.storage import S3Storage, build_storage


def _skew_seconds(endpoint: str) -> int:
    """Local clock minus the storage service's clock, in seconds.

    SigV4 refuses a request whose signature is more than fifteen minutes in the
    future, so a host with a drifting clock fails with RequestTimeTooSkewed.
    Production hosts run NTP; a development host may not, and this lets the
    smoke test still say something useful about the bucket.
    """
    request = urllib.request.Request(endpoint, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            header = response.headers.get("Date")
    except urllib.error.HTTPError as error:  # 403 still carries Date
        header = error.headers.get("Date")
    if not header:
        return 0
    server = email.utils.parsedate_to_datetime(header)
    if server.tzinfo is None:
        server = server.replace(tzinfo=datetime.timezone.utc)
    local = datetime.datetime.now(datetime.timezone.utc)
    return int((local - server).total_seconds())


def _correct_clock(skew: int) -> None:
    if not skew:
        return
    import botocore.auth

    original = botocore.auth.get_current_datetime

    def corrected(remove_tzinfo: bool = True):
        return original(remove_tzinfo) - datetime.timedelta(seconds=skew)

    botocore.auth.get_current_datetime = corrected


def main() -> int:
    settings = get_settings()
    if settings.storage_backend != "s3":
        print("HUB_STORAGE_BACKEND is not 's3'; nothing to smoke-test.", file=sys.stderr)
        return 2
    skew = _skew_seconds(settings.s3_endpoint)
    if skew:
        print(f"clock    local is {skew:+d}s from the service clock; signing with the corrected time")
        _correct_clock(skew)
    storage = build_storage(settings)
    assert isinstance(storage, S3Storage)

    key = f"assets/probe/smoke-{os.getpid()}-{os.urandom(6).hex()}.txt"
    payload = b"hub storage smoke " + os.urandom(16).hex().encode() + b"\n"

    print(f"bucket   {settings.s3_bucket}")
    print(f"endpoint {settings.s3_endpoint}")
    print(f"region   {settings.s3_region}")

    try:
        storage.put(key, payload, content_type="text/plain")
        print("put      ok")
    except Exception as error:  # noqa: BLE001 - the message is the report
        print(f"put      FAILED: {error}", file=sys.stderr)
        return 1

    url = storage.download_url(key, "smoke.txt", settings.presign_seconds)
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        print(f"presign  FAILED: HTTP {error.code}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001
        print(f"presign  FAILED: {error}", file=sys.stderr)
        return 1

    expected = hashlib.sha256(payload).hexdigest()
    actual = hashlib.sha256(body).hexdigest()
    if expected != actual:
        print(f"download MISMATCH: {actual} != {expected}", file=sys.stderr)
        return 1
    print(f"download ok (sha256 {actual[:16]}…)")

    # An anonymous read of the same key without the signature must be denied;
    # that is what "private bucket" means in practice.
    host = settings.s3_endpoint.split("://", 1)[-1].rstrip("/")
    bare = f"https://{settings.s3_bucket}.{host}/{key}"
    try:
        urllib.request.urlopen(bare, timeout=20)
        print("privacy  WARNING: the object is readable without a signature", file=sys.stderr)
    except urllib.error.HTTPError as error:
        print(f"privacy  ok (anonymous GET -> {error.code})")

    try:
        storage.delete(key)
        print("delete   ok")
    except Exception as error:  # noqa: BLE001
        print(f"delete   skipped: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
