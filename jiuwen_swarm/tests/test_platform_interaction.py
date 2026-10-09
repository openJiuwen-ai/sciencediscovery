# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from openjiuwen.harness.schema.interaction import OutputLeaseManager
from jiuwenswarm.server.runtime.mcp.platform_interaction import (
    retain_output_across_approvals, configure_swarm_context_files,
)


class InteractionTests(unittest.IsolatedAsyncioTestCase):
    def test_interleaved_tool_arguments_keep_their_indices_and_metadata(self):
        from openjiuwen.core.foundation.llm.schema.message_chunk import AssistantMessageChunk
        from openjiuwen.core.foundation.llm.schema.tool_call import ToolCall
        from jiuwenswarm.server.runtime.mcp.platform_interaction import configure_stream_tool_merge
        original = AssistantMessageChunk.__add__
        self.addCleanup(setattr, AssistantMessageChunk, "__add__", original)
        configure_stream_tool_merge()
        installed = AssistantMessageChunk.__add__
        configure_stream_tool_merge()
        self.assertIs(installed, AssistantMessageChunk.__add__)
        left = AssistantMessageChunk(content="", reasoning_content="think", tool_calls=[
            ToolCall(id="a", name="task", type="function", index=0, arguments='{"a":'),
            ToolCall(id="b", name="task", type="function", index=1, arguments='{"b":'),
        ])
        right = AssistantMessageChunk(content="done", tool_calls=[
            ToolCall(id="", name="", type="function", index=0, arguments="1}"),
            ToolCall(id="", name="", type="function", index=1, arguments="2}"),
        ])
        result = left + right
        self.assertEqual([c.arguments for c in result.tool_calls], ['{"a":1}', '{"b":2}'])
        self.assertEqual([c.id for c in result.tool_calls], ["a", "b"])
        self.assertEqual(result.content, "done")
        self.assertEqual(result.reasoning_content, "think")
        self.assertEqual(left.tool_calls[0].arguments, '{"a":')

    def test_sparse_indices_and_changed_identity(self):
        from openjiuwen.core.foundation.llm.schema.message_chunk import AssistantMessageChunk
        from openjiuwen.core.foundation.llm.schema.tool_call import ToolCall
        from jiuwenswarm.server.runtime.mcp.platform_interaction import configure_stream_tool_merge
        original = AssistantMessageChunk.__add__
        self.addCleanup(setattr, AssistantMessageChunk, "__add__", original)
        configure_stream_tool_merge()
        def chunk(index, identity, args):
            return AssistantMessageChunk(content="", tool_calls=[ToolCall(
                id=identity, name="task" if identity else "", type="function", index=index, arguments=args)])
        result = chunk(3, "a", "{") + chunk(9, "b", "{")
        result = result + chunk(3, "", "}") + chunk(9, "", "}")
        self.assertEqual([(c.index, c.arguments) for c in result.tool_calls], [(3, "{}"), (9, "{}")])
        with self.assertRaisesRegex(ValueError, "changed identity"):
            result + chunk(3, "forged", "")


    async def test_fast_approval_keeps_real_sdk_lease_and_final_result(self):
        output = OutputLeaseManager()
        lease = await output.attach()
        async def write(result, session):
            await output.emit(result)
        agent = SimpleNamespace(_write_round_result_to_stream=write,
                                _should_keep_interaction_open_locked=lambda: False)
        retain_output_across_approvals(agent)
        installed = agent._write_round_result_to_stream
        retain_output_across_approvals(agent)
        self.assertIs(installed, agent._write_round_result_to_stream)
        for question in ("q1", "q2"):
            await agent._write_round_result_to_stream({"result_type": "interrupt", "question": question}, None)
            # The supervisor's close decision happens before the consumer has
            # drained the pause. A fast answer cannot attach a second lease.
            if not agent._should_keep_interaction_open_locked():
                await output.finish_current()
            self.assertIsNone(await output.attach())
            self.assertFalse(lease.finishing)
            self.assertEqual((await output.next_item(lease))["question"], question)
        final = {"result_type": "answer", "content": "research completed"}
        await agent._write_round_result_to_stream(final, None)
        self.assertFalse(agent._should_keep_interaction_open_locked())
        await output.finish_current()
        self.assertEqual(await output.next_item(lease), final)
        self.assertIsNone(await output.next_item(lease))
        self.assertFalse(output.has_consumer())

    async def test_native_pending_work_still_keeps_output_open(self):
        agent = SimpleNamespace(_write_round_result_to_stream=AsyncMock(),
                                _should_keep_interaction_open_locked=lambda: True)
        retain_output_across_approvals(agent)
        await agent._write_round_result_to_stream({"result_type": "answer"}, None)
        self.assertTrue(agent._should_keep_interaction_open_locked())

    async def test_explicit_detach_can_cancel_a_waiting_output_lease(self):
        output = OutputLeaseManager()
        lease = await output.attach()
        agent = SimpleNamespace(_write_round_result_to_stream=AsyncMock(),
                                _should_keep_interaction_open_locked=lambda: False)
        retain_output_across_approvals(agent)
        await agent._write_round_result_to_stream({"result_type": "interrupt"}, None)
        await output.detach(lease.token)
        self.assertIsNone(await output.next_item(lease))
        self.assertFalse(output.has_consumer())
        replacement = await output.attach()
        self.assertIsNotNone(replacement)
        await agent._write_round_result_to_stream({"result_type": "answer"}, None)
        self.assertFalse(agent._should_keep_interaction_open_locked())
        await output.detach(replacement.token)

    async def test_heartbeat_is_not_read_but_other_read_errors_are_not_suppressed(self):
        from openjiuwen.harness.rails.context_engineer import context_assemble_rail as rail
        from openjiuwen.harness.prompts.sections import context
        original = rail.build_context_file_sections
        self.addCleanup(setattr, rail, "build_context_file_sections", original)
        configure_swarm_context_files()
        installed = rail.build_context_file_sections
        configure_swarm_context_files()
        self.assertIs(installed, rail.build_context_file_sections)
        seen = []
        def get_path(key):
            seen.append(key)
            return None
        await rail.build_context_file_sections(object(), SimpleNamespace(get_node_path=get_path))
        self.assertNotIn("HEARTBEAT.md", seen)
        self.assertIn("AGENT.md", seen)
        with patch.object(context, "_read_context_file", AsyncMock(side_effect=PermissionError("denied"))):
            with self.assertRaises(PermissionError):
                await rail.build_context_file_sections(object(), SimpleNamespace(get_node_path=get_path))


if __name__ == "__main__":
    unittest.main()
