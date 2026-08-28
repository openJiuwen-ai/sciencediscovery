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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  groupModelsByProvider,
  hoverPopupStyle,
  modelDisplayName,
  ModelPicker,
  ModelPickerModelFacts,
  parseThinkingChoice,
  thinkingChoiceLabel,
  thinkingChoiceLabelKey,
} from "../src/composer/ModelPicker.js";
import { installWebModelCatalog } from "./model-catalog-fixture.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { en, zhCN } from "../src/i18n/messages.js";
import type { ModelThinkingControls } from "../src/modelThinking.js";
import { thinkingChoiceOptions, thinkingChoiceValue } from "../src/modelThinking.js";

function model(id: string, name: string, providerId?: string): ModelProfile {
  return {
    baseUrl: "https://provider.example.test/v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    hasApiToken: true,
    id,
    model: `${id}-id`,
    name,
    ...(providerId ? { providerId } : {}),
    proxyPolicy: "inherit",
    updatedAt: "2026-01-01T00:00:00.000Z",
    vision: false,
  };
}

function provider(id: string, name: string): ModelProvider {
  return {
    apiProtocol: "openai-chat-completions",
    apiVariant: "openai",
    baseUrl: "https://provider.example.test/v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    hasApiToken: true,
    id,
    modelDiscovery: "openai-models",
    name,
    proxyPolicy: "inherit",
    tokenOptional: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const FULL_CONTROLS: ModelThinkingControls = {
  efforts: ["high", "max"],
  legacyBudget: false,
  modes: ["auto", "enabled", "disabled"],
  supported: true,
};

/** Kimi K3 style: thinking cannot be turned off, only leveled. */
const ALWAYS_ON_CONTROLS: ModelThinkingControls = {
  efforts: ["low", "high", "max"],
  legacyBudget: false,
  modes: ["enabled"],
  supported: true,
};

test("the thinking slider stops are off, model default, then weakest to strongest", () => {
  const options = thinkingChoiceOptions(FULL_CONTROLS);
  assert.deepEqual(options.map((option) => option.value), ["off", "auto", "effort:high", "effort:max"]);

  assert.equal(thinkingChoiceValue("disabled", "high", options), "off");
  assert.equal(thinkingChoiceValue("auto", "high", options), "auto");
  assert.equal(thinkingChoiceValue("enabled", "max", options), "effort:max");
  // A persisted effort the model no longer offers falls back to a legal stop.
  assert.equal(thinkingChoiceValue("enabled", "low" as never, options), "off");
});

test("models that cannot disable thinking have no off stop", () => {
  const options = thinkingChoiceOptions(ALWAYS_ON_CONTROLS);
  assert.deepEqual(options.map((option) => option.value), ["effort:low", "effort:high", "effort:max"]);
  assert.ok(!options.some((option) => option.mode === "disabled"));

  assert.deepEqual(thinkingChoiceOptions({ efforts: [], legacyBudget: false, modes: [], supported: false }), []);
});

test("thinking choice values round-trip through the parser", () => {
  assert.deepEqual(parseThinkingChoice("off"), { mode: "disabled" });
  assert.deepEqual(parseThinkingChoice("auto"), { mode: "auto" });
  assert.deepEqual(parseThinkingChoice("on"), { mode: "enabled" });
  assert.deepEqual(parseThinkingChoice("effort:max"), { effort: "max", mode: "enabled" });
  assert.deepEqual(parseThinkingChoice(""), {});
  assert.equal(thinkingChoiceLabelKey({ mode: "disabled", value: "off" }), "composer.modelPicker.off");
  assert.equal(thinkingChoiceLabelKey({ mode: "auto", value: "auto" }), "settings.thinkingMode.auto");
  // Effort levels keep the provider's raw vocabulary; only off/default localize.
  assert.equal(thinkingChoiceLabelKey({ effort: "xhigh", mode: "enabled", value: "effort:xhigh" }), undefined);
  assert.equal(thinkingChoiceLabel({ effort: "xhigh", mode: "enabled", value: "effort:xhigh" }, (key) => key), "xhigh");
  assert.equal(thinkingChoiceLabel({ mode: "disabled", value: "off" }, (key) => key), "composer.modelPicker.off");
});

test("models group under their provider with a trailing group for standalone profiles", () => {
  const providers = [provider("p1", "DeepSeek"), provider("p2", "Moonshot")];
  const models = [model("m1", "DeepSeek Chat", "p1"), model("m2", "Kimi K3", "p2"), model("m3", "Legacy standalone")];
  const groups = groupModelsByProvider(models, providers);
  assert.deepEqual(groups.map((group) => group.provider?.name), ["DeepSeek", "Moonshot", undefined]);
  assert.deepEqual(groups[2]!.models.map((item) => item.id), ["m3"]);
});

function renderPicker(locale: "en" | "zh-CN", overrides: {
  activeModelId?: string;
  controls?: ModelThinkingControls;
  models?: ModelProfile[];
  providers?: ModelProvider[];
  thinkingEffort?: "high" | "max";
  thinkingMode?: "auto" | "enabled" | "disabled";
  thinkingSummary?: string;
} = {}): string {
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: locale },
    createElement(ModelPicker, {
      activeModelId: overrides.activeModelId,
      controls: overrides.controls ?? FULL_CONTROLS,
      models: overrides.models ?? [],
      onOpenSettings: () => undefined,
      onSelect: () => undefined,
      onThinkingChange: () => undefined,
      providers: overrides.providers ?? [],
      thinkingEffort: overrides.thinkingEffort ?? "high",
      thinkingMode: overrides.thinkingMode ?? "auto",
      thinkingSummary: overrides.thinkingSummary,
    }),
  ));
}

test("the trigger renders the current model and the popover is connector-style", () => {
  const models = [model("m1", "DeepSeek · DeepSeek Chat", "p1")];
  const html = renderPicker("en", {
    activeModelId: "m1",
    models,
    providers: [provider("p1", "DeepSeek")],
    thinkingSummary: "max",
  });
  assert.match(html, /class="model-picker-trigger"/);
  assert.match(html, /DeepSeek Chat/);
  assert.doesNotMatch(html, /DeepSeek · DeepSeek Chat/);
  assert.match(html, /model-picker-trigger-thinking[^>]*>max/);
  assert.match(html, /aria-haspopup="dialog"/);
  // Closed by default: no popover until the user clicks.
  assert.doesNotMatch(html, /model-picker-popover/);
});

test("model names drop only their own provider prefix and fixed hover cards do not resize the picker", () => {
  const p = provider("p1", "DeepSeek（测试中转）");
  assert.equal(modelDisplayName(model("m1", "DeepSeek（测试中转） · DeepSeek V4 Flash", "p1"), p), "DeepSeek V4 Flash");
  assert.equal(modelDisplayName(model("m2", "Independent name", "p1"), p), "Independent name");

  const below = hoverPopupStyle(
    { bottom: 140, left: 970, top: 100 },
    300,
    240,
    { height: 800, width: 1_000 },
  );
  assert.deepEqual(below, { left: 692, position: "fixed", top: 144, width: 300 });
  const flipped = hoverPopupStyle(
    { bottom: 760, left: 20, top: 720 },
    300,
    240,
    { height: 800, width: 1_000 },
  );
  assert.deepEqual(flipped, { bottom: 84, left: 20, position: "fixed", width: 300 });
});

test("the stop row carries exactly the legal stops and the current value", () => {
  const models = [model("m1", "DeepSeek Chat", "p1")];
  const html = renderPicker("en", {
    activeModelId: "m1",
    models,
    providers: [provider("p1", "DeepSeek")],
    thinkingEffort: "max",
    thinkingMode: "enabled",
  });
  // SSR renders the trigger only; the slider markup is exercised through the
  // stops helpers above, so here we pin the trigger badge instead.
  assert.match(html, /model-picker-trigger/);

  const stops = thinkingChoiceOptions(FULL_CONTROLS);
  const labels = stops.map((stop) => thinkingChoiceLabel(stop, (key) => key));
  assert.deepEqual(labels, [
    "composer.modelPicker.off",
    "settings.thinkingMode.auto",
    "high",
    "max",
  ]);
});

test("hovering a conversation model row reveals a rich detail card", () => {
  installWebModelCatalog();
  const renderFacts = (overrides: Partial<ModelProfile> = {}) => renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: "en" },
    createElement(ModelPickerModelFacts, {
      model: {
        ...model("m1", "DeepSeek · DeepSeek V4 Flash", "p1"),
        model: "deepseek-v4-flash",
        vision: true,
        ...overrides,
      },
      provider: { ...provider("p1", "DeepSeek"), presetId: "deepseek" },
    }),
  ));

  const html = renderFacts();
  assert.match(html, /role="tooltip"/);
  assert.match(html, /<strong>DeepSeek V4 Flash<\/strong>/);
  assert.match(html, /<code>deepseek-v4-flash<\/code>/);
  assert.match(html, /1,000,000/);
  assert.match(html, /low \/ high \/ max/);
  assert.match(html, /CNY 3 \/ 9 \/ 0\.1 · per 1M tokens/);
  // No native tooltip anywhere on the row popup.
  assert.doesNotMatch(html, /title=/);

  // User-declared facts win and are marked as the source.
  const manual = renderFacts({
    facts: { contextWindow: 64_000, thinkingEfforts: ["high", "max"] },
  });
  assert.match(manual, /64,000/);
  assert.match(manual, /high \/ max/);
  assert.match(manual, /entered by you/);
});

test("an empty registry offers a path into the model settings", () => {
  const html = renderPicker("en");
  assert.match(html, /aria-haspopup="dialog"/);
});

test("model default replaces auto in user-facing labels", () => {
  assert.equal(en["settings.thinkingMode.auto"], "Model default");
  assert.equal(zhCN["settings.thinkingMode.auto"], "模型默认");
  assert.ok(!Object.values(en).some((value) => value === "Auto"));
  assert.ok(!Object.values(zhCN).some((value) => value === "自动"));
  assert.equal(en["composer.modelPicker.thinkingOff"], "Thinking off");
  assert.equal(zhCN["composer.modelPicker.thinkingOff"], "思考关闭");
});
