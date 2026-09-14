# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Domain-independent, read-only MCP bridge to an LLM Wiki REST API."""

from __future__ import annotations

import json
import os
from typing import Annotated, Any
from urllib.parse import quote, urlsplit

import httpx
from mcp.server.fastmcp import FastMCP
from pydantic import Field

SERVER = FastMCP("llm-wiki")


def _base_url() -> str:
    parts = urlsplit(os.environ.get("SCIENCE_AGENT_LLM_WIKI_URL") or "http://127.0.0.1:8100")
    if parts.scheme not in ("http", "https") or parts.username or parts.password \
            or parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ValueError("LLM Wiki URL must be an HTTP(S) origin without credentials or a path")
    return parts._replace(path="", query="", fragment="").geturl()


BASE_URL = _base_url()
MAX_RESPONSE_BYTES = 2_000_000


def _page_path(path: str) -> str:
    if (not 0 < len(path) <= 500 or any(c in path for c in "\\%?#:")
            or any(ord(c) < 32 for c in path)
            or any(part in {"", ".", ".."} for part in path.split("/"))):
        raise ValueError("Expected a relative Wiki page path")
    return path


async def _request(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
    token = os.environ.get("SCIENCE_AGENT_LLM_WIKI_TOKEN")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx.AsyncClient(timeout=55, follow_redirects=False, headers=headers) as client:
        async with client.stream(method, f"{BASE_URL}/api/v1/{path}", **kwargs) as response:
            response.raise_for_status()
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise ValueError("RESPONSE_TOO_LARGE: LLM Wiki response exceeds 2 MB")
            return json.loads(body)


@SERVER.tool()
async def search(
    query: Annotated[str, Field(min_length=1, max_length=500)],
    limit: Annotated[int, Field(ge=1, le=25)] = 5,
) -> dict[str, Any]:
    """Retrieve Wiki pages and source references without LLM answer generation."""
    return await _request("POST", "query/structured", json={
        "question": query, "top_k": limit, "mode": "hybrid",
    })


@SERVER.tool()
async def get_page(path: str) -> dict[str, Any]:
    """Read one Wiki page, including its original source references."""
    return await _request("GET", f"wiki/{quote(_page_path(path), safe='/')}")


@SERVER.tool()
async def get_pages(
    paths: Annotated[list[str], Field(min_length=1, max_length=20)],
    max_tokens: Annotated[int, Field(ge=100, le=16000)] = 8000,
) -> dict[str, Any]:
    """Read selected Wiki pages within a token budget and report omitted paths."""
    result = await _request("POST", "wiki/pages/batch", json={
        "paths": [_page_path(path) for path in paths],
        "max_tokens": max_tokens, "token_budget_enabled": True,
    })
    # Derive truncation from returned paths rather than the provider's budget flag.
    returned = {page["path"] for page in result["pages"]}
    missing = set(result["missing"])
    result["omitted_paths"] = [path for path in paths if path not in returned and path not in missing]
    result["truncated_by_budget"] = bool(result["omitted_paths"])
    return result


if __name__ == "__main__":
    SERVER.run(transport="stdio")
