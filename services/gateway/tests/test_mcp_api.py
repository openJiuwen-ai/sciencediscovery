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

import time
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from langchain_core.messages import AIMessage
from langgraph.prebuilt import ToolNode
from langgraph.runtime import Runtime

from science_agent_gateway._engine import (
    McpServerDefinition,
    get_tool_routing,
    is_deferred_tool,
)
from science_agent_gateway.callback import CallbackTarget
from science_agent_gateway.mcp_api import (
    ExecutionPolicy,
    InvokeContext,
    InvokeRequest,
    RetryPolicy,
    _catalog_payload,
    _classify_error,
    _invoke_with_retry,
    require_internal_token,
)
from science_agent_gateway.tools import build_proxy_tools


class FakeTool:
    def __init__(self, name: str, outcomes: list[object]) -> None:
        self.name = name
        self.description = f"{name} description"
        self.args_schema = {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        }
        self.metadata = {}
        self._outcomes = outcomes
        self.calls = 0

    async def ainvoke(self, arguments, config=None):
        del arguments, config
        outcome = self._outcomes[min(self.calls, len(self._outcomes) - 1)]
        self.calls += 1
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def invoke_request(retry_policy: RetryPolicy | None = None) -> InvokeRequest:
    return InvokeRequest(
        request_id="request-1",
        server_id="demo",
        tool_name="search",
        arguments={"query": "TP53"},
        context=InvokeContext(
            project_id="project-1",
            session_id="session-1",
            tool_call_id="tool-call-1",
            turn_id="turn-1",
        ),
        execution=ExecutionPolicy(
            retry_policy=retry_policy or RetryPolicy(retry_on=[]),
            timeout_ms=2_000,
        ),
    )


class McpApiTests(unittest.IsolatedAsyncioTestCase):
    def test_proxy_tool_preserves_deferred_mcp_routing_metadata(self) -> None:
        tools = build_proxy_tools(
            [{
                "name": "mcp__uniprot__lookup",
                "description": "Lookup protein",
                "input_schema": {"type": "object", "properties": {}},
                "deferred": True,
                "source_id": "uniprot",
                "tool_id": "lookup",
                "routing": {
                    "keywords": ["protein", "accession"],
                    "mode": "prefer",
                    "priority": 90,
                },
            }],
            CallbackTarget(url="http://127.0.0.1:1/internal/tool-exec", token="test"),
        )
        self.assertTrue(is_deferred_tool(tools[0]))
        self.assertEqual(get_tool_routing(tools[0])["priority"], 90)

    def test_tool_node_runs_one_model_batch_in_parallel_and_waits_for_all(self) -> None:
        tools = build_proxy_tools(
            [
                {"name": "first", "input_schema": {"type": "object", "properties": {}}},
                {"name": "second", "input_schema": {"type": "object", "properties": {}}},
            ],
            CallbackTarget(url="http://127.0.0.1:1/internal/tool-exec", token="test"),
        )

        def delayed_result(_target, name, _args, _tool_call_id):
            time.sleep(0.2)
            self.assertIn(_tool_call_id, {"call-first", "call-second"})
            return f"{name}-done"

        started = time.monotonic()
        with patch("science_agent_gateway.tools.invoke_node_tool", side_effect=delayed_result):
            output = ToolNode(tools)._func({
                "messages": [AIMessage(content="", tool_calls=[
                    {"args": {}, "id": "call-first", "name": "first", "type": "tool_call"},
                    {"args": {}, "id": "call-second", "name": "second", "type": "tool_call"},
                ])],
            }, {}, Runtime())
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, 0.35)
        self.assertEqual(
            [message.content for message in output["messages"]],
            ["first-done", "second-done"],
        )

    async def test_catalog_is_token_protected(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            require_internal_token(None)
        self.assertEqual(raised.exception.status_code, 401)

    def test_catalog_exposes_original_tool_name_and_stable_revision(self) -> None:
        servers = {
            "demo": McpServerDefinition(
                description="Demo source",
                enabled=True,
                transport="stdio",
            ),
        }
        tool = FakeTool("demo_search", ["ok"])
        with (
            patch("science_agent_gateway.mcp_api.load_mcp_servers", return_value=servers),
            patch("science_agent_gateway.mcp_api.get_mcp_tools", return_value=[tool]),
        ):
            first = _catalog_payload()
            second = _catalog_payload()
        self.assertEqual(first.revision, second.revision)
        self.assertEqual(first.servers[0].tools[0].name, "search")
        self.assertEqual(first.servers[0].transport, "stdio")

    async def test_invoke_returns_normalized_content(self) -> None:
        tool = FakeTool("demo_search", [[{"type": "text", "text": "result"}]])
        with patch("science_agent_gateway.mcp_api.get_mcp_tools", return_value=[tool]):
            result = await _invoke_with_retry(invoke_request())
        self.assertFalse(result.is_error)
        self.assertEqual(result.content, [{"type": "text", "text": "result"}])
        self.assertEqual(result.attempts[0].status, "succeeded")

    async def test_invoke_retries_only_declared_transient_errors(self) -> None:
        tool = FakeTool("demo_search", [RuntimeError("HTTP 503 service unavailable"), "recovered"])
        policy = RetryPolicy(
            initial_delay_ms=1,
            jitter_ratio=0,
            max_attempts=2,
            max_delay_ms=1,
            retry_on=["server-error"],
        )
        with patch("science_agent_gateway.mcp_api.get_mcp_tools", return_value=[tool]):
            result = await _invoke_with_retry(invoke_request(policy))
        self.assertFalse(result.is_error)
        self.assertEqual(tool.calls, 2)
        self.assertEqual([attempt.status for attempt in result.attempts], ["server-error", "succeeded"])

    async def test_invoke_does_not_retry_semantic_errors(self) -> None:
        tool = FakeTool("demo_search", [RuntimeError("invalid query")])
        policy = RetryPolicy(max_attempts=3, retry_on=["server-error"])
        with patch("science_agent_gateway.mcp_api.get_mcp_tools", return_value=[tool]):
            result = await _invoke_with_retry(invoke_request(policy))
        self.assertTrue(result.is_error)
        self.assertEqual(tool.calls, 1)
        self.assertEqual(result.attempts[0].status, "semantic-error")

    async def test_invoke_rejects_a_response_larger_than_the_node_policy(self) -> None:
        tool = FakeTool("demo_search", ["x" * 2_000])
        request = invoke_request()
        request.execution.max_response_bytes = 1_024
        with patch("science_agent_gateway.mcp_api.get_mcp_tools", return_value=[tool]):
            result = await _invoke_with_retry(request)
        self.assertTrue(result.is_error)
        self.assertEqual(result.attempts[0].error_code, "RESPONSE_TOO_LARGE")
        self.assertEqual(tool.calls, 1)

    async def test_invoke_does_not_retry_unauthorized_errors(self) -> None:
        tool = FakeTool("demo_search", [RuntimeError("HTTP 401 Unauthorized")])
        policy = RetryPolicy(max_attempts=3, retry_on=["server-error", "transport-error"])
        with patch("science_agent_gateway.mcp_api.get_mcp_tools", return_value=[tool]):
            result = await _invoke_with_retry(invoke_request(policy))
        self.assertTrue(result.is_error)
        self.assertEqual(result.attempts[0].error_code, "UNAUTHORIZED")
        self.assertEqual(tool.calls, 1)

    def test_classify_error_reads_retry_after_anchored_to_the_token(self) -> None:
        status, _message, retry_after_ms = _classify_error(
            RuntimeError("HTTP 429 Too Many Requests from export.arxiv.org (retry-after: 5)"),
        )
        self.assertEqual(status, "rate-limited")
        # The status code before the token must not be misread as the delay.
        self.assertEqual(retry_after_ms, 5_000)

    def test_classify_error_without_retry_after_token_has_no_delay(self) -> None:
        status, _message, retry_after_ms = _classify_error(
            RuntimeError("HTTP 429 Too Many Requests from export.arxiv.org"),
        )
        self.assertEqual(status, "rate-limited")
        self.assertIsNone(retry_after_ms)


if __name__ == "__main__":
    unittest.main()
