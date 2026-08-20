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

"""MCP discovery, cache, and metadata seams owned by the engine adapter."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from deerflow.config.extensions_config import ExtensionsConfig
from deerflow.mcp.cache import get_cached_mcp_tools, reset_mcp_tools_cache
from deerflow.tools.mcp_metadata import (
    get_mcp_routing,
    is_mcp_tool,
    tag_mcp_routing,
    tag_mcp_tool,
)

_PROXY_ENV_VARS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
)
_proxy_env_overlays: dict[str, dict[str, str]] = {}
_original_extensions_from_file = ExtensionsConfig.from_file.__func__


def _from_file_with_proxy_overlays(cls, config_path: str | None = None) -> ExtensionsConfig:
    config = _original_extensions_from_file(cls, config_path)
    for name, server in config.mcp_servers.items():
        overlay = _proxy_env_overlays.get(name)
        if overlay is None or (server.type or "stdio") != "stdio":
            continue
        env = {key: value for key, value in (server.env or {}).items() if key not in _PROXY_ENV_VARS}
        env.update(overlay)
        server.env = env
    return config


ExtensionsConfig.from_file = classmethod(_from_file_with_proxy_overlays)


@dataclass(frozen=True)
class McpServerDefinition:
    description: str | None
    enabled: bool
    transport: str


def load_mcp_servers() -> dict[str, McpServerDefinition]:
    config = ExtensionsConfig.from_file()
    return {
        name: McpServerDefinition(
            description=server.description or None,
            enabled=server.enabled,
            transport=server.type,
        )
        for name, server in config.mcp_servers.items()
    }


def get_mcp_tools() -> list[Any]:
    return list(get_cached_mcp_tools())


def reset_mcp_tool_cache() -> None:
    reset_mcp_tools_cache()


def apply_mcp_proxy_overlay(server_id: str, overlay: dict[str, str]) -> None:
    """Apply one product proxy overlay and reconnect when it changed."""

    if _proxy_env_overlays.get(server_id) == overlay:
        return
    _proxy_env_overlays[server_id] = dict(overlay)
    reset_mcp_tools_cache()


def replace_mcp_proxy_overlays(overlays: dict[str, dict[str, str]]) -> None:
    """Atomically replace all product proxy overlays and reset connections."""

    _proxy_env_overlays.clear()
    _proxy_env_overlays.update({server_id: dict(overlay) for server_id, overlay in overlays.items()})
    reset_mcp_tools_cache()


def get_tool_routing(tool: Any) -> dict[str, Any] | None:
    return get_mcp_routing(tool)


def mark_deferred_tool(tool: Any) -> None:
    tag_mcp_tool(tool)


def mark_tool_routing(tool: Any, routing: dict[str, Any]) -> None:
    tag_mcp_routing(tool, routing)


def is_deferred_tool(tool: Any) -> bool:
    return is_mcp_tool(tool)
