# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License");
import asyncio
import json

import httpx
import pytest

from sciencediscovery_adapter.agent_runs import Bridge, bridge_caller

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))


async def test_streaming_response_cannot_reset_the_total_ordinary_deadline():
    closed = asyncio.Event()
    calls = []

    class SlowBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            try:
                while True:
                    await asyncio.sleep(.005)
                    yield b" "
            finally:
                closed.set()

    async def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, stream=SlowBody())

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        call = bridge_caller(Bridge(url="http://bridge.test/call"), client,
                             timeout_s=.03, configuration_wait_timeout_s=1)
        text, error = await asyncio.wait_for(call("run_shell", {}), .5)
    assert error is True
    assert "timed out after 0.03s" in text
    assert "inspect state before retrying" in text
    assert closed.is_set()
    assert len(calls) == 1


async def test_configuration_propose_has_a_finite_deadline_and_no_retry():
    cancelled = asyncio.Event()
    calls = []

    async def handler(request):
        calls.append(json.loads(request.content))
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        call = bridge_caller(Bridge(url="http://bridge.test/call"), client,
                             timeout_s=.01, configuration_wait_timeout_s=.04)
        text, error = await asyncio.wait_for(call("configuration", {"action": "propose"}), .5)
    assert error is True
    assert "timed out after 0.04s" in text
    assert cancelled.is_set()
    assert len(calls) == 1


async def test_external_cancellation_is_not_converted_to_tool_error():
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def handler(request):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        call = bridge_caller(Bridge(url="http://bridge.test/call"), client,
                             timeout_s=.01, configuration_wait_timeout_s=1)
        pending = asyncio.create_task(call("configuration", {"action": "propose"}))
        await asyncio.wait_for(entered.wait(), .5)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
    assert cancelled.is_set()
