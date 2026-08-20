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

"""Blocking HTTP call back into the Node control API for tool execution.

The Node control API is the callback target: it runs the real tool handler
(bubblewrap runner, permission gate, provenance) and returns the result. The
target is captured per run into each proxy tool's closure (tools are built per
request), so no shared or thread-local state is involved.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class CallbackTarget:
    url: str
    token: str


def invoke_node_tool(target: CallbackTarget, name: str, args: dict, tool_call_id: str | None) -> str:
    """Run a workspace tool back on the Node control API, return its text result.

    Blocking on purpose: this executes inside LangGraph's synchronous tool
    dispatch on the run's worker thread. A non-2xx, transport error, or
    is_error result becomes the tool's error text so the agent loop can see
    and react to it, matching how the in-process pi tools surfaced thrown
    errors as tool results.
    """
    try:
        response = httpx.post(
            target.url,
            headers={"authorization": f"Bearer {target.token}"},
            json={"name": name, "args": args, "toolCallId": tool_call_id},
            timeout=None,
        )
    except httpx.HTTPError as exc:
        return f"Tool callback transport error: {exc}"
    if response.status_code >= 400:
        try:
            detail = response.json().get("error", response.text)
        except Exception:
            detail = response.text
        return f"Tool error: {detail}"
    payload = response.json()
    content = payload.get("content", "")
    if payload.get("is_error"):
        return f"Tool error: {content}"
    return content
