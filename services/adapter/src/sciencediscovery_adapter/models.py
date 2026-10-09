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

"""Put the model a run asked for into JiuwenSwarm's model list.

JiuwenSwarm keeps one global list (`models.list` / `models.replace_all`) and a
chat picks an entry with `model_name`. The UI chooses a model per run, so before
each run the adapter makes sure that model is in the list. Replacement is
whole-list, hence the lock: two runs must not interleave read-modify-write.

Limit: `model_name` is both the entry's key and the model id sent to the
provider, so two endpoints serving the same model id share one entry (the most
recent wins).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

Rpc = Callable[..., Awaitable[dict[str, Any]]]

# Fields JiuwenSwarm computes itself; sending them back is noise, not state.
_DERIVED = frozenset({"origin_index"})


@dataclass(frozen=True)
class ModelProfile:
    model: str
    base_url: str
    api_key: str
    provider: str = "OpenAI"
    def entry(self) -> dict[str, Any]:
        return {"model_name": self.model, "api_base": self.base_url, "api_key": self.api_key,
                "model_provider": self.provider}


class ModelSync:
    def __init__(self, rpc: Rpc, mgmt_url: str) -> None:
        self._rpc = rpc
        self._url = mgmt_url
        self._lock = asyncio.Lock()

    async def ensure(self, profile: ModelProfile) -> str:
        """Return the `model_name` to chat with, adding or updating the entry if needed."""
        async with self._lock:
            current = (await self._rpc(self._url, "models.list")).get("models", [])
            existing = next((m for m in current if m.get("model_name") == profile.model), None)
            wanted = profile.entry()
            if existing and all(existing.get(key) == value for key, value in wanted.items()):
                return profile.model
            kept = [{k: v for k, v in m.items() if k not in _DERIVED}
                    for m in current if m.get("model_name") != profile.model]
            entry = {**(existing or {}), **wanted}
            entry.pop("origin_index", None)
            entry["is_default"] = bool((existing or {}).get("is_default")) or not any(m.get("is_default") for m in kept)
            await self._rpc(self._url, "models.replace_all", {"models": [*kept, entry]})
            return profile.model

    async def remove(self, model_name: str) -> None:
        """Drop a private per-run entry once its run is over."""
        async with self._lock:
            current = (await self._rpc(self._url, "models.list")).get("models", [])
            kept = [{k: v for k, v in m.items() if k not in _DERIVED} for m in current if m.get("model_name") != model_name]
            if len(kept) == len(current):
                return
            if kept and not any(m.get("is_default") for m in kept):
                kept[0]["is_default"] = True
            await self._rpc(self._url, "models.replace_all", {"models": kept})

    async def prune(self, adapter_url: str, keep: frozenset[str] = frozenset()) -> int:
        """Drop the entries this adapter left behind and JiuwenSwarm's placeholder; return how many.

        Ours are recognised by their endpoint (`<adapter_url>/llm/...`), whatever their name: a run that ended
        abnormally (the stack was killed) never removed its entry, and JiuwenSwarm probes every entry each time
        it starts. The placeholder a fresh install ships (`https://example.com/...`) points nowhere and would be
        listed to the model as an available model. Only safe while no run is active: at start-up.
        """
        async with self._lock:
            current = (await self._rpc(self._url, "models.list")).get("models", [])

            def stale(m: dict[str, Any]) -> bool:
                if m.get("model_name") in keep:
                    return False
                base = str(m.get("api_base", ""))
                return base.startswith(f"{adapter_url}/llm/") or base.startswith("https://example.com")

            kept = [{k: v for k, v in m.items() if k not in _DERIVED} for m in current if not stale(m)]
            if len(kept) == len(current):
                return 0
            if kept and not any(m.get("is_default") for m in kept):
                kept[0]["is_default"] = True
            await self._rpc(self._url, "models.replace_all", {"models": kept})
            return len(current) - len(kept)

    async def ensure_default(self, profile: ModelProfile) -> None:
        """Make `profile` the one default model of JiuwenSwarm, and change nothing if it already is."""
        async with self._lock:
            current = (await self._rpc(self._url, "models.list")).get("models", [])
            wanted = profile.entry()
            existing = next((m for m in current if m.get("model_name") == profile.model), None)
            others_default = any(m.get("is_default") for m in current if m.get("model_name") != profile.model)
            if existing and existing.get("is_default") and not others_default \
                    and all(existing.get(key) == value for key, value in wanted.items()):
                return
            kept = [{**{k: v for k, v in m.items() if k not in _DERIVED}, "is_default": False}
                    for m in current if m.get("model_name") != profile.model]
            entry = {**{k: v for k, v in (existing or {}).items() if k not in _DERIVED}, **wanted, "is_default": True}
            # First in the list as well as flagged: JiuwenSwarm's own housekeeping may take the first entry.
            await self._rpc(self._url, "models.replace_all", {"models": [entry, *kept]})
