"""All Idea Tree state lives under a dedicated, configurable service directory."""
import json
import os
import tempfile
from pathlib import Path


def data_root() -> Path:
    configured = os.environ.get("SCIENCE_AGENT_IDEA_TREE_DATA_DIR")
    root = os.environ.get("SCIENCE_DISCOVERY_DATA_DIR") or os.environ.get("SCIENCE_AGENT_DATA_DIR", ".sciencediscovery-data")
    return Path(configured) if configured else Path(root) / "idea-tree"


def save_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
            temporary = output.name
            json.dump(value, output, ensure_ascii=False, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
