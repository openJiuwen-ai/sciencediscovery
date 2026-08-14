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

"""Minimal OpenAI-compatible mock model for exercising the deer-flow sidecar.

Dev/test only. There is no model credential in this environment, so this server
lets us prove the orchestration plumbing end-to-end: the harness runs a real
agent loop, calls one tool, and streams a final answer — all deterministically.

Behaviour of POST /v1/chat/completions:
  * If the request carries `tools` AND no prior `role:"tool"` message exists yet,
    emit exactly ONE tool call. The tool + args are chosen from env
    MOCK_TOOL_NAME / MOCK_TOOL_ARGS (JSON) when set, else the first advertised
    tool with minimal schema-valid args.
  * Otherwise (a tool result is already present, or no tools) emit a short final
    text answer.
  * Honours `stream: true` (SSE chunks) and `stream: false` (single JSON) — the
    non-streaming path also covers deer-flow's TitleMiddleware title call.

Run:  MOCK_TOOL_NAME=sci_echo python test/gateway/mock_model.py --port 9099
"""

from __future__ import annotations

import argparse
import json
import os
import time
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

MODEL_ID = os.environ.get("MOCK_MODEL_ID", "mock-1")

app = FastAPI()


def _minimal_args_from_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Build a minimal object that satisfies a JSON-schema `required` list."""
    args: dict[str, Any] = {}
    props = (schema or {}).get("properties", {}) or {}
    for name in (schema or {}).get("required", []) or []:
        spec = props.get(name, {})
        typ = spec.get("type")
        if typ == "string":
            args[name] = spec.get("enum", ["mock"])[0]
        elif typ in ("integer", "number"):
            args[name] = 0
        elif typ == "boolean":
            args[name] = False
        elif typ == "array":
            args[name] = []
        elif typ == "object":
            args[name] = {}
        else:  # unconstrained / anyOf — a string is the safest placeholder
            args[name] = "mock"
    return args


def _choose_tool_call(tools: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    """Pick which tool to call and with what args."""
    forced_name = os.environ.get("MOCK_TOOL_NAME")
    forced_args = os.environ.get("MOCK_TOOL_ARGS")
    names = [t.get("function", {}).get("name") for t in tools]
    if os.environ.get("MOCK_DEBUG"):
        import sys
        print(f"[mock] forced_name={forced_name!r} advertised={names}", file=sys.stderr, flush=True)
    if forced_name and forced_name in names:
        target = next(t for t in tools if t["function"]["name"] == forced_name)
    else:
        target = tools[0]
    name = target["function"]["name"]
    if forced_args is not None and (not forced_name or forced_name == name):
        args = json.loads(forced_args)
    else:
        args = _minimal_args_from_schema(target["function"].get("parameters", {}))
    return name, args


def _wants_tool_call(body: dict[str, Any]) -> bool:
    tools = body.get("tools") or []
    if not tools:
        return False
    messages = body.get("messages") or []
    already_used_a_tool = any(m.get("role") == "tool" for m in messages)
    return not already_used_a_tool


def _chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
    return {
        "id": "chatcmpl-mock",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj)}\n\n"


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "mock"}]}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    stream = bool(body.get("stream"))
    usage = {"prompt_tokens": 8, "completion_tokens": 8, "total_tokens": 16}

    if _wants_tool_call(body):
        name, args = _choose_tool_call(body["tools"])
        call_id = "call_mock_1"
        if not stream:
            return JSONResponse(
                {
                    "id": "chatcmpl-mock",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": MODEL_ID,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": call_id,
                                        "type": "function",
                                        "function": {"name": name, "arguments": json.dumps(args)},
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                    "usage": usage,
                }
            )

        def gen_tool():
            yield _sse(_chunk({"role": "assistant", "content": None,
                               "tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                               "function": {"name": name, "arguments": ""}}]}))
            yield _sse(_chunk({"tool_calls": [{"index": 0, "function": {"arguments": json.dumps(args)}}]}))
            yield _sse(_chunk({}, finish="tool_calls"))
            yield _sse({**_chunk({}), "choices": [], "usage": usage})
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen_tool(), media_type="text/event-stream")

    text = os.environ.get(
        "MOCK_FINAL_TEXT",
        "Done. I called the workspace tool and summarized its result.",
    )
    if not stream:
        return JSONResponse(
            {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": MODEL_ID,
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
                ],
                "usage": usage,
            }
        )

    def gen_text():
        yield _sse(_chunk({"role": "assistant", "content": ""}))
        for word in text.split(" "):
            yield _sse(_chunk({"content": word + " "}))
        yield _sse(_chunk({}, finish="stop"))
        yield _sse({**_chunk({}), "choices": [], "usage": usage})
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen_text(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9099)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
