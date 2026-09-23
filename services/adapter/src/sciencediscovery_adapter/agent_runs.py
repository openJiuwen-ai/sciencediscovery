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

"""`POST /agent/runs`: run one agent turn on JiuwenSwarm and stream its events.

The caller (the legacy API's executor) sends the prompt and the run's toolset.
The adapter hosts that toolset as an MCP server, points JiuwenSwarm at it for
this run only, and streams what happens back as NDJSON, one JSON object a line:

    {"event": {...}}                      a run event (see events.py)
    {"done": {"finalText": "...", ...}}   the run finished; last line

A call to a tool is forwarded to `bridge.url` with the bridge token, and the
answer `{"text": "...", "isError": false}` goes back to JiuwenSwarm.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from typing import Any, Literal

import httpx
import websockets
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import gateway
from .config import Settings
from .diagnostics import emit as trace_boundary
from .events import RunEventMapper
from .llm_proxy import DEFAULT_ALIAS, LlmRoute, LlmRoutes
from .mcp_server import SERVER_NAME, Toolset, ToolsetRegistry
from .models import ModelProfile, ModelSync
from .schema import relax_schema
from .skills import SkillSync

# SCIENCE_AGENT_ADAPTER_DEBUG=1 prints every tool event of every run to stderr.
_DEBUG = os.environ.get("SCIENCE_AGENT_ADAPTER_DEBUG") == "1"
logger = logging.getLogger("uvicorn.error.run_binding")


class ToolSpec(BaseModel):
    name: str
    description: str = ""
    inputSchema: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})
    # What JiuwenSwarm's permission engine does before a call: "ask" the user, or "allow". Set once per tool name,
    # the first time a run brings it (JiuwenSwarm's own settings, or a user's "always", win after that).
    approval: Literal["allow", "ask"] = "allow"


class Bridge(BaseModel):
    url: str
    token: str = ""


class ModelSpec(BaseModel):
    model: str
    baseUrl: str
    apiKey: str = ""
    provider: str = "OpenAI"


class AgentRunRequest(BaseModel):
    sessionId: str
    runId: str | None = None
    agentId: str | None = None
    prompt: str
    mode: str = "agent.work.normal"
    cwd: str = "/tmp"
    tools: list[ToolSpec] = Field(default_factory=list)
    bridge: Bridge | None = None
    model: ModelSpec | None = None
    # The caller's system prompt for this run (needs `model`). `systemPromptMode` says what becomes of
    # JiuwenSwarm's own: "append" keeps it whole and adds this one after it; "replace" swaps it out.
    systemPrompt: str | None = None
    systemPromptMode: Literal["prepend", "append", "replace"] = "replace"
    # Added after JiuwenSwarm's prompt in "prepend": the part that changes every turn (the run contract).
    systemPromptTail: str | None = None
    # The JiuwenSwarm session that holds this agent's conversation: stable across runs, one per agent
    # (the main agent, and each subagent, of one caller session). JiuwenSwarm keeps and compresses the
    # context there; the adapter neither sends nor rebuilds any history. Defaults to `sessionId`.
    sessionKey: str | None = None
    # Names of JiuwenSwarm's own tools that stay visible to the model besides the toolset above
    # (for example `todo_create`). They run inside JiuwenSwarm, not over the bridge.
    nativeTools: list[str] = Field(default_factory=list)
    # "all": every one of JiuwenSwarm's own tools is offered too, and one of ours with the same name gives way.
    jiuwenSwarmTools: Literal["all", "listed"] = "listed"
    # JiuwenSwarm's own tools the model must not get (they act on the host; see LlmRoute.hidden_native_tools).
    hiddenJiuwenSwarmTools: list[str] = Field(default_factory=list, max_length=100)
    # Longest a single tool call may take, in seconds; the run's own timeout, when the caller has one.
    toolTimeoutSeconds: int | None = Field(default=None, gt=0)


# JiuwenSwarm's configuration for web search (`config.set` keys): its two free engines and its paid-search keys.
JIUWENSWARM_WEB_CONFIG_KEYS = frozenset({
    "free_search_ddg_enabled", "free_search_bing_enabled",
    "jina_api_key", "bocha_api_key", "serper_api_key", "perplexity_api_key",
})


class JiuwenSwarmConfig(BaseModel):
    values: dict[str, str]


class SkillPackage(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    path: str  # the frozen package on this host, with SKILL.md at its top
    hash: str


class SkillImport(BaseModel):
    skills: list[SkillPackage] = Field(max_length=200)


class SkillEnabled(BaseModel):
    enabled: bool


class AgentLanguage(BaseModel):
    language: Literal["zh", "en"]


class PermissionAnswer(BaseModel):
    decision: Literal["allow_once", "allow_matching", "deny"]


def describe_approval(request: dict[str, Any], route: LlmRoute | None) -> None:
    """Say what a JiuwenSwarm approval question is about: the tool and the arguments of the call it stopped.

    Its question names the tool (`mcp_sci_run_shell（当前模式默认需确认）…`) but not the call; the model proxy saw
    the call go by. `toolName` is the bare tool name (`run_shell`), stable across calls: the API uses it, not the
    per-call text, to classify the privileged action the way the rest of ScienceDiscovery does (so a standing
    grant for that action, made outside a run, still applies to a call JiuwenSwarm stops). `summary` is the
    descriptive, per-call text for the approval card; unlike before, it is not reused as the resource. Its own
    text stays as the summary when no call matches.
    """
    call = route.take_call(str(request.get("summary") or "")) if route else None
    if call is None:
        return
    name, arguments = call
    shown = name.removeprefix(route.tool_prefix) if route and name.startswith(route.tool_prefix) else name
    main = next((arguments[key] for key in ("command", "scriptPath", "code", "file_path", "path", "url", "query")
                 if isinstance(arguments.get(key), str) and arguments[key].strip()), None)
    detail = main if main is not None else json.dumps(arguments, ensure_ascii=False)
    text = f"{shown}: {detail}" if arguments else shown
    request["summary"] = text[:500]
    request["toolName"] = shown


def bridge_caller(bridge: Bridge, client: httpx.AsyncClient):
    async def call(name: str, arguments: dict[str, Any]) -> tuple[str, bool]:
        response = await client.post(
            bridge.url, json={"name": name, "arguments": arguments},
            headers={"authorization": f"Bearer {bridge.token}"} if bridge.token else {},
        )
        response.raise_for_status()
        body = response.json()
        return str(body.get("text", "")), bool(body.get("isError", False))
    return call


class AgentRunner:
    """Runs agent turns. The gateway calls are attributes so tests can replace them."""

    def __init__(
        self, settings: Settings, registry: ToolsetRegistry, client: Callable[[], httpx.AsyncClient],
        routes: LlmRoutes | None = None,
    ) -> None:
        self.settings = settings
        self.registry = registry
        self.routes = routes or LlmRoutes()
        self.client = client  # a getter: the HTTP client exists only while the app runs
        self.chat_run = gateway.ChatRun
        self.rpc = gateway.rpc
        self.models = ModelSync(lambda *a, **k: self.rpc(*a, **k), settings.mgmt_url)
        self.skills = SkillSync(lambda *a, **k: self.rpc(*a, **k), settings.mgmt_url)
        self._shared_lock = asyncio.Lock()
        self._shared_registered = False
        self._shared_timeout_s = 0
        self._permissions_on = False
        self._tool_approvals: dict[str, str] = {}
        # Runs paused on one of JiuwenSwarm's approval questions, by the question's id.
        self.pending_approvals: dict[str, tuple[Any, RunEventMapper]] = {}

    async def ensure_default_model(self) -> None:
        """Point JiuwenSwarm's default model at the adapter (see `llm_proxy.DEFAULT_ALIAS`)."""
        await self.models.ensure_default(ModelProfile(
            DEFAULT_ALIAS, f"{self.settings.public_url}/llm/default/v1", self.routes.default_key, "OpenAI"))

    async def ensure_shared_tools(self, tools: list[dict[str, Any]], timeout_s: int) -> None:
        """Register once; refresh the catalog without replacing the shared client.

        Execution deadlines are enforced by Toolset; timeout_s is validated
        here but must never trigger a transport-wide configuration change.
        """
        if timeout_s <= 0:
            raise ValueError("Tool timeout must be positive")
        async with self._shared_lock:
            # Swarm permissions are global by tool name. Reject conflicting
            # contracts before mutating the catalog or another run's policy.
            policies = dict(self._tool_approvals)
            for tool in tools:
                level = tool.get("approval") or "allow"
                previous = policies.setdefault(tool["name"], level)
                if previous != level:
                    raise ValueError(f"Conflicting approval policy for {tool['name']}: "
                                     f"registered {previous}, requested {level}; "
                                     "Swarm requires a consistent policy for shared tool names")
            await self._apply_approvals(tools)
            changed = self.registry.merge(tools)
            if self._shared_registered and not changed:
                return
            if not self._shared_registered:
                # Only startup replaces a stale registration. Tool execution
                # deadlines belong to each Toolset, never to this shared client.
                self._shared_timeout_s = self.settings.tool_timeout_s
                for method in ("mcp.disconnect", "mcp.delete_custom"):
                    try:
                        await self.rpc(self.settings.mgmt_url, method, {"name": SERVER_NAME})
                    except Exception:
                        pass
                await self.rpc(self.settings.mgmt_url, "mcp.register_custom", {
                    "name": SERVER_NAME, "transport": "streamable-http",
                    "url": f"{self.settings.public_url}/mcp/{self.registry.token}", "timeout_s": self._shared_timeout_s,
                })
            await self.rpc(self.settings.mgmt_url, "mcp.connect", {"name": SERVER_NAME})
            self._shared_registered = True

    async def answer_approval(self, request_id: str, decision: str) -> None:
        """Resume a run paused on one of JiuwenSwarm's approval questions with the user's decision.

        A cancel racing this same approval closes the run's connection first often enough to matter: the
        caller (a deny sent on abort, `jiuwenswarm-agent.ts`'s `answerApproval`) has nothing left to resume
        by then, so that race is a no-op here rather than a 500 from an unhandled send-on-closed-socket.
        """
        pending = self.pending_approvals.pop(request_id, None)
        if pending is None:
            raise KeyError(request_id)
        run, mapper = pending
        answer, _ = mapper.decide(request_id, decision)
        try:
            await run.answer(request_id, "permission_interrupt", answer)
        except (gateway.GatewayError, websockets.WebSocketException) as error:
            if not mapper.finished and not mapper._cancel_requested:
                raise gateway.GatewayError("approval delivery failed") from error

    async def _apply_approvals(self, tools: list[dict[str, Any]]) -> None:
        """JiuwenSwarm's permission engine decides every call (ScienceDiscovery's approval layer allows what it
        lets through). Switched on once; a tool it has not seen yet gets the level the API asked for."""
        if not self._permissions_on:
            await self.rpc(self.settings.mgmt_url, "config.set", {"permissions_enabled": True})
            self._permissions_on = True
        for tool in tools:
            if tool["name"] in self._tool_approvals:
                continue
            await self.rpc(self.settings.mgmt_url, "permissions.tools.update", {
                "tool": f"mcp_{SERVER_NAME}_{tool['name']}", "level": tool.get("approval") or "allow",
            })
            self._tool_approvals[tool["name"]] = tool.get("approval") or "allow"

    async def stream(self, request: AgentRunRequest) -> AsyncGenerator[str, None]:
        name = SERVER_NAME
        token = None
        llm_token = None
        terminal_status = "completed"
        jw_session = request.sessionKey or request.sessionId
        trace_context = {"run_id": request.runId, "agent_id": request.agentId,
                         "session_id": request.sessionId, "swarm_session": jw_session}
        trace_boundary("run.started", **trace_context, tool_count=len(request.tools))
        logger.info("run-binding start run=%s agent=%s session=%s swarm_session=%s tools=%d",
                    request.runId, request.agentId, request.sessionId, jw_session, len(request.tools))
        mapper = RunEventMapper(session_id=request.sessionId, mcp_prefixes=(f"mcp_{name}_",))
        params: dict[str, Any] = {
            "session_id": jw_session, "content": request.prompt, "query": request.prompt,
            "mode": request.mode, "cwd": request.cwd, "project_dir": request.cwd, "trusted_dirs": [request.cwd],
            "supports_user_interaction": True, "sci_persistent_output": True,
            "agent_ref": {"mode": request.mode, "id": "default"},
        }
        try:
            if request.tools:
                if request.bridge is None:
                    raise ValueError("tools were given without a bridge to run them")
                # JiuwenSwarm validates strictly; the model still sees the originals (see LlmRoute).
                token = self.registry.add(Toolset(
                    tools=[{**t.model_dump(), "inputSchema": relax_schema(t.inputSchema)} for t in request.tools],
                    call=bridge_caller(request.bridge, self.client()),
                    timeout_s=request.toolTimeoutSeconds or self.settings.tool_timeout_s,
                    trace_context=trace_context,
                ))
                trace_boundary("run.tools.bound", **trace_context, run_tag=token, tool_count=len(request.tools))
            if request.model:
                if request.model.provider != "OpenAI":
                    raise ValueError(f"the {request.model.provider} protocol is not supported by this executor yet")
                # A private connection routes this run's tools and prompt without
                # changing the real model name or the global model configuration.
                llm_token = self.routes.add(LlmRoute(
                    base_url=request.model.baseUrl.rstrip("/"), api_key=request.model.apiKey, model=request.model.model,
                    tool_prefix=f"mcp_{name}_", tool_names=frozenset(t.name for t in request.tools),
                    tool_specs={t.name: {"description": t.description, "parameters": t.inputSchema} for t in request.tools},
                    system_prompt=request.systemPrompt, system_prompt_mode=request.systemPromptMode,
                    system_prompt_tail=request.systemPromptTail,
                    native_tools=frozenset(request.nativeTools), all_native_tools=request.jiuwenSwarmTools == "all",
                    hidden_native_tools=frozenset(request.hiddenJiuwenSwarmTools), run_tag=token,
                ))
                params["model_name"] = request.model.model
                # Private, in-memory session binding. Never publish per-run credentials
                # into Swarm's global model list or trigger a global model reload.
                params["run_model"] = {
                    "model_name": request.model.model,
                    "api_base": f"{self.settings.public_url}/llm/{llm_token}/v1",
                    "api_key": llm_token, "client_provider": "OpenAI",
                }
            if request.tools:
                if request.bridge is None:
                    raise ValueError("tools were given without a bridge to run them")
                tools = [{**t.model_dump(), "inputSchema": relax_schema(t.inputSchema)} for t in request.tools]
                await self.ensure_shared_tools(tools, request.toolTimeoutSeconds or self.settings.tool_timeout_s)
                params["mcp"] = [name]
            async with self.chat_run(self.settings.gateway_url, params) as run:
                try:
                    async for frame in run:
                        for event in mapper.feed(frame):
                            if event["type"] in {"tool.started", "tool.completed", "permission.required",
                                                  "assistant.response.settled", "run.failed", "run.cancelled"}:
                                trace = event.get("trace") or {}
                                trace_boundary("swarm.event", **trace_context, event_type=event["type"],
                                               tool=trace.get("name"), tool_call_id=trace.get("id"), status=trace.get("status"))
                            if event["type"] == "run.failed":
                                terminal_status = "failed"
                            elif event["type"] == "run.cancelled":
                                terminal_status = "cancelled"
                            if event["type"] == "permission.required":
                                self.pending_approvals[event["request"]["id"]] = (run, mapper)
                                route = self.routes.get(llm_token) if llm_token else None
                                describe_approval(event["request"], route)
                            if _DEBUG and event["type"].startswith("tool."):
                                print(f"[adapter-debug] {request.sessionId[:8]} {json.dumps(event, ensure_ascii=False)[:500]}",
                                      file=sys.stderr, flush=True)
                            yield json.dumps({"event": event}, ensure_ascii=False) + "\n"
                except BaseException:
                    # The caller went away (or the task was cancelled): stop the run.
                    if not mapper.finished:
                        mapper.request_cancel()
                        try:
                            await run.cancel()
                        except Exception:
                            pass
                    raise
            if not mapper.finished:
                raise gateway.GatewayError("Swarm stream ended without a terminal event")
            yield json.dumps({"done": {
                "status": "cancelled" if mapper._cancel_requested else terminal_status,
                "finalText": mapper.final_text or "", "unmapped": mapper.unmapped,
                "cancelled": mapper._cancel_requested,
            }}, ensure_ascii=False) + "\n"
        except (gateway.GatewayError, ValueError, httpx.HTTPError) as error:
            terminal_status = "failed"
            trace_boundary("run.error", **trace_context, error_type=type(error).__name__)
            failure = {"type": "run.failed", "error": str(error), "errorCode": "transport-error"}
            yield json.dumps({"event": failure}, ensure_ascii=False) + "\n"
            yield json.dumps({"done": {"status": "failed", "finalText": "", "unmapped": mapper.unmapped, "cancelled": False}}) + "\n"
        finally:
            trace_boundary("run.released", **trace_context, run_tag=token, terminal=mapper.finished,
                           status="cancelled" if mapper._cancel_requested else terminal_status)
            logger.info("run-binding release run=%s agent=%s swarm_session=%s terminal=%s",
                        request.runId, request.agentId, jw_session, mapper.finished)
            if llm_token:
                self.routes.remove(llm_token)
            if token:
                self.registry.remove(token)  # the shared server stays; calls for this run find nothing now
            for request_id in [key for key, (_, owner) in self.pending_approvals.items() if owner is mapper]:
                self.pending_approvals.pop(request_id, None)


async def stream_with_keepalive(source: AsyncGenerator[str, None], interval: float = 15.0) -> AsyncIterator[str]:
    """Keep the HTTP body alive while a run waits on tools or user approval.

    Gateway WebSocket heartbeats are filtered before reaching this stream.
    A blank NDJSON line keeps transport readers alive without reporting agent
    progress or resetting the run's own idle deadline. Never cancel an active
    read just because a heartbeat is due: that would cancel the agent itself.
    """
    pending = None
    try:
        while True:
            if pending is None:
                pending = asyncio.create_task(anext(source))
            ready, _ = await asyncio.wait({pending}, timeout=interval)
            if not ready:
                yield "\n"
                continue
            try:
                item = pending.result()
            except StopAsyncIteration:
                return
            pending = None
            yield item
    finally:
        if pending is not None:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await source.aclose()


def agent_router(runner: AgentRunner, settings: Settings) -> APIRouter:
    router = APIRouter()

    @router.post("/agent/runs")
    async def create_run(body: AgentRunRequest, authorization: str | None = Header(default=None)) -> StreamingResponse:
        if settings.agent_token and authorization != f"Bearer {settings.agent_token}":
            raise HTTPException(status_code=401, detail="unauthorized")
        return StreamingResponse(stream_with_keepalive(runner.stream(body)), media_type="application/x-ndjson")

    @router.post("/agent/jiuwenswarm-config")
    async def jiuwenswarm_config(body: JiuwenSwarmConfig, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        """Apply the web settings to JiuwenSwarm (`config.set`). Only the keys it has for web search are accepted."""
        if settings.agent_token and authorization != f"Bearer {settings.agent_token}":
            raise HTTPException(status_code=401, detail="unauthorized")
        unknown = sorted(set(body.values) - JIUWENSWARM_WEB_CONFIG_KEYS)
        if unknown:
            raise HTTPException(status_code=400, detail=f"not a web search setting: {', '.join(unknown)}")
        try:
            result = await runner.rpc(settings.mgmt_url, "config.set", dict(body.values))
        except Exception as error:
            raise HTTPException(status_code=502, detail=f"JiuwenSwarm refused the settings: {str(error)[:200]}") from error
        return {"applied": sorted(body.values), "jiuwenswarm": result}

    @router.post("/agent/skills")
    async def import_skills(body: SkillImport, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        """Install a run's skills in JiuwenSwarm (see `skills.py`). Answers, by id, the name it has there or an error."""
        if settings.agent_token and authorization != f"Bearer {settings.agent_token}":
            raise HTTPException(status_code=401, detail="unauthorized")
        try:
            imported = await runner.skills.sync([skill.model_dump() for skill in body.skills])
        except Exception as error:
            raise HTTPException(status_code=502, detail=f"JiuwenSwarm could not list its skills: {str(error)[:200]}") from error
        return {"skills": imported}

    @router.post("/agent/language")
    async def set_language(body: AgentLanguage, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        """JiuwenSwarm's language (`preferred_language`): its own prompt, rails and tools, and the language it asks
        the model to answer in. One setting for every session; a session started afterwards uses it. Only the TUI
        channel's `config.set` has this key, so it goes there, not to the management channel."""
        if settings.agent_token and authorization != f"Bearer {settings.agent_token}":
            raise HTTPException(status_code=401, detail="unauthorized")
        try:
            result = await runner.rpc(settings.gateway_url, "config.set", {"preferred_language": body.language})
        except Exception as error:
            raise HTTPException(status_code=502, detail=f"JiuwenSwarm refused the language: {str(error)[:200]}") from error
        if "preferred_language" not in (result.get("updated") or []):
            raise HTTPException(status_code=502, detail=f"JiuwenSwarm did not take the language: {str(result)[:200]}")
        return {"language": body.language}

    @router.post("/agent/approvals/{request_id}")
    async def answer_approval(request_id: str, body: PermissionAnswer, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        """The user's decision on one of JiuwenSwarm's approval questions (`permission.required` in a run's stream)."""
        if settings.agent_token and authorization != f"Bearer {settings.agent_token}":
            raise HTTPException(status_code=401, detail="unauthorized")
        try:
            await runner.answer_approval(request_id, body.decision)
        except KeyError:
            raise HTTPException(status_code=404, detail="no run is waiting on that question") from None
        except gateway.GatewayError:
            raise HTTPException(status_code=502, detail="approval delivery failed") from None
        return {"answered": request_id, "decision": body.decision}

    @router.get("/agent/skills")
    async def list_skills(authorization: str | None = Header(default=None)) -> dict[str, Any]:
        """The skills JiuwenSwarm has installed, ScienceDiscovery's and its own, and whether each is on."""
        if settings.agent_token and authorization != f"Bearer {settings.agent_token}":
            raise HTTPException(status_code=401, detail="unauthorized")
        try:
            return {"skills": await runner.skills.listed()}
        except Exception as error:
            raise HTTPException(status_code=502, detail=f"JiuwenSwarm could not list its skills: {str(error)[:200]}") from error

    @router.post("/agent/skills/{name}/enabled")
    async def set_skill_enabled(name: str, body: SkillEnabled, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        """Switch one of JiuwenSwarm's skills on or off, for every session."""
        if settings.agent_token and authorization != f"Bearer {settings.agent_token}":
            raise HTTPException(status_code=401, detail="unauthorized")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", name):
            raise HTTPException(status_code=400, detail="not a skill name")
        try:
            await runner.skills.set_enabled(name, body.enabled)
        except Exception as error:
            raise HTTPException(status_code=502, detail=f"JiuwenSwarm refused: {str(error)[:200]}") from error
        return {"name": name, "enabled": body.enabled}

    @router.get("/agent/info")
    async def info(authorization: str | None = Header(default=None)) -> dict[str, Any]:
        """Which backend runs agent turns, and whether JiuwenSwarm answers: the way to check a deployment."""
        accepted = {f"Bearer {token}" for token in (settings.agent_token, settings.api_token) if token}
        if accepted and authorization not in accepted:
            raise HTTPException(status_code=401, detail="unauthorized")
        reachable, detail = True, None
        try:
            await runner.rpc(settings.mgmt_url, "models.list", timeout=5)
        except Exception as error:  # gateway down, refused, timed out
            reachable, detail = False, str(error)[:200]
        return {
            "adapter": True,
            "executor": settings.executor,
            "jiuwenswarm": {
                "gatewayUrl": settings.gateway_url, "managementUrl": settings.mgmt_url,
                "reachable": reachable, **({"error": detail} if detail else {}),
            },
            "toolTimeoutSeconds": settings.tool_timeout_s,
        }

    return router
