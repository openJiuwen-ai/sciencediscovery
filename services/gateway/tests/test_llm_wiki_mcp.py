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

import importlib
import json
import unittest
from unittest.mock import patch

import httpx
from mcp.server.fastmcp.exceptions import ToolError

from sciencediscovery_gateway import llm_wiki_mcp as wiki


class LlmWikiTests(unittest.IsolatedAsyncioTestCase):
    def client(self, handler):
        client = httpx.AsyncClient
        return patch.object(wiki.httpx, "AsyncClient", side_effect=lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))

    async def test_search_calls_structured_retrieval_and_preserves_sources(self):
        def handle(request):
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.url.path, "/api/v1/query/structured")
            self.assertEqual(json.loads(request.content), {"question": "Overview", "top_k": 3, "mode": "hybrid"})
            self.assertEqual(request.headers["Authorization"], "Bearer test")
            return httpx.Response(200, json={"sources": [{"page_id": "Overview.md", "source_refs": ["paper.md"]}]})
        with self.client(handle), patch.dict(wiki.os.environ, {"SCIENCE_AGENT_LLM_WIKI_TOKEN": "test"}):
            result = await wiki.search("Overview", 3)
        self.assertEqual(result["sources"][0]["source_refs"], ["paper.md"])

    async def test_get_page_encodes_paths_and_rejects_traversal_before_http(self):
        def handle(request):
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.url.path, "/api/v1/wiki/知识/Overview 1.md")
            return httpx.Response(200, json={"path": "知识/Overview 1.md", "content": "body", "sources": ["doi:1"]})
        with self.client(handle):
            result = await wiki.get_page("知识/Overview 1.md")
        self.assertEqual(result["content"], "body")
        for path in ["../x", "/x", "a/../x", "a\\x", "%2e%2e/x", "a?x"]:
            with self.assertRaises(ValueError):
                await wiki.get_page(path)

    async def test_batch_reports_unvisited_paths_and_corrects_budget_flag(self):
        def handle(request):
            self.assertEqual(request.url.path, "/api/v1/wiki/pages/batch")
            body = json.loads(request.content)
            self.assertTrue(body["token_budget_enabled"])
            self.assertEqual(body["max_tokens"], 100)
            return httpx.Response(200, json={"pages": [{"path": "a.md", "content": "A"}], "missing": ["b.md"], "truncated_by_budget": True})
        with self.client(handle):
            result = await wiki.get_pages(["a.md", "b.md", "c.md"], 100)
        self.assertEqual(result["omitted_paths"], ["c.md"])
        self.assertTrue(result["truncated_by_budget"])
        with self.client(handle):
            result = await wiki.get_pages(["a.md", "b.md"], 100)
        self.assertFalse(result["truncated_by_budget"])

    async def test_http_errors_redirects_and_oversized_results_are_not_hidden(self):
        for status in [302, 404, 503]:
            with self.client(lambda request: httpx.Response(status, headers={"location": "http://other.test"})):
                with self.assertRaises(httpx.HTTPStatusError):
                    await wiki.get_page("a.md")
        with self.client(lambda request: httpx.Response(200, content=b"x" * 101)), patch.object(wiki, "MAX_RESPONSE_BYTES", 100):
            with self.assertRaisesRegex(ValueError, "RESPONSE_TOO_LARGE"):
                await wiki.get_page("a.md")

    async def test_mcp_catalog_and_call_apply_input_constraints(self):
        tools = {tool.name: tool for tool in await wiki.SERVER.list_tools()}
        self.assertEqual(set(tools), {"search", "get_page", "get_pages"})
        self.assertEqual(tools["get_pages"].inputSchema["properties"]["paths"]["maxItems"], 20)
        with self.assertRaises(ToolError):
            await wiki.SERVER.call_tool("search", {"query": "Overview", "limit": 100})

    def test_base_url_rejects_non_origin_configurations(self):
        for url in ["file:///tmp", "http://user:pass@localhost", "http://localhost/api", "http://localhost?token=x"]:
            with patch.dict(wiki.os.environ, {"SCIENCE_AGENT_LLM_WIKI_URL": url}), self.assertRaises(ValueError):
                importlib.reload(wiki)
        with patch.dict(wiki.os.environ, {"SCIENCE_AGENT_LLM_WIKI_URL": "http://127.0.0.1:8100"}):
            importlib.reload(wiki)


if __name__ == "__main__":
    unittest.main()
