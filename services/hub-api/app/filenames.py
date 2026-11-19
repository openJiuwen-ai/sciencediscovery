from __future__ import annotations

from urllib.parse import quote


def content_disposition(filename: str) -> str:
    """A Content-Disposition value that survives any filename.

    The filename comes from a multipart upload, so it may contain quotes, line
    breaks or non-ASCII text. Starlette encodes header values as latin-1, and a
    UTF-8 name would raise while sending the response, so the header carries an
    ASCII fallback plus RFC 5987's `filename*` form.
    """
    cleaned = (
        filename.replace("\\", "_")
        .replace('"', "")
        .replace("\r", "")
        .replace("\n", "")
    ) or "download"
    ascii_name = cleaned.encode("ascii", "ignore").decode("ascii").strip() or "download"
    if ascii_name == cleaned:
        return f'attachment; filename="{ascii_name}"'
    return (
        f'attachment; filename="{ascii_name}"; '
        f"filename*=UTF-8''{quote(cleaned, safe='')}"
    )
