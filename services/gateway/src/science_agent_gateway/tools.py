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

"""Per-run proxy tools built from the tool specs the Node API sends.

Node serializes its live `createWorkspaceTools` set (name, description, JSON
schema) into each `/run` request, so the advertised tools always match what the
session actually enables — MCP sources, scientific environments, approval policy, and
remote hosts included. Every call forwards to the Node callback endpoint where
the real handler runs with the product's governance; the returned text becomes
the tool result the agent loop sees.
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import StructuredTool

from ._engine import mark_deferred_tool, mark_tool_routing
from .callback import CallbackTarget, invoke_node_tool

# A tool with no arguments still needs a valid object schema for binding.
_EMPTY_SCHEMA: dict[str, Any] = {"type": "object", "properties": {}}


class CallbackStructuredTool(StructuredTool):
    """Keep Node's JSON Schema while forwarding LangGraph's real tool-call id."""

    def _parse_input(self, tool_input: str | dict[str, Any], tool_call_id: str | None) -> str | dict[str, Any]:
        parsed = super()._parse_input(tool_input, tool_call_id)
        if isinstance(parsed, dict):
            return {**parsed, "tool_call_id": tool_call_id}
        return parsed


def build_proxy_tools(specs: list[dict[str, Any]], target: CallbackTarget) -> list[StructuredTool]:
    """Build one forwarding StructuredTool per spec, bound to this run's callback."""
    tools: list[StructuredTool] = []
    for spec in specs:
        name = spec["name"]

        def forward(tool_call_id: str | None = None, _name: str = name, **kwargs: Any) -> str:
            return invoke_node_tool(target, _name, kwargs, tool_call_id)

        tool = CallbackStructuredTool(
            name=name,
            description=spec.get("description") or name,
            # langchain accepts a plain JSON schema dict here, so Node's
            # TypeBox schemas pass through without a pydantic rebuild.
            args_schema=spec.get("input_schema") or _EMPTY_SCHEMA,
            func=forward,
        )
        if spec.get("deferred"):
            mark_deferred_tool(tool)
            routing = spec.get("routing")
            if isinstance(routing, dict):
                mark_tool_routing(tool, routing)
        tools.append(tool)
    return tools
