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
  MODELS_DEV_PROVIDER_MAPPINGS,
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

test("a provider that rehosts another brand never overwrites that brand's facts", () => {
  // The real collision behind the GLM regression: DashScope is the vendor for
  // Qwen but republishes Zhipu's GLM with a shorter output limit and an empty
  // `reasoning_options`, and SiliconFlow rehosts it under a prefixed id. All
  // three entries normalize to the same catalog key, so whichever mapping the
  // merge reaches first is the one whose facts survive.
  const payload = {
    "alibaba-cn": {
      doc: "https://www.alibabacloud.com/help/en/model-studio/models",
      id: "alibaba-cn",
      models: {
        "glm-5.2": {
          cost: { input: 0.7, output: 2.5 },
          id: "glm-5.2",
          limit: { context: 1_000_000, output: 128_000 },
          modalities: { input: ["text"], output: ["text"] },
          name: "GLM-5.2 (Model Studio)",
          reasoning: true,
          reasoning_options: [],
        },
      },
    },
    "siliconflow-cn": {
      doc: "https://cloud.siliconflow.com/models",
      id: "siliconflow-cn",
      models: {
        "zai-org/GLM-5.2": {
          cost: { input: 0.5, output: 2 },
          id: "zai-org/GLM-5.2",
          limit: { context: 1_000_000, output: 262_000 },
          modalities: { input: ["text"], output: ["text"] },
          name: "GLM-5.2 (SiliconFlow)",
          reasoning: true,
        },
      },
    },
    zhipuai: {
      doc: "https://docs.z.ai/guides/overview/pricing",
      id: "zhipuai",
      models: {
        "glm-5.2": {
          cost: { input: 0.6, output: 2.2 },
          id: "glm-5.2",
          limit: { context: 1_000_000, output: 131_072 },
          modalities: { input: ["text"], output: ["text"] },
          name: "GLM-5.2",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["high", "max"] }],
        },
      },
    },
  };

  setModelCatalogSnapshot({
    fetchedAt: FIXTURE_FETCHED_AT,
    origin: "downloaded",
    records: mapModelsDevCatalog(payload, { fetchedAt: FIXTURE_FETCHED_AT, sourceUrl: FIXTURE_SOURCE_URL }),
    sourceUrl: FIXTURE_SOURCE_URL,
  });

  const merged = lookupModelCatalog("glm-5.2")!;
  assert.equal(merged.maxOutputTokens, 131_072, "the vendor's own output limit, not a rehosted one");
  assert.deepEqual(merged.thinking?.efforts, ["high", "max"],
    "the vendor publishes an effort scale; the rehosted entries are silent about it");
  assert.equal(merged.label, "GLM-5.2", "and the vendor's own name");

  // Prices stay attributed per endpoint: our Zhipu preset calls
  // open.bigmodel.cn, which upstream does not price, while SiliconFlow's own
  // rate applies to the SiliconFlow preset.
  assert.equal(lookupModelCatalog("glm-5.2", "zhipu")!.pricing, undefined);
  assert.equal(lookupModelCatalog("glm-5.2", "siliconflow")!.pricing?.input, 0.5);

  // Every provider that lists it still offers it as a suggestion.
  for (const preset of ["zhipu", "siliconflow", "dashscope"]) {
    assert.deepEqual(listCatalogModelsForPreset(preset).map((record) => record.key), ["glm-5.2"]);
  }

  installTestModelCatalog();
});

test("a published effort scale outranks a provider that is merely silent about one", () => {
  // Order alone is not enough: whichever provider is reached first must not be
  // able to erase a scale another one documents. A provider that says the
  // model does not reason at all is a claim, not silence, and is not upgraded.
  const payload = {
    openai: {
      doc: "https://developers.openai.com/api/docs/api-reference/introduction",
      id: "openai",
      models: {
        "gpt-5.5": {
          cost: { input: 1.25, output: 10 },
          id: "gpt-5.5",
          limit: { context: 1_050_000, output: 128_000 },
          modalities: { input: ["text"], output: ["text"] },
          name: "GPT-5.5",
          reasoning: true,
        },
        "gpt-image-1.5": {
          id: "gpt-image-1.5",
          limit: { context: 4_096, output: 4_096 },
          modalities: { input: ["text"], output: ["image"] },
          name: "GPT Image 1.5",
          reasoning: false,
        },
      },
    },
    openrouter: {
      doc: "https://openrouter.ai/docs/quickstart",
      id: "openrouter",
      models: {
        "openai/gpt-5.5": {
          cost: { input: 1.4, output: 11 },
          id: "openai/gpt-5.5",
          limit: { context: 1_050_000, output: 128_000 },
          modalities: { input: ["text"], output: ["text"] },
          name: "GPT-5.5 (OpenRouter)",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        },
        "openai/gpt-image-1.5": {
          id: "openai/gpt-image-1.5",
          limit: { context: 4_096, output: 4_096 },
          modalities: { input: ["text"], output: ["image"] },
          name: "GPT Image 1.5 (OpenRouter)",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        },
      },
    },
  };

  setModelCatalogSnapshot({
    fetchedAt: FIXTURE_FETCHED_AT,
    origin: "downloaded",
    records: mapModelsDevCatalog(payload, { fetchedAt: FIXTURE_FETCHED_AT, sourceUrl: FIXTURE_SOURCE_URL }),
    sourceUrl: FIXTURE_SOURCE_URL,
  });

  const gpt = lookupModelCatalog("gpt-5.5", "openai")!;
  assert.deepEqual(gpt.thinking?.efforts, ["low", "high"], "the documented scale survives the silent entry");
  assert.equal(gpt.label, "GPT-5.5", "everything else still comes from the vendor");
  assert.equal(gpt.pricing?.input, 1.25);

  const image = lookupModelCatalog("gpt-image-1.5", "openai")!;
  assert.equal(image.thinking?.supported, false, "a stated 'does not reason' is not silence and is not upgraded");
  assert.equal(image.thinking?.efforts, undefined);

  installTestModelCatalog();
});

test("every aggregator mapping sits after every vendor mapping", () => {
  // Capability facts are first-publish-wins, so this ordering is the whole
  // mechanism behind "the vendor describes its own model". A future insert in
  // the wrong place would silently hand the facts back to a rehoster.
  const aggregators = new Set(["openrouter", "siliconflow-cn"]);
  const firstAggregator = MODELS_DEV_PROVIDER_MAPPINGS
    .findIndex((mapping) => aggregators.has(mapping.id));
  const lastVendor = MODELS_DEV_PROVIDER_MAPPINGS
    .map((mapping, index) => ({ index, isVendor: !aggregators.has(mapping.id) }))
    .filter((entry) => entry.isVendor)
    .at(-1)!.index;
  assert.ok(firstAggregator > lastVendor,
    `aggregators must follow every vendor; first aggregator at ${firstAggregator}, last vendor at ${lastVendor}`);
});
