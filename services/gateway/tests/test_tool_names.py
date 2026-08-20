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

from __future__ import annotations

import json
import re
import unittest

import httpx
from langchain_core.messages import HumanMessage

from science_agent_gateway.callback import CallbackTarget
from science_agent_gateway.model import build_reasoning_chat_model
from science_agent_gateway.tools import build_proxy_tools


ENVIRONMENT_TOOL_NAMES = [
    "environment_list",
    "environment_create",
    "environment_delete",
    "environment_install",
    "environment_uninstall",
]


class ProviderToolNameTests(unittest.TestCase):
    def setUp(self) -> None:
        self.requests: list[dict] = []
        self.http_client = httpx.Client(transport=httpx.MockTransport(self._provider))
        specs = [
            {
                "name": name,
                "description": name,
                "input_schema": {"type": "object", "properties": {}},
            }
            for name in ENVIRONMENT_TOOL_NAMES
        ]
        proxy_tools = build_proxy_tools(
            specs,
            CallbackTarget(url="http://127.0.0.1:1/internal/tool-exec", token="redacted"),
        )
        model = build_reasoning_chat_model(
            model="provider-tool-name-test",
            base_url="https://provider.invalid/v1",
            api_key="redacted",
            http_client=self.http_client,
            max_retries=0,
            stream_usage=True,
        )
        self.model = model.bind_tools(proxy_tools)

    def tearDown(self) -> None:
        self.http_client.close()

    def _provider(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        names = [tool["function"]["name"] for tool in payload["tools"]]
        if any(re.fullmatch(r"[a-zA-Z0-9_-]+", name) is None for name in names):
            return httpx.Response(
                400,
                json={
                    "error": {
                        "message": "Invalid function.name: string does not match pattern",
                        "type": "invalid_request_error",
                    }
                },
            )
        self.requests.append(payload)

        if payload.get("stream"):
            chunks = [
                {
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "provider-tool-name-test",
                    "choices": [{"index": 0, "delta": {"role": "assistant", "content": "ok"}, "finish_reason": None}],
                },
                {
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "provider-tool-name-test",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                },
                {
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "provider-tool-name-test",
                    "choices": [],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                },
            ]
            body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
            return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "created": 1,
                "model": "provider-tool-name-test",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )

    def assert_latest_tool_names(self) -> None:
        names = [tool["function"]["name"] for tool in self.requests[-1]["tools"]]
        self.assertEqual(names, ENVIRONMENT_TOOL_NAMES)
        self.assertTrue(all(re.fullmatch(r"[a-zA-Z0-9_-]+", name) for name in names))

    def test_non_streaming_provider_request_uses_fixed_names(self) -> None:
        response = self.model.invoke([HumanMessage(content="redacted")])
        self.assertEqual(response.content, "ok")
        self.assertFalse(self.requests[-1]["stream"])
        self.assert_latest_tool_names()

    def test_streaming_provider_request_uses_fixed_names(self) -> None:
        response = "".join(str(chunk.content) for chunk in self.model.stream([HumanMessage(content="redacted")]))
        self.assertEqual(response, "ok")
        self.assertTrue(self.requests[-1]["stream"])
        self.assert_latest_tool_names()


if __name__ == "__main__":
    unittest.main()
