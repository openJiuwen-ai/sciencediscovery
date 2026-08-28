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
import {
  compactTokenCount,
  type ManualModelForm,
  mergeProviderModelRows,
  prefillManualFromCatalog,
  providerModelDisplayName,
  providerModelPopupStyle,
  ProviderModelSettings,
  ProviderRow,
  sortProviderModels,
} from "../src/ProviderModelSettings.js";
import { installWebModelCatalog } from "./model-catalog-fixture.js";

function entry(id: string, profileId?: string): ProviderModelEntry {
  return { id, ...(profileId ? { profileId } : {}) };
}

test("token counts compact to integers: 1M, 200k, 131k", () => {
  assert.equal(compactTokenCount(1_000_000), "1M");
  assert.equal(compactTokenCount(1_048_576), "1M");
  assert.equal(compactTokenCount(200_000), "200k");
  assert.equal(compactTokenCount(131_072), "131k");
  assert.equal(compactTokenCount(512), "512");
  assert.equal(compactTokenCount(undefined), undefined);
});

const EMPTY_FORM: ManualModelForm = {
  contextWindow: "",
  label: "",
  maxOutputTokens: "",
  modelId: "",
  priceCached: "",
  priceCurrency: "",
  priceInput: "",
  priceOutput: "",
  efforts: "",
  vision: false,
};

test("typing a catalog-known model ID prefills facts without stomping user input", () => {
  installWebModelCatalog();

  const prefilled = prefillManualFromCatalog(EMPTY_FORM, "deepseek-v4-flash", "deepseek");
  assert.equal(prefilled.label, "DeepSeek V4 Flash");
  assert.equal(prefilled.contextWindow, "1000000");
  assert.equal(prefilled.priceCurrency, "CNY");
  assert.equal(prefilled.priceInput, "3");
  assert.equal(prefilled.priceOutput, "9");
  assert.equal(prefilled.priceCached, "0.1");

  // User-typed values win over the catalog.
  const kept = prefillManualFromCatalog(
    { ...EMPTY_FORM, label: "My own name", priceInput: "0.5" },
    "deepseek-v4-flash",
    "deepseek",
  );
  assert.equal(kept.label, "My own name");
  assert.equal(kept.priceInput, "0.5");
  assert.equal(kept.priceOutput, "9");

  const haiku = prefillManualFromCatalog(EMPTY_FORM, "claude-haiku-4-5", "anthropic");
  assert.equal(haiku.vision, true);
  assert.equal(haiku.contextWindow, "200000");
  assert.equal(haiku.maxOutputTokens, "64000");

  // No exact match: nothing is guessed.
  const unknown = prefillManualFromCatalog(EMPTY_FORM, "totally-unknown-model", "deepseek");
  assert.deepEqual(unknown, { ...EMPTY_FORM, modelId: "totally-unknown-model" });
});

test("provider model tables sort added models first, then alphabetically", () => {
  const sorted = sortProviderModels([entry("zeta"), entry("alpha"), entry("beta", "profile-1"), entry("gamma", "profile-2")]);
  assert.deepEqual(sorted.map((model) => model.id), ["beta", "gamma", "alpha", "zeta"]);
});

test("provider model rows remove only their provider prefix and keep hover cards in the viewport", () => {
  const p = provider("p1", "DeepSeek（测试中转）");
  assert.equal(providerModelDisplayName({
    displayName: "DeepSeek（测试中转） · DeepSeek V4 Flash",
    id: "deepseek-v4-flash",
  }, p), "DeepSeek V4 Flash");
  assert.equal(providerModelDisplayName({ displayName: "Independent name", id: "independent" }, p), "Independent name");

  const below = providerModelPopupStyle(
    { bottom: 140, left: 970, top: 100 },
    320,
    240,
    { height: 800, width: 1_000 },
  );
  assert.deepEqual(below, { left: 672, position: "fixed", top: 144, width: 320 });
  const flipped = providerModelPopupStyle(
    { bottom: 760, left: 20, top: 720 },
    320,
    240,
    { height: 800, width: 1_000 },
  );
  assert.deepEqual(flipped, { bottom: 84, left: 20, position: "fixed", width: 320 });
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

test("a listing row cannot blank the facts the user just stated", () => {
  // Adding a model to a provider that already pulled a listing inserts a bare
  // stub for it. Before, that stub replaced the profile row and the hover card
  // went all-unknown with the source reading "models.dev database" until the
  // next refresh, even though the API had the facts saved.
  const p = provider("p1", "Custom");
  const stated = {
    ...profile("m1", "p1"),
    facts: { contextWindow: 123_456, pricing: { currency: "USD" as const, input: 1, output: 2 } },
    vision: true,
  };

  const rows = mergeProviderModelRows(
    // The stub `addModel` prepends, plus a real listing row for another model.
    [entry("m1-id", "m1"), entry("other")],
    [stated],
    p,
  );
  const row = rows.find((model) => model.id === "m1-id")!;
  assert.deepEqual(row.user, stated.facts, "what the user stated survives the listing row");
  assert.equal(row.remote?.vision, true, "and so does the vision decision saved on the profile");
  assert.equal(row.profileId, "m1");

  // A listing that reports its own facts still supplies them; only the
  // user-stated ones are protected.
  const withRemote = mergeProviderModelRows(
    [{ id: "m1-id", profileId: "m1", remote: { contextWindow: 8_000, vision: false } }],
    [stated],
    p,
  );
  const remoteRow = withRemote.find((model) => model.id === "m1-id")!;
  assert.equal(remoteRow.remote?.contextWindow, 8_000, "the vendor's own numbers still come through");
  assert.equal(remoteRow.remote?.vision, true, "but not over a vision the user decided");
  assert.deepEqual(remoteRow.user, stated.facts);
});

function provider(id: string, name: string, presetId?: "dashscope" | "zhipu" | "zai"): ModelProvider {
  return {
    apiProtocol: "openai-chat-completions",
    apiVariant: "openai",
    baseUrl: "https://provider.example.test/v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    hasApiToken: true,
    id,
    modelDiscovery: "openai-models",
    name,
    ...(presetId ? { presetId } : {}),
    proxyPolicy: "inherit",
    tokenOptional: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function glmProfile(id: string, providerId: string): ModelProfile {
  return {
    ...profile(id, providerId),
    model: "glm-5.2",
    name: `GLM ${id}`,
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

  // Adding sits below the list behind one "Add provider" button; the preset
  // dropdown and custom button only appear after opening it.
  assert.match(html, /aria-expanded="false" class="provider-add-button"/);
  assert.doesNotMatch(html, /provider-add-panel/);
  assert.doesNotMatch(html, />Custom provider<\/button>/);
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
  assert.match(chinese, /添加 Provider/);
  assert.match(chinese, /已添加 1/);
  assert.match(chinese, /数据来源：models\.dev/);
  assert.doesNotMatch(chinese, /provider-editor/);
});

test("the same model follows the current provider preset's price", () => {
  installWebModelCatalog();
  const renderRow = (presetId: "dashscope" | "zhipu") => renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: "en" },
    createElement(ProviderRow, {
      addedProfiles: [glmProfile(`m-${presetId}`, presetId)],
      busy: false,
      expanded: true,
      onAddModel: () => Promise.resolve(true),
      onDeleteModel: () => Promise.resolve(true),
      onEdit: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      provider: provider(presetId, presetId, presetId),
      testModel: () => Promise.reject(new Error("not under test")),
    }),
  ));

  // The reseller price shows on the reseller's row…
  assert.match(renderRow("dashscope"), /0\.6 \/ 1\.8 USD\/1M/);
  // …while the domestic preset without an official price stays honestly unknown.
  assert.match(renderRow("zhipu"), /<span class="fact">\?<\/span>/);
  // Capabilities stay vendor-first on both.
  for (const html of [renderRow("dashscope"), renderRow("zhipu")]) {
    assert.match(html, /1M \/ 131k/);
    assert.match(html, /high max/);
  }
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
      onDeleteModel: () => Promise.resolve(true),
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
  assert.match(html, />Delete<\/button>/);
  assert.doesNotMatch(html, />Added<\/button>/);
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
      onDeleteModel: () => Promise.resolve(true),
      onEdit: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      provider: p,
      testModel: () => Promise.reject(new Error("not under test")),
    }),
  ));
  assert.match(chinese, /服务商未返回模型。请手动添加精确模型 ID。/);
});

test("provider table actions are add for discovered models and delete for added profiles", () => {
  const p = provider("p1", "DeepSeek（测试中转）");
  const render = (addedProfiles: ModelProfile[], listing: ProviderModelEntry[]) => renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: "en" },
    createElement(ProviderRow, {
      addedProfiles,
      busy: false,
      expanded: true,
      listing: {
        list: { fetchedAt: "2026-08-27T00:00:00.000Z", models: listing, providerId: "p1", source: "catalog" },
        loading: false,
      },
      onAddModel: () => Promise.resolve(true),
      onDeleteModel: () => Promise.resolve(true),
      onEdit: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      provider: p,
      testModel: () => Promise.reject(new Error("not under test")),
    }),
  ));

  const unadded = render([], [{ displayName: "DeepSeek V4 Flash", id: "deepseek-v4-flash" }]);
  assert.match(unadded, />Add model<\/button>/);
  assert.doesNotMatch(unadded, />Delete<\/button>/);

  const added = render([
    { ...profile("flash", "p1"), model: "deepseek-v4-flash", name: "Old provider name · DeepSeek V4 Flash" },
  ], []);
  assert.match(added, /<strong>DeepSeek V4 Flash<\/strong>/);
  assert.doesNotMatch(added, /provider-model-cell-name"><strong>Old provider name · DeepSeek V4 Flash/);
  assert.match(added, />Delete<\/button>/);
});
