from __future__ import annotations


def parse_session_category(path: str | None) -> dict:
    """A session's category string, in the order the importer writes it.

    `source/task`, or `domain/source/task`; a single segment is a task. Both
    the import path and the API's create/update path use this, so the stored
    object and the tree never disagree about the same asset.
    """
    parts = [part for part in str(path or "").split("/") if part]
    if len(parts) >= 3:
        return {"domain": parts[0], "source": parts[1], "task": parts[2]}
    if len(parts) == 2:
        return {"source": parts[0], "task": parts[1]}
    if len(parts) == 1:
        return {"task": parts[0]}
    return {}


def parse_category_object(kind: str, path: str | None) -> dict:
    """The per-kind category object the site compiles against."""
    parts = [part for part in str(path or "").split("/") if part]
    if kind in ("skill", "team"):
        return {
            "domain": parts[0] if parts else "",
            "subdomain": parts[1] if len(parts) > 1 else "",
        }
    if kind == "connector":
        return {"function": parts[0] if parts else ""}
    if kind == "session":
        return parse_session_category(path)
    return {}
