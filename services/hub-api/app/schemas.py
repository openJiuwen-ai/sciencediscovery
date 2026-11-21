from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    password: str = Field(min_length=8, max_length=256)
    display_name: str = Field(default="", max_length=128)


class LoginRequest(BaseModel):
    username: str
    password: str


class CreateAssetRequest(BaseModel):
    kind: Literal["skill", "team", "specialist", "connector", "session"]
    name: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    display_name: str = Field(min_length=1, max_length=128)
    summary: str = Field(default="", max_length=4096)
    description: str = Field(default="", max_length=200_000)
    category: str | None = Field(default=None, max_length=64)
    tags: list[str] = Field(default_factory=list)
    visibility: Literal["public", "private"] = "public"


class UpdateAssetRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=128)
    summary: str | None = Field(default=None, max_length=4096)
    description: str | None = Field(default=None, max_length=200_000)
    category: str | None = Field(default=None, max_length=64)
    tags: list[str] | None = None
    visibility: Literal["public", "private"] | None = None


class ReviewRequest(BaseModel):
    decision: Literal["approve", "reject"]
    reason: str = Field(default="", max_length=4096)
