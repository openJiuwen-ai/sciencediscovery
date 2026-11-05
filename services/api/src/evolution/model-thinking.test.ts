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


import { setModelCatalogSnapshot, type ModelCatalogSnapshot, type ModelProfile } from "@sciencediscovery/schema";

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

test("a toggle without a disabled stop cannot be told to stop", () => {
  // `gemini` and `kimi-k3` map a thinking field, but their only stops are
  // "auto" and "enabled": sending "disabled" leaves thinking on exactly as a
  // dialect with no field does, so a budget must not price them quiet.
  assert.equal(endpointCanDisableThinking(model({ apiVariant: "gemini" })), false);
  assert.equal(endpointCanDisableThinking(model({ apiVariant: "kimi-k3" })), false);

  // A stated fact answers a different question — whether this endpoint honors
  // the field — so it cannot add a stop the dialect does not carry.
  assert.equal(
    endpointCanDisableThinking(model({ apiVariant: "gemini", facts: { thinkingSupported: true } })),
    false,
  );
});

test("the catalog's own stop list decides for a model it knows", () => {
  // The hardcoded variant list only covers dialects whose stops are public
  // knowledge. A model the catalog knows carries its own, and that entry is
  // the only thing that knows whether this particular model has a stop.
  installCatalog([
    record("no-stop-model", { supported: true, modes: ["auto", "enabled"] }),
    record("stoppable-model", { supported: true, modes: ["auto", "enabled", "disabled"] }),
    record("never-thinks-model", { supported: false }),
  ]);
  try {
    assert.equal(endpointCanDisableThinking(model({ apiVariant: "deepseek", model: "no-stop-model" })), false);
    assert.equal(endpointCanDisableThinking(model({ apiVariant: "deepseek", model: "stoppable-model" })), true);
    assert.equal(endpointCanDisableThinking(model({ apiVariant: "deepseek", model: "never-thinks-model" })), false);

    // A stated fact overrides the catalog's supported flag...
    assert.equal(endpointCanDisableThinking(model({
      apiVariant: "deepseek", facts: { thinkingSupported: true }, model: "never-thinks-model",
    })), true);
    // ...but not its stop list: "the field is heard" is not "the field has
    // disabled".
    assert.equal(endpointCanDisableThinking(model({
      apiVariant: "deepseek", facts: { thinkingSupported: true }, model: "no-stop-model",
    })), false);
  } finally {
    installCatalog(undefined);
  }
});

test("the configured dialect, not the catalog's, decides whether a field exists", () => {
  // The catalog's apiVariant describes the vendor's own endpoint. A gateway
  // that reuses the model name may speak a dialect with no thinking field, and
  // the profile is what this run will actually call, so the catalog cannot
  // promise a control the request will never carry. The opposite direction is
  // safe: a profile that under-claims is merely priced for thinking.
  installCatalog([record("vendor-model", { supported: true }, "deepseek")]);
  try {
    assert.equal(endpointCanDisableThinking(model({ apiVariant: "openai", model: "vendor-model" })), false);
    assert.equal(endpointCanDisableThinking(model({ apiVariant: "deepseek", model: "vendor-model" })), true);
  } finally {
    installCatalog(undefined);
  }
});

function installCatalog(records: ModelCatalogSnapshot["records"] | undefined): void {
  setModelCatalogSnapshot(records && {
    fetchedAt: "2026-11-03T00:00:00.000Z",
    origin: "downloaded",
    records,
    sourceUrl: "https://example.test/catalog.json",
  });
}

function record(
  key: string,
  thinking: NonNullable<ModelCatalogSnapshot["records"][number]["thinking"]>,
  apiVariant?: ModelCatalogSnapshot["records"][number]["apiVariant"],
): ModelCatalogSnapshot["records"][number] {
  return {
    key,
    label: key,
    source: { retrievedAt: "2026-11-03T00:00:00.000Z", url: "https://example.test/catalog.json" },
    thinking,
    ...(apiVariant ? { apiVariant } : {}),
  };
}

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
