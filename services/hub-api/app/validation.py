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
    try:
        is_tar = data[:2] == b"\x1f\x8b" or tarfile.is_tarfile(io.BytesIO(data))
    except (tarfile.TarError, EOFError) as exc:
        raise PackageError("the uploaded file is not a readable archive") from exc
    if is_tar:
        try:
            archive = tarfile.open(fileobj=io.BytesIO(data), mode="r:*")
        except (tarfile.TarError, EOFError) as exc:
            raise PackageError("the uploaded file is not a readable archive") from exc
        with archive:
            # Iterate, don't materialise: `getmembers()` builds the whole
            # TarInfo list before the entry cap is consulted.
            count = 0
            try:
                for member in archive:
                    count += 1
                    if count > MAX_ENTRIES:
                        raise PackageError(
                            f"the package has more than {MAX_ENTRIES} entries"
                        )
                    _safe_member(member.name)
                    if member.isdir():
                        continue
                    if not member.isfile():
                        raise PackageError(f"non-regular entry: {member.name!r}")
                    handle = archive.extractfile(member)
                    if handle is None:
                        raise PackageError(f"unreadable entry: {member.name!r}")
                    yield member.name, member.size, handle
            except (tarfile.TarError, EOFError) as exc:
                raise PackageError("the uploaded file is not a readable archive") from exc
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


def _iter_tar(archive):
    count = 0
    try:
        for member in archive:
            count += 1
            if count > MAX_ENTRIES:
                raise PackageError(f"the package has more than {MAX_ENTRIES} entries")
            _safe_member(member.name)
            if member.isdir():
                continue
            if not member.isfile():
                raise PackageError(f"non-regular entry: {member.name!r}")
            handle = archive.extractfile(member)
            if handle is None:
                raise PackageError(f"unreadable entry: {member.name!r}")
            yield member.name, member.size, handle
    except (tarfile.TarError, EOFError) as exc:
        raise PackageError("the archive is not readable") from exc


def _iter_zip(archive):
    for entry in archive.infolist():
        _safe_member(entry.filename)
        if entry.is_dir():
            continue
        if entry.flag_bits & 0x1:
            raise PackageError(f"encrypted entry: {entry.filename}")
        with archive.open(entry) as handle:
            yield entry.filename, entry.file_size, handle


def _manifest(entries, *, max_uncompressed: int) -> list[dict]:
    total = 0
    manifest: list[dict] = []
    seen: set[str] = set()
    for name, size, handle in entries:
        if name in seen:
            raise PackageError(f"duplicate entry: {name}")
        seen.add(name)
        total += size
        if total > max_uncompressed:
            raise PackageError(f"package expands to more than {max_uncompressed} bytes")
        digest = hashlib.sha256()
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        manifest.append({"path": name, "size": size, "sha256": digest.hexdigest()})
    manifest.sort(key=lambda item: item["path"])
    return manifest


def validate_package_file(fileobj, *, max_bytes: int, max_uncompressed: int) -> PackageInfo:
    """Validate a package from a seekable file, without loading it into memory.

    The caller streams the upload to this file and hashes it on the way; the
    size comes from that count. The archive is read twice (headers and entry
    payloads), so a spilled temporary file is the intended input.
    """
    fileobj.seek(0)
    head = fileobj.read(2)
    fileobj.seek(0)
    size = fileobj.seek(0, io.SEEK_END)
    fileobj.seek(0)
    if size > max_bytes:
        raise PackageError(f"package is {size} bytes; the limit is {max_bytes} bytes")
    if head == b"PK":
        with zipfile.ZipFile(fileobj) as archive:
            manifest = _manifest(_iter_zip(archive), max_uncompressed=max_uncompressed)
    else:
        try:
            archive = tarfile.open(fileobj=fileobj, mode="r:*")
        except (tarfile.TarError, EOFError) as exc:
            raise PackageError("the uploaded file is not a zip or tar archive") from exc
        with archive:
            manifest = _manifest(_iter_tar(archive), max_uncompressed=max_uncompressed)
    if not manifest:
        raise PackageError("the package has no files")
    return PackageInfo(sha256="", size=size, manifest=manifest)


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
    try:
        is_tar = data[:2] == b"\x1f\x8b" or tarfile.is_tarfile(io.BytesIO(data))
    except (tarfile.TarError, EOFError) as exc:
        raise PackageError("the stored package is not a readable archive") from exc
    if is_tar:
        try:
            archive = tarfile.open(fileobj=io.BytesIO(data), mode="r:*")
        except (tarfile.TarError, EOFError) as exc:
            raise PackageError("the stored package is not a readable archive") from exc
        with archive:
            count = 0
            try:
                for entry in archive:
                    count += 1
                    if count > MAX_ENTRIES:
                        raise PackageError(
                            f"the package has more than {MAX_ENTRIES} entries"
                        )
                    if entry.name == name and entry.isfile():
                        if entry.size > max_bytes:
                            raise PackageError("file is too large to preview")
                        handle = archive.extractfile(entry)
                        return handle.read() if handle else None
            except (tarfile.TarError, EOFError) as exc:
                raise PackageError("the stored package is not a readable archive") from exc
        return None

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for entry in archive.infolist():
            if entry.filename == name and not entry.is_dir():
                if entry.file_size > max_bytes:
                    raise PackageError("file is too large to preview")
                with archive.open(entry) as handle:
                    return handle.read()
    return None
