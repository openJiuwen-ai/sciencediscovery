"""Package validation.

Everything here runs before a byte is written to storage. The rules come from
the static exporter's contract (50 MiB cap, whole-file sha256, a manifest with
every entry's size and digest) plus the two rules a server must add because it
accepts uploads from users: refuse path traversal and refuse archives that
expand far beyond their compressed size.
"""

from __future__ import annotations

import hashlib
import io
import zipfile
from dataclasses import dataclass

MAX_ENTRIES = 5000


class PackageError(ValueError):
    """A package the service will not store."""


@dataclass(frozen=True)
class PackageInfo:
    sha256: str
    size: int
    manifest: list[dict]


def _safe_member(name: str) -> None:
    if not name or name.startswith("/") or name.startswith("\\"):
        raise PackageError(f"absolute path in package: {name!r}")
    if ".." in name.replace("\\", "/").split("/"):
        raise PackageError(f"path traversal in package: {name!r}")
    if "\\" in name:
        raise PackageError(f"backslash in package path: {name!r}")


def validate_package(data: bytes, *, max_bytes: int, max_uncompressed: int) -> PackageInfo:
    if not data:
        raise PackageError("the uploaded file is empty")
    if len(data) > max_bytes:
        raise PackageError(
            f"package is {len(data)} bytes; the limit is {max_bytes} bytes"
        )
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise PackageError("the uploaded file is not a zip archive") from exc

    entries = archive.infolist()
    if not entries:
        raise PackageError("the package has no files")
    if len(entries) > MAX_ENTRIES:
        raise PackageError(f"the package has {len(entries)} entries; the limit is {MAX_ENTRIES}")

    total = 0
    manifest: list[dict] = []
    seen: set[str] = set()
    for entry in entries:
        _safe_member(entry.filename)
        if entry.is_dir():
            continue
        if entry.filename in seen:
            raise PackageError(f"duplicate entry: {entry.filename}")
        seen.add(entry.filename)
        if entry.flag_bits & 0x1:
            raise PackageError(f"encrypted entry: {entry.filename}")
        total += entry.file_size
        if total > max_uncompressed:
            raise PackageError(
                f"package expands to more than {max_uncompressed} bytes"
            )
        digest = hashlib.sha256()
        with archive.open(entry) as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        manifest.append(
            {
                "path": entry.filename,
                "size": entry.file_size,
                "sha256": digest.hexdigest(),
            }
        )

    if not manifest:
        raise PackageError("the package has no files")
    manifest.sort(key=lambda item: item["path"])
    return PackageInfo(
        sha256=hashlib.sha256(data).hexdigest(),
        size=len(data),
        manifest=manifest,
    )


def read_member(data: bytes, name: str) -> bytes | None:
    """Read one entry for the Files tab, with the same traversal rules."""
    _safe_member(name)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for entry in archive.infolist():
            if entry.filename == name and not entry.is_dir():
                with archive.open(entry) as handle:
                    return handle.read()
    return None
