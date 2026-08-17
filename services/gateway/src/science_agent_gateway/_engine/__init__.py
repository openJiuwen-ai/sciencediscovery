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

"""Internal web-provider adapter package.

The agent loop, model transport, and MCP client all run natively in the Node
control plane; this package is what remains of the Python engine seam and backs
only the keyed web providers. ``web`` executes vendor community providers and is
imported lazily, so a missing vendor dependency fails web provider invocation
alone rather than Gateway start-up.
"""

_WEB_EXPORTS = frozenset(
    {
        "ResolvedWebProvider",
        "configure_web_proxy_environment",
        "invoke_isolated_web_provider",
        "invoke_serialized_web_provider",
        "invoke_web_provider",
        "resolve_web_provider",
    }
)

__all__ = [
    "ResolvedWebProvider",
    "configure_web_proxy_environment",
    "invoke_isolated_web_provider",
    "invoke_serialized_web_provider",
    "invoke_web_provider",
    "resolve_web_provider",
]


def __getattr__(name: str):
    # Resolved lazily so importing this package never touches the vendor
    # dependency until a web provider is actually invoked.
    if name in _WEB_EXPORTS:
        from . import web

        return getattr(web, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
