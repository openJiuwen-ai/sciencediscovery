"""Package storage.

Two backends behind one interface:

- ``LocalStorage`` writes under a directory and serves downloads through the
  API. It exists so the service can be developed and tested without a bucket.
- ``S3Storage`` talks to OBS (or any S3-compatible store) and hands the client
  a presigned URL, exactly as the reference implementation does. The bucket is
  expected to be private; nothing here ever makes an object public.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def safe_segment(value: str) -> str:
    if not _SAFE_SEGMENT.match(value or ""):
        raise ValueError(f"unsafe path segment: {value!r}")
    return value


def package_key(
    *, kind: str, publisher_id: str, asset_id: str, version: str, filename: str
) -> str:
    """The one place asset keys are composed.

    Mirrors the reference layout (`skills/<publisher>/<asset>/<version>/...`)
    but adds the kind, because the hub publishes several kinds from one bucket.
    """
    for segment in (kind, publisher_id, asset_id, version):
        safe_segment(segment)
    name = os.path.basename(filename)
    if not name or name in (".", "..") or "\\" in name or "/" in name:
        raise ValueError(f"unsafe filename: {filename!r}")
    return f"assets/{kind}/{publisher_id}/{asset_id}/{version}/{name}"


class StorageError(RuntimeError):
    pass


class Storage:
    def put(self, key: str, data: bytes, content_type: str) -> None:
        raise NotImplementedError

    def get(self, key: str) -> bytes:
        raise NotImplementedError

    def download_url(self, key: str, filename: str, expires_in: int) -> str:
        raise NotImplementedError

    def delete(self, key: str) -> None:
        raise NotImplementedError


@dataclass
class LocalStorage(Storage):
    root: Path
    base_url: str

    def __post_init__(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        target = (self.root / key).resolve()
        root = self.root.resolve()
        if root != target and root not in target.parents:
            raise StorageError(f"key escapes the storage root: {key}")
        return target

    def put(self, key: str, data: bytes, content_type: str) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(path)

    def get(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise StorageError(f"missing object: {key}")
        return path.read_bytes()

    def download_url(self, key: str, filename: str, expires_in: int) -> str:
        # The API forwards the bytes; dev only, never the production path.
        return f"{self.base_url.rstrip('/')}/api/v1/files/{key}"

    def delete(self, key: str) -> None:
        path = self._path(key)
        if path.is_file():
            path.unlink()


class S3Storage(Storage):
    def __init__(
        self,
        *,
        endpoint: str,
        region: str,
        bucket: str,
        access_key: str,
        secret_key: str,
    ) -> None:
        import boto3
        from botocore.config import Config

        if not (endpoint and bucket and access_key and secret_key):
            raise StorageError(
                "S3 backend needs HUB_S3_ENDPOINT, HUB_S3_BUCKET, "
                "HUB_S3_ACCESS_KEY and HUB_S3_SECRET_KEY"
            )
        self.bucket = bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region or None,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            # OBS accepts SigV4 but not the CRC32 trailer botocore adds by
            # default since 1.36 (aws-chunked uploads); without this the PUT
            # fails with XAmzContentSHA256Mismatch.
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "virtual"},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
        )

    def get(self, key: str) -> bytes:
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        return response["Body"].read()

    def download_url(self, key: str, filename: str, expires_in: int) -> str:
        return self.client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": self.bucket,
                "Key": key,
                "ResponseContentDisposition": f'attachment; filename="{filename}"',
            },
            ExpiresIn=expires_in,
        )

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)


def build_storage(settings) -> Storage:
    if settings.storage_backend == "s3":
        return S3Storage(
            endpoint=settings.s3_endpoint,
            region=settings.s3_region,
            bucket=settings.s3_bucket,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
        )
    if settings.storage_backend == "local":
        return LocalStorage(
            root=Path(settings.local_root), base_url=settings.public_base_url
        )
    raise StorageError(f"unknown storage backend: {settings.storage_backend}")
