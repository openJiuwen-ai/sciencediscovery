# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Real SDK -> real HTTP -> adapter router -> controlled tool callbacks.

Run with the pinned Swarm venv and PYTHONPATH=services/adapter/src. No LLM,
external network, production server or credentials. Failures remain failures:
transport survival/recovery is a contract, not an expected-failure fixture.
"""
import asyncio
import json
import socket
import unittest
from collections import Counter
from unittest.mock import patch

import httpx
import uvicorn
from fastapi import FastAPI, Request
from openjiuwen.core.foundation.tool import McpServerConfig
from openjiuwen.core.runner.resources_manager.tool_manager import ToolMgr
from jiuwenswarm.server.runtime.mcp.call_timeout_patch import apply_mcp_call_timeout_patch
from sciencediscovery_adapter.mcp_server import RUN_ARG, Toolset, ToolsetRegistry, mcp_router
from sciencediscovery_adapter.agent_runs import Bridge, bridge_caller


class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        apply_mcp_call_timeout_patch()
        self.counts = Counter()
        self.entered = {}
        self.gates = {}
        self.cancelled = {}
        self.registry = ToolsetRegistry()
        self.tools = [{"name": "probe", "description": "local fixture",
                       "inputSchema": {"type": "object", "properties": {"label": {"type": "string"}}}}]

        async def call(name, arguments):
            label = arguments["label"]
            self.counts[label] += 1
            self.entered.setdefault(label, asyncio.Event()).set()
            gate = self.gates.get(label)
            if gate:
                try:
                    await gate.wait()
                except asyncio.CancelledError:
                    self.cancelled.setdefault(label, asyncio.Event()).set()
                    raise
            if arguments.get("raise"):
                raise ValueError("controlled tool failure")
            return label, bool(arguments.get("is_error"))

        self.callback = call
        self.tag = self.registry.add(Toolset(self.tools, call, timeout_s=3))
        self.registry.merge(self.tools)
        app = FastAPI()
        self.app = app
        app.include_router(mcp_router(self.registry))
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.url = f"http://127.0.0.1:{sock.getsockname()[1]}/mcp/{self.registry.token}"
        self.server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
        self.serving = asyncio.create_task(self.server.serve(sockets=[sock]))
        for _ in range(200):
            if self.server.started:
                break
            await asyncio.sleep(.01)
        self.assertTrue(self.server.started)
        self.config = McpServerConfig(server_name="sci", server_id="boundary",
            client_type="streamable-http", server_path=self.url, params={"timeout_s": 5})
        self.client = ToolMgr._create_client(self.config)
        self.assertTrue(await asyncio.wait_for(self.client.connect(), 3))
        self.tasks = []

    async def asyncTearDown(self):
        for gate in self.gates.values():
            gate.set()
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await asyncio.wait_for(self.client.disconnect(), 3)
        self.server.should_exit = True
        await asyncio.wait_for(self.serving, 3)

    def start(self, label, **arguments):
        task = asyncio.create_task(self.invoke(label, **arguments))
        self.tasks.append(task)
        return task

    async def invoke(self, label, tag=None, **arguments):
        return await asyncio.wait_for(self.client.call_tool("probe", {
            "label": label, RUN_ARG: tag or self.tag, **arguments,
        }), 3)

    async def wait_entered(self, label):
        await asyncio.wait_for(self.entered.setdefault(label, asyncio.Event()).wait(), 2)

    def post_fault(self, bad_label, fault):
        """Fault only the selected SDK HTTP request; all other I/O is real."""
        original = httpx.AsyncClient.send
        target = self.url

        async def send(client, request, **kwargs):
            if str(request.url) == target and request.method == "POST":
                body = json.loads(request.content)
                if body.get("params", {}).get("arguments", {}).get("label") == bad_label:
                    if isinstance(fault, int):
                        return httpx.Response(fault, request=request, content=b"controlled HTTP failure")
                    if isinstance(fault, bytes):
                        return httpx.Response(200, request=request, headers={"content-type": "application/json"}, content=fault)
                    raise fault("controlled transport failure", request=request)
            return await original(client, request, **kwargs)

        return patch.object(httpx.AsyncClient, "send", send)

    async def test_seven_parent_waits_with_seven_child_results(self):
        # Seven long task calls stay pending while seven children use the same
        # connection. Release in reverse order to detect response misrouting.
        for i in range(7):
            self.gates[f"parent-{i}"] = asyncio.Event()
        parents = [self.start(f"parent-{i}") for i in range(7)]
        await asyncio.gather(*(self.wait_entered(f"parent-{i}") for i in range(7)))
        children = await asyncio.gather(*(self.invoke(f"child-{i}") for i in range(7)))
        self.assertEqual(children, [f"child-{i}" for i in range(7)])
        for i in reversed(range(7)):
            self.gates[f"parent-{i}"].set()
            self.assertEqual(await parents[i], f"parent-{i}")
        self.assertTrue(all(count == 1 for count in self.counts.values()))

    async def test_100_concurrent_calls_keep_identity_and_execute_once(self):
        result = await asyncio.gather(*(self.invoke(f"call-{i}") for i in range(100)))
        self.assertEqual(result, [f"call-{i}" for i in range(100)])
        self.assertTrue(all(count == 1 for count in self.counts.values()))

    async def test_business_error_does_not_break_parent_or_next_call(self):
        self.gates["parent"] = asyncio.Event()
        parent = self.start("parent")
        await self.wait_entered("parent")
        error = await self.invoke("child", **{"raise": True})
        self.assertIn("controlled tool failure", str(error))
        self.gates["parent"].set()
        self.assertEqual(await parent, "parent")
        self.assertEqual(await self.invoke("next"), "next")

    async def test_run_deadline_does_not_cancel_sibling_or_next_call(self):
        short_tag = self.registry.add(Toolset(self.tools, self.callback, timeout_s=.05))
        self.gates["short"] = asyncio.Event()
        result, sibling = await asyncio.gather(self.invoke("short", tag=short_tag), self.invoke("sibling"))
        self.assertIn("timed out", str(result))
        self.assertEqual(sibling, "sibling")
        self.assertEqual(await self.invoke("next"), "next")

    async def test_cancelled_caller_late_result_does_not_poison_connection(self):
        self.gates["cancel"] = asyncio.Event()
        task = self.start("cancel")
        await self.wait_entered("cancel")
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.gates["cancel"].set()
        self.assertEqual(await self.invoke("after-cancel"), "after-cancel")
        await asyncio.sleep(.03)  # allow the late response to reach the SDK
        self.assertEqual(await self.invoke("after-late-result"), "after-late-result")
        self.assertEqual(self.counts["cancel"], 1)

    async def test_retired_run_tag_cannot_execute_or_affect_live_run(self):
        old = self.registry.add(Toolset(self.tools, self.callback, timeout_s=3))
        self.registry.remove(old)
        result = await self.invoke("retired", tag=old)
        self.assertIn("no running run", str(result))
        self.assertEqual(self.counts["retired"], 0)
        self.assertEqual(await self.invoke("live"), "live")

    async def test_tools_list_refresh_during_parent_wait_keeps_transport(self):
        self.gates["parent"] = asyncio.Event()
        parent = self.start("parent")
        await self.wait_entered("parent")
        self.registry.merge([{"name": "extra", "description": "new", "inputSchema": {}}])
        cards = await self.client.list_tools()
        self.assertTrue(any(card.name == "extra" for card in cards))
        self.gates["parent"].set()
        self.assertEqual(await parent, "parent")

    async def check_request_fault_isolation(self, fault):
        self.gates["sibling"] = asyncio.Event()
        sibling = self.start("sibling")
        await self.wait_entered("sibling")
        with self.post_fault("fault", fault):
            with self.assertRaises(Exception):
                await self.invoke("fault")
        self.gates["sibling"].set()
        self.assertEqual(await sibling, "sibling", "One request failure must not cancel a healthy sibling")
        self.assertEqual(await self.invoke("after-fault"), "after-fault")
        self.assertEqual(self.counts["fault"], 0, "A failed unsent call must not be replayed")

    async def test_http_503_is_request_local(self):
        await self.check_request_fault_isolation(503)

    async def test_http_429_is_request_local(self):
        await self.check_request_fault_isolation(429)

    async def test_http_404_is_request_local(self):
        await self.check_request_fault_isolation(404)

    async def test_read_error_is_request_local(self):
        await self.check_request_fault_isolation(httpx.ReadError)

    async def test_connect_error_is_request_local(self):
        await self.check_request_fault_isolation(httpx.ConnectError)

    async def test_pool_timeout_is_request_local(self):
        await self.check_request_fault_isolation(httpx.PoolTimeout)

    async def test_write_timeout_is_request_local(self):
        await self.check_request_fault_isolation(httpx.WriteTimeout)

    async def test_invalid_json_fails_promptly_without_waiting_for_tool_deadline(self):
        with self.post_fault("malformed", b"not-json"):
            with self.assertRaises(Exception) as caught:
                await asyncio.wait_for(self.invoke("malformed"), .5)
        self.assertNotIsInstance(caught.exception, TimeoutError, "Malformed response left request waiting for timeout")
        self.assertEqual(await self.invoke("healthy"), "healthy")

    async def test_mismatched_response_id_fails_only_its_request(self):
        wrong = json.dumps({"jsonrpc": "2.0", "id": "unrelated-id", "result": {}}).encode()
        with self.post_fault("wrong-id", wrong):
            with self.assertRaisesRegex(Exception, "request failed.*ValueError"):
                await asyncio.wait_for(self.invoke("wrong-id"), 1)
        self.assertEqual(await self.invoke("healthy"), "healthy")

    async def test_cancelling_connect_waiter_does_not_kill_shared_initialization(self):
        entered, release = asyncio.Event(), asyncio.Event()
        original = httpx.AsyncClient.send
        fresh = ToolMgr._create_client(self.config)

        async def send(client, request, **kwargs):
            if str(request.url) == self.url and request.method == "POST":
                if json.loads(request.content).get("method") == "initialize":
                    entered.set()
                    await release.wait()
            return await original(client, request, **kwargs)

        first = second = None
        try:
            with patch.object(httpx.AsyncClient, "send", send):
                first = asyncio.create_task(fresh.connect())
                await asyncio.wait_for(entered.wait(), 1)
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                second = asyncio.create_task(fresh.connect())
                release.set()
                self.assertTrue(await asyncio.wait_for(second, 2))
                self.assertEqual(await fresh.call_tool("probe", {RUN_ARG: self.tag, "label": "connected"}), "connected")
        finally:
            release.set()
            for task in (first, second):
                if task is not None and not task.done():
                    task.cancel()
            await fresh.disconnect()

    async def test_new_call_can_recover_after_transport_owner_failure_without_replay(self):
        # A request-local 503 must no longer kill the owner. Inject a genuine
        # lifecycle failure to verify recovery independently of HTTP isolation.
        self.gates["in-flight"] = asyncio.Event()
        pending = self.start("in-flight")
        await self.wait_entered("in-flight")
        self.client._owner.cancel()
        await asyncio.gather(self.client._owner, return_exceptions=True)
        with self.assertRaises(Exception):
            await pending
        self.assertEqual(await self.invoke("new-call"), "new-call")
        self.assertEqual(self.counts["in-flight"], 1, "An interrupted request must not be replayed on recovery")

    async def test_explicit_reconnect_is_single_flight(self):
        self.client._owner.cancel()
        await asyncio.gather(self.client._owner, return_exceptions=True)
        original = httpx.AsyncClient.send
        initializations = []

        async def send(client, request, **kwargs):
            if str(request.url) == self.url and request.method == "POST":
                if json.loads(request.content).get("method") == "initialize":
                    initializations.append(1)
            return await original(client, request, **kwargs)

        with patch.object(httpx.AsyncClient, "send", send):
            self.assertTrue(all(await asyncio.gather(*(self.client.connect() for _ in range(8)))))
        self.assertEqual(len(initializations), 1, "Concurrent recovery must create exactly one session")
        self.assertEqual(await self.invoke("reconnected"), "reconnected")
        self.assertEqual(self.counts["reconnected"], 1)

    async def test_http_disconnect_propagates_cancellation_to_adapter_callback(self):
        self.gates["disconnected"] = asyncio.Event()
        cancelled = self.cancelled.setdefault("disconnected", asyncio.Event())
        pending = self.start("disconnected")
        await self.wait_entered("disconnected")
        await self.client.disconnect()
        with self.assertRaises(Exception):
            await pending
        await asyncio.wait_for(cancelled.wait(), .3)

    async def test_caller_cancel_closes_real_adapter_outbound_bridge_request(self):
        entered, disconnected = asyncio.Event(), asyncio.Event()

        @self.app.post("/execution-bridge")
        async def bridge(request: Request):
            await request.json()
            entered.set()
            while not await request.is_disconnected():
                await asyncio.sleep(.01)
            disconnected.set()
            return {"text": "cancelled", "isError": True}

        async with httpx.AsyncClient(timeout=None) as outbound:
            tag = self.registry.add(Toolset(self.tools, bridge_caller(
                Bridge(url=self.url.split("/mcp/")[0] + "/execution-bridge", token="fixture"), outbound), timeout_s=3))
            pending = self.start("outbound", tag=tag)
            await asyncio.wait_for(entered.wait(), 2)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            await asyncio.wait_for(disconnected.wait(), 1)
            self.assertEqual(await self.invoke("unrelated"), "unrelated")

    async def test_explicit_disconnect_does_not_auto_reopen(self):
        await self.client.disconnect()
        with self.assertRaisesRegex(RuntimeError, "explicitly disconnected"):
            await self.invoke("must-not-run")
        self.assertEqual(self.counts["must-not-run"], 0)

    async def test_lost_response_after_side_effect_is_not_replayed_on_reconnect(self):
        original = httpx.AsyncClient.send
        target = self.url

        async def send(client, request, **kwargs):
            response = await original(client, request, **kwargs)
            if str(request.url) == target and request.method == "POST":
                body = json.loads(request.content)
                if body.get("params", {}).get("arguments", {}).get("label") == "effect":
                    await response.aclose()
                    raise httpx.ReadError("response lost after execution", request=request)
            return response

        with patch.object(httpx.AsyncClient, "send", send):
            with self.assertRaises(Exception):
                await self.invoke("effect")
        self.assertEqual(self.counts["effect"], 1)
        self.assertTrue(await self.client.connect())
        self.assertEqual(await self.invoke("fresh"), "fresh")
        self.assertEqual(self.counts["effect"], 1, "Reconnection must never replay an unknown-outcome action")

    async def test_initialization_failure_can_be_retried_explicitly(self):
        original = httpx.AsyncClient.send

        async def send(client, request, **kwargs):
            if str(request.url) == self.url and request.method == "POST":
                if json.loads(request.content).get("method") == "initialize":
                    return httpx.Response(503, request=request, content=b"controlled startup failure")
            return await original(client, request, **kwargs)

        fresh = ToolMgr._create_client(self.config)
        try:
            with patch.object(httpx.AsyncClient, "send", send):
                self.assertFalse(await asyncio.wait_for(fresh.connect(), 2))
            self.assertTrue(await asyncio.wait_for(fresh.connect(), 2))
            self.assertEqual(await fresh.call_tool("probe", {RUN_ARG: self.tag, "label": "after-init"}), "after-init")
        finally:
            await fresh.disconnect()


if __name__ == "__main__":
    unittest.main()
