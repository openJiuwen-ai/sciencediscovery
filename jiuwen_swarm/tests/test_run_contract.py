# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

"""Contract regressions against the patched Swarm checkout; no model API calls."""
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch

from jiuwenswarm.common.schema.agent import AgentResponse
from jiuwenswarm.common.e2a.gateway_normalize import (
    e2a_response_from_agent_response, e2a_response_to_agent_chunk,
)


class RunContractTests(unittest.TestCase):
    def test_unary_startup_error_remains_a_stream_error(self):
        response = AgentResponse(request_id="startup", channel_id="tui", ok=False,
                                 payload={"error": "model binding rejected"})
        wire = e2a_response_from_agent_response(response, response_id="response")
        chunk = e2a_response_to_agent_chunk(wire)
        self.assertEqual(chunk.payload["event_type"], "chat.error")
        self.assertEqual(chunk.payload["error"], "model binding rejected")
        self.assertTrue(chunk.is_complete)
        self.assertEqual(chunk.request_id, "startup")

    def test_error_without_details_preserves_message(self):
        response = AgentResponse(request_id="startup", channel_id="tui", ok=False,
                                 payload={"error": "binding rejected"})
        wire = e2a_response_from_agent_response(response, response_id="response")
        wire.body.pop("details")
        chunk = e2a_response_to_agent_chunk(wire)
        self.assertEqual(chunk.payload["event_type"], "chat.error")
        self.assertEqual(chunk.payload["error"], "binding rejected")


class ModelBindingTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def binding(token):
        return {"model_name": "same-model", "api_base": f"http://localhost/llm/{token}/v1",
                "api_key": token, "client_provider": "OpenAI"}

    def adapter(self, token):
        from jiuwenswarm.server.runtime.agent_adapter.interface_deep import JiuWenSwarmDeepAdapter
        adapter = object.__new__(JiuWenSwarmDeepAdapter)
        adapter._run_model = self.binding(token)
        adapter._model_cache = {}
        adapter._model_name_to_keys = {}
        adapter._global_index_to_cache_key = {}
        adapter._last_models_config_fingerprint = None
        adapter._model = None
        adapter._inject_attribution_to_config = lambda config: None
        def build(config):
            entry = config["models"]["defaults"][0]["model_client_config"]
            adapter._model_cache[entry["model_name"]] = SimpleNamespace(
                model_client_config=entry, model_config=SimpleNamespace(context_window=8192))
            adapter._model_name_to_keys[entry["model_name"]] = [entry["model_name"]]
        adapter._build_model_cache_from_defaults = build
        return adapter

    def test_same_name_routes_stay_isolated_across_global_reload_and_rotation(self):
        module = "jiuwenswarm.server.runtime.agent_adapter.interface_deep"
        global_config = {"models": {"defaults": [{"model_client_config": {"model_name": "global"}}]}}
        before = deepcopy(global_config)
        a, b = self.adapter("a"), self.adapter("b")
        with patch(f"{module}.model_client_config_view", side_effect=lambda value: value), \
             patch(f"{module}.is_placeholder_model_entry", return_value=False):
            first = a._create_model(global_config)
            second = b._create_model(global_config)
            self.assertEqual(first.model_client_config["api_key"], "a")
            self.assertEqual(second.model_client_config["api_key"], "b")
            self.assertEqual(global_config, before)
            self.assertIs(a._create_model({"models": {"defaults": []}}), first)
            a._run_model = self.binding("next")
            rotated = a._create_model(global_config)
            self.assertEqual(rotated.model_client_config["api_key"], "next")
            self.assertIs(a._resolve_model_by_name(None), rotated)
            with self.assertRaisesRegex(ValueError, "does not match"):
                a._resolve_model_by_name("other-model")

    async def test_active_session_cannot_be_rebound(self):
        root = self.adapter("root")
        root._is_session_scoped_adapter = False
        root._session_adapter_key = lambda sid: sid
        root._session_adapter_locks = {}
        child = SimpleNamespace(_run_model=self.binding("old"), is_session_active=lambda sid: True)
        root._session_adapters = {"s": child}
        with self.assertRaisesRegex(ValueError, "active session"):
            await root._get_or_create_session_adapter("s", model_name="same-model", run_model=self.binding("new"))
        self.assertEqual(child._run_model, self.binding("old"))

    async def test_invalid_binding_fails_before_session_creation(self):
        root = self.adapter("root")
        with self.assertRaisesRegex(ValueError, "Invalid run-level"):
            await root._get_or_create_session_adapter("s", model_name="same-model", run_model={})
        with self.assertRaisesRegex(ValueError, "does not match"):
            await root._get_or_create_session_adapter("s", model_name="wrong", run_model=self.binding("new"))
