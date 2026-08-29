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

// The effort stops a user declared for one endpoint decide what the chat
// control offers. The catalog describes what a vendor documents; a gateway in
// front of it often accepts fewer stops, and only its operator knows that.

import assert from "node:assert/strict";
import test from "node:test";

import type { ModelProfile, ModelProvider } from "@sciencediscovery/schema";

import {
  modelThinkingControls,
  normalizeSessionThinking,
  thinkingChoiceOptions,
} from "../src/modelThinking.js";
import { installWebModelCatalog } from "./model-catalog-fixture.js";

installWebModelCatalog();

const openai = { id: "openai-provider", presetId: "openai" } as ModelProvider;

const profile = (update: Partial<ModelProfile>): ModelProfile => ({
  apiProtocol: "openai-responses",
  apiVariant: "responses",
  baseUrl: "https://example.test/v1",
  createdAt: "2026-08-27T00:00:00.000Z",
  hasApiToken: true,
  id: "model-1",
  model: "gpt-5.5",
  name: "GPT-5.5",
  providerId: openai.id,
  proxyPolicy: "inherit",
  updatedAt: "2026-08-27T00:00:00.000Z",
  vision: false,
  ...update,
});

test("declared stops narrow the chat control to what the endpoint accepts", () => {
  const published = modelThinkingControls(profile({}), [openai]);
  assert.deepEqual(published.efforts, ["low", "medium", "high", "xhigh"], "the catalog's published scale");

  const declared = modelThinkingControls(
    profile({ facts: { thinkingEfforts: ["low", "high"] } }),
    [openai],
  );
  assert.deepEqual(declared.efforts, ["low", "high"]);
  assert.equal(declared.supported, true);

  // The combined control is built from those stops, so the chat offers exactly
  // the two the user declared plus the non-effort entries.
  assert.deepEqual(
    thinkingChoiceOptions(declared).map((option) => option.value),
    ["off", "auto", "effort:low", "effort:high"],
  );
});

test("a stop the endpoint does not accept is normalized away on model switch", () => {
  const model = profile({ facts: { thinkingEfforts: ["low", "high"] } });
  assert.deepEqual(
    normalizeSessionThinking(model, [openai], "enabled", "xhigh"),
    { thinkingEffort: "high" },
    "a saved xhigh is pulled back to a stop that exists",
  );
  assert.deepEqual(normalizeSessionThinking(model, [openai], "enabled", "low"), {},
    "a legal stop is left alone");
});

test("declaring stops makes a model the catalog never heard of thinkable", () => {
  const unknown = profile({ id: "model-2", model: "self-hosted-mystery-7b" });
  assert.deepEqual(
    modelThinkingControls(unknown, [openai]).efforts,
    ["low", "medium", "high", "xhigh", "max"],
    "with nothing declared the wire dialect decides",
  );

  const declared = modelThinkingControls(
    profile({ facts: { thinkingEfforts: ["medium", "max"] }, id: "model-2", model: "self-hosted-mystery-7b" }),
    [openai],
  );
  assert.deepEqual(declared.efforts, ["medium", "max"]);
});

test("stating that an endpoint does not think removes the control entirely", () => {
  const controls = modelThinkingControls(
    profile({ facts: { thinkingSupported: false } }),
    [openai],
  );
  assert.equal(controls.supported, false);
  assert.deepEqual(controls.efforts, []);
  assert.deepEqual(thinkingChoiceOptions(controls), [], "no stops means no control to render");
});
