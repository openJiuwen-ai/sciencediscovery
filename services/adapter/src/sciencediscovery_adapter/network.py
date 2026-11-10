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

"""Keep internal loopback transport independent of outbound proxy settings."""
from functools import partialmethod
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
    def __init__(self, *, base_url: str = "", transport=None, timeout=None, limits=None):
        self.base_url = httpx.URL(base_url)
        # httpx's limits default is a live Limits object; an explicit None would
        # break the pool later (None.max_connections), so only pass it through
        # when the caller supplied one.
        self.options = dict(base_url=base_url, timeout=timeout, follow_redirects=False, transport=transport)
        if limits is not None:
            self.options["limits"] = limits
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

    def _outbound_for(self, destination: str) -> httpx.AsyncClient:
        """Pick the transport for one destination.

        Loopback destinations belong to the direct client. Anything else goes
        through the environment-aware client, which is created on first use so
        that a broken proxy configuration never blocks startup.
        """
        if is_loopback(destination):
            return self.direct
        if self.external is None:
            self.external = httpx.AsyncClient(**self.options)
        return self.external

    async def send(self, request, **kwargs):
        outbound = self._outbound_for(str(request.url))
        return await outbound.send(request, **kwargs)

    async def _dispatch(self, method: str, url: str, **kwargs):
        prepared = self.build_request(method, url, **kwargs)
        return await self.send(prepared)

    # Verb shortcuts bind _dispatch partially instead of hand-writing the
    # usual per-verb async wrappers; call sites keep awaiting client.get(...)
    # and client.post(...) exactly as before.
    get = partialmethod(_dispatch, "GET")
    post = partialmethod(_dispatch, "POST")


def websocket_proxy_options(url: str) -> dict:
    return {"proxy": None} if is_loopback(url) else {}
