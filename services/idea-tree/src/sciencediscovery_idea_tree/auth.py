"""Service credentials never double as user, model, or evolve credentials."""
import os
import secrets
from typing import Annotated

from fastapi import Header, HTTPException


def require_internal_token(authorization: Annotated[str | None, Header()] = None):
    expected = os.environ.get("SCIENCE_AGENT_IDEA_TREE_INTERNAL_TOKEN", "")
    if not expected or not secrets.compare_digest(authorization or "", f"Bearer {expected}"):
        raise HTTPException(401, "invalid idea-tree token")
