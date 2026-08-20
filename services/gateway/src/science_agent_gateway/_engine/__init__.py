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

"""Internal orchestration-engine adapter.

Only this package may depend on the bundled engine's Python modules.  The
Gateway routes and orchestration flow consume the product-oriented functions
exported here so upstream package layout and configuration types stay private.
"""

from .agent import AgentRuntimeComponents, build_agent_runtime, search_skill_ids
from .mcp import (
    McpServerDefinition,
    apply_mcp_proxy_overlay,
    get_mcp_tools,
    get_tool_routing,
    is_deferred_tool,
    load_mcp_servers,
    mark_deferred_tool,
    mark_tool_routing,
    reset_mcp_tool_cache,
    replace_mcp_proxy_overlays,
)
from .model import create_reasoning_chat_model
from .web import (
    ResolvedWebProvider,
    configure_web_proxy_environment,
    invoke_isolated_web_provider,
    invoke_serialized_web_provider,
    invoke_web_provider,
    resolve_web_provider,
)

__all__ = [
    "AgentRuntimeComponents",
    "McpServerDefinition",
    "ResolvedWebProvider",
    "apply_mcp_proxy_overlay",
    "build_agent_runtime",
    "configure_web_proxy_environment",
    "create_reasoning_chat_model",
    "get_mcp_tools",
    "get_tool_routing",
    "invoke_isolated_web_provider",
    "invoke_serialized_web_provider",
    "invoke_web_provider",
    "is_deferred_tool",
    "load_mcp_servers",
    "mark_deferred_tool",
    "mark_tool_routing",
    "reset_mcp_tool_cache",
    "replace_mcp_proxy_overlays",
    "resolve_web_provider",
    "search_skill_ids",
]
