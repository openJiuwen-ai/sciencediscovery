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

"""Gateway-owned DDGS and Jina web-provider implementations."""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from .external_urls import external_url_list

JINA_ENDPOINTS = external_url_list("web.jina_endpoints")


@dataclass(frozen=True)
class ProviderAttempt:
    duration_ms: int
    endpoint: str
    is_error: bool
    error_code: str | None = None
    error_message: str | None = None


@dataclass(frozen=True)
class JinaResult:
    attempts: list[ProviderAttempt]
    content: str
    error_code: str | None = None
    error_message: str | None = None

    @property
    def is_error(self) -> bool:
        return self.error_code is not None


def _proxy(options: dict[str, Any]) -> str | None:
    mode = options.get("proxy_mode", "environment")
    if mode == "custom":
        value = options.get("proxy")
        return value.strip() if isinstance(value, str) and value.strip() else None
    if mode == "environment":
        projected = options.get("proxy_environment")
        if isinstance(projected, dict):
            value = projected.get("HTTPS_PROXY") or projected.get("ALL_PROXY")
            return value.strip() if isinstance(value, str) and value.strip() else None
        # Match httpx/Node precedence exactly: a present lowercase variable
        # wins even when blank, and DDGS_PROXY is not a separate competing
        # configuration source after WebSearch joins the shared registry.
        # DDGS' search endpoints are HTTPS; HTTP_PROXY is intentionally not a
        # fallback, matching the target-aware Node/httpx resolver.
        for lower, upper in (("https_proxy", "HTTPS_PROXY"), ("all_proxy", "ALL_PROXY")):
            name = lower if lower in os.environ else upper if upper in os.environ else None
            if name is not None:
                value = os.environ[name].strip()
                return value or None
    return None


def _error_code(error: BaseException | None = None, status_code: int | None = None) -> str:
    if status_code in {401, 403}:
        return "unauthorized"
    if status_code == 429:
        return "rate-limited"
    if status_code is not None and status_code >= 500:
        return "server-error"
    if isinstance(error, (TimeoutError, httpx.TimeoutException)):
        return "timeout"
    if isinstance(error, (ConnectionError, OSError, httpx.TransportError)):
        return "transport-error"
    return "semantic-error"


def _jina_headers(options: dict[str, Any], timeout_seconds: float) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "X-Return-Format": "markdown",
        "X-Timeout": str(max(1, round(timeout_seconds))),
    }
    api_key = options.get("api_key")
    if isinstance(api_key, str) and api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"
    return headers


def _bypasses_proxy(url: str, no_proxy: str | None) -> bool:
    if not no_proxy:
        return False
    if no_proxy.strip() == "*":
        return True
    target = urlsplit(url)
    hostname = (target.hostname or "").lower()
    port = target.port or (443 if target.scheme == "https" else 80)
    for raw_entry in no_proxy.replace(",", " ").split():
        entry = raw_entry
        entry_port = 0
        if ":" in raw_entry and raw_entry.rsplit(":", 1)[1].isdigit():
            entry, raw_port = raw_entry.rsplit(":", 1)
            entry_port = int(raw_port)
        entry = entry.removeprefix("*.").removeprefix(".").lower()
        if entry_port and entry_port != port:
            continue
        if hostname == entry or hostname.endswith(f".{entry}"):
            return True
    return False


def _jina_client_options(options: dict[str, Any], endpoint: str) -> dict[str, Any]:
    proxy_mode = options.get("proxy_mode", "environment")
    if proxy_mode == "custom":
        return {"proxy": _proxy(options), "trust_env": False}
    if proxy_mode == "direct":
        return {"trust_env": False}
    proxy_environment = options.get("proxy_environment")
    if not isinstance(proxy_environment, dict):
        return {"trust_env": True}  # Legacy callers before the canonical snapshot wire.
    client_options: dict[str, Any] = {"trust_env": False}
    if not _bypasses_proxy(endpoint, proxy_environment.get("NO_PROXY")):
        proxy = proxy_environment.get("HTTPS_PROXY") or proxy_environment.get("ALL_PROXY")
        if proxy:
            client_options["proxy"] = proxy
    return client_options


async def invoke_jina_reader(
    url: str,
    timeout_seconds: float,
    options: dict[str, Any],
) -> JinaResult:
    attempts: list[ProviderAttempt] = []
    deadline = time.monotonic() + timeout_seconds

    for index, endpoint in enumerate(JINA_ENDPOINTS):
        async with httpx.AsyncClient(**_jina_client_options(options, endpoint)) as client:
            started = time.monotonic()
            try:
                routes_left = len(JINA_ENDPOINTS) - index
                attempt_timeout = max(0.1, (deadline - started) / routes_left)
                response = await client.post(
                    f"{endpoint}/",
                    headers=_jina_headers(options, timeout_seconds),
                    json={"url": url},
                    timeout=attempt_timeout,
                )
                duration_ms = round((time.monotonic() - started) * 1000)
                content = response.text.strip()
                if response.status_code == 200 and content:
                    attempts.append(ProviderAttempt(duration_ms, endpoint, False))
                    return JinaResult(attempts=attempts, content=content)

                code = _error_code(status_code=response.status_code)
                message = (
                    "Jina Reader returned an empty response"
                    if response.status_code == 200
                    else f"Jina Reader returned HTTP {response.status_code}"
                )
                attempts.append(ProviderAttempt(duration_ms, endpoint, True, code, message))
                if response.status_code in {401, 403} or (400 <= response.status_code < 500 and response.status_code != 429):
                    return JinaResult(attempts=attempts, content="", error_code=code, error_message=message)
            except Exception as exc:  # httpx exposes several transport-specific subclasses
                code = _error_code(exc)
                message = f"{type(exc).__name__}: {exc}"[:1_000]
                attempts.append(ProviderAttempt(
                    round((time.monotonic() - started) * 1000), endpoint, True, code, message,
                ))

    last = attempts[-1]
    return JinaResult(
        attempts=attempts,
        content="",
        error_code=last.error_code or "semantic-error",
        error_message=last.error_message or "Jina Reader failed",
    )


def _search(query: str, max_results: int, options: dict[str, Any]) -> str:
    from ddgs import DDGS

    backend = options.get("backend", "bing")
    if backend not in {"bing", "auto", "duckduckgo"}:
        raise ValueError("Unsupported DDGS backend")
    proxy_mode = options.get("proxy_mode", "environment")
    client = DDGS(proxy=_proxy(options), timeout=30)
    if proxy_mode == "direct":
        # DDGS otherwise reads DDGS_PROXY even when no explicit proxy is passed.
        client._proxy = None
    results = client.text(
        query,
        backend=backend,
        max_results=max(1, min(max_results, 10)),
        region="wt-wt",
        safesearch="moderate",
    )
    normalized = [
        {
            "title": item.get("title", ""),
            "url": item.get("href", item.get("link", "")),
            "content": item.get("body", item.get("snippet", "")),
        }
        for item in (results or [])
    ]
    if not normalized:
        raise RuntimeError("DDGS returned no results")
    return json.dumps(
        {"query": query, "total_results": len(normalized), "results": normalized},
        ensure_ascii=False,
        indent=2,
    )


async def invoke_ddgs_search(
    query: str,
    max_results: int,
    options: dict[str, Any],
) -> str:
    """Run the blocking DDGS client without blocking the Gateway event loop."""

    return await asyncio.to_thread(_search, query, max_results, options)
