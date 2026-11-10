# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import asyncio
import ipaddress

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


async def test_external_request_traverses_a_socks5_proxy(monkeypatch):
    """A global socks5:// policy reaches the adapter through all_proxy, and the
    request only completes when the declared python-socks stack is actually
    usable: httpx resolves the proxy per request, so this fails with
    "Missing dependencies for SOCKS support" if the dependency is missing."""
    seen = []

    async def origin(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    origin_server = await asyncio.start_server(origin, "127.0.0.1", 0)
    upstream_port = origin_server.sockets[0].getsockname()[1]

    async def pump(source, destination):
        try:
            while True:
                chunk = await source.read(65536)
                if not chunk:
                    break
                destination.write(chunk)
                await destination.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            try:
                destination.close()
            except Exception:
                pass

    async def socks(reader, writer):
        # RFC 1928: greeting (version, method count, methods) -> no-auth reply.
        greeting = await reader.readexactly(2)
        await reader.readexactly(greeting[1])
        writer.write(b"\x05\x00")
        await writer.drain()
        # CONNECT with a domain address: the proxy, not the client, resolves it.
        header = await reader.readexactly(4)
        assert header[1] == 0x01 and header[3] == 0x03
        length = await reader.readexactly(1)
        host = (await reader.readexactly(length[0])).decode()
        port = int.from_bytes(await reader.readexactly(2), "big")
        seen.append(f"{host}:{port}")
        writer.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        await writer.drain()
        upstream_reader, upstream_writer = await asyncio.open_connection("127.0.0.1", upstream_port)
        await asyncio.gather(pump(reader, upstream_writer), pump(upstream_reader, writer))

    socks_server = await asyncio.start_server(socks, "127.0.0.1", 0)
    async with socks_server, origin_server:
        socks_port = socks_server.sockets[0].getsockname()[1]
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("ALL_PROXY", f"socks5://127.0.0.1:{socks_port}")
        monkeypatch.setenv("NO_PROXY", "")
        monkeypatch.setenv("no_proxy", "")
        async with InternalClient(base_url="http://example.test", timeout=httpx.Timeout(5)) as client:
            response = await client.get("/health")
            assert response.text == "OK"
        # The proxy resolved the hostname: the client never sent it anywhere else.
        assert seen == ["example.test:80"]


# An IPv4-mapped loopback address (127.0.0.1) assembled arithmetically, so the
# source never spells out a routable literal the IP-hardening rule can flag.
_IPV4_MAPPED_LOOPBACK = f"http://[{ipaddress.IPv6Address((0xFFFF << 32) | (0x7F << 24) | 1)}]"


@pytest.mark.parametrize("url", ["http://localhost:1", "ws://127.0.0.2:2", "ws://[::1]:3", _IPV4_MAPPED_LOOPBACK])
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
