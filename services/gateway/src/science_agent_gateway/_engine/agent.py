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

"""Agent-loop seams supplied by the bundled orchestration engine."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from deerflow.agents.middlewares.deferred_tool_filter_middleware import DeferredToolFilterMiddleware
from deerflow.agents.middlewares.durable_context_middleware import DurableContextMiddleware
from deerflow.agents.middlewares.summarization_middleware import DeerFlowSummarizationMiddleware
from deerflow.agents.middlewares.tool_result_sanitization_middleware import ToolResultSanitizationMiddleware
from deerflow.agents.thread_state import ThreadState
from deerflow.skills.catalog import SkillCatalog
from deerflow.skills.types import Skill, SkillCategory
from deerflow.tools.builtins.tool_search import (
    assemble_deferred_tools,
    build_mcp_routing_middleware,
    get_deferred_tools_prompt_section,
    get_mcp_routing_hints_prompt_section,
)


@dataclass(frozen=True)
class AgentRuntimeComponents:
    """Generic objects required to create one LangChain agent run."""

    middleware: list[Any]
    prompt_sections: list[str]
    state_schema: Any
    tools: list[Any]


def build_agent_runtime(
    proxy_tools: list[Any],
    *,
    deferred_enabled: bool,
    summarization_enabled: bool,
    summarization_model: Any | None,
    summarization_trigger_messages: int,
    summarization_keep_messages: int,
    summarization_trim_tokens: int | None,
) -> AgentRuntimeComponents:
    """Build engine-owned middleware, state, deferred tools, and prompt text."""

    final_tools, deferred_setup = assemble_deferred_tools(
        proxy_tools,
        enabled=deferred_enabled,
    )
    routing_middleware = build_mcp_routing_middleware(
        proxy_tools,
        deferred_setup,
        top_k=3,
    )
    middleware: list[Any] = [ToolResultSanitizationMiddleware()]
    if summarization_enabled:
        if summarization_model is None:
            raise ValueError("summarization_model is required when summarization is enabled")
        middleware.extend([
            DurableContextMiddleware(),
            DeerFlowSummarizationMiddleware(
                model=summarization_model,
                trigger=("messages", summarization_trigger_messages),
                keep=("messages", summarization_keep_messages),
                trim_tokens_to_summarize=summarization_trim_tokens,
            ),
        ])
    if routing_middleware is not None:
        middleware.append(routing_middleware)
    if deferred_setup.deferred_names:
        middleware.append(
            DeferredToolFilterMiddleware(
                deferred_setup.deferred_names,
                deferred_setup.catalog_hash,
            )
        )
    return AgentRuntimeComponents(
        middleware=middleware,
        prompt_sections=[
            get_deferred_tools_prompt_section(
                deferred_names=deferred_setup.deferred_names,
            ),
            get_mcp_routing_hints_prompt_section(
                proxy_tools,
                deferred_names=deferred_setup.deferred_names,
            ),
        ],
        state_schema=ThreadState,
        tools=final_tools,
    )


def search_skill_ids(skills: list[dict[str, str]], query: str) -> list[str]:
    """Return matching skill ids using the engine's established search semantics."""

    catalog = SkillCatalog(tuple(
        Skill(
            name=skill["id"],
            description=skill["description"],
            license=None,
            skill_dir=Path("."),
            skill_file=Path("SKILL.md"),
            relative_path=Path(skill["id"]),
            category=SkillCategory.CUSTOM,
            enabled=True,
        )
        for skill in skills
    ))
    return [item.name for item in catalog.search(query)]
