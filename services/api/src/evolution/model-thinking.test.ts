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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import type { ModelProfile } from "@sciencediscovery/schema";

import { endpointCanDisableThinking } from "./model-thinking.js";

function model(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    baseUrl: "http://127.0.0.1:1/v1", createdAt: "", hasApiToken: true, id: "m1",
    model: "some-gateway-model", name: "Gateway", proxyPolicy: "inherit" as never,
    updatedAt: "", vision: false, ...over,
  };
}

test("the plain OpenAI dialect has no field to turn thinking off with", () => {
  // A custom gateway is configured as `openai` unless its operator names a
  // dialect, and that dialect accepts `thinking: {type: "disabled"}` and
  // ignores it. Nothing about the model's name changes that.
  assert.equal(endpointCanDisableThinking(model()), false);
  assert.equal(endpointCanDisableThinking(model({ apiVariant: "openai" })), false);
});

test("a dialect that maps the toggle carries it", () => {
  assert.equal(endpointCanDisableThinking(model({ apiVariant: "deepseek" })), true);
  assert.equal(endpointCanDisableThinking(model({ apiVariant: "qwen" })), true);
  assert.equal(endpointCanDisableThinking(model({ apiProtocol: "openai-responses" })), true);
});

test("a stated fact overrides what the dialect suggests", () => {
  // The operator of a gateway is the only one who knows whether it honors the
  // field; the fact is theirs to state either way.
  assert.equal(
    endpointCanDisableThinking(model({ apiVariant: "deepseek", facts: { thinkingSupported: false } })),
    false,
  );
});

test("a model that is not configured yet keeps the declared setting", () => {
  // Pre-flight already reports a missing model; refusing a budget on top of
  // that would bury the real problem.
  assert.equal(endpointCanDisableThinking(undefined), true);
});
