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

import json

import httpx
import pytest

from sciencediscovery_adapter.app import create_app
from sciencediscovery_adapter.config import Settings

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

SETTINGS = Settings(host="127.0.0.1", port=4310, legacy_url="http://legacy.test")


def streamed(status: int, body: bytes = b"", headers=None) -> httpx.Response:
    """A response whose body is still a stream, as a real transport returns it."""
    return httpx.Response(status, headers=headers, stream=httpx.ByteStream(body))


def legacy_transport(handler):
    return httpx.MockTransport(handler)


async def call(handler, method="GET", url="/api/x", **kwargs):
    app = create_app(SETTINGS, transport=legacy_transport(handler))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
            return await client.request(method, url, **kwargs)


async def test_forwards_method_path_query_headers_and_body():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(method=request.method, url=str(request.url), auth=request.headers.get("authorization"),
                    host=request.headers.get("host"), body=request.content)
        return streamed(201, b'{"ok": true}', {"content-type": "application/json"})

    response = await call(handler, "POST", "/api/sessions/1/messages?after=3",
                          headers={"Authorization": "Bearer t"}, content=b'{"a":1}')
    assert response.status_code == 201 and response.json() == {"ok": True}
    assert seen["method"] == "POST"
    assert seen["url"] == "http://legacy.test/api/sessions/1/messages?after=3"
    assert seen["auth"] == "Bearer t"
    assert seen["host"] == "adapter"  # the client's Host, not the upstream's
    assert seen["body"] == b'{"a":1}'


async def test_streams_server_sent_events_unchanged():
    payload = b"event: run.started\ndata: {}\n\nevent: run.completed\ndata: {}\n\n"

    def handler(request: httpx.Request) -> httpx.Response:
        return streamed(200, payload, {"content-type": "text/event-stream"})

    response = await call(handler)
    assert response.headers["content-type"] == "text/event-stream"
    assert response.content == payload
    assert len(response.headers["x-sciencediscovery-request-id"]) == 32


async def test_passes_error_status_and_repeated_headers():
    def handler(request: httpx.Request) -> httpx.Response:
        return streamed(409, b"conflict", [("set-cookie", "a=1"), ("set-cookie", "b=2")])

    response = await call(handler)
    assert response.status_code == 409 and response.text == "conflict"
    assert response.headers.get_list("set-cookie") == ["a=1", "b=2"]


async def test_legacy_down_is_a_502_with_a_json_body():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    response = await call(handler)
    assert response.status_code == 502
    assert json.loads(response.text)["error"] == "legacy_unavailable"


async def test_read_failure_is_correlated_without_logging_secrets_or_retrying(caplog):
    calls = []
    def handler(request):
        calls.append(request)
        try:
            raise OSError("secret-upstream-body")
        except OSError as cause:
            raise httpx.ReadError("secret-url-key") from cause
    response = await call(handler, "POST", "/api/run?key=secret-query", content="secret-body",
                          headers={"Authorization": "Bearer secret-auth"})
    assert response.status_code == 502 and len(calls) == 1
    assert response.json()["requestId"] in caplog.text
    assert "ReadError" in caplog.text and "OSError" in caplog.text
    assert "phase=headers" in caplog.text and "path=/api/run" in caplog.text
    assert "secret-" not in caplog.text


async def test_body_read_failure_closes_stream_and_logs_phase(caplog):
    class BrokenStream(httpx.AsyncByteStream):
        closed = False
        async def __aiter__(self):
            yield b"partial"
            raise httpx.ReadError("secret-response")
        async def aclose(self):
            self.closed = True
    stream = BrokenStream()
    with pytest.raises(httpx.ReadError):
        await call(lambda _: httpx.Response(200, stream=stream))
    assert stream.closed
    assert "phase=body" in caplog.text
    assert "secret-response" not in caplog.text


async def test_hop_by_hop_headers_are_not_forwarded():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["headers"] = dict(request.headers)
        return streamed(200)

    await call(handler, headers={"Connection": "keep-alive, x-private", "X-Private": "1", "X-Keep": "2"})
    assert "x-private" not in seen["headers"]
    assert seen["headers"]["x-keep"] == "2"


async def test_streams_ndjson_unchanged():
    payload = b'{"type":"run.started"}\n{"type":"run.completed"}\n'

    def handler(request: httpx.Request) -> httpx.Response:
        return streamed(200, payload, {"content-type": "application/x-ndjson"})

    response = await call(handler, url="/api/sessions/1/trajectory/export")
    assert response.headers["content-type"] == "application/x-ndjson"
    assert response.content == payload


async def test_a_path_outside_api_reaches_the_legacy_server_too():
    """The front end's static files are served by the legacy server; the adapter does not own them."""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return streamed(200, b"<html></html>", {"content-type": "text/html"})

    response = await call(handler, url="/assets/app.js")
    assert seen["url"] == "http://legacy.test/assets/app.js"
    assert response.headers["content-type"] == "text/html"
