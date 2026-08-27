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

import type { ModelProfile, ModelProvider, ModelProviderPreset, ProviderModelEntry } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SettingsApiClient } from "../src/api/settings.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { mergeProviderModelRows, ProviderModelSettings, ProviderRow, sortProviderModels } from "../src/ProviderModelSettings.js";

function entry(id: string, profileId?: string): ProviderModelEntry {
  return { id, ...(profileId ? { profileId } : {}) };
}

test("provider model tables sort added models first, then alphabetically", () => {
  const sorted = sortProviderModels([entry("zeta"), entry("alpha"), entry("beta", "profile-1"), entry("gamma", "profile-2")]);
  assert.deepEqual(sorted.map((model) => model.id), ["beta", "gamma", "alpha", "zeta"]);
});

test("inline table unions added profiles with the listing, added first, no duplicates", () => {
  const p = provider("p1", "Custom");
  const added = [profile("m1", "p1"), profile("m2", "p1")];
  // manual + empty listing: the added models must still own rows.
  const manualOnly = mergeProviderModelRows([], added, p);
  assert.deepEqual(manualOnly.map((model) => model.id), ["m1-id", "m2-id"]);
  assert.deepEqual(manualOnly.map((model) => model.profileId), ["m1", "m2"]);

  // A listing entry for the same model merges into the added row instead of
  // duplicating it; not-yet-added entries follow.
  const merged = mergeProviderModelRows(
    [entry("m2-id", "m2"), entry("zeta"), entry("alpha")],
    added,
    p,
  );
  assert.deepEqual(merged.map((model) => model.id), ["m1-id", "m2-id", "alpha", "zeta"]);
  const m2 = merged.find((model) => model.id === "m2-id")!;
  assert.equal(m2.profileId, "m2");
  assert.equal(m2.displayName, "Model m2");
});

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

function profile(id: string, providerId: string): ModelProfile {
  return {
    baseUrl: "https://provider.example.test/v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    hasApiToken: true,
    id,
    model: `${id}-id`,
    name: `Model ${id}`,
    providerId,
    proxyPolicy: "inherit",
    updatedAt: "2026-01-01T00:00:00.000Z",
    vision: false,
  };
}

const PRESETS: ModelProviderPreset[] = [{
  apiProtocol: "openai-chat-completions",
  apiVariant: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  id: "deepseek",
  modelDiscovery: "openai-models",
  name: "DeepSeek",
}];

function renderSettings(locale: "en" | "zh-CN"): string {
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: locale },
    createElement(ProviderModelSettings, {
      client: {} as SettingsApiClient,
      models: [profile("m1", "p1")],
      onError: () => undefined,
      onModelsChange: () => undefined,
      onNotice: () => undefined,
      onProvidersChange: () => undefined,
      presets: PRESETS,
      providers: [provider("p1", "DeepSeek")],
    }),
  ));
}

test("the registry opens without a preset wall or a resident editor", () => {
  const html = renderSettings("en");

  // Adding is a dropdown of presets plus a custom-provider button.
  assert.match(html, /aria-label="Add provider"/);
  assert.match(html, /<option value="" selected="">Choose a preset…<\/option>/);
  assert.match(html, /<option value="deepseek">DeepSeek<\/option>/);
  assert.match(html, />Custom provider<\/button>/);
  // No preset cards are laid out.
  assert.doesNotMatch(html, /provider-preset-card/);
  // The provider editor stays hidden until the user asks for it.
  assert.doesNotMatch(html, /provider-editor/);
  // One row per provider with the added count and an expand affordance.
  assert.match(html, /provider-row-summary/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /1 added/);
  assert.match(html, /Data source: models\.dev/);

  const chinese = renderSettings("zh-CN");
  assert.match(chinese, /aria-label="添加 Provider"/);
  assert.match(chinese, /<option value="" selected="">选择预置服务商…<\/option>/);
  assert.match(chinese, /已添加 1/);
  assert.match(chinese, /数据来源：models\.dev/);
  assert.doesNotMatch(chinese, /provider-editor/);
});

test("manual provider with an empty listing still shows the added model row, never the empty state", () => {
  const p = provider("p1", "Custom endpoint");
  const html = renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: "en" },
    createElement(ProviderRow, {
      addedProfiles: [profile("m1", "p1")],
      busy: false,
      expanded: true,
      listing: {
        list: { fetchedAt: "2026-08-27T00:00:00.000Z", models: [], providerId: "p1", source: "catalog" },
        loading: false,
      },
      onAddModel: () => Promise.resolve(true),
      onEdit: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      provider: p,
      testModel: () => Promise.reject(new Error("not under test")),
    }),
  ));

  // The manually registered model keeps its row even though discovery
  // returned nothing; the honest empty state is reserved for "nothing added
  // and nothing discovered".
  assert.match(html, /provider-model-table/);
  assert.match(html, /<code>m1-id<\/code>/);
  assert.match(html, />Added<\/button>/);
  assert.doesNotMatch(html, /No models were returned/);
  // Count, table, and test dropdown all read the same union.
  assert.match(html, /1\/1 models/);
  assert.match(html, /aria-label="Model to test"/);

  const chinese = renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: "zh-CN" },
    createElement(ProviderRow, {
      addedProfiles: [],
      busy: false,
      expanded: true,
      listing: {
        list: { fetchedAt: "2026-08-27T00:00:00.000Z", models: [], providerId: "p1", source: "catalog" },
        loading: false,
      },
      onAddModel: () => Promise.resolve(true),
      onEdit: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      provider: p,
      testModel: () => Promise.reject(new Error("not under test")),
    }),
  ));
  assert.match(chinese, /服务商未返回模型。请手动添加精确模型 ID。/);
});
