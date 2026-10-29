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

"""Keep the adapter's local service traffic out of host-configured proxies."""

import inspect
from ipaddress import ip_address
from urllib.parse import urlsplit

import websockets


def is_loopback_url(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    if host.rstrip(".").lower() == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def loopback_mounts(*urls: str) -> dict[str, None]:
    """Use HTTPX's direct transport for local services, preserving remote proxies and TLS settings."""
    hosts = {"localhost", "localhost.", "127.0.0.1", "::1"}
    hosts.update(urlsplit(url).hostname for url in urls if is_loopback_url(url))
    return {f"all://[{host}]" if ":" in host else f"all://{host}": None for host in hosts}


def connect_gateway(url: str):
    # websockets 15+ auto-detects proxies. Older supported releases connect
    # directly already and don't accept the proxy argument. Remote URLs keep
    # the library's default proxy behavior in either case.
    options = {}
    if is_loopback_url(url) and "proxy" in inspect.signature(websockets.connect).parameters:
        options["proxy"] = None
    return websockets.connect(url, max_size=None, **options)
