from __future__ import annotations

import io
import zipfile


def make_zip(files: dict[str, bytes]) -> bytes:
    """A byte-stable archive.

    `writestr` stamps the current time into each entry unless it is given a
    `ZipInfo`, so two calls made a second apart produced different bytes and a
    test that compared an upload with a freshly built archive failed only when
    the two calls straddled a second boundary. A fixed timestamp keeps the
    helper deterministic.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, payload)
    return buffer.getvalue()
