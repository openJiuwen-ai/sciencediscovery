# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

"""Run with the pinned Swarm virtualenv, after applying the compatibility patches."""
import asyncio
import ast
import logging
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from openjiuwen.core.foundation.tool import McpServerConfig, McpToolCard
from openjiuwen.core.runner.resources_manager.tool_manager import ToolMgr, McpServerResource
from jiuwenswarm.server.runtime.mcp.call_timeout_patch import apply_mcp_call_timeout_patch
from jiuwenswarm.server.runtime.mcp import call_timeout_patch


class DynamicCatalogTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_specialist_tools_refresh_without_disconnecting_active_client(self):
        apply_mcp_call_timeout_patch()
        mgr = ToolMgr()
        config = McpServerConfig(server_name="sci", server_id="sci-test", client_type="streamable-http",
                                 server_path="http://localhost/mcp", params={"timeout_s": 7200})
        cards = [McpToolCard(server_name="sci", name="web_search", description="search", input_params={}),
                 McpToolCard(server_name="sci", name="mcp__pubmed__search", description="papers", input_params={})]
        client = SimpleNamespace(list_tools=AsyncMock(side_effect=lambda: deepcopy(cards)), disconnect=AsyncMock())
        mgr._mcp_server_resources[config.server_id] = McpServerResource(config, client, [], 0)
        first, second = await asyncio.gather(mgr.add_tool_server(config), mgr.add_tool_server(config))
        self.assertEqual([c.name for c in first], [c.name for c in cards])
        self.assertEqual([c.name for c in second], [c.name for c in cards])
        self.assertEqual(len(mgr._mcp_server_resources[config.server_id].tool_ids), 2)
        self.assertIs(mgr._mcp_server_resources[config.server_id].client, client)
        client.disconnect.assert_not_called()
        self.assertIsNone(first[0].properties["resilience"]["timeout_s"])


class ModelRouteTests(unittest.TestCase):
    def resolve(self, entries):
        # Exercise the actual patched resolver without constructing a full
        # DeepAgent, network client or skill registry.
        source = Path(call_timeout_patch.__file__).parents[1] / "agent_adapter/interface_deep.py"
        tree = ast.parse(source.read_text())
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_resolve_model_by_name")
        namespace = {"Model": object, "get_config": lambda: {}, "get_default_models": lambda _: entries,
                     "build_model_from_entry": lambda mcc, _: mcc["model_name"], "logger": logging.getLogger(__name__)}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), "exec"), namespace)
        state = SimpleNamespace(_model_cache={}, _model_name_to_keys={}, _default_model_name="sciencediscovery-default")
        return namespace["_resolve_model_by_name"](state, "private-run-model")

    def test_newly_published_alias_does_not_fall_back(self):
        self.assertEqual(self.resolve([{"model_client_config": {"model_name": "private-run-model"}}]), "private-run-model")

    def test_missing_run_alias_fails_instead_of_routing_to_another_run(self):
        with self.assertRaisesRegex(ValueError, "refusing default-route fallback"):
            self.resolve([])


if __name__ == "__main__":
    unittest.main()
