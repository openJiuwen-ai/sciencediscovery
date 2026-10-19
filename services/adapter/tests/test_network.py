# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import asyncio

import httpx
import pytest

from sciencediscovery_adapter.network import InternalClient, is_loopback, websocket_proxy_options

pytestmark = pytest.mark.science_tags(category="st", os="linux", arch=("amd64", "arm64"))


@pytest.mark.parametrize("proxy", ["http://127.0.0.1:1", "socks5://127.0.0.1:1", "invalid://private:password@host"])
async def test_local_transport_works_with_broken_outbound_proxy(monkeypatch, proxy):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.setenv(name, proxy)
    monkeypatch.setenv("NO_PROXY", "")
    monkeypatch.setenv("no_proxy", "")

    async def reply(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(reply, "127.0.0.1", 0)
    async with server:
        url = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        async with InternalClient(base_url=url, timeout=httpx.Timeout(2)) as client:
            assert (await client.get("/health")).text == "OK"
            assert client.external is None


async def test_declared_socks_dependency_can_construct_external_client(monkeypatch):
    monkeypatch.setenv("ALL_PROXY", "socks5://127.0.0.1:1")
    async with httpx.AsyncClient():
        pass


@pytest.mark.parametrize("url", ["http://localhost:1", "ws://127.0.0.2:2", "ws://[::1]:3", "http://[::ffff:127.0.0.1]"])
def test_loopback_and_websocket_policy(url):
    assert is_loopback(url)
    assert websocket_proxy_options(url) == {"proxy": None}
    assert websocket_proxy_options("wss://swarm.example.com") == {}


async def test_nonlocal_http_uses_environment_proxy(monkeypatch):
    seen = []

    async def reply(reader, writer):
        seen.append(await reader.readuntil(b"\r\n\r\n"))
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nPROXIED")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(reply, "127.0.0.1", 0)
    async with server:
        monkeypatch.setenv("http_proxy", f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}")
        monkeypatch.setenv("no_proxy", "")
        async with InternalClient(timeout=httpx.Timeout(2)) as client:
            assert (await client.get("http://external.invalid/test")).text == "PROXIED"
    assert b"http://external.invalid/test" in seen[0]
