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

import asyncio
import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import httpx
import pytest
import websockets

from sciencediscovery_adapter.app import create_app
from sciencediscovery_adapter.config import Settings
from sciencediscovery_adapter.gateway import chat, rpc
from sciencediscovery_adapter.network import connect_gateway, is_loopback_url

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))


def configure_proxies(monkeypatch, proxy):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "WS_PROXY", "WSS_PROXY", "NO_PROXY"):
        for key in (name, name.lower()):
            monkeypatch.delenv(key, raising=False)
            if proxy is not None:
                monkeypatch.setenv(key, "127.*" if name == "NO_PROXY" else proxy)


@asynccontextmanager
async def http_server(host, body):
    requests = []

    async def handler(reader, writer):
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            requests.append(headers.decode())
            for line in headers.split(b"\r\n"):
                if line.lower().startswith(b"content-length:"):
                    await reader.readexactly(int(line.split(b":", 1)[1]))
            payload = json.dumps(body).encode()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                         + f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode() + payload)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async with await asyncio.start_server(handler, host, 0) as server:
        yield server.sockets[0].getsockname()[1], requests


@pytest.mark.parametrize("proxy", [None, "http://127.0.0.1:1", "socks5://127.0.0.1:1"])
@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "[::1]"])
async def test_http_clients_reach_loopback_with_or_without_proxies(monkeypatch, proxy, host):
    configure_proxies(monkeypatch, proxy)
    monkeypatch.setattr("sciencediscovery_adapter.app.forget_stale_aliases", AsyncMock())
    bind = "::1" if host == "[::1]" else "127.0.0.1"
    async with http_server(bind, {"status": "ok"}) as (port, requests):
        url = f"http://{host}:{port}"
        app = create_app(Settings(host="127.0.0.1", port=4310, legacy_url=url))
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://adapter") as client:
                response = await client.get("/health")
                assert response.status_code == 200 and response.json() == {"status": "ok"}
            bridge_response = await app.state.bridge.post(f"{url}/bridge", json={"tool": "example"})
            assert bridge_response.json() == {"status": "ok"}
            model_response = await app.state.models.get(f"{url}/v1/models")
            assert model_response.json() == {"status": "ok"}
    assert len(requests) == 3
    assert requests[0].startswith("GET /health HTTP/1.1")
    assert requests[1].startswith("POST /bridge HTTP/1.1")
    assert requests[2].startswith("GET /v1/models HTTP/1.1")


async def test_remote_clients_keep_using_the_environment_proxy(monkeypatch):
    monkeypatch.setattr("sciencediscovery_adapter.app.forget_stale_aliases", AsyncMock())
    async with http_server("127.0.0.1", {"via": "proxy"}) as (port, requests):
        configure_proxies(monkeypatch, f"http://127.0.0.1:{port}")
        app = create_app(Settings(host="127.0.0.1", port=4310, legacy_url="http://remote-legacy.invalid"))
        async with app.router.lifespan_context(app):
            response = await app.state.legacy.get("/health")
            assert response.json() == {"via": "proxy"}
            response = await app.state.bridge.get("http://remote-model.invalid/v1/models")
            assert response.json() == {"via": "proxy"}
            response = await app.state.models.get("http://remote-model.invalid/v1/models")
            assert response.json() == {"via": "proxy"}
    assert requests[0].startswith("GET http://remote-legacy.invalid/health HTTP/1.1")
    assert requests[1].startswith("GET http://remote-model.invalid/v1/models HTTP/1.1")
    assert requests[2].startswith("GET http://remote-model.invalid/v1/models HTTP/1.1")


@pytest.mark.parametrize("proxy", [None, "http://127.0.0.1:1"])
@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "[::1]"])
@pytest.mark.parametrize("mode", ["chat", "rpc"])
async def test_gateway_reaches_loopback_with_or_without_proxies(monkeypatch, proxy, host, mode):
    configure_proxies(monkeypatch, proxy)

    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack"}))
        request = json.loads(await connection.recv())
        if mode == "chat":
            frame = {"type": "event", "event": "chat.processing_status",
                     "payload": {"is_complete": True, "is_processing": False}}
        else:
            frame = {"type": "res", "id": request["id"], "ok": True, "payload": {"status": "ok"}}
        await connection.send(json.dumps(frame))

    bind = "::1" if host == "[::1]" else "127.0.0.1"
    async with websockets.serve(handler, bind, 0) as server:
        url = f"ws://{host}:{server.sockets[0].getsockname()[1]}/ws"
        if mode == "chat":
            frames = await asyncio.wait_for(_collect_chat(url), 5)
            assert frames[-1]["payload"]["is_complete"]
        else:
            assert await rpc(url, "status", timeout=5) == {"status": "ok"}


async def _collect_chat(url):
    return [frame async for frame in chat(url, {})]


@pytest.mark.parametrize("url, expected", [
    ("http://localhost:4310", True), ("ws://LOCALHOST.:19000", True),
    ("http://127.0.0.2:4310", True), ("ws://[::1]:19000", True),
    ("https://localhost.example.com", False), ("https://example.com/127.0.0.1", False),
    ("http://192.168.1.2", False), ("http://10.0.0.1", False),
])
def test_only_loopback_urls_bypass_proxies(url, expected):
    assert is_loopback_url(url) is expected


def test_remote_gateway_keeps_automatic_proxy_selection(monkeypatch):
    seen = {}

    def connect(url, *, max_size, proxy=True):
        seen.update(url=url, proxy=proxy)

    monkeypatch.setattr(websockets, "connect", connect)
    connect_gateway("wss://remote-gateway.example.com/ws")
    assert seen["proxy"] is True


def test_older_websockets_does_not_receive_an_unsupported_proxy_argument(monkeypatch):
    seen = []

    def connect(url, *, max_size):
        seen.append(url)

    monkeypatch.setattr(websockets, "connect", connect)
    connect_gateway("ws://127.0.0.1:19000/ws")
    assert seen == ["ws://127.0.0.1:19000/ws"]
