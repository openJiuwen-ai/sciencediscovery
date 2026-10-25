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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { roleThinking } from "./model-catalog.js";
import type { ModelProfile } from "./model-usage.js";

// No catalog snapshot is installed here, so every case runs on the variant's
// own stops — the path a custom endpoint takes.
const profile = (update: Partial<ModelProfile>): ModelProfile => ({
  baseUrl: "https://example.test/v1",
  createdAt: "2026-10-25T00:00:00.000Z",
  hasApiToken: true,
  id: "model-1",
  model: "custom-model",
  name: "Custom",
  proxyPolicy: "inherit",
  thinkingEffort: "high",
  thinkingMode: "auto",
  updatedAt: "2026-10-25T00:00:00.000Z",
  vision: false,
  ...update,
});

test("a role effort turns thinking on at a stop the model accepts", () => {
  const kimi = profile({ apiProtocol: "openai-chat-completions", apiVariant: "kimi-k3" });
  assert.deepEqual(roleThinking(kimi, [], "max"), { thinkingEffort: "max", thinkingMode: "enabled" });
  // Kimi K3 has low, high and max; medium is narrowed rather than sent raw.
  assert.deepEqual(roleThinking(kimi, [], "medium"), { thinkingEffort: "high", thinkingMode: "enabled" });
});

test("declared stops replace the variant's when a role effort is narrowed", () => {
  const gateway = profile({ apiVariant: "deepseek", facts: { thinkingEfforts: ["low", "high"] } });
  assert.deepEqual(roleThinking(gateway, [], "low"), { thinkingEffort: "low", thinkingMode: "enabled" });
  assert.deepEqual(roleThinking(gateway, [], "max"), { thinkingEffort: "high", thinkingMode: "enabled" });
});

test("no role effort, or a model with nothing to honor it with, keeps the caller's thinking", () => {
  assert.equal(roleThinking(profile({ apiVariant: "kimi-k3" }), [], undefined), undefined);
  assert.equal(roleThinking(undefined, [], "high"), undefined);
  // OpenAI-compatible endpoints have no thinking field at all.
  assert.equal(roleThinking(profile({ apiVariant: "openai" }), [], "high"), undefined);
  // Qwen can switch thinking but has no effort to set.
  assert.equal(roleThinking(profile({ apiVariant: "qwen" }), [], "high"), undefined);
  // The user stated this endpoint does not think.
  assert.equal(roleThinking(profile({ apiVariant: "deepseek", facts: { thinkingSupported: false } }), [], "high"), undefined);
});
