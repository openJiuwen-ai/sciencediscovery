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

import os
import unittest
from unittest.mock import patch

from science_agent_gateway._engine import configure_web_proxy_environment, resolve_web_provider
from science_agent_gateway.web_providers import _proxy, _search, invoke_jina_reader


class FakeResponse:
    def __init__(self, status_code: int, text: str) -> None:
        self.status_code = status_code
        self.text = text


class FakeAsyncClient:
    responses: list[FakeResponse] = []
    requests: list[tuple[str, dict[str, str]]] = []
    options: dict[str, object] = {}

    def __init__(self, **options: object) -> None:
        type(self).options = options

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def post(self, url: str, *, headers: dict[str, str], **_kwargs: object) -> FakeResponse:
        type(self).requests.append((url, headers))
        return type(self).responses.pop(0)


class WebProviderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        FakeAsyncClient.requests = []
        FakeAsyncClient.options = {}

    async def test_jina_falls_back_from_china_to_global_and_uses_optional_key(self) -> None:
        FakeAsyncClient.responses = [FakeResponse(503, "unavailable"), FakeResponse(200, "# Article")]
        options = {
            "api_key": "jina-key",
            "proxy": "http://proxy.example:7890",
            "proxy_mode": "custom",
        }
        with patch("science_agent_gateway.web_providers.httpx.AsyncClient", FakeAsyncClient):
            result = await invoke_jina_reader("https://example.org/article", 10, options)

        self.assertFalse(result.is_error)
        self.assertEqual(result.content, "# Article")
        self.assertEqual([attempt.endpoint for attempt in result.attempts], [
            "https://r.jinaai.cn", "https://r.jina.ai",
        ])
        self.assertEqual(FakeAsyncClient.options["proxy"], "http://proxy.example:7890")
        self.assertFalse(FakeAsyncClient.options["trust_env"])
        self.assertEqual(FakeAsyncClient.requests[0][1]["Authorization"], "Bearer jina-key")

    async def test_jina_authentication_failure_is_terminal(self) -> None:
        FakeAsyncClient.responses = [FakeResponse(401, "unauthorized"), FakeResponse(200, "unused")]
        with patch("science_agent_gateway.web_providers.httpx.AsyncClient", FakeAsyncClient):
            result = await invoke_jina_reader(
                "https://example.org/article",
                10,
                {"proxy_mode": "direct"},
            )

        self.assertTrue(result.is_error)
        self.assertEqual(result.error_code, "unauthorized")
        self.assertEqual(len(result.attempts), 1)
        self.assertNotIn("Authorization", FakeAsyncClient.requests[0][1])

    async def test_jina_uses_the_projected_https_proxy_and_no_proxy(self) -> None:
        FakeAsyncClient.responses = [FakeResponse(200, "# Article")]
        options = {
            "proxy_environment": {
                "HTTPS_PROXY": "http://effective.test:3",
                "NO_PROXY": "unrelated.test",
            },
            "proxy_mode": "environment",
        }
        with patch("science_agent_gateway.web_providers.httpx.AsyncClient", FakeAsyncClient):
            result = await invoke_jina_reader("https://example.org/article", 10, options)

        self.assertFalse(result.is_error)
        self.assertEqual(FakeAsyncClient.options, {
            "proxy": "http://effective.test:3",
            "trust_env": False,
        })

        FakeAsyncClient.responses = [FakeResponse(200, "# Direct")]
        options = {
            "proxy_environment": {
                "HTTPS_PROXY": "http://effective.test:3",
                "NO_PROXY": ".jinaai.cn",
            },
            "proxy_mode": "environment",
        }
        with patch("science_agent_gateway.web_providers.httpx.AsyncClient", FakeAsyncClient):
            result = await invoke_jina_reader("https://example.org/article", 10, options)

        self.assertFalse(result.is_error)
        self.assertEqual(FakeAsyncClient.options, {"trust_env": False})

    def test_ddgs_receives_selected_backend_and_direct_mode_ignores_ddgs_proxy(self) -> None:
        captured: dict[str, object] = {}

        class FakeDDGS:
            def __init__(self, **options: object) -> None:
                captured["options"] = options
                self._proxy = "from-environment"

            def text(self, query: str, **options: object) -> list[dict[str, str]]:
                captured["query"] = query
                captured["search"] = options
                captured["effective_proxy"] = self._proxy
                return [{"title": "TP53", "href": "https://example.org", "body": "result"}]

        with patch("ddgs.DDGS", FakeDDGS):
            content = _search("TP53", 5, {"backend": "bing", "proxy_mode": "direct"})

        self.assertIn('"TP53"', content)
        self.assertEqual(captured["search"]["backend"], "bing")
        self.assertIsNone(captured["effective_proxy"])

    def test_isolated_worker_scopes_custom_proxy_to_its_environment(self) -> None:
        with patch.dict("os.environ", {"HTTPS_PROXY": "old", "NO_PROXY": "internal"}, clear=False):
            provider = resolve_web_provider(
                "search",
                "tavily",
                {
                    "api_key": "secret",
                    "proxy_mode": "custom",
                    "proxy": "socks5://proxy.example:1080",
                },
            )
            configure_web_proxy_environment(provider)
            self.assertEqual(os.environ["HTTPS_PROXY"], "socks5://proxy.example:1080")
            self.assertEqual(os.environ["DDGS_PROXY"], "socks5://proxy.example:1080")
            self.assertNotIn("NO_PROXY", os.environ)

    def test_environment_projection_replaces_conflicting_inherited_values(self) -> None:
        inherited = {
            "DDGS_PROXY": "http://hidden.test:1",
            "HTTP_PROXY": "http://ignored.test:2",
            "http_proxy": " ",
        }
        with patch.dict("os.environ", inherited, clear=True):
            provider = resolve_web_provider("search", "ddgs", {
                "proxy_environment": {"HTTPS_PROXY": "http://effective.test:3", "NO_PROXY": "localhost"},
                "proxy_mode": "environment",
            })
            configure_web_proxy_environment(provider)
            self.assertEqual(dict(os.environ), {
                "HTTPS_PROXY": "http://effective.test:3",
                "NO_PROXY": "localhost",
            })
            self.assertEqual(_proxy({
                "proxy_environment": provider.proxy_environment,
                "proxy_mode": "environment",
            }), "http://effective.test:3")

    def test_ddgs_environment_precedence_matches_httpx_and_ignores_ddgs_proxy(self) -> None:
        with patch.dict("os.environ", {
            "DDGS_PROXY": "http://hidden.test:1",
            "HTTPS_PROXY": "http://upper.test:2",
            "https_proxy": " ",
        }, clear=True):
            self.assertIsNone(_proxy({"proxy_mode": "environment"}))
        with patch.dict("os.environ", {
            "HTTPS_PROXY": "http://upper.test:2",
            "https_proxy": "http://lower.test:3",
        }, clear=True):
            self.assertEqual(_proxy({"proxy_mode": "environment"}), "http://lower.test:3")
        with patch.dict("os.environ", {"HTTP_PROXY": "http://http-only.test:4"}, clear=True):
            self.assertIsNone(_proxy({"proxy_mode": "environment"}))
        with patch.dict("os.environ", {"ALL_PROXY": "http://all.test:5"}, clear=True):
            self.assertEqual(_proxy({"proxy_mode": "environment"}), "http://all.test:5")


if __name__ == "__main__":
    unittest.main()
