# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Exercise the shipped default Agent tools and MCP path against real local HTTP."""
import asyncio
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
from unittest.mock import patch

from jiuwenswarm.agents.harness.common.tools.deepseek_web import (
    WebPaidSearchTool, WebFetchWebpageTool, deepseek_search, deepseek_fetch,
    is_paid_search_enabled,
)
from jiuwenswarm.agents.harness.common.tools import search_tools, web_fetch_tools


class DeepSeekWebTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.calls = []
        self.status = 200
        self.empty = False
        self.bad_content = False
        self.delay = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.calls.append((self.path, self.headers.get('Authorization'), body))
                if owner.delay:
                    threading.Event().wait(0.2)
                    return
                self.send_response(owner.status)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                if self.path.endswith('search'):
                    data = {'results': [] if owner.empty else [{'title': 'Catalyst study', 'url': 'https://example.com/catalyst', 'summary': 'The model-facing summary.', 'snippet': 'Short display snippet'}]}
                elif self.path.endswith('fetch'):
                    data = {'title': 'Catalyst study', 'content': '' if owner.bad_content else '# Results\n\nThe yield was **93%**.'}
                else:
                    data = {'organic': [{'link': 'https://example.com/legacy'}]}
                self.wfile.write(json.dumps(data).encode())

            def do_GET(self):
                owner.calls.append((self.path, None, None))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'Existing direct fetch content')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        env = {f'{p}_API_KEY': '' for p in ('BOCHA', 'PERPLEXITY', 'SERPER', 'JINA')}
        env.update(DEEPSEEK_API_KEY='local-test-key', DEEPSEEK_SEARCH_ENABLED='true',
                   DEEPSEEK_FETCH_ENABLED='true', DEEPSEEK_SEARCH_URL=self.origin+'/v1/tools/search',
                   DEEPSEEK_FETCH_URL=self.origin+'/v1/tools/fetch',
                   WEB_SEARCH_PROVIDER='', PAID_SEARCH_PROVIDER='', SERPER_API_URL=self.origin+'/serper')
        self.env = patch.dict(os.environ, env)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    async def test_default_agent_search_fetch_journey(self):
        self.assertTrue(is_paid_search_enabled(), 'DeepSeek alone must register paid_search')
        tool = WebPaidSearchTool(language='en')
        self.assertIn('deepseek', tool.card.input_params['properties']['provider']['enum'])
        search = await tool.invoke({'query': 'catalyst yield', 'max_results': 3})
        self.assertIn('Catalyst study', search)
        self.assertIn('model-facing summary', search)
        self.assertIn('https://example.com/catalyst', search)
        page = await WebFetchWebpageTool(language='en').invoke({'url': 'https://example.com/catalyst'})
        self.assertIn('Title: Catalyst study', page)
        self.assertIn('**93%**', page, 'the answer can cite the fetched Markdown evidence')
        self.assertEqual(self.calls, [
            ('/v1/tools/search', 'Bearer local-test-key', {'query': 'catalyst yield', 'count': 3}),
            ('/v1/tools/fetch', 'Bearer local-test-key', {'url': 'https://example.com/catalyst'}),
        ])
        # Import the real default adapter to verify its actual bindings.
        from jiuwenswarm.server.runtime.agent_adapter import interface_deep as runtime
        self.assertIs(runtime.WebPaidSearchTool, WebPaidSearchTool)
        self.assertIs(runtime.WebFetchWebpageTool, WebFetchWebpageTool)
        self.assertTrue(runtime.is_paid_search_enabled())

    async def test_legacy_auto_order_and_explicit_provider_are_preserved(self):
        os.environ['SERPER_API_KEY'] = 'legacy-test-key'
        result = await WebPaidSearchTool(language='en').invoke({'query': 'catalyst'})
        self.assertIn('legacy', result)
        self.assertEqual([c[0] for c in self.calls], ['/serper'])
        self.assertEqual(search_tools.configured_paid_search_providers(), ['serper', 'deepseek'])

    async def test_disabled_missing_key_and_unselected_fetch_make_no_deepseek_requests(self):
        for field, value, code in [('DEEPSEEK_SEARCH_ENABLED', 'false', 'PROVIDER_DISABLED'), ('DEEPSEEK_API_KEY', '', 'MISSING_CREDENTIALS')]:
            with patch.dict(os.environ, {field: value}):
                self.assertFalse(is_paid_search_enabled())
                result = await WebPaidSearchTool(language='en').invoke({'query': 'x', 'provider': 'deepseek'})
                self.assertIn(code, result)
                self.assertEqual(self.calls, [])
        with patch.dict(os.environ, {'DEEPSEEK_API_KEY': ''}):
            result = await WebFetchWebpageTool().invoke({'url': 'https://example.com/catalyst'})
            self.assertIn('MISSING_CREDENTIALS', result)
        with patch.dict(os.environ, {'DEEPSEEK_FETCH_ENABLED': 'false'}):
            await WebFetchWebpageTool().invoke({'url': self.origin+'/legacy'})
            data = await asyncio.to_thread(web_fetch_tools._fetch_webpage_sync, self.origin+'/legacy-mcp', 1)
            self.assertIn('Existing', data['content'])
        self.assertEqual([c[0] for c in self.calls], ['/legacy', '/legacy-mcp'])

    async def test_empty_results_are_not_provider_failure(self):
        self.empty = True
        result = await WebPaidSearchTool().invoke({'query': 'no match'})
        self.assertIn('No search results', result)
        self.assertNotIn('[ERROR]', result)
        provider, answer, urls = await search_tools.run_paid_search_structured('no match')
        self.assertEqual(provider, 'deepseek')
        self.assertEqual(urls, [])
        self.assertIn('free_search', answer)

    async def test_http_errors_remain_distinct_on_both_tools(self):
        for status, code in [(401, 'UNAUTHORIZED'), (402, 'INSUFFICIENT_BALANCE'), (429, 'RATE_LIMITED'), (408, 'TIMEOUT'), (504, 'TIMEOUT'), (404, 'FETCH_FAILED')]:
            self.status = status
            with self.subTest(status=status):
                result = await WebFetchWebpageTool().invoke({'url': 'https://example.com/catalyst'})
                self.assertIn(code, result)
                if status != 404:
                    result = await WebPaidSearchTool().invoke({'query': 'x', 'provider': 'deepseek'})
                    self.assertIn(code, result)
        self.status = 200
        self.bad_content = True
        self.assertIn('FETCH_FAILED', await WebFetchWebpageTool().invoke({'url': 'https://example.com/catalyst'}))

    async def test_mcp_tools_use_deepseek_too(self):
        provider, summary, urls = await search_tools.run_paid_search_structured('catalyst', max_results=2)
        self.assertEqual(provider, 'deepseek')
        self.assertIn('model-facing summary', summary)
        data = await asyncio.to_thread(web_fetch_tools._fetch_webpage_sync, urls[0], 2)
        self.assertIn('**93%**', data['content'])
        search_tools.refresh_paid_search_metadata()
        self.assertIn('deepseek', search_tools.mcp_paid_search.card.input_params['properties']['provider']['enum'])

    async def test_real_read_timeout_is_classified(self):
        self.delay = True
        for function, value in [(deepseek_search, 'x'), (deepseek_fetch, 'https://example.com')]:
            with self.assertRaisesRegex(ValueError, 'TIMEOUT'):
                await asyncio.to_thread(function, value, timeout_seconds=0.02)
