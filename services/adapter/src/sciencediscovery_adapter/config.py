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

"""Adapter settings, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    # The legacy TypeScript API that still serves every route not yet migrated.
    legacy_url: str
    # JiuwenSwarm: chats go to the gateway route, management calls to the web channel.
    gateway_url: str = "ws://127.0.0.1:19001/tui"
    mgmt_url: str = "ws://127.0.0.1:19000/ws"
    # How JiuwenSwarm reaches this process to call the per-run MCP toolsets.
    public_url: str = ""
    # Bearer token the legacy API presents on /agent/*; empty leaves them open
    # (the adapter listens on loopback by default).
    agent_token: str = ""
    # Default per-run tool deadline enforced by the adapter. The shared Swarm
    # transport must not impose a shorter execution deadline on child runs.
    tool_timeout_s: int = 3600
    # Which executor the API runs agent turns on (SCIENCE_AGENT_EXECUTOR): "jiuwenswarm" or "native".
    executor: str = "native"
    # The API's own access token (SCIENCE_AGENT_AUTH_TOKEN), which people already hold: it also opens /agent/info.
    api_token: str = ""

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        env = dict(os.environ if env is None else env)
        port = int(env.get("SCIENCE_AGENT_PORT", "4310"))
        legacy_port = int(env.get("SCIENCE_AGENT_LEGACY_PORT", str(port + 100)))
        return cls(
            host=env.get("SCIENCE_AGENT_HOST", "127.0.0.1"),
            port=port,
            legacy_url=env.get("SCIENCE_AGENT_LEGACY_URL", f"http://127.0.0.1:{legacy_port}").rstrip("/"),
            gateway_url=env.get("JIUWENSWARM_GATEWAY_URL", "ws://127.0.0.1:19001/tui"),
            mgmt_url=env.get("JIUWENSWARM_MGMT_URL", "ws://127.0.0.1:19000/ws"),
            public_url=env.get("SCIENCE_AGENT_ADAPTER_PUBLIC_URL", f"http://127.0.0.1:{port}").rstrip("/"),
            agent_token=env.get("SCIENCE_AGENT_ADAPTER_TOKEN", ""),
            tool_timeout_s=int(env.get("SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S", "3600")),
            api_token=env.get("SCIENCE_AGENT_AUTH_TOKEN", "").strip(),
            executor="jiuwenswarm" if env.get("SCIENCE_AGENT_EXECUTOR", "").strip() == "jiuwenswarm" else "native",
        )
