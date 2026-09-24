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
import os
import re
import shlex
import sys
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any, Literal

import httpx
import websockets
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import gateway
from .config import Settings
from .events import RunEventMapper
from .llm_proxy import DEFAULT_ALIAS, LlmRoute, LlmRoutes
from .mcp_server import SERVER_NAME, Toolset, ToolsetRegistry
from .models import ModelProfile, ModelSync
from .schema import relax_schema
from .skills import SkillSync, sandbox_skill_paths

# SCIENCE_AGENT_ADAPTER_DEBUG=1 prints every tool event of every run to stderr.
_DEBUG = os.environ.get("SCIENCE_AGENT_ADAPTER_DEBUG") == "1"
_SAFE_NAME = re.compile(r"[^a-z0-9]")


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
    # More of JiuwenSwarm's own tools the model must not get, besides JIUWENSWARM_HOST_TOOLS, which it never gets
    # (they act on the host; see LlmRoute.hidden_native_tools).
    hiddenJiuwenSwarmTools: list[str] = Field(default_factory=list, max_length=100)
    # Longest a single tool call may take, in seconds; the run's own timeout, when the caller has one.
    toolTimeoutSeconds: int | None = None


# JiuwenSwarm's own tools that act on the host, outside ScienceDiscovery's sandbox and Runner (the API's
# JIUWENSWARM_HOST_TOOLS): no run's model may call them, in any tool mode.
JIUWENSWARM_HOST_TOOLS = frozenset({"bash", "read_file", "write_file", "edit_file", "glob", "list_files", "grep", "read_pdf"})


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


def model_alias_base(model: str) -> str:
    """A model id as a JiuwenSwarm entry name: letters, digits, `.`, `_` and `-` only, at most 48 characters."""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", model).strip("-")[:48] or "model"


# The start of a JiuwenSwarm question about one of our tools: "mcp_sci_<tool>…" or, on a later generation of the
# shared server, "mcp_sci<ten digits>_<tool>…" (see llm_proxy._ANY_RUN_PREFIX).
_OUR_TOOL_QUESTION = re.compile(r"\s*mcp_sci(?:[0-9a-z]{10})?_([A-Za-z0-9_.\-]+)")


def describe_approval(request: dict[str, Any], route: LlmRoute | None) -> None:
    """Say what a JiuwenSwarm approval question is about: the tool and the arguments of the call it stopped.

    Its question names the tool (`mcp_sci_run_shell（当前模式默认需确认）…`) but not the call; the model proxy saw
    the call go by. `toolName` is the bare tool name (`run_shell`), stable across calls: the API uses it, not the
    per-call text, to classify the privileged action the way the rest of ScienceDiscovery does (so a standing
    grant for that action, made outside a run, still applies to a call JiuwenSwarm stops). `summary` is the
    descriptive, per-call text for the approval card; unlike before, it is not reused as the resource. Its own
    text stays as the summary when no call matches.
    """
    question = str(request.get("summary") or "")
    call = route.take_call(question) if route else None
    if call is None:
        # No call left to match: JiuwenSwarm asked again about a call already described (measured: with parallel
        # calls it re-asks one after the others ran). One of ours is still named by its tool, not by JiuwenSwarm's
        # wording, so the card reads the same and a grant the user already gave for that tool still applies.
        ours = _OUR_TOOL_QUESTION.match(question)
        if ours:
            request["summary"] = request["toolName"] = ours.group(1)
        return
    name, arguments = call
    shown = name.removeprefix(route.tool_prefix) if route and name.startswith(route.tool_prefix) else name
    main = next((arguments[key] for key in ("command", "scriptPath", "code", "file_path", "path", "url", "query")
                 if isinstance(arguments.get(key), str) and arguments[key].strip()), None)
    detail = main if main is not None else json.dumps(arguments, ensure_ascii=False)
    extra = arguments.get("arguments")
    if main is not None and isinstance(extra, list) and extra and all(isinstance(item, str) for item in extra):
        # run_shell's arguments run with the command; the card shows what the user is approving.
        detail = f"{detail} {shlex.join(extra)}"
    text = f"{shown}: {detail}" if arguments else shown
    request["summary"] = text[:500]
    request["toolName"] = shown


def bridge_caller(bridge: Bridge, client: httpx.AsyncClient, skill_directories: dict[str, str] | None = None):
    async def call(name: str, arguments: dict[str, Any]) -> tuple[str, bool]:
        if skill_directories and name == "run_shell" and isinstance(arguments.get("command"), str):
            arguments = {**arguments, "command": sandbox_skill_paths(arguments["command"], skill_directories)}
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
        # Starts at the configured ceiling, not 0: a run that omits toolTimeoutSeconds already falls back to
        # this same value (see ensure_shared_tools's caller), so starting low only matters for a run that
        # asks for less than it (a short-lived test, for one). Concurrent runs' start order is a race, and
        # whichever reaches ensure_shared_tools first sets this value for everyone; starting it low let an
        # early short-timeout run set a low bar that every normal-timeout run after it then had to bump back
        # up, each bump re-running the whole disconnect/register/connect dance under _shared_lock while every
        # other concurrent run waits on it. Starting at the ceiling means only a run that genuinely asks for
        # more than the configured default ever triggers that dance for this reason.
        self._shared_timeout_s = settings.tool_timeout_s
        # The shared server's generations (see ensure_shared_tools): the current name, how many runs are on each
        # name still registered, and the approval level each tool was first given (a new name needs them all again).
        self._generation = 0
        self._server = SERVER_NAME
        self._server_runs: dict[str, int] = {}
        self._server_tools: dict[str, set[str]] = {}
        self._approval_levels: dict[str, str] = {}
        self._permissions_on = False
        # Runs paused on one of JiuwenSwarm's approval questions, by the question's id.
        self.pending_approvals: dict[str, tuple[Any, RunEventMapper]] = {}

    async def ensure_default_model(self) -> None:
        """Point JiuwenSwarm's default model at the adapter (see `llm_proxy.DEFAULT_ALIAS`)."""
        await self.models.ensure_default(ModelProfile(
            DEFAULT_ALIAS, f"{self.settings.public_url}/llm/default/v1", self.routes.default_key, "OpenAI"))

    async def ensure_shared_tools(self, tools: list[dict[str, Any]], timeout_s: int) -> str:
        """Give JiuwenSwarm the one MCP server for every run's tools (see mcp_server), and its list again when a run
        brought a tool (or an argument) it did not have. Returns the server's name for this run, which holds it until
        `release_shared_tools`.

        A bare `mcp.connect` on an already-connected server does *not* make JiuwenSwarm re-read the tool
        list (confirmed live: a run whose only new tools arrived through that path never saw JiuwenSwarm
        issue `tools/list` again, so those tools were never callable) -- only a fresh registration does. But
        `mcp.disconnect` is global: done to the server other runs are calling through, it drops their calls in
        flight, and a run waiting on one (a `task` whose sub-agent is the very run that brought the new tools)
        never gets its result and hangs. So a new list goes to a new name, the next generation (`sci` + ten
        digits, see llm_proxy._ANY_RUN_PREFIX); the runs already on the old name keep it, and it is disconnected
        once the last of them has ended.
        """
        async with self._shared_lock:
            previous = self._server if self._shared_registered else None
            old_shared = self.registry.shared.copy()
            old_approvals = self._approval_levels.copy()
            old_timeout = self._shared_timeout_s
            old_permissions_on = self._permissions_on
            names = {tool["name"] for tool in tools}
            # Only running generations need their historical tools. A finished
            # generation can be replaced without carrying its catalog forward.
            active = set().union(*(self._server_tools.get(server, set())
                                   for server, count in self._server_runs.items() if count > 0))
            retained = names | active
            self.registry.shared = {name: tool for name, tool in self.registry.shared.items() if name in retained}
            self._approval_levels = {name: level for name, level in self._approval_levels.items() if name in retained}
            new = [tool for tool in tools if tool["name"] not in self.registry.shared]
            for tool in tools:
                self._approval_levels.setdefault(tool["name"], tool.get("approval") or "allow")
            changed = self.registry.merge(tools) or set(old_shared) != set(self.registry.shared)
            longer = timeout_s > self._shared_timeout_s
            if self._shared_registered and not changed and not longer:
                try:
                    await self._apply_approvals(new, self._server)
                except Exception:
                    self.registry.shared = old_shared
                    self._approval_levels = old_approvals
                    self._permissions_on = old_permissions_on
                    raise
                self._server_tools.setdefault(self._server, set()).update(names)
            else:
                candidate_timeout = max(timeout_s, self._shared_timeout_s)
                if previous is not None:
                    self._generation += 1
                    candidate = f"{SERVER_NAME}{self._generation:010d}"
                else:
                    candidate = self._server
                try:
                    # An earlier adapter may have left this name registered with another URL (its token changed).
                    for method in ("mcp.disconnect", "mcp.delete_custom"):
                        try:
                            await self.rpc(self.settings.mgmt_url, method, {"name": candidate})
                        except Exception:
                            pass
                    await self.rpc(self.settings.mgmt_url, "mcp.register_custom", {
                        "name": candidate, "transport": "streamable-http",
                        "url": f"{self.settings.public_url}/mcp/{self.registry.token}", "timeout_s": candidate_timeout,
                    })
                    await self.rpc(self.settings.mgmt_url, "mcp.connect", {"name": candidate})
                    # Approval levels are per tool name, and the name carries the server's: all of them again.
                    await self._apply_approvals([{"name": name, "approval": level} for name, level in self._approval_levels.items()],
                                                candidate)
                except Exception:
                    self.registry.shared = old_shared
                    self._approval_levels = old_approvals
                    self._shared_timeout_s = old_timeout
                    self._permissions_on = old_permissions_on
                    for method in ("mcp.disconnect", "mcp.delete_custom"):
                        try:
                            await self.rpc(self.settings.mgmt_url, method, {"name": candidate})
                        except Exception:
                            pass
                    raise
                self._server = candidate
                self._shared_timeout_s = candidate_timeout
                self._shared_registered = True
                self._server_tools[candidate] = set(self.registry.shared)
                if previous is not None and not self._server_runs.get(previous):
                    await self._retire(previous)
            self._server_runs[self._server] = self._server_runs.get(self._server, 0) + 1
            return self._server

    async def release_shared_tools(self, server: str) -> None:
        """A run on `server` ended: an earlier generation nobody is on any more is disconnected."""
        async with self._shared_lock:
            self._server_runs[server] = self._server_runs.get(server, 1) - 1
            if server != self._server and self._server_runs[server] <= 0:
                await self._retire(server)

    async def _retire(self, server: str) -> None:
        self._server_runs.pop(server, None)
        self._server_tools.pop(server, None)
        for method in ("mcp.disconnect", "mcp.delete_custom"):
            try:
                await self.rpc(self.settings.mgmt_url, method, {"name": server})
            except Exception:
                pass

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
        except (gateway.GatewayError, websockets.WebSocketException):
            pass

    async def _apply_approvals(self, tools: list[dict[str, Any]], server: str) -> None:
        """JiuwenSwarm's permission engine decides every call (ScienceDiscovery's approval layer allows what it
        lets through). Switched on once; a tool it has not seen yet gets the level the API asked for."""
        if not self._permissions_on:
            await self.rpc(self.settings.mgmt_url, "config.set", {"permissions_enabled": True})
            self._permissions_on = True
        for tool in tools:
            await self.rpc(self.settings.mgmt_url, "permissions.tools.update", {
                "tool": f"mcp_{server}_{tool['name']}", "level": tool.get("approval") or "allow",
            })

    async def stream(self, request: AgentRunRequest) -> AsyncIterator[str]:
        name = SERVER_NAME
        server_held = False
        token = None
        llm_token = None
        model_alias = None
        jw_session = request.sessionKey or request.sessionId
        mapper = RunEventMapper(session_id=request.sessionId, mcp_prefixes=(f"mcp_{name}_",))
        params: dict[str, Any] = {
            "session_id": jw_session, "content": request.prompt, "query": request.prompt,
            "mode": request.mode, "cwd": request.cwd, "project_dir": request.cwd, "trusted_dirs": [request.cwd],
            "supports_user_interaction": True, "agent_ref": {"mode": request.mode, "id": "default"},
        }
        try:
            if request.tools:
                if request.bridge is None:
                    raise ValueError("tools were given without a bridge to run them")
                # JiuwenSwarm validates strictly; the model still sees the originals (see LlmRoute).
                token = self.registry.add(Toolset(
                    tools=[{**t.model_dump(), "inputSchema": relax_schema(t.inputSchema)} for t in request.tools],
                    call=bridge_caller(request.bridge, self.client(), self.skills.directories),
                ))
                # Before the model route: the server's name is in every tool name the model and JiuwenSwarm use.
                tools = [{**t.model_dump(), "inputSchema": relax_schema(t.inputSchema)} for t in request.tools]
                name = await self.ensure_shared_tools(tools, request.toolTimeoutSeconds or self.settings.tool_timeout_s)
                server_held = True
                mapper.mcp_prefixes = (f"mcp_{name}_",)
                params["mcp"] = [name]
            if request.model:
                if request.model.provider != "OpenAI":
                    raise ValueError(f"the {request.model.provider} protocol is not supported by this executor yet")
                # JiuwenSwarm talks to a private alias that points at this run's proxy route, which
                # forwards to the real endpoint with the real id, tool names and system prompt.
                # Its host tools are turned away whatever the caller asked: leaving one unlisted only keeps it out
                # of the model's tool list, and a call the model makes to it anyway would run on the host.
                hidden = frozenset(request.hiddenJiuwenSwarmTools) | JIUWENSWARM_HOST_TOOLS
                llm_token = self.routes.add(LlmRoute(
                    base_url=request.model.baseUrl.rstrip("/"), api_key=request.model.apiKey, model=request.model.model,
                    tool_prefix=f"mcp_{name}_", tool_names=frozenset(t.name for t in request.tools),
                    tool_specs={t.name: {"description": t.description, "parameters": t.inputSchema} for t in request.tools},
                    system_prompt=request.systemPrompt, system_prompt_mode=request.systemPromptMode,
                    system_prompt_tail=request.systemPromptTail,
                    native_tools=frozenset(request.nativeTools) - hidden, all_native_tools=request.jiuwenSwarmTools == "all",
                    hidden_native_tools=hidden, run_tag=token,
                ))
                # Named after the real model: JiuwenSwarm tells the model its own model's name (runtime state), and
                # the alias is all it knows. The suffix keeps two runs of one model apart.
                model_alias = f"{model_alias_base(request.model.model)}-{llm_token[:6]}"
                await self.ensure_default_model()
                params["model_name"] = await self.models.ensure(ModelProfile(
                    model_alias, f"{self.settings.public_url}/llm/{llm_token}/v1", llm_token, "OpenAI",))
            async with self.chat_run(self.settings.gateway_url, params) as run:
                try:
                    async for frame in run:
                        for event in mapper.feed(frame):
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
            yield json.dumps({"done": {
                "finalText": mapper.final_text or "", "unmapped": mapper.unmapped,
                "cancelled": mapper._cancel_requested,
            }}, ensure_ascii=False) + "\n"
        except (gateway.GatewayError, ValueError, httpx.HTTPError) as error:
            failure = {"type": "run.failed", "error": str(error), "errorCode": "transport-error"}
            yield json.dumps({"event": failure}, ensure_ascii=False) + "\n"
            yield json.dumps({"done": {"finalText": "", "unmapped": mapper.unmapped, "cancelled": False}}) + "\n"
        finally:
            if llm_token:
                self.routes.remove(llm_token)
            if model_alias:
                try:
                    await self.models.remove(model_alias)
                except Exception:
                    pass
            if token:
                self.registry.remove(token)  # the shared server stays; calls for this run find nothing now
            if server_held:
                try:
                    await self.release_shared_tools(name)
                except Exception:
                    pass
            for request_id in [key for key, (_, owner) in self.pending_approvals.items() if owner is mapper]:
                self.pending_approvals.pop(request_id, None)


def agent_router(runner: AgentRunner, settings: Settings) -> APIRouter:
    router = APIRouter()

    @router.post("/agent/runs")
    async def create_run(body: AgentRunRequest, authorization: str | None = Header(default=None)) -> StreamingResponse:
        if settings.agent_token and authorization != f"Bearer {settings.agent_token}":
            raise HTTPException(status_code=401, detail="unauthorized")
        return StreamingResponse(runner.stream(body), media_type="application/x-ndjson")

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
