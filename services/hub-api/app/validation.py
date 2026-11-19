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
import tarfile
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


def _entries(data: bytes):
    """Yield `(name, size, handle)` for the regular files in a package.

    Two containers are accepted: a zip (the exporter's archives) and the
    gzip'd tar the product writes for `.sdresearch`. Both are untrusted, so the
    same rules apply to each: no absolute paths, no `..`, no backslashes, no
    duplicates, and regular files only — a tar can also carry symlinks, hard
    links and devices, none of which a package should contain.
    """
    if data[:2] == b"\x1f\x8b" or tarfile.is_tarfile(io.BytesIO(data)):
        try:
            archive = tarfile.open(fileobj=io.BytesIO(data), mode="r:*")
        except tarfile.TarError as exc:
            raise PackageError("the uploaded file is not a readable archive") from exc
        with archive:
            for member in archive.getmembers():
                if member.isdir():
                    continue
                if not member.isfile():
                    raise PackageError(f"non-regular entry: {member.name!r}")
                _safe_member(member.name)
                handle = archive.extractfile(member)
                if handle is None:
                    raise PackageError(f"unreadable entry: {member.name!r}")
                yield member.name, member.size, handle
        return

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise PackageError("the uploaded file is not a zip or tar archive") from exc
    with archive:
        for entry in archive.infolist():
            _safe_member(entry.filename)
            if entry.is_dir():
                continue
            if entry.flag_bits & 0x1:
                raise PackageError(f"encrypted entry: {entry.filename}")
            with archive.open(entry) as handle:
                yield entry.filename, entry.file_size, handle


def validate_package(data: bytes, *, max_bytes: int, max_uncompressed: int) -> PackageInfo:
    if not data:
        raise PackageError("the uploaded file is empty")
    if len(data) > max_bytes:
        raise PackageError(
            f"package is {len(data)} bytes; the limit is {max_bytes} bytes"
        )

    total = 0
    count = 0
    manifest: list[dict] = []
    seen: set[str] = set()
    for name, size, handle in _entries(data):
        count += 1
        if count > MAX_ENTRIES:
            raise PackageError(
                f"the package has more than {MAX_ENTRIES} entries"
            )
        if name in seen:
            raise PackageError(f"duplicate entry: {name}")
        seen.add(name)
        total += size
        if total > max_uncompressed:
            raise PackageError(
                f"package expands to more than {max_uncompressed} bytes"
            )
        digest = hashlib.sha256()
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        manifest.append({"path": name, "size": size, "sha256": digest.hexdigest()})

    if not manifest:
        raise PackageError("the package has no files")
    manifest.sort(key=lambda item: item["path"])
    return PackageInfo(
        sha256=hashlib.sha256(data).hexdigest(),
        size=len(data),
        manifest=manifest,
    )


def read_member(data: bytes, name: str, *, max_bytes: int = 2 * 1024 * 1024) -> bytes | None:
    """Read one entry for the Files tab, with the same traversal rules and a cap."""
    _safe_member(name)
    if data[:2] == b"\x1f\x8b" or tarfile.is_tarfile(io.BytesIO(data)):
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
            for entry in archive.getmembers():
                if entry.name == name and entry.isfile():
                    if entry.size > max_bytes:
                        raise PackageError("file is too large to preview")
                    handle = archive.extractfile(entry)
                    return handle.read() if handle else None
        return None
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for entry in archive.infolist():
            if entry.filename == name and not entry.is_dir():
                if entry.file_size > max_bytes:
                    raise PackageError("file is too large to preview")
                with archive.open(entry) as handle:
                    return handle.read()
    return None
