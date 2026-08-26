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

import {
  constrainCatalogThinking,
  listCatalogModelsForPreset,
  lookupModelCatalog,
  mapModelsDevCatalog,
  setModelCatalogSnapshot,
} from "@sciencediscovery/schema";

import {
  FIXTURE_FETCHED_AT,
  FIXTURE_SOURCE_URL,
  installTestModelCatalog,
  MODELS_DEV_FIXTURE,
} from "./models-dev.fixture.js";

test("mapping keeps only mapped providers and attributes prices to their own preset", () => {
  installTestModelCatalog();
  const pro = lookupModelCatalog("deepseek-v4-pro", "deepseek")!;
  assert.deepEqual(pro.pricing, {
    cachedInput: 0.014,
    currency: "USD",
    input: 0.55,
    output: 2.2,
    source: { retrievedAt: FIXTURE_FETCHED_AT, url: "https://api-docs.deepseek.com/quick_start/pricing" },
    unit: "per-1m-tokens",
  });
  // The same model rehosted elsewhere keeps facts and gets that host's price,
  // never the vendor's.
  assert.equal(lookupModelCatalog("deepseek-v4-pro", "openrouter")!.pricing!.input, 0.9);
  assert.equal(lookupModelCatalog("deepseek-v4-pro", "siliconflow")?.pricing, undefined);
  // Vendor facts win over the aggregator that lists the same model.
  assert.equal(pro.contextWindow, 1_000_000);
  assert.equal(pro.label, "DeepSeek V4 Pro");

  // Our Ollama preset is a local endpoint, so the hosted Ollama listing is not
  // mapped and cannot price a model running on the user's own machine.
  assert.equal(lookupModelCatalog("local-only-model"), undefined);
});

test("thinking capability is read from the document and never widened or invented", () => {
  installTestModelCatalog();
  // `none` and `minimal` are not effort levels this product exposes.
  assert.deepEqual(lookupModelCatalog("gpt-5.5")!.thinking!.efforts, ["low", "medium", "high", "xhigh"]);
  // The document says how reasoning is requested, never that it cannot be
  // turned off, so `modes` stays with the protocol dialect.
  assert.equal(lookupModelCatalog("gpt-5.5")!.thinking!.modes, undefined);
  assert.equal(lookupModelCatalog("gpt-image-1.5")!.thinking!.supported, false);
  // A toggle-only model exposes no effort scale rather than a guessed one.
  assert.equal(lookupModelCatalog("glm-5")!.thinking!.efforts, undefined);
  // Legacy `max` on a model that stops at `xhigh` degrades to its nearest
  // legal value instead of being sent as-is.
  assert.deepEqual(constrainCatalogThinking("gpt-5.5", "enabled", "max"), { effort: "xhigh", mode: "enabled" });
});

test("Anthropic thinking dialect is mapped explicitly and other providers stay unset", () => {
  installTestModelCatalog();
  // Only a token budget is accepted → the legacy `thinking.budget_tokens` wire
  // contract; an effort scale means the adaptive one, which is the preset
  // default and therefore left unset.
  assert.equal(lookupModelCatalog("claude-haiku-4-5")!.apiVariant, "anthropic-legacy");
  assert.equal(lookupModelCatalog("claude-haiku-4-5-20251001")!.apiVariant, "anthropic-legacy");
  assert.equal(lookupModelCatalog("claude-opus-5")!.apiVariant, undefined);
  assert.equal(lookupModelCatalog("deepseek-v4-pro")!.apiVariant, undefined);
});

test("confirmed product wire contracts override the document", () => {
  installTestModelCatalog();
  const k3 = lookupModelCatalog("kimi-k3", "moonshot")!;
  assert.equal(k3.apiVariant, "kimi-k3");
  assert.deepEqual(k3.thinking, {
    defaultEffort: "max",
    defaultMode: "enabled",
    efforts: ["low", "high", "max"],
    modes: ["enabled"],
    supported: true,
  });
  // The upstream toggle would have allowed `disabled`; K3 always reasons.
  assert.deepEqual(constrainCatalogThinking("kimi-k3", "disabled"), { effort: "max", mode: "enabled" });
});

test("providers without a listing endpoint still get suggestions when prices are withheld", () => {
  installTestModelCatalog();
  // z.ai prices do not apply to the open.bigmodel.cn endpoint our preset uses,
  // so GLM keeps its facts, loses the price, and stays a suggestion.
  const suggestions = listCatalogModelsForPreset("zhipu").map((record) => record.key);
  assert.deepEqual(suggestions, ["glm-5"]);
  assert.equal(lookupModelCatalog("glm-5", "zhipu")!.pricing, undefined);
  assert.equal(lookupModelCatalog("glm-5", "zhipu")!.contextWindow, 200_000);
});

test("an absent catalog reports every fact as unknown instead of a default", () => {
  setModelCatalogSnapshot(undefined);
  assert.equal(lookupModelCatalog("gpt-5.5"), undefined);
  assert.deepEqual(listCatalogModelsForPreset("openai"), []);
  // Without catalog facts a requested value is passed through untouched.
  assert.deepEqual(constrainCatalogThinking("gpt-5.5", "enabled", "max"), { effort: "max", mode: "enabled" });
});

test("a payload that is not a provider map yields no records", () => {
  assert.deepEqual(mapModelsDevCatalog(null, { fetchedAt: FIXTURE_FETCHED_AT, sourceUrl: FIXTURE_SOURCE_URL }), []);
  assert.deepEqual(mapModelsDevCatalog([], { fetchedAt: FIXTURE_FETCHED_AT, sourceUrl: FIXTURE_SOURCE_URL }), []);
  assert.deepEqual(mapModelsDevCatalog({ openai: 7 }, { fetchedAt: FIXTURE_FETCHED_AT, sourceUrl: FIXTURE_SOURCE_URL }), []);
});
