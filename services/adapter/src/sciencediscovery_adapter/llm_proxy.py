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

"""A per-run OpenAI chat-completions proxy between JiuwenSwarm and the real model.

JiuwenSwarm names MCP tools `mcp_<server>_<tool>`, offers the model dozens of
tools of its own and wraps the prompt in its own persona. ScienceDiscovery's
model was tuned against its own tool names, toolset and system prompt, so the
proxy gives it those back:

- the tool list is cut to the run's toolset and the `mcp_<server>_` prefix removed;
- the system prompt is replaced by the caller's, when it sent one;
- the model id is the real one (JiuwenSwarm addresses the run by a private alias);
- tool calls coming back are given the prefix again so JiuwenSwarm can route them.

Only the OpenAI chat-completions protocol is handled.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from .mcp_server import RUN_ARG
from starlette.background import BackgroundTask


@dataclass
class LlmRoute:
    base_url: str  # the real endpoint, up to and including /v1
    api_key: str
    model: str  # the real model id
    tool_prefix: str  # "mcp_<server>_"
    tool_names: frozenset[str]  # the run's tools, unprefixed
    system_prompt: str | None = None
    # The tools as the caller defined them. JiuwenSwarm holds a relaxed copy of the schema
    # (see schema.relax_schema); the model gets the original back, constraints included.
    tool_specs: dict[str, dict[str, Any]] = field(default_factory=dict)
    # JiuwenSwarm's own tools the model may keep, by their own names; the model sees their own specs.
    native_tools: frozenset[str] = frozenset()
    # "replace": `system_prompt` takes the place of JiuwenSwarm's own system prompt. "prepend": JiuwenSwarm's
    # prompt (identity, safety, tool rules, memory, context compression, installed skills) stays whole, with
    # `system_prompt` before it and `system_prompt_tail` after it. "append": JiuwenSwarm's first, then ours.
    system_prompt_mode: str = "replace"
    # Put last, after JiuwenSwarm's prompt: what changes from turn to turn (the run contract), so that
    # everything before it is the same prefix on every request and can be cached by the provider.
    system_prompt_tail: str | None = None
    # Offer every one of JiuwenSwarm's own tools, not only `native_tools`. Where one of ours has the same
    # name, JiuwenSwarm's is kept and ours is not offered (`shadowed`, filled in as requests go by).
    all_native_tools: bool = False
    shadowed: set[str] = field(default_factory=set)
    # JiuwenSwarm's own tools the model never gets: those that act on the host (bash, file reads and writes), whose
    # work goes to ScienceDiscovery's tools, in its sandbox and Runner. One of ours of the same name is offered instead,
    # and a call the model makes to one anyway (JiuwenSwarm's prompt still names them) is turned away.
    hidden_native_tools: frozenset[str] = frozenset()
    # The run's tag: put in each call of one of its tools, it tells the shared MCP server which run the call is for.
    run_tag: str | None = None
    # The calls the model made, oldest first, as JiuwenSwarm is asked to run them (name, arguments without the run
    # tag): an approval question from JiuwenSwarm names the tool but not the arguments, which the user needs to see.
    recent_calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    def take_call(self, question: str) -> tuple[str, dict[str, Any]] | None:
        """The oldest call not yet asked about whose tool the question names (longest name first, so that
        `mcp_sci_read_file` is not taken for `read_file`)."""
        for name in sorted({name for name, _ in self.recent_calls}, key=len, reverse=True):
            if name in question:
                index = next(i for i, (called, _) in enumerate(self.recent_calls) if called == name)
                return self.recent_calls.pop(index)
        return None


@dataclass
class LlmRoutes:
    _routes: dict[str, LlmRoute] = field(default_factory=dict)
    # Bearer key of JiuwenSwarm's default-model entry (see `default_completions`).
    default_key: str = field(default_factory=lambda: secrets.token_hex(16))

    def add(self, route: LlmRoute) -> str:
        token = secrets.token_hex(16)
        self._routes[token] = route
        return token

    def get(self, token: str) -> LlmRoute | None:
        return self._routes.get(token)

    def remove(self, token: str) -> None:
        self._routes.pop(token, None)

    def latest(self) -> LlmRoute | None:
        """The model of the run that started last and is still going."""
        return next(reversed(self._routes.values()), None)


# The prefix JiuwenSwarm gave the tools of each run's own MCP server, before there was one server for all (`mcp_` + the server name `sci` + 10 characters,
# see agent_runs). Each run has its own server, and a session's history, which JiuwenSwarm keeps across runs,
# holds the calls of earlier runs under their prefixes. Those servers are gone once their run ended.
# The shared server's later generations (agent_runs.ensure_shared_tools) are named the same way, `sci` + ten digits, and
# its first is plain `sci`: a session's history can hold calls made through any of them.
_ANY_RUN_PREFIX = re.compile(r"^mcp_sci(?:[0-9a-z]{10})?_")


def _unprefixed(name: str, route: LlmRoute) -> str:
    """The tool's own name, whichever run's server the prefix came from."""
    if name.startswith(route.tool_prefix):
        return name.removeprefix(route.tool_prefix)
    earlier = _ANY_RUN_PREFIX.match(name)
    if earlier and name[earlier.end():] in route.tool_names:
        return name[earlier.end():]
    return name


def _original(function: dict[str, Any], route: LlmRoute) -> dict[str, Any]:
    if not function["name"].startswith(route.tool_prefix):
        # One of JiuwenSwarm's own tools: its own description and parameters, even when one of ours has the
        # same name (JiuwenSwarm's read_file takes `file_path`, ours `path`).
        return function
    name = _unprefixed(function["name"], route)
    spec = route.tool_specs.get(name)
    if spec is None:
        return {**function, "name": name}
    return {**function, "name": name, "description": spec["description"], "parameters": spec["parameters"]}


_DEBUG = os.environ.get("SCIENCE_AGENT_ADAPTER_DEBUG") in ("1", "2")
# 2: every message of every model request, as far as the first 1500 characters (what JiuwenSwarm adds around the prompt).
_DEBUG_FULL = os.environ.get("SCIENCE_AGENT_ADAPTER_DEBUG") == "2"
_TRACE_TOOLS = os.environ.get("SCIENCE_AGENT_TRACE_TOOLS") == "1"


def rewrite_request(body: dict[str, Any], route: LlmRoute) -> dict[str, Any]:
    out = dict(body)
    out["model"] = route.model
    if body.get("tools"):
        names = [tool.get("function", {}).get("name", "") for tool in body["tools"]]
        native = {name for name in names if not name.startswith(route.tool_prefix)} - route.hidden_native_tools
        if route.all_native_tools:
            route.shadowed |= native & route.tool_names

        def keep(name: str) -> bool:
            if _is_ours(name, route):
                return _unprefixed(name, route) not in route.shadowed
            if name in route.hidden_native_tools:
                return False
            return name in route.native_tools or (route.all_native_tools and name in native)

        out["tools"] = [
            {**tool, "function": _original(tool["function"], route)}
            for tool in body["tools"] if keep(tool.get("function", {}).get("name", ""))
        ]
        if not out["tools"]:
            del out["tools"]
            out.pop("tool_choice", None)
    if _TRACE_TOOLS:
        incoming = [t.get("function", {}).get("name", "") for t in body.get("tools") or []]
        outgoing = [t.get("function", {}).get("name", "") for t in out.get("tools") or []]
        expected = route.tool_names - route.shadowed
        print("[tool-contract] " + json.dumps({"run": route.run_tag, "expected": sorted(expected),
            "swarm": incoming, "llm": outgoing, "missing": sorted(expected - set(outgoing))}),
            file=sys.stderr, flush=True)
    choice = body.get("tool_choice")
    if isinstance(choice, dict) and isinstance(choice.get("function"), dict):
        out["tool_choice"] = {**choice, "function": {**choice["function"], "name": _unprefixed(choice["function"]["name"], route)}}
    if _DEBUG_FULL:
        for message in body.get("messages", []):
            if message.get("role") == "system":
                text = message.get("content") if isinstance(message.get("content"), str) else json.dumps(message.get("content"), ensure_ascii=False)
                print(f"[llm-proxy:jw-system] {len(text)} chars: {text!r}", file=sys.stderr, flush=True)
        print(f"[llm-proxy:jw-tools] {[t['function']['name'] for t in body.get('tools') or []]}", file=sys.stderr, flush=True)
    messages = []
    replaced = False
    for message in body.get("messages", []):
        message = dict(message)
        if message.get("role") == "system" and route.system_prompt is not None:
            if replaced:
                continue  # one system prompt
            own = message.get("content")
            own = own if isinstance(own, str) else json.dumps(own, ensure_ascii=False)
            if route.system_prompt_mode == "prepend":
                message["content"] = "\n\n".join(p for p in (route.system_prompt, own, route.system_prompt_tail) if p)
            elif route.system_prompt_mode == "append":
                message["content"] = "\n\n".join(p for p in (own, route.system_prompt, route.system_prompt_tail) if p)
            else:
                message["content"] = "\n\n".join(p for p in (route.system_prompt, route.system_prompt_tail) if p)
            replaced = True
        for call in message.get("tool_calls") or []:
            call["function"] = {**call["function"], "name": _unprefixed(call["function"]["name"], route),
                                "arguments": _with_run_tag(call["function"].get("arguments"), None)}
        if isinstance(message.get("name"), str):
            message["name"] = _unprefixed(message["name"], route)
        messages.append(message)
    if route.system_prompt is not None and not replaced:
        messages.insert(0, {"role": "system", "content": "\n\n".join(p for p in (route.system_prompt, route.system_prompt_tail) if p)})
    out["messages"] = messages
    if _DEBUG:
        tail = [f"{m.get('role')}:{str(m.get('content'))[:90]!r}" for m in messages[-3:]]
        print(f"[llm-proxy] {len(messages)} messages, last: {tail}", file=sys.stderr, flush=True)
        if _DEBUG_FULL:
            for index, message in enumerate(messages):
                content = message.get("content")
                text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                shown = text if message.get("role") == "system" else text[:1500]  # the system prompt whole
                print(f"[llm-proxy:full] #{index} {message.get('role')} {len(text)} chars: {shown!r}", file=sys.stderr, flush=True)
            print(f"[llm-proxy:full] tools sent to the model: {[t['function']['name'] for t in out.get('tools', [])]}", file=sys.stderr, flush=True)
    return out


def _is_ours(name: str, route: LlmRoute) -> bool:
    """A tool of this run's toolset: JiuwenSwarm names those `<prefix><name>`.

    A name without the prefix is JiuwenSwarm's own tool, even when it is spelled like one of ours
    (`read_file`, `list_files`): letting it through would give the model two tools of one name.
    """
    return name.startswith(route.tool_prefix) and name.removeprefix(route.tool_prefix) in route.tool_names


# What a call to a hidden JiuwenSwarm tool is renamed to: no tool has that name, so JiuwenSwarm answers that it does
# not exist and the model carries on with the tools it was given, instead of JiuwenSwarm running it on the host.
UNAVAILABLE_PREFIX = "unavailable__"


def _prefixed(name: str, route: LlmRoute) -> str:
    # A model that copies an earlier run's name from the history is sent to this run's server.
    name = _unprefixed(name, route)
    if name in route.tool_names and name not in route.shadowed:
        return route.tool_prefix + name
    return UNAVAILABLE_PREFIX + name if name in route.hidden_native_tools else name


def _with_run_tag(arguments: Any, tag: str | None) -> Any:
    """Set/remove a run tag in complete JSON arguments (not streamed fragments)."""
    if not isinstance(arguments, str):
        return arguments
    try:
        parsed = json.loads(arguments) if arguments.strip() else {}
    except ValueError:
        return arguments
    if not isinstance(parsed, dict) or (tag is None and RUN_ARG not in parsed):
        return arguments
    parsed.pop(RUN_ARG, None)
    if tag is not None:
        parsed[RUN_ARG] = tag
    return json.dumps(parsed, ensure_ascii=False)


def _remember_call(function: dict[str, Any], route: LlmRoute) -> None:
    try:
        arguments = json.loads(function.get("arguments") or "{}")
    except (TypeError, ValueError):
        return  # Incomplete/malformed arguments must not become an approval summary.
    if isinstance(arguments, dict):
        arguments.pop(RUN_ARG, None)
        route.recent_calls.append((function["name"], arguments))
        del route.recent_calls[:-50]


def rewrite_response(payload: dict[str, Any], route: LlmRoute) -> dict[str, Any]:
    """Give tool calls the prefix again, and ours the run's tag. Works on a full response and on a stream chunk."""
    for choice in payload.get("choices") or []:
        for holder in (choice.get("message"), choice.get("delta")):
            for call in (holder or {}).get("tool_calls") or []:
                function = call.get("function") or {}
                if isinstance(function.get("name"), str):
                    function["name"] = _prefixed(function["name"], route)
                    if route.run_tag and function["name"].startswith(route.tool_prefix):
                        function["arguments"] = _with_run_tag(function.get("arguments"), route.run_tag)
                    _remember_call(function, route)
    return payload


_HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "host"}


class StreamingToolRewriter:
    """Forward arguments immediately, retaining only the final non-space byte.

    The authoritative run tag is appended before the closing object brace at
    finish_reason, never as a second JSON object. State is per response/choice/
    tool index, so parallel calls and concurrent model requests cannot mix.
    Complete raw arguments are retained separately for approval summaries.
    """
    def __init__(self, route: LlmRoute):
        self.route = route
        self.calls: dict[tuple[int, int], dict[str, Any]] = {}

    def rewrite(self, payload: dict[str, Any]) -> dict[str, Any]:
        for choice in payload.get("choices") or []:
            choice_index = choice.get("index", 0)
            delta = choice.get("delta") or {}
            for call in delta.get("tool_calls") or []:
                index = call.get("index", 0)
                state = self.calls.setdefault((choice_index, index), {"name": "", "raw": "", "tail": ""})
                function = call.get("function") or {}
                if isinstance(function.get("name"), str):
                    function["name"] = _prefixed(function["name"], self.route)
                    state["name"] = function["name"]
                fragment = function.get("arguments")
                if isinstance(fragment, str):
                    state["raw"] += fragment
                    if self.route.run_tag and state["name"].startswith(self.route.tool_prefix):
                        pending = state["tail"] + fragment
                        cut = max(0, len(pending.rstrip()) - 1)
                        function["arguments"], state["tail"] = pending[:cut], pending[cut:]
            if choice.get("finish_reason") is not None:
                for (owner, index), state in list(self.calls.items()):
                    if owner != choice_index:
                        continue
                    if self.route.run_tag and state["name"].startswith(self.route.tool_prefix):
                        parsed = json.loads(state["raw"].strip() or "{}")
                        if not isinstance(parsed, dict):
                            raise ValueError("platform tool arguments must be a JSON object")
                        tail = state["tail"]
                        if state["raw"].strip() and not tail.startswith("}"):
                            raise ValueError("platform tool arguments have no closing object brace")
                        suffix = (("," if parsed else "") if state["raw"].strip() else "{")
                        suffix += json.dumps(RUN_ARG) + ":" + json.dumps(self.route.run_tag) + "}" + tail[1:]
                        calls = delta.setdefault("tool_calls", [])
                        current = next((c for c in calls if c.get("index", 0) == index), None)
                        if current is None:
                            calls.append({"index": index, "function": {"arguments": suffix}})
                        else:
                            function = current.setdefault("function", {})
                            function["arguments"] = function.get("arguments", "") + suffix
                        choice["delta"] = delta
                    _remember_call({"name": state["name"], "arguments": state["raw"]}, self.route)
                    del self.calls[(owner, index)]
        return payload


async def _rewrite_stream(upstream: httpx.Response, route: LlmRoute) -> AsyncIterator[bytes]:
    buffer = ""
    rewriter = StreamingToolRewriter(route)
    async for text in upstream.aiter_text():
        buffer += text
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            if line.startswith("data:") and line[5:].strip() not in ("", "[DONE]"):
                try:
                    payload = json.loads(line[5:])
                except json.JSONDecodeError:
                    pass  # not JSON: pass it through untouched
                else:
                    try:
                        payload = rewriter.rewrite(payload)
                    except ValueError:
                        yield b'data: {"error":{"message":"invalid streamed platform tool arguments"}}\n\n'
                        return
                    line = "data: " + json.dumps(payload, ensure_ascii=False)
            yield (line + "\n").encode()
    if buffer:
        yield buffer.encode()


# The name of JiuwenSwarm's default-model entry. JiuwenSwarm's own housekeeping calls (compressing a long
# conversation, titling a session, probing a new model) use its default model, not the model of the run;
# a fresh install's default is a placeholder that answers with an HTML page, so nothing it does with a model
# works until the default points somewhere real.
DEFAULT_ALIAS = "sciencediscovery-default"


def llm_router(routes: LlmRoutes, client_getter) -> APIRouter:
    router = APIRouter()

    async def forward(route: LlmRoute, body: dict[str, Any], *, restore_names: bool) -> Response:
        client: httpx.AsyncClient = client_getter()
        upstream_request = client.build_request(
            "POST", f"{route.base_url}/chat/completions", json=body,
            headers={
                **({"authorization": f"Bearer {route.api_key}"} if route.api_key else {}),
                **({"x-sciencediscovery-model-purpose": "housekeeping"} if not restore_names else {}),
            },
        )
        try:
            upstream = await client.send(upstream_request, stream=True)
        except httpx.HTTPError as error:
            return JSONResponse({"error": {"message": f"model endpoint unreachable: {type(error).__name__}"}}, status_code=502)
        headers = {k: v for k, v in upstream.headers.items() if k.lower() not in _HOP_BY_HOP}
        if "text/event-stream" in upstream.headers.get("content-type", ""):
            stream = _rewrite_stream(upstream, route) if restore_names else upstream.aiter_raw()
            return StreamingResponse(
                stream, status_code=upstream.status_code, headers=headers,
                media_type="text/event-stream", background=BackgroundTask(upstream.aclose),
            )
        content = await upstream.aread()
        await upstream.aclose()
        if upstream.status_code == 200 and restore_names:
            try:
                content = json.dumps(rewrite_response(json.loads(content), route), ensure_ascii=False).encode()
            except ValueError:
                pass
        return Response(content, status_code=upstream.status_code, headers=headers,
                        media_type=upstream.headers.get("content-type", "application/json"))

    # Registered before the `{token}` route so that "default" is not taken for a run's token.
    @router.post("/llm/default/v1/chat/completions")
    async def default_completions(request: Request) -> Response:
        """JiuwenSwarm's own model calls, sent on to the model of the run in progress, untouched.

        No system prompt, tool list or tool name is rewritten: these are JiuwenSwarm's requests, not the
        agent's. With no run in progress there is no model to use.
        """
        if request.headers.get("authorization") != f"Bearer {routes.default_key}":
            return JSONResponse({"error": {"message": "unauthorized"}}, status_code=401)
        route = routes.latest()
        if route is None:
            return JSONResponse({"error": {"message": "no run in progress: no model to use"}}, status_code=503)
        return await forward(route, {**await request.json(), "model": route.model}, restore_names=False)

    @router.post("/llm/{token}/v1/chat/completions")
    async def completions(token: str, request: Request) -> Response:
        route = routes.get(token)
        if route is None:
            return JSONResponse({"error": {"message": "unknown route"}}, status_code=404)
        return await forward(route, rewrite_request(await request.json(), route), restore_names=True)

    return router
