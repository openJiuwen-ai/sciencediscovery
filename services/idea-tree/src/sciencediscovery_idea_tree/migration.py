"""One-time copy of legacy JSON records. Originals remain available for rollback."""
import json
import os
import re
from pathlib import Path

from .storage import data_root, save_json


def migrate_legacy():
    root = data_root()
    marker = root / "legacy-import.json"
    if marker.exists():
        return
    source = Path(os.environ.get("SCIENCE_AGENT_IDEA_TREE_LEGACY_DATA_DIR") or
                  os.environ.get("SCIENCE_DISCOVERY_DATA_DIR") or
                  os.environ.get("SCIENCE_AGENT_DATA_DIR", ".sciencediscovery-data"))
    count = 0
    for name in ("idea-trees", "idea-research"):
        legacy = source / name
        if not legacy.exists() or legacy.resolve() == (root / name).resolve():
            continue
        for path in legacy.glob("*/*/*.json"):
            relative = path.relative_to(legacy)
            if path.is_symlink() or any(not re.fullmatch(r"[A-Za-z0-9_.-]+", p) for p in relative.parts):
                raise ValueError("Invalid legacy Idea Tree record path")
            value = json.loads(path.read_text(encoding="utf-8"))
            destination = root / name / relative
            if destination.exists():
                # A previous interrupted import may already have copied this record.
                if json.loads(destination.read_text(encoding="utf-8")) != value:
                    raise ValueError(f"Conflicting legacy Idea Tree record: {relative}")
            else:
                save_json(destination, value)
                count += 1
    save_json(marker, dict(version=1, copied=count))
