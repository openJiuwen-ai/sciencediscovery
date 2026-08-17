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

"""Internal web search/fetch bridge for the Node control plane."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import time
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ._engine import (
    ResolvedWebProvider,
    invoke_isolated_web_provider,
    invoke_web_provider,
    resolve_web_provider,
)
from .internal_auth import require_internal_token
from .web_providers import invoke_ddgs_search, invoke_jina_reader

router = APIRouter(prefix="/internal/web", tags=["internal-web"])
MAX_TOOL_RESPONSE_BYTES = 1_000_000


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True)


class WebProviderOptions(WireModel):
    api_key: str | None = None
    backend: Literal["bing", "auto", "duckduckgo"] | None = None
    proxy: str | None = None
    proxy_environment: dict[str, str] | None = None
    proxy_mode: Literal["environment", "custom", "direct"] = "environment"


class WebInvokeRequest(WireModel):
    operation: Literal["search", "fetch"]
    provider: Literal["ddgs", "tavily", "exa", "brave", "jina"]
    arguments: dict[str, Any] = Field(default_factory=dict)
    options: WebProviderOptions = Field(default_factory=WebProviderOptions)
    timeout_ms: int = Field(default=30_000, ge=100, le=120_000)


class WebProviderAttempt(WireModel):
    duration_ms: int
    endpoint: str | None = None
    is_error: bool
    error_code: str | None = None
    error_message: str | None = None


class WebInvokeResponse(WireModel):
    attempts: list[WebProviderAttempt] | None = None
    content: str
    duration_ms: int
    is_error: bool
    error_code: str | None = None
    error_message: str | None = None


def _resolve_provider(req: WebInvokeRequest) -> ResolvedWebProvider:
    try:
        return resolve_web_provider(
            req.operation,
            req.provider,
            req.options.model_dump(exclude_none=True),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _error_code(exc: BaseException) -> str:
    message = str(exc).lower()
    if isinstance(exc, TimeoutError) or "timed out" in message or "timeout" in message:
        return "timeout"
    if "401" in message or "403" in message or "unauthor" in message or "forbidden" in message:
        return "unauthorized"
    if "429" in message or "rate limit" in message or "too many requests" in message:
        return "rate-limited"
    if any(token in message for token in ("500", "502", "503", "504", "server error")):
        return "server-error"
    if isinstance(exc, (ConnectionError, OSError)):
        return "transport-error"
    return "semantic-error"


def _semantic_error(content: str) -> bool:
    value = content.strip()
    if value.lower().startswith("error:"):
        return True
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError):
        return False
    return isinstance(decoded, dict) and bool(decoded.get("error"))


async def _validate_public_url(url: object) -> str:
    if not isinstance(url, str) or len(url) > 8_192:
        raise ValueError("url must be a string no longer than 8192 characters")
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("url must be a public http(s) URL without embedded credentials")
    if parsed.hostname.lower() == "localhost":
        raise ValueError("local and private network URLs are not allowed")
    try:
        literal = ipaddress.ip_address(parsed.hostname)
        addresses = [literal]
    except ValueError:
        loop = asyncio.get_running_loop()
        records = await loop.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
        addresses = [ipaddress.ip_address(record[4][0]) for record in records]
    if not addresses or any(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
        for address in addresses
    ):
        raise ValueError("local and private network URLs are not allowed")
    return url


@router.post(
    "/invoke",
    response_model=WebInvokeResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_internal_token)],
)
async def invoke_web(req: WebInvokeRequest) -> WebInvokeResponse:
    provider = _resolve_provider(req)

    arguments = dict(req.arguments)
    if req.operation == "search":
        query = arguments.get("query")
        if not isinstance(query, str) or not query.strip() or len(query) > 2_000:
            raise HTTPException(status_code=400, detail="query must be a non-empty string no longer than 2000 characters")
        arguments["query"] = query.strip()
    else:
        try:
            arguments["url"] = await _validate_public_url(arguments.get("url"))
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    started = time.monotonic()
    try:
        options = req.options.model_dump(exclude_none=True)
        if req.operation == "fetch" and req.provider == "jina":
            result = await invoke_jina_reader(arguments["url"], req.timeout_ms / 1000, options)
            attempts = [WebProviderAttempt.model_validate(attempt.__dict__) for attempt in result.attempts]
            content = result.content
            if result.is_error:
                return WebInvokeResponse(
                    attempts=attempts,
                    content="",
                    duration_ms=round((time.monotonic() - started) * 1000),
                    is_error=True,
                    error_code=result.error_code,
                    error_message=result.error_message,
                )
        elif req.operation == "search" and req.provider == "ddgs":
            max_results = arguments.get("max_results", 5)
            if not isinstance(max_results, int):
                raise ValueError("max_results must be an integer")
            content = await asyncio.wait_for(
                invoke_ddgs_search(arguments["query"], max_results, options),
                timeout=req.timeout_ms / 1000,
            )
            attempts = None
        elif provider.requires_isolation:
            content = await invoke_isolated_web_provider(
                provider,
                arguments,
                req.timeout_ms / 1000,
            )
            attempts = None
        else:
            content = await invoke_web_provider(provider, arguments, req.timeout_ms / 1000)
            attempts = None
        duration_ms = round((time.monotonic() - started) * 1000)
        if len(content.encode("utf-8")) > MAX_TOOL_RESPONSE_BYTES:
            return WebInvokeResponse(
                attempts=attempts,
                content="",
                duration_ms=duration_ms,
                is_error=True,
                error_code="semantic-error",
                error_message="Web provider response exceeded the 1 MB limit.",
            )
        is_error = _semantic_error(content)
        return WebInvokeResponse(
            attempts=attempts,
            content=content,
            duration_ms=duration_ms,
            is_error=is_error,
            error_code=_error_code(RuntimeError(content)) if is_error else None,
            error_message=content[:1_000] if is_error else None,
        )
    except Exception as exc:
        duration_ms = round((time.monotonic() - started) * 1000)
        error_code = _error_code(exc)
        return WebInvokeResponse(
            content="",
            duration_ms=duration_ms,
            is_error=True,
            error_code=error_code,
            error_message=f"{req.provider} provider failed: {error_code}",
        )
