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

"""Adapter application: migrated routes first, legacy proxy for the rest."""

from __future__ import annotations

from contextlib import asynccontextmanager

import sys

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import Response

from .agent_runs import AgentRunner, agent_router
from .config import Settings
from .llm_proxy import DEFAULT_ALIAS, LlmRoutes, llm_router
from .mcp_server import ToolsetRegistry, mcp_router
from .proxy import proxy_to_legacy


async def forget_stale_aliases(runner) -> None:
    """Remove the per-run model aliases an earlier, abnormally ended process left in JiuwenSwarm."""
    try:
        # The default entry first: JiuwenSwarm refuses an empty model list, and it is the one entry kept.
        await runner.ensure_default_model()
        removed = await runner.models.prune(runner.settings.public_url, keep=frozenset({DEFAULT_ALIAS}))
    except Exception as error:  # JiuwenSwarm may not be up yet; nothing to clean then
        print(f"[adapter] could not clean stale model aliases: {error}", file=sys.stderr, flush=True)
        return
    if removed:
        print(f"[adapter] removed {removed} stale or placeholder model entr(y/ies) from JiuwenSwarm", file=sys.stderr, flush=True)


def create_app(settings: Settings | None = None, *, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # No read timeout: SSE runs stay open for the whole agent run.
        timeout = httpx.Timeout(connect=5.0, read=None, write=60.0, pool=5.0)
        async with (
            httpx.AsyncClient(base_url=settings.legacy_url, transport=transport, timeout=timeout,
                              follow_redirects=False) as legacy,
            # Tool-bridge calls go to loopback URLs the caller names, not to the legacy base URL.
            httpx.AsyncClient(timeout=timeout) as bridge,
        ):
            app.state.legacy = legacy
            app.state.bridge = bridge
            await forget_stale_aliases(app.state.agent_runner)
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    registry = ToolsetRegistry()
    app.include_router(mcp_router(registry))
    routes = LlmRoutes()
    app.include_router(llm_router(routes, lambda: app.state.bridge))
    app.state.agent_runner = AgentRunner(settings, registry, lambda: app.state.bridge, routes)
    app.include_router(agent_router(app.state.agent_runner, settings))
    # Migrated routes are registered above this line, one router per domain.

    @app.api_route(
        "/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        include_in_schema=False,
    )
    async def legacy(request: Request) -> Response:
        return await proxy_to_legacy(app.state.legacy, request)

    return app
