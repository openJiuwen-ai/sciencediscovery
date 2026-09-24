# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Use real SDK message types; no model API requests or shell side effects."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from openjiuwen.core.foundation.llm import AssistantMessage, ToolCall
from jiuwenswarm.server.runtime.mcp.output_recovery import enable_output_recovery, OutputRecoveryExhausted


class OutputRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setup_agent(self, responses):
        original = AsyncMock(side_effect=responses)
        agent = SimpleNamespace(_react_agent=SimpleNamespace(_call_model=original))
        enable_output_recovery(agent)
        wrapped = agent._react_agent._call_model
        enable_output_recovery(agent)
        self.assertIs(wrapped, agent._react_agent._call_model)
        context = SimpleNamespace(add_messages=AsyncMock())
        return wrapped, original, context

    async def test_truncated_tools_never_reach_execution_even_when_json_valid(self):
        calls = [ToolCall(type='function', id='cut', name='write', arguments='{"text":"partial"}')]
        truncated = AssistantMessage(content='', tool_calls=calls, finish_reason='length')
        final = AssistantMessage(content='', tool_calls=[ToolCall(type='function', id='small', name='write', arguments='{"text":"draft"}')], finish_reason='tool_calls')
        call, original, context = self.setup_agent([truncated, final])
        result = await call(SimpleNamespace(), context, [])
        self.assertEqual([c.id for c in result.tool_calls], ['small'])
        self.assertEqual(original.await_count, 2)
        feedback = context.add_messages.call_args.args[0]
        self.assertEqual(feedback.role, 'user')
        self.assertIn('NO tools', feedback.content)
        self.assertIn('tool_arguments', feedback.content)
        self.assertNotIn('"text":"partial"', feedback.content)

    async def test_empty_thinking_and_partial_answer_both_recover(self):
        for text, kind in [('', 'reasoning_only'), ('unfinished report', 'partial_answer'),
                           ('[output_limit:tool_calls_withheld] No tools from this response were executed.', 'tool_arguments')]:
            with self.subTest(kind=kind):
                call, original, context = self.setup_agent([
                    AssistantMessage(content=text, reasoning_content='long private thought', finish_reason='length'),
                    AssistantMessage(content='artifact: report.md', finish_reason='stop')])
                result = await call(None, context, [])
                self.assertEqual(result.content, 'artifact: report.md')
                self.assertIn(kind, context.add_messages.call_args.args[0].content)
                self.assertNotIn('long private thought', context.add_messages.call_args.args[0].content)

    async def test_exhaustion_is_bounded_and_structured(self):
        call, original, context = self.setup_agent([AssistantMessage(content='', finish_reason='length')] * 4)
        with self.assertRaises(OutputRecoveryExhausted) as raised:
            await call(None, context, [])
        self.assertEqual(original.await_count, 3)
        self.assertEqual(context.add_messages.await_count, 2)
        self.assertEqual(raised.exception.details['recoveryAttempts'], 2)
        self.assertFalse(raised.exception.details['currentTurnToolsExecuted'])

    async def test_no_retry_on_network_error_or_cancellation(self):
        for error in [RuntimeError('402 insufficient balance'), asyncio.CancelledError()]:
            call, original, context = self.setup_agent([error])
            with self.assertRaises(type(error)):
                await call(None, context, [])
            self.assertEqual(original.await_count, 1)
            context.add_messages.assert_not_called()

    async def test_successful_boundary_not_replayed_and_budget_resets(self):
        cut = AssistantMessage(content='', finish_reason='length')
        ok = AssistantMessage(content='done', finish_reason='stop')
        call, original, context = self.setup_agent([cut, cut, ok, cut, cut, ok])
        self.assertIs(await call(None, context, []), ok)
        self.assertIs(await call(None, context, []), ok)
        self.assertEqual(original.await_count, 6)

    def test_missing_react_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'initialized'):
            enable_output_recovery(SimpleNamespace())

    async def test_real_react_loop_executes_only_recovered_call_and_completes(self):
        from unittest.mock import MagicMock, patch
        from openjiuwen.core.single_agent.agents.react_agent import ReActAgent, ReActAgentConfig
        from openjiuwen.core.single_agent.schema.agent_card import AgentCard
        from openjiuwen.core.foundation.llm import ToolMessage
        react = ReActAgent(card=AgentCard(name='recovery-test', description='output recovery'))
        react.configure(ReActAgentConfig().configure_model('mock').configure_max_iterations(5))
        context = MagicMock()
        history = []
        async def add(message):
            history.extend(message if isinstance(message, list) else [message])
        context.add_messages = AsyncMock(side_effect=add)
        context.get_messages.side_effect = lambda: list(history)
        engine = MagicMock()
        engine.create_context = AsyncMock(return_value=context)
        engine.save_contexts = AsyncMock()
        react.context_engine = engine
        session = MagicMock()
        session.get_state.return_value = None
        session.write_stream = AsyncMock()
        cut = AssistantMessage(content='', finish_reason='length', tool_calls=[
            ToolCall(type='function', id='do-not-write', name='write', arguments='{"text":"incomplete"}')])
        small = AssistantMessage(content='', finish_reason='tool_calls', tool_calls=[
            ToolCall(type='function', id='draft', name='write', arguments='{"text":"draft"}')])
        executed = []
        async def execute(**kwargs):
            executed.extend(c.id for c in kwargs['tool_call'])
            return [('saved', ToolMessage(content='saved', tool_call_id='draft'))]
        enable_output_recovery(SimpleNamespace(_react_agent=react))
        with patch.object(react, '_railed_model_call', AsyncMock(side_effect=[cut, small, AssistantMessage(content='report.md saved', finish_reason='stop')])), \
             patch.object(react.ability_manager, 'execute', AsyncMock(side_effect=execute)):
            result = await react.invoke({'conversation_id':'output-recovery-test','query':'write report'}, session=session)
        self.assertEqual(result['output'], 'report.md saved')
        self.assertEqual(executed, ['draft'])
        self.assertFalse(any(c.id == 'do-not-write' for m in history for c in getattr(m, 'tool_calls', []) or []))
        self.assertTrue(any('Output limit recovery' in str(getattr(m, 'content', '')) for m in history))
