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

"""Proxy resolution plumbing: model clients and MCP stdio env overlays."""

import asyncio
import unittest
from dataclasses import dataclass, field
from unittest.mock import patch

from science_agent_gateway._engine import apply_mcp_proxy_overlay, replace_mcp_proxy_overlays
from science_agent_gateway._engine import mcp as engine_mcp
from science_agent_gateway.mcp_api import proxy_env_overlay
from science_agent_gateway.server import ModelSpec, ProxySpec, _build_model, _model_proxy_clients


class ProxyEnvOverlayTest(unittest.TestCase):
    def test_url_mode_sets_proxy_variables_and_keeps_no_proxy(self) -> None:
        with patch.dict("os.environ", {"NO_PROXY": "localhost,127.0.0.1"}, clear=False):
            overlay = proxy_env_overlay("url", "http://proxy.example.test:7890")
        self.assertEqual(overlay["HTTP_PROXY"], "http://proxy.example.test:7890")
        self.assertEqual(overlay["https_proxy"], "http://proxy.example.test:7890")
        self.assertEqual(overlay["NO_PROXY"], "localhost,127.0.0.1")

    def test_environment_mode_forwards_gateway_proxy_variables(self) -> None:
        env = {"HTTPS_PROXY": "http://corp:3128", "HTTP_PROXY": "http://corp:3128"}
        with patch.dict("os.environ", env, clear=True):
            overlay = proxy_env_overlay("environment", None)
        self.assertEqual(overlay, env)

    def test_direct_mode_is_empty(self) -> None:
        with patch.dict("os.environ", {"HTTPS_PROXY": "http://corp:3128"}, clear=False):
            self.assertEqual(proxy_env_overlay("direct", None), {})

    def test_url_mode_without_url_is_rejected(self) -> None:
        with self.assertRaises(Exception):
            proxy_env_overlay("url", None)


class FromFileOverlayTest(unittest.TestCase):
    def tearDown(self) -> None:
        replace_mcp_proxy_overlays({})

    @dataclass
    class FakeServer:
        description: str = ""
        enabled: bool = True
        env: dict[str, str] = field(default_factory=dict)
        type: str = "stdio"

    @dataclass
    class FakeConfig:
        mcp_servers: dict[str, "FromFileOverlayTest.FakeServer"]

    def _config(self) -> "FromFileOverlayTest.FakeConfig":
        return self.FakeConfig(mcp_servers={
            "biomed": self.FakeServer(env={"HTTP_PROXY": "http://stale:1", "KEEP_ME": "yes"}),
            "uniprot": self.FakeServer(),
        })

    def test_overlays_apply_per_server_without_cross_talk(self) -> None:
        replace_mcp_proxy_overlays({
            "biomed": proxy_env_overlay("url", "http://proxy.example.test:7890"),
        })
        with patch.object(
            engine_mcp, "_original_extensions_from_file",
            lambda cls, config_path=None: self._config(),
        ):
            config = engine_mcp.ExtensionsConfig.from_file()
        biomed = config.mcp_servers["biomed"]
        # The stale operator-authored proxy var is replaced, other env kept.
        self.assertEqual(biomed.env["HTTPS_PROXY"], "http://proxy.example.test:7890")
        self.assertEqual(biomed.env["KEEP_ME"], "yes")
        # A server without an overlay is left untouched.
        self.assertEqual(config.mcp_servers["uniprot"].env, {})

    def test_direct_overlay_strips_configured_proxy_variables(self) -> None:
        replace_mcp_proxy_overlays({"biomed": proxy_env_overlay("direct", None)})
        with patch.object(
            engine_mcp, "_original_extensions_from_file",
            lambda cls, config_path=None: self._config(),
        ):
            config = engine_mcp.ExtensionsConfig.from_file()
        self.assertEqual(config.mcp_servers["biomed"].env, {"KEEP_ME": "yes"})

    def test_apply_proxy_overlay_resets_cache_only_on_change(self) -> None:
        overlay = proxy_env_overlay("url", "http://proxy.example.test:7890")
        replace_mcp_proxy_overlays({})
        with patch.object(engine_mcp, "reset_mcp_tools_cache") as reset:
            apply_mcp_proxy_overlay("biomed", overlay)
            apply_mcp_proxy_overlay("biomed", dict(overlay))
        self.assertEqual(reset.call_count, 1)


class ModelProxyClientsTest(unittest.TestCase):
    def _close(self, clients: dict[str, object]) -> None:
        clients["http_client"].close()
        asyncio.run(clients["http_async_client"].aclose())

    def test_environment_mode_uses_default_clients(self) -> None:
        self.assertEqual(_model_proxy_clients(None), {})
        self.assertEqual(_model_proxy_clients(ProxySpec(mode="environment")), {})

    def test_direct_mode_disables_trust_env(self) -> None:
        clients = _model_proxy_clients(ProxySpec(mode="direct"))
        try:
            self.assertFalse(clients["http_async_client"].trust_env)
            self.assertFalse(clients["http_client"].trust_env)
        finally:
            self._close(clients)

    def test_url_mode_builds_proxied_clients(self) -> None:
        clients = _model_proxy_clients(ProxySpec(mode="url", url="http://proxy.example.test:7890"))
        try:
            self.assertIn("http_async_client", clients)
            self.assertIn("http_client", clients)
            mounts = clients["http_client"]._mounts
            self.assertTrue(mounts, "expected proxy mounts on the sync client")
        finally:
            self._close(clients)

    def test_url_mode_requires_url(self) -> None:
        with self.assertRaises(ValueError):
            _model_proxy_clients(ProxySpec(mode="url"))

    def test_model_spec_accepts_proxy(self) -> None:
        spec = ModelSpec.model_validate({
            "base_url": "https://models.example.test/v1",
            "model": "m",
            "proxy": {"mode": "url", "url": "http://proxy.example.test:7890"},
        })
        self.assertIsNotNone(spec.proxy)
        self.assertEqual(spec.proxy.mode, "url")

    def test_anthropic_compatible_path_uses_per_profile_clients(self) -> None:
        owned = []
        model = _build_model(ModelSpec(
            base_url="https://models.example.test/api/plan",
            model="plan-model",
            proxy=ProxySpec(mode="direct"),
        ), owned)
        try:
            self.assertEqual(len(owned), 2)
            self.assertFalse(model._client._client.trust_env)
            self.assertFalse(model._async_client._client.trust_env)
        finally:
            for client in owned:
                if hasattr(client, "aclose"):
                    asyncio.run(client.aclose())
                else:
                    client.close()
