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

"""One MCP server (streamable HTTP, JSON-RPC) for the tools of every run.

A run's toolset is the tools the legacy API would have given its native agent for that run. JiuwenSwarm knows
one server, `sci`, whose tool list is every tool any run has brought; so a tool has the same name in every run
(`mcp_sci_<name>`), which JiuwenSwarm's permission policy can name. JiuwenSwarm's MCP client says nothing about
the session a call comes from, so the adapter's model proxy, which is per run, puts the run's tag in each call
(`RUN_ARG`); a call goes to that run's toolset and its callback, which executes the legacy closure. Stateless on
purpose: no session ids, no server-sent stream.
"""

from __future__ import annotations

import logging
import time
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from .schema import open_schema, restore_dropped_empties

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = "2025-03-26"

# The argument that names the run a call belongs to. The model never sees it: the proxy adds it to each call.
RUN_ARG = "_sd_run"
SERVER_NAME = "sci"

# (tool name, arguments) -> (text, is_error)
ToolCall = Callable[[str, dict[str, Any]], Awaitable[tuple[str, bool]]]


@dataclass
class Toolset:
    tools: list[dict[str, Any]]  # {name, description, inputSchema}
    call: ToolCall


@dataclass
class ToolsetRegistry:
    """Live toolsets by run tag, and the one tool list JiuwenSwarm is given for all of them.

    `token` is the capability in the server's URL; JiuwenSwarm is the only one told it.
    """

    _sets: dict[str, Toolset] = field(default_factory=dict)
    token: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    # Every tool a run has brought, as JiuwenSwarm is given it: one entry per name. Runs can give one tool different
    # schemas (an enum of this session's skills or Runners), so what JiuwenSwarm holds is open: the properties seen so
    # far, with no enum and nothing required. The model gets the run's own schema (the proxy), and the run's tool
    # checks the arguments itself.
    shared: dict[str, dict[str, Any]] = field(default_factory=dict)

    def add(self, toolset: Toolset) -> str:
        tag = secrets.token_hex(8)
        self._sets[tag] = toolset
        return tag

    def get(self, tag: str) -> Toolset | None:
        return self._sets.get(tag)

    def remove(self, tag: str) -> None:
        self._sets.pop(tag, None)

    def merge(self, tools: list[dict[str, Any]]) -> bool:
        """Add a run's tools to the shared list; True when JiuwenSwarm has to be given the list again."""
        changed = False
        for tool in tools:
            name = tool["name"]
            schema = open_schema(tool.get("inputSchema") or {})
            known = self.shared.get(name)
            properties = {**((known or {}).get("inputSchema", {}).get("properties") or {}), **(schema.get("properties") or {})}
            properties[RUN_ARG] = {"type": "string", "description": "Set by the runtime."}
            merged = {"name": name, "description": (known or tool).get("description", ""),
                      "inputSchema": {**schema, "type": "object", "properties": properties}}
            if known is None or set(properties) != set(known["inputSchema"]["properties"]):
                self.shared[name] = merged
                changed = True
        return changed


def _result(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


async def handle_rpc(registry: ToolsetRegistry, message: dict[str, Any]) -> dict[str, Any] | None:
    """Answer one JSON-RPC message; `None` for a notification."""
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}
    if request_id is None:
        return None  # notifications/initialized, notifications/cancelled, ...
    if method == "initialize":
        return _result(request_id, {
            "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": "0.0.0"},
        })
    if method == "ping":
        return _result(request_id, {})
    if method == "tools/list":
        return _result(request_id, {"tools": list(registry.shared.values())})
    if method == "tools/call":
        name = params.get("name")
        arguments = dict(params.get("arguments") or {})
        tag = arguments.pop(RUN_ARG, None)
        toolset = registry.get(tag) if isinstance(tag, str) else None
        if toolset is None:
            logger.warning("tools/call %r: run tag %r is not live (ended, or not a run's own call)", name, tag)
            text = "This tool call belongs to no running run (it has ended, or the call was not made by its model)."
            return _result(request_id, {"content": [{"type": "text", "text": text}], "isError": True})
        tool = next((t for t in toolset.tools if t["name"] == name), None)
        if tool is None:
            logger.warning(
                "tools/call %r: not one of run %r's tools (it has %s)",
                name, tag, sorted(t["name"] for t in toolset.tools),
            )
            return _result(request_id, {"content": [{"type": "text", "text": f"{name} is not one of this run's tools"}], "isError": True})
        arguments = restore_dropped_empties(tool.get("inputSchema") or {}, arguments)
        started = time.monotonic()
        logger.info("tool bridge start: tool=%s request=%s run=%s", name, request_id, tag)
        try:
            text, is_error = await toolset.call(str(name), arguments)
        except Exception as error:  # the callback is another process; surface, don't crash the run
            logger.exception("tools/call %r (run %r) failed", name, tag)
            text, is_error = f"tool bridge failed: {type(error).__name__}: {error}", True
        if is_error:
            logger.warning("tools/call %r (run %r) returned isError: %s", name, tag, text[:500])
        logger.info("tool bridge return: tool=%s request=%s run=%s error=%s elapsed=%.3fs",
                    name, request_id, tag, is_error, time.monotonic() - started)
        return _result(request_id, {"content": [{"type": "text", "text": text}], "isError": is_error})
    return _error(request_id, -32601, f"method not found: {method}")


def mcp_router(registry: ToolsetRegistry) -> APIRouter:
    router = APIRouter()

    @router.post("/mcp/{token}")
    async def post(token: str, request: Request) -> Response:
        if not secrets.compare_digest(token, registry.token):
            return JSONResponse({"error": "unknown toolset"}, status_code=404)
        body = await request.json()
        if isinstance(body, list):  # a JSON-RPC batch
            replies = [r for r in [await handle_rpc(registry, m) for m in body] if r is not None]
            return JSONResponse(replies) if replies else Response(status_code=202)
        reply = await handle_rpc(registry, body)
        return JSONResponse(reply) if reply is not None else Response(status_code=202)

    @router.get("/mcp/{token}")
    async def get(token: str) -> Response:
        # No server-initiated stream: the spec allows refusing it.
        return Response(status_code=405, headers={"allow": "POST, DELETE"})

    @router.delete("/mcp/{token}")
    async def delete(token: str) -> Response:
        return Response(status_code=200)

    return router
