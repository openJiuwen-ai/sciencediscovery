"""Persist the existing UI settings contract, including partial assessor updates."""
import json
import threading

from fastapi import APIRouter, Depends, HTTPException

from .auth import require_internal_token
from .storage import data_root, save_json

DEFAULTS = dict(templateId="scientific-hypothesis-general/v1", explorationIntensity="standard",
                maxRounds=3, candidatesPerRound=3, maxTokens=None, maxTokensPerCall=32768,
                maxDepth=5, maxNodes=100, maxSearchRounds=10, scoreDirection="maximize",
                assessorActivity={}, assessorStability={}, assessorSustainability={})
RANGES = dict(maxRounds=(1, 100), candidatesPerRound=(1, 20), maxTokensPerCall=(256, 32768),
              maxDepth=(1, 20), maxNodes=(2, 10000), maxSearchRounds=(1, 10000), maxTokens=(1, 9007199254740991))
ASSESSORS = ("assessorActivity", "assessorStability", "assessorSustainability")
PROMPTS = ("designSystemPrompt", "aggregatorSystemPrompt", "propagateInsightSystemPrompt")
_lock = threading.RLock()
router = APIRouter(dependencies=[Depends(require_internal_token)])


def normalize(update, current):
    result = json.loads(json.dumps(current))
    for key, (low, high) in RANGES.items():
        if key not in update:
            continue
        value = update[key]
        if key == "maxTokens" and value is None:
            result[key] = None
            continue
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high or int(value) != value:
            raise ValueError(f"{key} must be an integer between {low} and {high}")
        result[key] = int(value)
    for key in ("templateId", "explorationIntensity"):
        if update.get(key) is not None:
            result[key] = update[key]
    if update.get("scoreDirection") in ("maximize", "minimize"):
        result["scoreDirection"] = update["scoreDirection"]
    for key in PROMPTS:
        if key in update:
            value = update[key]
            if value is not None and not isinstance(value, str):
                raise ValueError(f"Invalid {key}")
            result.pop(key, None)
            if value and value.strip():
                result[key] = value.strip()
    for key in ASSESSORS:
        if key not in update:
            continue
        if update[key] is None:
            continue
        if not isinstance(update[key], dict):
            raise ValueError(f"Invalid {key}")
        cfg = dict(result[key])
        for field in ("systemPrompt", "scoringCriteria"):
            if field in update[key]:
                value = update[key][field]
                if value is not None and not isinstance(value, str):
                    raise ValueError(f"Invalid {field}")
                cfg.pop(field, None)
                if value and value.strip():
                    cfg[field] = value.strip()
        if "weight" in update[key]:
            weight = update[key]["weight"]
            if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not 0 <= weight <= 1:
                raise ValueError("weight must be between 0 and 1")
            cfg["weight"] = weight
        result[key] = cfg
    weights = [(update.get(key) or {}).get("weight") for key in ASSESSORS]
    if all(w is not None for w in weights) and abs(sum(weights) - 1) > .001:
        raise ValueError("Assessor weights must sum to 1.0")
    return result


def read_settings():
    with _lock:
        path = data_root() / "settings.json"
        return normalize(json.loads(path.read_text(encoding="utf-8")), DEFAULTS) if path.exists() else dict(DEFAULTS)


@router.get("/api/settings/idea-tree")
def get_settings():
    return read_settings()


@router.put("/api/settings/idea-tree")
def put_settings(update: dict):
    with _lock:
        try:
            value = normalize(update, read_settings())
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        save_json(data_root() / "settings.json", value)
        return value


@router.post("/settings/import")
def import_settings(update: dict):
    # Legacy catalog is a migration seed, never a second writer after import.
    with _lock:
        if not (data_root() / "settings.json").exists():
            return put_settings(update)
        return read_settings()
