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

from sciencediscovery_adapter.models import ModelProfile, ModelSync
import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

URL = "ws://gw/ws"


class FakeGateway:
    def __init__(self, models=()):
        self.models = [dict(m) for m in models]
        self.replacements = []

    async def rpc(self, url, method, params=None, **kwargs):
        await asyncio.sleep(0)  # let another task interleave, as a real socket would
        if method == "models.list":
            return {"models": [dict(m) for m in self.models]}
        assert method == "models.replace_all"
        self.replacements.append(params["models"])
        self.models = [dict(m) for m in params["models"]]
        return {"count": len(self.models)}


def entry(name, base="http://a/v1", key="k", default=False, **extra):
    return {"model_name": name, "api_base": base, "api_key": key, "model_provider": "OpenAI", "is_default": default, **extra}


async def test_an_already_configured_model_changes_nothing():
    gateway = FakeGateway([entry("m1", default=True)])
    name = await ModelSync(gateway.rpc, URL).ensure(ModelProfile("m1", "http://a/v1", "k"))
    assert name == "m1" and gateway.replacements == []


async def test_a_new_model_is_added_and_the_others_are_kept():
    gateway = FakeGateway([entry("m1", default=True, origin_index=0, temperature=0.2)])
    name = await ModelSync(gateway.rpc, URL).ensure(ModelProfile("m2", "http://b/v1", "k2"))
    assert name == "m2"
    added, = gateway.replacements
    assert [m["model_name"] for m in added] == ["m1", "m2"]
    assert added[0]["temperature"] == 0.2 and "origin_index" not in added[0]  # kept, minus derived fields
    assert added[0]["is_default"] is True and added[1]["is_default"] is False
    assert added[1]["api_base"] == "http://b/v1" and added[1]["api_key"] == "k2"


async def test_a_changed_endpoint_or_key_replaces_the_entry_in_place():
    gateway = FakeGateway([entry("m1", default=True), entry("m2", key="old")])
    await ModelSync(gateway.rpc, URL).ensure(ModelProfile("m2", "http://a/v1", "new"))
    result, = gateway.replacements
    assert [m["model_name"] for m in result] == ["m1", "m2"] and result[1]["api_key"] == "new"
    assert sum(1 for m in result if m["model_name"] == "m2") == 1


async def test_the_first_model_becomes_the_default_when_there_is_none():
    gateway = FakeGateway([])
    await ModelSync(gateway.rpc, URL).ensure(ModelProfile("m1", "http://a/v1", "k"))
    assert gateway.replacements[0][0]["is_default"] is True


async def test_concurrent_runs_do_not_lose_each_others_models():
    gateway = FakeGateway([entry("m0", default=True)])
    sync = ModelSync(gateway.rpc, URL)
    await asyncio.gather(*(sync.ensure(ModelProfile(f"m{i}", f"http://h{i}/v1", "k")) for i in range(1, 6)))
    assert sorted(m["model_name"] for m in gateway.models) == [f"m{i}" for i in range(6)]


async def test_remove_drops_a_private_entry_and_keeps_a_default():
    gateway = FakeGateway([entry("m1", default=True), entry("sd-x")])
    await ModelSync(gateway.rpc, URL).remove("sd-x")
    assert [m["model_name"] for m in gateway.models] == ["m1"] and gateway.models[0]["is_default"]


async def test_removing_an_absent_entry_changes_nothing():
    gateway = FakeGateway([entry("m1", default=True)])
    await ModelSync(gateway.rpc, URL).remove("nope")
    assert gateway.replacements == []


ADAPTER = "http://adapter:4310"


async def test_prune_removes_the_adapters_entries_and_the_placeholder_and_keeps_the_rest():
    gw = FakeGateway([entry("real", default=True), entry("DeepSeek-V4-abc123", base=f"{ADAPTER}/llm/abc/v1"),
                      entry("sd-old", base=f"{ADAPTER}/llm/def/v1"), entry("your-model-name", base="https://example.com/compatible-mode/v1"),
                      entry("other", base="http://elsewhere/v1")])
    assert await ModelSync(gw.rpc, URL).prune(ADAPTER) == 3
    assert [m["model_name"] for m in gw.models] == ["real", "other"]


async def test_prune_with_nothing_to_remove_writes_nothing():
    gw = FakeGateway([entry("real", default=True)])
    assert await ModelSync(gw.rpc, URL).prune(ADAPTER) == 0
    assert gw.replacements == []


async def test_prune_keeps_a_default_when_the_default_was_removed():
    gw = FakeGateway([entry("your-model-name", base="https://example.com/v1", default=True), entry("real")])
    await ModelSync(gw.rpc, URL).prune(ADAPTER)
    assert [(m["model_name"], m["is_default"]) for m in gw.models] == [("real", True)]


async def test_ensure_default_makes_one_default_and_clears_the_others():
    gw = FakeGateway([entry("your-model-name", default=True), entry("sd-run1")])
    await ModelSync(gw.rpc, URL).ensure_default(ModelProfile("sd-default", "http://a/llm/default/v1", "key"))
    assert [(m["model_name"], m["is_default"]) for m in gw.models] == [("sd-default", True), ("your-model-name", False), ("sd-run1", False)]


async def test_ensure_default_writes_nothing_when_it_already_is_the_only_default():
    gw = FakeGateway([entry("other")])
    sync = ModelSync(gw.rpc, URL)
    profile = ModelProfile("sd-default", "http://a/llm/default/v1", "key")
    await sync.ensure_default(profile)
    writes = len(gw.replacements)
    await sync.ensure_default(profile)
    assert len(gw.replacements) == writes


async def test_ensure_default_repairs_an_entry_whose_endpoint_changed():
    gw = FakeGateway([entry("sd-default", base="http://old/v1", default=True)])
    await ModelSync(gw.rpc, URL).ensure_default(ModelProfile("sd-default", "http://new/v1", "key"))
    assert gw.models[0]["api_base"] == "http://new/v1" and gw.models[0]["is_default"] is True


async def test_prune_keeps_the_entries_it_is_told_to_keep_even_when_they_are_ours():
    gw = FakeGateway([entry("sciencediscovery-default", base=f"{ADAPTER}/llm/default/v1", default=True),
                      entry("your-model-name", base="https://example.com/v1")])
    assert await ModelSync(gw.rpc, URL).prune(ADAPTER, keep=frozenset({"sciencediscovery-default"})) == 1
    assert [m["model_name"] for m in gw.models] == ["sciencediscovery-default"]
