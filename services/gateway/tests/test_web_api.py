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

import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from science_agent_gateway.internal_auth import require_internal_token
from science_agent_gateway.web_api import (
    MAX_TOOL_RESPONSE_BYTES,
    WebInvokeRequest,
    WebProviderOptions,
    invoke_web,
)
from science_agent_gateway.web_providers import JinaResult, ProviderAttempt


def web_options(**values: object) -> WebProviderOptions:
    return WebProviderOptions.model_validate(values)


class WebApiHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_camel_case_wire_parses_generic_provider_options(self) -> None:
        request = WebInvokeRequest.model_validate({
            "operation": "search",
            "provider": "ddgs",
            "arguments": {"query": "TP53"},
            "options": {
                "apiKey": "secret",
                "backend": "duckduckgo",
                "proxyEnvironment": {"HTTPS_PROXY": "http://proxy.example.test:8080"},
                "proxyMode": "environment",
            },
            "timeoutMs": 1_234,
        })

        self.assertEqual(request.timeout_ms, 1_234)
        self.assertEqual(request.options.api_key, "secret")
        self.assertEqual(request.options.proxy_environment, {
            "HTTPS_PROXY": "http://proxy.example.test:8080",
        })
        self.assertEqual(request.options.proxy_mode, "environment")

    async def test_invoke_is_internal_only(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            require_internal_token(None)
        self.assertEqual(raised.exception.status_code, 401)

    async def test_search_http_response_omits_null_optional_fields(self) -> None:
        with patch(
            "science_agent_gateway.web_api.invoke_ddgs_search",
            new=AsyncMock(return_value='[{"title":"TP53"}]'),
        ):
            response = await invoke_web(WebInvokeRequest(
                operation="search",
                provider="ddgs",
                arguments={"query": "TP53"},
                options=web_options(backend="bing", proxy_mode="direct"),
            ))

        encoded = response.model_dump(mode="json", by_alias=True, exclude_none=True)
        self.assertEqual(encoded, {
            "content": '[{"title":"TP53"}]',
            "durationMs": encoded["durationMs"],
            "isError": False,
        })

    async def test_search_http_response_preserves_provider_error_without_null_attempts(self) -> None:
        with patch(
            "science_agent_gateway.web_api.invoke_ddgs_search",
            new=AsyncMock(return_value="Error: HTTP 429 Too Many Requests"),
        ):
            response = await invoke_web(WebInvokeRequest(
                operation="search",
                provider="ddgs",
                arguments={"query": "TP53"},
                options=web_options(proxy_mode="environment"),
            ))

        body = response.model_dump(mode="json", by_alias=True, exclude_none=True)
        self.assertNotIn("attempts", body)
        self.assertEqual(body["errorCode"], "rate-limited")
        self.assertEqual(body["errorMessage"], "Error: HTTP 429 Too Many Requests")

    async def test_keyed_provider_requires_a_key(self) -> None:
        request = WebInvokeRequest(
            operation="search",
            provider="tavily",
            arguments={"query": "TP53"},
            options=web_options(proxy_mode="environment"),
        )
        with self.assertRaises(HTTPException) as raised:
            await invoke_web(request)
        self.assertEqual(raised.exception.status_code, 400)
        self.assertNotIn("api_key", str(raised.exception.detail))

    async def test_fetch_rejects_private_network_targets(self) -> None:
        request = WebInvokeRequest(
            operation="fetch",
            provider="jina",
            arguments={"url": "http://127.0.0.1/private"},
            options=web_options(proxy_mode="direct"),
        )
        with self.assertRaises(HTTPException) as raised:
            await invoke_web(request)
        self.assertEqual(raised.exception.status_code, 400)

    async def test_provider_operation_combination_is_allowlisted(self) -> None:
        request = WebInvokeRequest(
            operation="fetch",
            provider="brave",
            arguments={"url": "https://example.org"},
            options=web_options(api_key="secret", proxy_mode="direct"),
        )
        with self.assertRaises(HTTPException) as raised:
            await invoke_web(request)
        self.assertEqual(raised.exception.status_code, 400)


class WebApiTests(unittest.IsolatedAsyncioTestCase):

    async def test_engine_invocation_uses_request_scoped_options(self) -> None:
        request = WebInvokeRequest(
            operation="search",
            provider="tavily",
            arguments={"query": "TP53"},
            options=web_options(api_key="secret"),
        )
        fake_tool = MagicMock()
        fake_tool.ainvoke = AsyncMock(return_value='[{"title":"TP53","url":"https://example.org"}]')
        with (
            patch("science_agent_gateway._engine.web.resolve_variable", return_value=fake_tool),
            patch("science_agent_gateway._engine.web.push_current_app_config") as push,
            patch("science_agent_gateway._engine.web.pop_current_app_config") as pop,
        ):
            response = await invoke_web(request)

        self.assertFalse(response.is_error)
        push.assert_called_once()
        pop.assert_called_once_with()
        scoped_config = push.call_args.args[0]
        tool_config = scoped_config.tools[0]
        self.assertEqual(tool_config.model_extra["api_key"], "secret")

    async def test_invocation_does_not_resolve_global_config(self) -> None:
        request = WebInvokeRequest(
            operation="search",
            provider="tavily",
            arguments={"query": "TP53"},
            options=web_options(api_key="secret"),
        )
        fake_tool = MagicMock()
        fake_tool.ainvoke = AsyncMock(return_value='[{"title":"TP53","url":"https://example.org"}]')
        with (
            patch(
                "science_agent_gateway._engine.web.AppConfig.resolve_config_path",
                side_effect=AssertionError("global config must not be read"),
            ),
            patch("science_agent_gateway._engine.web.resolve_variable", return_value=fake_tool),
        ):
            response = await invoke_web(request)

        self.assertFalse(response.is_error)

    async def test_environment_proxy_snapshot_is_validated_without_echoing_values(self) -> None:
        request = WebInvokeRequest(
            operation="search",
            provider="ddgs",
            arguments={"query": "TP53"},
            options=web_options(
                proxy_environment={"HTTPS_PROXY": "secret-invalid-value"},
                proxy_mode="environment",
            ),
        )
        with self.assertRaises(HTTPException) as raised:
            await invoke_web(request)
        self.assertEqual(raised.exception.status_code, 400)
        self.assertNotIn("secret-invalid-value", str(raised.exception.detail))

    async def test_projected_environment_runs_in_a_normalized_subprocess(self) -> None:
        request = WebInvokeRequest(
            operation="search",
            provider="tavily",
            arguments={"query": "TP53"},
            options=web_options(
                api_key="secret",
                proxy_environment={"HTTPS_PROXY": "http://effective.test:3"},
                proxy_mode="environment",
            ),
        )
        with patch(
            "science_agent_gateway.web_api.invoke_isolated_web_provider",
            new=AsyncMock(return_value='[{"title":"TP53"}]'),
        ) as isolated:
            response = await invoke_web(request)

        self.assertFalse(response.is_error)
        isolated.assert_awaited_once()
    async def test_provider_error_content_preserves_retry_classification(self) -> None:
        request = WebInvokeRequest(
            operation="search",
            provider="ddgs",
            arguments={"query": "TP53"},
            options=web_options(proxy_mode="direct"),
        )
        with patch(
            "science_agent_gateway.web_api.invoke_ddgs_search",
            new=AsyncMock(return_value="Error: HTTP 429 Too Many Requests"),
        ):
            response = await invoke_web(request)

        self.assertTrue(response.is_error)
        self.assertEqual(response.error_code, "rate-limited")

    async def test_provider_exception_does_not_expose_implementation_details(self) -> None:
        marker = "private-provider-module"
        request = WebInvokeRequest(
            operation="search",
            provider="ddgs",
            arguments={"query": "TP53"},
            options=web_options(proxy_mode="direct"),
        )
        with patch(
            "science_agent_gateway.web_api.invoke_ddgs_search",
            new=AsyncMock(side_effect=ConnectionError(marker)),
        ):
            response = await invoke_web(request)

        self.assertTrue(response.is_error)
        self.assertEqual(response.error_code, "transport-error")
        self.assertNotIn(marker, response.error_message or "")

    async def test_provider_response_size_is_bounded(self) -> None:
        request = WebInvokeRequest(
            operation="search",
            provider="ddgs",
            arguments={"query": "TP53"},
            options=web_options(proxy_mode="direct"),
        )
        with patch(
            "science_agent_gateway.web_api.invoke_ddgs_search",
            new=AsyncMock(return_value="x" * (MAX_TOOL_RESPONSE_BYTES + 1)),
        ):
            response = await invoke_web(request)

        self.assertTrue(response.is_error)
        self.assertEqual(response.error_code, "semantic-error")
        self.assertEqual(response.content, "")

    async def test_jina_route_attempts_are_returned_to_node(self) -> None:
        request = WebInvokeRequest(
            operation="fetch",
            provider="jina",
            arguments={"url": "https://example.org/article"},
            options=web_options(proxy_mode="direct"),
        )
        result = JinaResult(
            attempts=[
                ProviderAttempt(12, "https://r.jinaai.cn", True, "server-error", "HTTP 503"),
                ProviderAttempt(8, "https://r.jina.ai", False),
            ],
            content="# Article",
        )
        with (
            patch(
                "science_agent_gateway.web_api._validate_public_url",
                new=AsyncMock(return_value="https://example.org/article"),
            ),
            patch("science_agent_gateway.web_api.invoke_jina_reader", new=AsyncMock(return_value=result)),
        ):
            response = await invoke_web(request)

        self.assertFalse(response.is_error)
        self.assertEqual(response.content, "# Article")
        self.assertEqual(len(response.attempts or []), 2)
        self.assertEqual(response.attempts[0].endpoint, "https://r.jinaai.cn")
        self.assertTrue(response.attempts[0].is_error)
        self.assertEqual(response.attempts[1].endpoint, "https://r.jina.ai")

    async def test_paid_provider_custom_or_direct_proxy_runs_in_isolated_process(self) -> None:
        request = WebInvokeRequest(
            operation="search",
            provider="tavily",
            arguments={"query": "TP53"},
            options=web_options(api_key="secret", proxy_mode="direct"),
        )
        with (
            patch(
                "science_agent_gateway.web_api.invoke_web_provider",
                side_effect=AssertionError("must be isolated"),
            ),
            patch(
                "science_agent_gateway.web_api.invoke_isolated_web_provider",
                new=AsyncMock(return_value='[{"title":"TP53"}]'),
            ) as isolated,
        ):
            response = await invoke_web(request)

        self.assertFalse(response.is_error)
        isolated.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
