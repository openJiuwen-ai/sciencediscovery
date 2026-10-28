# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Exercise bulk management requests against the real locked YAML writer."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml

from jiuwenswarm.common import config
from jiuwenswarm.common.schema.agent import AgentRequest
from jiuwenswarm.common.schema.message import ReqMethod
from jiuwenswarm.agents.harness.common.rails.permissions.permissions_config_rpc import (
    dispatch_permissions_config_request,
)


class BatchPermissionTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory(prefix="batch-permissions-"))
        self.path = Path(directory) / "config.yaml"
        self.original = {"permissions": {
            "tools": {"unrelated": {"*": "ask"}, "mcp_live_shell": "deny"},
            "rules": [{"id": "keep", "action": "deny"}],
        }, "react": {"agent_name": "unchanged"}}
        self.path.write_text(yaml.safe_dump(self.original))
        self.enterContext(patch.object(config, "CONFIG_YAML_PATH", self.path))
        self.writes = self.enterContext(patch.object(config, "dump_yaml_round_trip", wraps=config.dump_yaml_round_trip))

    def request(self, method, params):
        return dispatch_permissions_config_request(AgentRequest(
            request_id="batch-test", channel_id="web", req_method=method, params=params,
        ))

    def read(self):
        return yaml.safe_load(self.path.read_text())

    def test_44_permissions_are_merged_in_one_write_with_exact_levels(self):
        levels = ("allow", "ask", "deny")
        tools = {f"mcp_sci_tool_{index}": levels[index % 3] for index in range(44)}
        response = self.request(ReqMethod.PERMISSIONS_TOOLS_UPDATE, {"tools": tools})
        self.assertTrue(response.ok, response.payload)
        self.assertEqual(self.writes.call_count, 1)
        expected = {**self.original["permissions"]["tools"], **tools}
        self.assertEqual(response.payload["tools"], expected)
        self.assertEqual(self.read()["permissions"]["tools"], expected)
        self.assertEqual(self.read()["permissions"]["rules"], self.original["permissions"]["rules"])
        self.assertEqual(self.read()["react"], self.original["react"])

    def test_retirement_is_one_write_and_preserves_other_generations(self):
        tools = {f"mcp_old_tool_{index}": "deny" for index in range(44)}
        self.request(ReqMethod.PERMISSIONS_TOOLS_UPDATE, {"tools": tools})
        self.writes.reset_mock()
        response = self.request(ReqMethod.PERMISSIONS_TOOLS_DELETE, {"tools": list(tools)})
        self.assertTrue(response.ok, response.payload)
        self.assertEqual(self.writes.call_count, 1)
        self.assertEqual(self.read(), self.original)
        # Retrying after a lost acknowledgement must not fail or rewrite YAML.
        response = self.request(ReqMethod.PERMISSIONS_TOOLS_DELETE, {"tools": list(tools)})
        self.assertTrue(response.ok)
        self.assertEqual(self.writes.call_count, 1)

    def test_invalid_batch_never_partially_persists(self):
        cases = [
            (ReqMethod.PERMISSIONS_TOOLS_UPDATE, {"tools": {"valid": "allow", "invalid": "maybe"}}),
            (ReqMethod.PERMISSIONS_TOOLS_UPDATE, {"tools": []}),
            (ReqMethod.PERMISSIONS_TOOLS_UPDATE, {"tools": {"": "allow"}}),
            (ReqMethod.PERMISSIONS_TOOLS_UPDATE, {"tools": {"valid": "allow"}, "tool": "other", "level": "deny"}),
            (ReqMethod.PERMISSIONS_TOOLS_DELETE, {"tools": "mcp_live_shell"}),
            (ReqMethod.PERMISSIONS_TOOLS_DELETE, {"tools": ["mcp_live_shell", ""]}),
        ]
        for method, params in cases:
            with self.subTest(method=method, params=params):
                response = self.request(method, params)
                self.assertFalse(response.ok)
                self.assertEqual(response.payload["code"], "BAD_REQUEST")
                self.assertEqual(self.read(), self.original)
        self.writes.assert_not_called()

    def test_single_tool_management_requests_remain_compatible(self):
        response = self.request(ReqMethod.PERMISSIONS_TOOLS_UPDATE, {"tool": "single", "level": "ask"})
        self.assertTrue(response.ok)
        self.assertEqual(self.read()["permissions"]["tools"]["single"], "ask")
        self.assertTrue(self.request(ReqMethod.PERMISSIONS_TOOLS_DELETE, {"tool": "single"}).ok)
        missing = self.request(ReqMethod.PERMISSIONS_TOOLS_DELETE, {"tool": "single"})
        self.assertFalse(missing.ok)
        self.assertEqual(missing.payload["code"], "NOT_FOUND")

    def test_concurrent_generation_updates_keep_both_maps(self):
        def update(index):
            return config.update_permissions_tools_in_config({f"mcp_gen_{index}_shell": "ask"})
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(update, range(8)))
        self.assertEqual(self.writes.call_count, 8)
        self.assertEqual(self.read()["permissions"]["tools"], {
            **self.original["permissions"]["tools"],
            **{f"mcp_gen_{index}_shell": "ask" for index in range(8)},
        })


if __name__ == "__main__":
    unittest.main()
