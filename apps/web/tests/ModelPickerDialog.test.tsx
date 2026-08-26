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
  ModelPickerDialog,
  thinkingChoiceOptions,
  thinkingChoiceValue,
} from "../src/composer/ModelPickerDialog.js";
import { LocaleProvider } from "../src/i18n/index.js";
import type { ModelThinkingControls } from "../src/modelThinking.js";

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
  modes: ["auto", "enabled"],
  supported: true,
};

function renderDialog(locale: "en" | "zh-CN", overrides: {
  activeModelId?: string;
  controls?: ModelThinkingControls;
  models?: ModelProfile[];
  providers?: ModelProvider[];
  thinkingEffort?: "high" | "max";
  thinkingMode?: "auto" | "enabled" | "disabled";
} = {}): string {
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: locale },
    createElement(ModelPickerDialog, {
      activeModelId: overrides.activeModelId,
      controls: overrides.controls ?? FULL_CONTROLS,
      models: overrides.models ?? [],
      onClose: () => undefined,
      onOpenSettings: () => undefined,
      onSelect: () => undefined,
      onThinkingChange: () => undefined,
      providers: overrides.providers ?? [],
      thinkingEffort: overrides.thinkingEffort ?? "high",
      thinkingMode: overrides.thinkingMode ?? "auto",
    }),
  ));
}

test("the combined thinking control is off plus the effort list", () => {
  const options = thinkingChoiceOptions(FULL_CONTROLS);
  assert.deepEqual(options.map((option) => option.value), ["off", "auto", "effort:high", "effort:max"]);
  assert.deepEqual(options.map((option) => option.mode), ["disabled", "auto", "enabled", "enabled"]);

  assert.equal(thinkingChoiceValue("disabled", "high", options), "off");
  assert.equal(thinkingChoiceValue("auto", "high", options), "auto");
  assert.equal(thinkingChoiceValue("enabled", "max", options), "effort:max");
  // A persisted effort the model no longer offers falls back to a legal entry.
  assert.equal(thinkingChoiceValue("enabled", "low" as never, options), "off");
});

test("models that cannot disable thinking have no off entry", () => {
  const options = thinkingChoiceOptions(ALWAYS_ON_CONTROLS);
  assert.deepEqual(options.map((option) => option.value), ["auto", "effort:low", "effort:high", "effort:max"]);
  assert.ok(!options.some((option) => option.mode === "disabled"));

  assert.equal(thinkingChoiceValue("enabled", "high", options), "effort:high");
  assert.equal(thinkingChoiceValue("auto", "high", options), "auto");

  const unsupported = thinkingChoiceOptions({ efforts: [], legacyBudget: false, modes: [], supported: false });
  assert.deepEqual(unsupported, []);
});

test("models group under their provider with a trailing group for standalone profiles", () => {
  const providers = [provider("p1", "DeepSeek"), provider("p2", "Moonshot")];
  const models = [
    model("m1", "DeepSeek Chat", "p1"),
    model("m2", "Kimi K3", "p2"),
    model("m3", "Legacy standalone"),
  ];
  const groups = groupModelsByProvider(models, providers);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.provider?.name), ["DeepSeek", "Moonshot", undefined]);
  assert.deepEqual(groups[2]!.models.map((item) => item.id), ["m3"]);

  const html = renderDialog("en", { activeModelId: "m2", models, providers });
  assert.match(html, /<h4>DeepSeek<\/h4>/);
  assert.match(html, /<h4>Moonshot<\/h4>/);
  assert.match(html, /<h4>Other models<\/h4>/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /Current/);
});

test("the dialog renders the combined thinking control for the selected model", () => {
  const models = [model("m1", "DeepSeek Chat", "p1")];
  const html = renderDialog("en", {
    activeModelId: "m1",
    models,
    providers: [provider("p1", "DeepSeek")],
    thinkingMode: "enabled",
    thinkingEffort: "max",
  });

  assert.match(html, /aria-label="Thinking switch and effort for this conversation"/);
  assert.match(html, /<option value="off">Off<\/option>/);
  assert.match(html, /<option value="auto">Auto<\/option>/);
  assert.match(html, /<option value="effort:max" selected="">Max<\/option>/);

  const chinese = renderDialog("zh-CN", {
    activeModelId: "m1",
    controls: ALWAYS_ON_CONTROLS,
    models,
    providers: [provider("p1", "DeepSeek")],
    thinkingMode: "enabled",
    thinkingEffort: "high",
  });
  assert.match(chinese, /<option value="effort:high" selected="">高<\/option>/);
  assert.doesNotMatch(chinese, /<option value="off">/);

  const unsupported = renderDialog("en", {
    activeModelId: "m1",
    controls: { efforts: [], legacyBudget: false, modes: [], supported: false },
    models,
  });
  assert.match(unsupported, /does not expose a thinking control field/);
});

test("an empty registry offers a path into the model settings", () => {
  const html = renderDialog("en");
  assert.match(html, /No models configured yet\./);
  assert.match(html, /Open model settings/);

  const chinese = renderDialog("zh-CN");
  assert.match(chinese, /尚未配置模型。/);
  assert.match(chinese, /打开模型设置/);
});
