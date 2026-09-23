# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

"""Loopback transport regressions; no LLM, credentials, or Swarm services."""
import asyncio
import json
import socket
import unittest
from unittest.mock import patch

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from openjiuwen.core.foundation.tool import McpServerConfig
from openjiuwen.core.runner.resources_manager.tool_manager import ToolMgr
from mcp.shared.exceptions import McpError
from jiuwenswarm.server.runtime.mcp.call_timeout_patch import apply_mcp_call_timeout_patch
from jiuwenswarm.server.runtime.mcp.sci_http_client import SciHttpClient, transport_failure_details


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        apply_mcp_call_timeout_patch()
        self.completed = []
        app = FastAPI()

        @app.post("/mcp")
        async def post(request: Request):
            body = await request.json()
            if "id" not in body:
                return Response(status_code=202)
            if body["method"] == "initialize":
                result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "test", "version": "1"}}
            elif body["method"] == "tools/call":
                args = body["params"]["arguments"]
                if args.get("fail"):
                    return Response(status_code=503)
                await asyncio.sleep(args.get("delay", 0))
                self.completed.append(body["id"])
                result = {"content": [{"type": "text", "text": args.get("value", "done")}], "isError": False}
            else:
                result = {"tools": []}
            return JSONResponse({"jsonrpc": "2.0", "id": body["id"], "result": result})

        @app.get("/mcp")
        async def get():
            return Response(status_code=405)

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
        self.serving = asyncio.create_task(self.server.serve(sockets=[sock]))
        while not self.server.started:
            await asyncio.sleep(0.01)
        config = McpServerConfig(server_name="sci", server_id="sci-test", client_type="streamable-http",
            server_path=f"http://127.0.0.1:{sock.getsockname()[1]}/mcp", params={"timeout_s": 5})
        self.client = ToolMgr._create_client(config)
        self.assertIsInstance(self.client, SciHttpClient)
        # Prewarm finishes before callers start, as in production.
        self.assertTrue(await asyncio.create_task(self.client.connect()))

    async def asyncTearDown(self):
        self.assertTrue(await self.client.disconnect())
        self.assertTrue(self.client._owner.done())
        self.server.should_exit = True
        await self.serving

    async def test_long_call_has_no_hidden_http_read_deadline(self):
        # Verify actual client configuration, not only an input parameter.
        original = httpx.AsyncClient.send
        seen = []
        async def send(client, request, **kwargs):
            seen.append(request.extensions["timeout"]["read"])
            return await original(client, request, **kwargs)
        with patch.object(httpx.AsyncClient, "send", send):
            result = await asyncio.wait_for(self.client.call_tool("task", {"delay": .15}), 2)
        self.assertEqual(result, "done")
        self.assertTrue(seen)
        self.assertTrue(all(value is None for value in seen))

    async def test_concurrent_results_remain_correlated(self):
        results = await asyncio.gather(self.client.call_tool("task", {"delay": .15, "value": "first"}),
                                       self.client.call_tool("task", {"value": "second"}))
        self.assertEqual(results, ["first", "second"])

    async def test_default_tool_deadline_does_not_use_shared_registration_timeout(self):
        self.client._jws_call_timeout = .01
        result = await asyncio.wait_for(self.client.call_tool("task", {"delay": .15}), 2)
        self.assertEqual(result, "done")

    async def test_single_tool_timeout_does_not_abort_sibling_or_transport(self):
        results = await asyncio.gather(self.client.call_tool("task", {"delay": .3}, timeout=.05),
                                       self.client.call_tool("task", {"delay": .15}), return_exceptions=True)
        self.assertIsInstance(results[0], TimeoutError)
        self.assertEqual(results[1], "done")
        self.assertEqual(await self.client.call_tool("task", {}), "done")

    async def test_transport_failure_logs_sanitized_cause_not_just_generic_message(self):
        # Diagnostic coverage only. Survival/recovery expectations live in
        # test_mcp_boundary; do not bless permanent failure as correct behavior.
        with self.assertLogs("jiuwenswarm.server.runtime.mcp.sci_http_client", level="ERROR") as logs:
            with self.assertRaises(Exception):
                await asyncio.wait_for(self.client.call_tool("task", {"fail": True}), 2)
        text = "\n".join(logs.output)
        self.assertIn("HTTPStatusError", text)
        self.assertIn('"http_status": 503', text)
        self.assertNotIn("http://", text)

    async def test_forced_http_read_timeout_is_reported_without_hanging(self):
        # Reproduce the original failure at a small timescale, even though
        # production now disables this competing transport deadline.
        original = httpx.AsyncClient.send
        async def send(client, request, **kwargs):
            request.extensions["timeout"]["read"] = .03
            return await original(client, request, **kwargs)
        with patch.object(httpx.AsyncClient, "send", send):
            with self.assertRaisesRegex(McpError, "request failed.*ReadTimeout"):
                await asyncio.wait_for(self.client.call_tool("task", {"delay": .2}), 1)
        self.assertFalse(self.client._owner.done())
        self.assertEqual(await self.client.call_tool("task", {}), "done")

    async def test_explicit_disconnect_wakes_pending_call(self):
        call = asyncio.create_task(self.client.call_tool("task", {"delay": .4}))
        await asyncio.sleep(.05)
        await self.client.disconnect()
        with self.assertRaises(Exception):
            await asyncio.wait_for(call, 1)

    async def test_caller_cancellation_keeps_shared_connection_usable(self):
        call = asyncio.create_task(self.client.call_tool("task", {"delay": .3}))
        await asyncio.sleep(.05)
        call.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await call
        self.assertFalse(self.client._owner.done())
        self.assertEqual(await self.client.call_tool("task", {}), "done")

    async def test_explicit_reconnect_after_failure(self):
        with self.assertRaises(Exception):
            await asyncio.wait_for(self.client.call_tool("task", {"fail": True}), 2)
        self.assertTrue(await self.client.connect())
        self.assertEqual(await self.client.call_tool("task", {}), "done")


class DiagnosticTests(unittest.TestCase):
    def test_nested_exception_log_never_contains_headers_body_url_or_error_message(self):
        secret = "fixture-credential-never-log"
        request = httpx.Request("POST", f"https://example.invalid/mcp/{secret}",
                               headers={"authorization": f"Bearer {secret}"}, content=secret)
        response = httpx.Response(503, request=request, text=secret)
        try:
            raise httpx.HTTPStatusError(secret, request=request, response=response)
        except httpx.HTTPStatusError as cause:
            error = ExceptionGroup(secret, [cause, httpx.ReadError(secret, request=request)])
            details = json.dumps(transport_failure_details(error))
        self.assertIn("HTTPStatusError", details)
        self.assertIn("ReadError", details)
        self.assertIn('"http_status": 503', details)
        self.assertIn("frames", details)
        self.assertNotIn(secret, details)
        self.assertNotIn("example.invalid", details)
        self.assertNotIn("authorization", details)

    def test_cyclic_causes_are_bounded(self):
        first, second = RuntimeError("one"), RuntimeError("two")
        first.__cause__, second.__cause__ = second, first
        self.assertLess(len(json.dumps(transport_failure_details(first))), 1000)


if __name__ == "__main__":
    unittest.main()
