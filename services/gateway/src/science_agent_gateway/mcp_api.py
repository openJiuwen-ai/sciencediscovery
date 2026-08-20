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

"""Internal MCP discovery and invocation API for the Node control plane."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import random
import sys
import time
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.encoders import jsonable_encoder
from langchain_core.messages import ToolMessage
from pydantic import BaseModel, ConfigDict, Field

from ._engine import (
    apply_mcp_proxy_overlay,
    get_mcp_tools,
    get_tool_routing,
    load_mcp_servers,
    replace_mcp_proxy_overlays,
    reset_mcp_tool_cache,
)
from .bootstrap_tokens import resolve_internal_token

router = APIRouter(prefix="/internal/mcp", tags=["internal-mcp"])

# Stdio MCP subprocesses must use the same environment as the gateway. The
# engine does not guarantee their cwd, so prefer a PATH-resolved interpreter over a
# repository-relative launcher or a machine-specific absolute path.
_python_bin_dir = os.path.dirname(sys.executable)
os.environ["PATH"] = os.pathsep.join([
    _python_bin_dir,
    *[entry for entry in os.environ.get("PATH", "").split(os.pathsep) if entry != _python_bin_dir],
])

# --- Per-server proxy environment injection -------------------------------
#
# The MCP Python SDK spawns stdio servers with an allowlisted environment
# (HOME/PATH/...) that drops every proxy variable. Node therefore sends each
# resolved policy and the internal adapter applies its environment overlay
# before connections are built. HTTP/SSE MCP proxying remains out of scope.

_PROXY_ENV_VARS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
)
_URL_PROXY_ENV_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")

def proxy_env_overlay(mode: str, url: str | None) -> dict[str, str]:
    """Environment variables that make a subprocess honour a resolved proxy.

    - direct: empty — the overlay application also strips any configured
      proxy variables, so spawning without them is a direct connection.
    - environment: forward the proxy variables of the gateway process.
    - url: point every proxy variable at the URL, keeping NO_PROXY exclusions.
    """
    if mode == "direct":
        return {}
    if mode == "environment":
        return {name: value for name in _PROXY_ENV_VARS if (value := os.environ.get(name))}
    if not url:
        raise HTTPException(status_code=400, detail="Proxy mode 'url' requires a proxy URL")
    overlay: dict[str, str] = {name: url for name in _URL_PROXY_ENV_VARS}
    for name in ("NO_PROXY", "no_proxy"):
        value = os.environ.get(name)
        if value:
            overlay[name] = value
    return overlay


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True)


class RetryPolicy(WireModel):
    initial_delay_ms: int = Field(default=500, ge=0, le=60_000)
    jitter_ratio: float = Field(default=0.2, ge=0, le=1)
    max_attempts: int = Field(default=3, ge=1, le=5)
    max_delay_ms: int = Field(default=10_000, ge=0, le=120_000)
    multiplier: float = Field(default=2, ge=1, le=10)
    respect_retry_after: bool = True
    retry_on: list[Literal["transport-error", "timeout", "rate-limited", "server-error"]] = Field(default_factory=list)


class InvokeContext(WireModel):
    project_id: str
    session_id: str
    tool_call_id: str
    turn_id: str


class ExecutionPolicy(WireModel):
    max_response_bytes: int = Field(default=5_000_000, ge=1_024, le=100_000_000)
    retry_policy: RetryPolicy = Field(default_factory=RetryPolicy)
    timeout_ms: int = Field(default=30_000, ge=100, le=240_000)


class ResolvedProxySpec(WireModel):
    mode: Literal["direct", "environment", "url"]
    url: str | None = None


class InvokeRequest(WireModel):
    arguments: dict[str, Any] = Field(default_factory=dict)
    context: InvokeContext
    execution: ExecutionPolicy = Field(default_factory=ExecutionPolicy)
    proxy: ResolvedProxySpec | None = None
    request_id: str
    server_id: str
    tool_name: str


class ReloadRequest(WireModel):
    proxies: dict[str, ResolvedProxySpec] | None = None


class Attempt(WireModel):
    attempt: int
    duration_ms: int
    error_code: str | None = None
    error_message: str | None = None
    finished_at: str
    retry_after_ms: int | None = None
    started_at: str
    status: Literal["rate-limited", "semantic-error", "server-error", "succeeded", "timeout", "transport-error"]


class InvokeResponse(WireModel):
    attempts: list[Attempt]
    content: list[dict[str, Any]]
    duration_ms: int
    is_error: bool
    request_id: str
    server_id: str
    structured_content: Any | None = None
    tool_name: str


class CatalogTool(WireModel):
    annotations: dict[str, Any] | None = None
    description: str
    input_schema: dict[str, Any]
    name: str
    schema_hash: str


class CatalogServer(WireModel):
    description: str | None = None
    enabled: bool
    id: str
    tools: list[CatalogTool]
    transport: Literal["http", "sse", "stdio"]


class CatalogResponse(WireModel):
    loaded_at: str
    revision: str
    servers: list[CatalogServer]


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _internal_token() -> str:
    return resolve_internal_token()


def require_internal_token(authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {_internal_token()}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Invalid gateway internal token")


def _schema_for(tool: Any) -> dict[str, Any]:
    schema = getattr(tool, "args_schema", None)
    if isinstance(schema, dict):
        return schema
    if schema is not None and hasattr(schema, "model_json_schema"):
        return schema.model_json_schema()
    try:
        resolved = tool.get_input_schema()
        return resolved.model_json_schema()
    except Exception:
        return {"properties": {}, "type": "object"}


def _server_for_bound_tool(bound_name: str, server_names: list[str]) -> tuple[str, str] | None:
    for server_name in sorted(server_names, key=len, reverse=True):
        prefix = f"{server_name}_"
        if bound_name.startswith(prefix):
            return server_name, bound_name[len(prefix) :]
    return None


def _catalog_payload() -> CatalogResponse:
    enabled_servers = {
        name: server
        for name, server in load_mcp_servers().items()
        if server.enabled
    }
    tools_by_server: dict[str, list[CatalogTool]] = {name: [] for name in enabled_servers}

    for tool in get_mcp_tools():
        resolved = _server_for_bound_tool(tool.name, list(enabled_servers))
        if resolved is None:
            continue
        server_name, original_name = resolved
        input_schema = _schema_for(tool)
        schema_hash = hashlib.sha256(
            json.dumps(input_schema, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        ).hexdigest()
        routing = get_tool_routing(tool)
        tools_by_server[server_name].append(
            CatalogTool(
                annotations={"routing": routing} if routing else None,
                description=tool.description or original_name,
                input_schema=input_schema,
                name=original_name,
                schema_hash=schema_hash,
            )
        )

    servers = [
        CatalogServer(
            description=server.description or None,
            enabled=True,
            id=name,
            tools=sorted(tools_by_server[name], key=lambda item: item.name),
            transport=server.transport if server.transport in {"http", "sse", "stdio"} else "stdio",
        )
        for name, server in sorted(enabled_servers.items())
    ]
    revision_input = [server.model_dump(mode="json", by_alias=True) for server in servers]
    revision = hashlib.sha256(
        json.dumps(revision_input, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    return CatalogResponse(loaded_at=_utc_now(), revision=revision, servers=servers)


@router.get("/catalog", response_model=CatalogResponse, dependencies=[Depends(require_internal_token)])
async def catalog() -> CatalogResponse:
    return await asyncio.to_thread(_catalog_payload)


@router.post("/reload", response_model=CatalogResponse, dependencies=[Depends(require_internal_token)])
async def reload_catalog(payload: ReloadRequest | None = None) -> CatalogResponse:
    if payload is not None and payload.proxies is not None:
        replace_mcp_proxy_overlays({
            server_id: proxy_env_overlay(proxy.mode, proxy.url)
            for server_id, proxy in payload.proxies.items()
        })
    else:
        reset_mcp_tool_cache()
    return await asyncio.to_thread(_catalog_payload)


def _parse_retry_after_ms(lowered: str) -> int | None:
    """Extract the value following a retry-after token.

    Anchoring on the token matters: scanning the whole message for the first
    number would happily read the status code ("429") as a 429s retry delay.
    """
    tokens = lowered.replace("=", " ").replace(":", " ").split()
    for index, token in enumerate(tokens):
        if "retry-after" not in token and "retry_after" not in token:
            continue
        for candidate in tokens[index + 1:index + 3]:
            try:
                return max(0, int(float(candidate.strip("()[]{},;'\"")) * 1_000))
            except ValueError:
                continue
    return None


def _classify_error(error: Exception) -> tuple[str, str, int | None]:
    message = str(error) or error.__class__.__name__
    lowered = message.lower()
    retry_after_ms = _parse_retry_after_ms(lowered)
    if isinstance(error, TimeoutError) or "timed out" in lowered or "timeout" in lowered:
        return "timeout", message, retry_after_ms
    if "429" in lowered or "rate limit" in lowered or "too many requests" in lowered:
        return "rate-limited", message, retry_after_ms
    if any(marker in lowered for marker in ("connection", "transport", "network", "broken pipe", "reset by peer")):
        return "transport-error", message, retry_after_ms
    if any(marker in lowered for marker in (" 500", " 502", " 503", " 504", "server error", "service unavailable")):
        return "server-error", message, retry_after_ms
    return "semantic-error", message, retry_after_ms


def _content_blocks(value: Any) -> tuple[list[dict[str, Any]], Any | None]:
    artifact: Any | None = None
    if isinstance(value, ToolMessage):
        artifact = value.artifact
        value = value.content
    elif isinstance(value, tuple) and len(value) == 2:
        value, artifact = value

    if isinstance(value, str):
        blocks = [{"type": "text", "text": value}]
    elif isinstance(value, list):
        blocks = []
        for item in value:
            encoded = jsonable_encoder(item)
            if isinstance(encoded, dict) and encoded.get("type") == "text":
                blocks.append({"type": "text", "text": str(encoded.get("text", ""))})
            elif isinstance(encoded, dict) and encoded.get("url"):
                blocks.append({
                    "type": "resource",
                    "uri": str(encoded["url"]),
                    **({"mimeType": encoded["mime_type"]} if encoded.get("mime_type") else {}),
                })
            else:
                blocks.append({"type": "json", "value": encoded})
    else:
        blocks = [{"type": "json", "value": jsonable_encoder(value)}]

    structured = None
    if isinstance(artifact, dict):
        structured = artifact.get("structured_content")
    return blocks, jsonable_encoder(structured)


async def _invoke_with_retry(request: InvokeRequest) -> InvokeResponse:
    started = time.monotonic()
    if request.proxy is not None:
        # Self-healing: a proxy change (or a gateway restart that lost the
        # overlays) reconnects the server under the requested environment.
        apply_mcp_proxy_overlay(request.server_id, proxy_env_overlay(request.proxy.mode, request.proxy.url))
    tools = {tool.name: tool for tool in get_mcp_tools()}
    bound_name = f"{request.server_id}_{request.tool_name}"
    tool = tools.get(bound_name)
    if tool is None:
        raise HTTPException(status_code=404, detail=f"Unknown MCP tool: {request.server_id}/{request.tool_name}")

    policy = request.execution.retry_policy
    deadline = started + request.execution.timeout_ms / 1_000
    attempts: list[Attempt] = []
    final_error = "MCP tool failed"

    for attempt_number in range(1, policy.max_attempts + 1):
        attempt_started_at = _utc_now()
        attempt_started = time.monotonic()
        remaining = deadline - attempt_started
        if remaining <= 0:
            error = TimeoutError("MCP invocation deadline exceeded")
            status, final_error, retry_after_ms = _classify_error(error)
        else:
            try:
                config = {
                    "configurable": {"thread_id": request.context.session_id},
                    "metadata": {
                        "project_id": request.context.project_id,
                        "session_id": request.context.session_id,
                        "tool_call_id": request.context.tool_call_id,
                        "turn_id": request.context.turn_id,
                    },
                }
                value = await asyncio.wait_for(
                    tool.ainvoke(request.arguments, config=config),
                    timeout=remaining,
                )
                content, structured = _content_blocks(value)
                response_bytes = len(json.dumps(
                    {"content": content, "structuredContent": structured},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8"))
                if response_bytes > request.execution.max_response_bytes:
                    raise ValueError(
                        f"RESPONSE_TOO_LARGE: MCP response used {response_bytes} bytes; "
                        f"limit is {request.execution.max_response_bytes}"
                    )
                attempts.append(Attempt(
                    attempt=attempt_number,
                    duration_ms=round((time.monotonic() - attempt_started) * 1_000),
                    finished_at=_utc_now(),
                    started_at=attempt_started_at,
                    status="succeeded",
                ))
                return InvokeResponse(
                    attempts=attempts,
                    content=content,
                    duration_ms=round((time.monotonic() - started) * 1_000),
                    is_error=False,
                    request_id=request.request_id,
                    server_id=request.server_id,
                    structured_content=structured,
                    tool_name=request.tool_name,
                )
            except Exception as error:
                status, final_error, retry_after_ms = _classify_error(error)

        attempts.append(Attempt(
            attempt=attempt_number,
            duration_ms=round((time.monotonic() - attempt_started) * 1_000),
            error_code=(
                "RESPONSE_TOO_LARGE" if final_error.startswith("RESPONSE_TOO_LARGE:")
                else "UNAUTHORIZED" if "401" in final_error or "unauthorized" in final_error.lower()
                else "NOT_FOUND" if "404" in final_error or "not found" in final_error.lower()
                else status.upper().replace("-", "_")
            ),
            error_message=final_error[:1_000],
            finished_at=_utc_now(),
            retry_after_ms=retry_after_ms,
            started_at=attempt_started_at,
            status=status,
        ))
        retryable = status in policy.retry_on and attempt_number < policy.max_attempts
        if not retryable:
            break
        exponential = min(
            policy.max_delay_ms,
            policy.initial_delay_ms * policy.multiplier ** (attempt_number - 1),
        )
        delay_ms = retry_after_ms if policy.respect_retry_after and retry_after_ms is not None else exponential
        delay_ms *= 1 + random.uniform(-policy.jitter_ratio, policy.jitter_ratio)
        remaining_ms = max(0, (deadline - time.monotonic()) * 1_000)
        if delay_ms <= 0 or delay_ms >= remaining_ms:
            break
        await asyncio.sleep(delay_ms / 1_000)

    return InvokeResponse(
        attempts=attempts,
        content=[{"type": "text", "text": final_error[:1_000]}],
        duration_ms=round((time.monotonic() - started) * 1_000),
        is_error=True,
        request_id=request.request_id,
        server_id=request.server_id,
        tool_name=request.tool_name,
    )


@router.post("/invoke", response_model=InvokeResponse, dependencies=[Depends(require_internal_token)])
async def invoke(request: InvokeRequest) -> InvokeResponse:
    return await _invoke_with_retry(request)
