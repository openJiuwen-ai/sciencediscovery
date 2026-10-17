# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Keep internal loopback transport independent of outbound proxy settings."""
from ipaddress import ip_address
from urllib.parse import urlsplit

import httpx


def is_loopback(url: str) -> bool:
    host = (urlsplit(url).hostname or "").rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        address = ip_address(host)
        return address.is_loopback or bool(getattr(address, "ipv4_mapped", None) and address.ipv4_mapped.is_loopback)
    except ValueError:
        return False


class InternalClient:
    """Lazy external client: an invalid external proxy must not block startup.

    Each URL is classified before choosing its client. Redirect following is
    disabled, so a local endpoint cannot redirect through the direct client to
    an external destination. The configured non-local service path retains
    httpx's normal environment/NO_PROXY handling.
    """
    def __init__(self, *, base_url: str = "", transport=None, timeout=None):
        self.base_url = httpx.URL(base_url)
        self.options = dict(base_url=base_url, timeout=timeout, follow_redirects=False, transport=transport)
        self.direct = httpx.AsyncClient(**self.options, trust_env=False)
        self.external = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.direct.aclose()
        if self.external is not None:
            await self.external.aclose()

    def build_request(self, *args, **kwargs):
        return self.direct.build_request(*args, **kwargs)

    async def send(self, request, **kwargs):
        client = self.direct
        if not is_loopback(str(request.url)):
            if self.external is None:
                self.external = httpx.AsyncClient(**self.options)
            client = self.external
        return await client.send(request, **kwargs)

    async def request(self, method, url, **kwargs):
        return await self.send(self.build_request(method, url, **kwargs))

    async def post(self, url, **kwargs):
        return await self.request("POST", url, **kwargs)

    async def get(self, url, **kwargs):
        return await self.request("GET", url, **kwargs)


def websocket_proxy_options(url: str) -> dict:
    return {"proxy": None} if is_loopback(url) else {}
