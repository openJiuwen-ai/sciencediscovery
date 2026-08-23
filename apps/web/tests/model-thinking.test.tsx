// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import test from "node:test";

import type { ModelProfile, ModelProvider } from "@sciencediscovery/schema";

import { modelThinkingControls } from "../src/modelThinking.js";

const profile = (update: Partial<ModelProfile>): ModelProfile => ({
  baseUrl: "https://example.test/v1",
  createdAt: "2026-08-23T00:00:00.000Z",
  hasApiToken: true,
  id: "model-1",
  model: "custom",
  name: "Custom",
  proxyPolicy: "inherit",
  updatedAt: "2026-08-23T00:00:00.000Z",
  vision: false,
  ...update,
});

test("known provider catalog narrows Gemini to supported modes and efforts", () => {
  const provider = {
    id: "provider-1",
    presetId: "gemini",
  } as ModelProvider;
  const controls = modelThinkingControls(profile({
    apiProtocol: "openai-chat-completions",
    apiVariant: "gemini",
    model: "gemini-3.7-flash",
    providerId: provider.id,
  }), [provider]);
  assert.deepEqual(controls, {
    efforts: ["low", "medium", "high"],
    modes: ["auto", "enabled"],
    supported: true,
  });
});

test("a protocol without compatible controls never exposes thinking choices", () => {
  assert.deepEqual(modelThinkingControls(profile({ apiVariant: "openai" }), []), {
    efforts: [],
    modes: [],
    supported: false,
  });
});

test("custom Responses endpoints use dialect capabilities without inventing catalog facts", () => {
  assert.deepEqual(modelThinkingControls(profile({
    apiProtocol: "openai-responses",
    apiVariant: "responses",
  }), []), {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    modes: ["auto", "enabled", "disabled"],
    supported: true,
  });
});

test("known OpenAI and Kimi models expose only legal model-level controls", () => {
  const openai = { id: "openai-provider", presetId: "openai" } as ModelProvider;
  const gpt55 = modelThinkingControls(profile({
    apiProtocol: "openai-responses",
    apiVariant: "responses",
    model: "gpt-5.5",
    providerId: openai.id,
  }), [openai]);
  assert.deepEqual(gpt55.efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(gpt55.efforts.includes("max"), false);

  const moonshot = { id: "moonshot-provider", presetId: "moonshot" } as ModelProvider;
  assert.deepEqual(modelThinkingControls(profile({
    apiProtocol: "openai-chat-completions",
    apiVariant: "kimi-k3",
    model: "kimi-k3",
    providerId: moonshot.id,
  }), [moonshot]), {
    efforts: ["low", "high", "max"],
    modes: ["enabled"],
    supported: true,
  });
});
