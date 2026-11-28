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


import type { ModelProfile, ModelProvider, ModelProviderPreset, ProviderModelEntry } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

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

test("manual provider rows use catalog labels and keep unknown IDs honest", () => {
  installWebModelCatalog();
  const p = provider("p1", "Custom DeepSeek");
  const knownProfile = {
    ...profile("known", p.id),
    model: "deepseek-chat",
    name: `${p.name} · deepseek-chat`,
  };
  const unknownProfile = {
    ...profile("unknown", p.id),
    model: "self-hosted-mystery-7b",
    name: `${p.name} · self-hosted-mystery-7b`,
  };

  const rows = mergeProviderModelRows([], [knownProfile, unknownProfile], p);
  const known = rows.find((model) => model.id === "deepseek-chat")!;
  const unknown = rows.find((model) => model.id === "self-hosted-mystery-7b")!;

  assert.equal(known.catalog?.label, "DeepSeek Chat", "the installed catalog is attached to the manual row");
  assert.equal(providerModelDisplayName(known, p), "DeepSeek Chat");
  assert.equal(known.id, "deepseek-chat", "the registered model ID remains available beside the title");
  assert.equal(unknown.catalog, undefined);
  assert.equal(providerModelDisplayName(unknown, p), "self-hosted-mystery-7b");
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

test("the registry opens as a read-only list: no add-provider entry, no resident editor", () => {
  const html = renderSettings("en");

  // The standalone add-provider entry is gone for good: creation lives in the
  // connect wizard card, which stays closed by default when providers exist.
  assert.doesNotMatch(html, /provider-add-button/);
  assert.doesNotMatch(html, /provider-add-panel/);
  assert.doesNotMatch(html, /model-connect-wizard/);
  // No preset cards are laid out.
  assert.doesNotMatch(html, /provider-preset-card/);
  // The provider editor stays hidden until the user asks for it.
  assert.doesNotMatch(html, /provider-editor/);
  // One row per provider with the added count and an expand affordance.
  assert.match(html, /provider-row-summary/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /1 added/);
  assert.match(html, /Data source: models\.dev/);
  // The wizard toggle is the only provider-creation entry.
  assert.match(html, /Add provider/);

  const chinese = renderSettings("zh-CN");
  assert.doesNotMatch(chinese, /添加 Provider/);
  assert.match(chinese, /添加服务商/);
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
      onAddModels: async () => ({ added: [], failed: 0 }),
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
      onAddModels: async () => ({ added: [], failed: 0 }),
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
      onAddModels: async () => ({ added: [], failed: 0 }),
      onDeleteModel: () => Promise.resolve(true),
      onEdit: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      provider: p,
      testModel: () => Promise.reject(new Error("not under test")),
    }),
  ));
  assert.match(chinese, /服务商未返回模型。请手动填写精确模型 ID。/);
});

test("each provider has one Add model entry, and added profiles still offer Delete", () => {
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
      onAddModels: async () => ({ added: [], failed: 0 }),
      onDeleteModel: () => Promise.resolve(true),
      onEdit: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      provider: p,
      testModel: () => Promise.reject(new Error("not under test")),
    }),
  ));

  const unadded = render([], [{ displayName: "DeepSeek V4 Flash", id: "deepseek-v4-flash" }]);
  // The listing row itself has no per-row Add; registration has one entry.
  assert.equal((unadded.match(/>Add model<\/button>/g) ?? []).length, 1);
  assert.doesNotMatch(unadded, />Delete<\/button>/);

  const added = render([
    { ...profile("flash", "p1"), model: "deepseek-v4-flash", name: "Old provider name · DeepSeek V4 Flash" },
  ], []);
  assert.match(added, /<strong>DeepSeek V4 Flash<\/strong>/);
  assert.doesNotMatch(added, /provider-model-cell-name"><strong>Old provider name · DeepSeek V4 Flash/);
  assert.match(added, />Delete<\/button>/);
});

function extractText(node: any): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node || !node.children) return "";
  return node.children.map(extractText).join("");
}

test("wizard 高级配置在卡片内展开精细字段：向导与服务商列表都保持可见", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const client = {
    listProviderModels: async (providerId: string) => ({
      fetchedAt: "2026-09-17T00:00:00.000Z",
      models: [],
      providerId,
      source: "remote" as const,
    }),
  } as unknown as SettingsApiClient;

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ProviderModelSettings, {
          client,
          initialWizardOpen: true,
          models: [profile("m1", "p1")],
          onError: () => undefined,
          onModelsChange: () => undefined,
          onNotice: () => undefined,
          onProvidersChange: () => undefined,
          presets: PRESETS,
          providers: [provider("p1", "DeepSeek")],
        }),
      ),
    );
  });

  // Wizard starts open.
  assert.equal(renderer!.root.findAllByProps({ className: "model-connect-wizard" }).length, 1);
  assert.equal(renderer!.root.findAllByProps({ className: "wizard-advanced" }).length, 0);

  const manualButton = renderer!.root.findAllByType("button")
    .find((button) => extractText(button).includes("高级服务商设置"));
  assert.ok(manualButton, "advanced configuration button is rendered");
  await act(async () => {
    manualButton!.props.onClick();
  });

  // The wizard stays mounted and expands its advanced area in place…
  assert.equal(renderer!.root.findAllByProps({ className: "model-connect-wizard" }).length, 1);
  assert.equal(renderer!.root.findAllByProps({ className: "wizard-advanced" }).length, 1);
  // …while the registry list stays right below it.
  assert.ok(renderer!.root.findAllByProps({ className: "provider-row" }).length >= 1);
  // There is no separate add-provider entry anywhere.
  const buttonTexts = renderer!.root.findAllByType("button").map((button) => extractText(button));
  assert.ok(buttonTexts.some((text) => text.includes("收起")), "wizard toggle survives");
  assert.ok(!buttonTexts.some((text) => text.includes("添加 Provider")), "no add-provider entry");
});

test("the registry shows the default model read-only and links to the single editable control", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let edits = 0;
  const client = {
    listProviderModels: async (providerId: string) => ({
      fetchedAt: "2026-09-20T00:00:00.000Z",
      models: [],
      providerId,
      source: "remote" as const,
    }),
  } as unknown as SettingsApiClient;

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ProviderModelSettings, {
          client,
          defaultModelId: "m1",
          models: [profile("m1", "p1"), { ...profile("m2", "p1"), model: "deepseek-v4-pro", name: "工作 DeepSeek · DeepSeek V4 Pro" }],
          onEditDefaultModel: () => { edits += 1; },
          onError: () => undefined,
          onModelsChange: () => undefined,
          onNotice: () => undefined,
          onProvidersChange: () => undefined,
          presets: PRESETS,
          providers: [provider("p1", "DeepSeek")],
        }),
      ),
    );
  });

  // The registry holds no second editable control for the same field.
  const output = renderer!.root.findByProps({ id: "registry-default-model" });
  assert.equal(output.type, "output");
  assert.equal(extractText(output), "Model m1");
  assert.equal(output.props.onChange, undefined);
  assert.equal(renderer!.root.findAllByType("select").length, 0, "no registry select writes the global default");

  // It sends the user to Global defaults → Task model instead.
  const edit = renderer!.root.findAllByType("button")
    .find((button) => extractText(button) === "编辑");
  assert.ok(edit, "link to the canonical control is rendered");
  await act(async () => { edit!.props.onClick(); });
  assert.equal(edits, 1);
});

test("one Add model dialog stages a multi-model selection and submits it in one action", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls: Array<{ providerId: string; models: string[] }> = [];
  const p = provider("p1", "DeepSeek");
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "en" },
        createElement(ProviderRow, {
          addedProfiles: [],
          busy: false,
          expanded: true,
          listing: {
            list: {
              fetchedAt: "2026-08-27T00:00:00.000Z",
              models: [{ id: "listed-a" }, { id: "listed-b" }],
              providerId: "p1",
              source: "catalog",
            },
            loading: false,
          },
          onAddModels: async (providerId, requests) => {
            calls.push({ providerId, models: requests.map((request) => request.model) });
            return {
              added: requests.map((request) => ({ id: `profile-${request.model}`, model: request.model }) as ModelProfile),
              failed: 0,
            };
          },
          onDeleteModel: async () => true,
          onEdit: () => undefined,
          onRefresh: () => undefined,
          onToggle: () => undefined,
          provider: p,
          testModel: () => Promise.reject(new Error("not under test")),
        }),
      ),
    );
  });

  const addButton = renderer!.root.findAllByType("button")
    .find((button) => extractText(button) === "Add model");
  assert.ok(addButton, "the row exposes the single Add model entry");
  await act(async () => { addButton!.props.onClick(); });

  const dialog = renderer!.root.findByType("dialog");
  assert.match(extractText(dialog), /Add models to DeepSeek/);
  assert.equal(renderer!.root.findByProps({ "aria-label": "listed-a" }).props.checked, false);
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Register all listed models" }).props.onChange({ target: { checked: true } });
  });
  const submit = dialog.findAllByType("button").find((button) => extractText(button) === "Add selected models");
  assert.ok(submit);
  assert.deepEqual(calls, [], "staging writes nothing before the dialog's submit");
  await act(async () => { await submit!.props.onClick(); });

  assert.deepEqual(calls, [{ providerId: "p1", models: ["listed-a", "listed-b"] }]);
  assert.equal(renderer!.root.findAllByType("dialog").length, 0, "the dialog closes after the single submit");
});

test("collapsing a provider row with a dirty draft asks immediately and only then discards it", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const previousWindow = globalThis.window;
  const confirmations: string[] = [];
  let answer = false;
  globalThis.window = {
    confirm: (message: string) => { confirmations.push(message); return answer; },
  } as unknown as Window & typeof globalThis;
  try {
    const client = {
      listProviderModels: async (providerId: string) => ({
        fetchedAt: "2026-09-20T00:00:00.000Z",
        models: [],
        providerId,
        source: "remote" as const,
      }),
    } as unknown as SettingsApiClient;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          LocaleProvider,
          { initialLocale: "en" },
          createElement(ProviderModelSettings, {
            client,
            models: [],
            onError: () => undefined,
            onModelsChange: () => undefined,
            onNotice: () => undefined,
            onProvidersChange: () => undefined,
            presets: PRESETS,
            providers: [provider("p1", "DeepSeek")],
          }),
        ),
      );
    });

    const row = renderer!.root.findByProps({ className: "provider-row" });
    await act(async () => { row.findByProps({ className: "provider-row-summary" }).props.onClick(); });
    await act(async () => {
      renderer!.root.findAllByType("button").find((button) => extractText(button) === "Edit")!.props.onClick();
    });
    assert.equal(renderer!.root.findAllByProps({ className: "provider-editor" }).length, 1);
    const nameInput = renderer!.root.findAllByType("label")
      .find((label) => extractText(label).includes("Provider name"))!.findByType("input");
    await act(async () => { nameInput.props.onChange({ target: { value: "DeepSeek edited" } }); });

    // The prompt appears while the editor is still visible, not later at close.
    await act(async () => { row.findByProps({ className: "provider-row-summary" }).props.onClick(); });
    assert.equal(confirmations.length, 1);
    assert.equal(renderer!.root.findAllByProps({ className: "provider-editor" }).length, 1, "cancel keeps the draft open");

    answer = true;
    await act(async () => { row.findByProps({ className: "provider-row-summary" }).props.onClick(); });
    assert.equal(confirmations.length, 2);
    assert.equal(renderer!.root.findAllByProps({ className: "provider-row-detail" }).length, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});

function listing(models: ProviderModelEntry[]): {
  list: { fetchedAt: string; models: ProviderModelEntry[]; providerId: string; source: "catalog" };
  loading: boolean;
} {
  return {
    list: { fetchedAt: "2026-08-27T00:00:00.000Z", models, providerId: "p1", source: "catalog" },
    loading: false,
  };
}

function rowElement(
  models: ProviderModelEntry[],
  onAddModels: (providerId: string, requests: import("@sciencediscovery/schema").CreateProviderModelRequest[]) => Promise<{ added: ModelProfile[]; failed: number }>,
  providerValue = provider("p1", "DeepSeek"),
  onRefresh: (providerId: string) => void = () => undefined,
) {
  return createElement(
    LocaleProvider,
    { initialLocale: "en" },
    createElement(ProviderRow, {
      addedProfiles: [],
      busy: false,
      expanded: true,
      listing: listing(models),
      onAddModels,
      onDeleteModel: async () => true,
      onEdit: () => undefined,
      onRefresh,
      onToggle: () => undefined,
      provider: providerValue,
      testModel: () => Promise.reject(new Error("not under test")),
    }),
  );
}

test("Add model dialog counts only visible ticks and never submits a zero-write selection", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls: string[][] = [];
  const add = async (_providerId: string, requests: import("@sciencediscovery/schema").CreateProviderModelRequest[]) => {
    calls.push(requests.map((request) => request.model));
    return { added: requests.map((request) => ({ id: `profile-${request.model}`, model: request.model }) as ModelProfile), failed: 0 };
  };
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(rowElement([{ id: "listed-a" }], add)); });
  await act(async () => {
    renderer!.root.findAllByType("button").find((button) => extractText(button) === "Add model")!.props.onClick();
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "listed-a" }).props.onChange({ target: { checked: true } });
  });

  // The listing now says the ticked model is registered by another client.
  await act(async () => {
    renderer!.update(rowElement([{ id: "listed-a", profileId: "profile-a" }], add));
  });

  assert.equal(renderer!.root.findAllByProps({ "aria-label": "listed-a" }).length, 0);
  assert.match(extractText(renderer!.root.findByType("dialog")), /All listed models are already added/);
  const submit = renderer!.root.findByType("dialog").findAllByType("button")
    .find((button) => extractText(button) === "Add selected models")!;
  assert.equal(submit.props.disabled, true);
  await act(async () => { await submit.props.onClick(); });
  assert.deepEqual(calls, [], "no request may be issued when no visible tick survives");
});

test("Add model dialog reports a partial result and keeps only the failed rows selected", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let calls = 0;
  const add = async (_providerId: string, requests: import("@sciencediscovery/schema").CreateProviderModelRequest[]) => {
    calls += 1;
    const first = requests[0]!;
    return { added: [{ id: "profile-a", model: first.model } as ModelProfile], failed: requests.length - 1 };
  };
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(rowElement([{ id: "listed-a" }, { id: "listed-b" }], add)); });
  await act(async () => {
    renderer!.root.findAllByType("button").find((button) => extractText(button) === "Add model")!.props.onClick();
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Register all listed models" }).props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    await renderer!.root.findByType("dialog").findAllByType("button")
      .find((button) => extractText(button) === "Add selected models")!.props.onClick();
  });

  // The parent marks the succeeded row with its profile id; the dialog keeps
  // the failed tick and reports the partial outcome.
  await act(async () => {
    renderer!.update(rowElement([{ id: "listed-a", profileId: "profile-a" }, { id: "listed-b" }], add));
  });
  const dialog = renderer!.root.findByType("dialog");
  assert.equal(calls, 1);
  assert.match(extractText(dialog), /Added 1 of 2 selected models/);
  assert.equal(renderer!.root.findAllByProps({ "aria-label": "listed-a" }).length, 0, "the succeeded row is gone");
  assert.equal(renderer!.root.findByProps({ "aria-label": "listed-b" }).props.checked, true, "only the failed row stays selected");
  const submit = dialog.findAllByType("button").find((button) => extractText(button) === "Add selected models")!;
  assert.equal(submit.props.disabled, false);

  // Editing the remaining plan clears the stale "Added N of M" outcome.
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "listed-b" }).props.onChange({ target: { checked: false } });
  });
  assert.doesNotMatch(extractText(renderer!.root.findByType("dialog")), /Added 1 of 2/);
});

test("a dirty Add model dialog asks before discarding ticks or staged manual entries", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const previousWindow = globalThis.window;
  const confirmations: string[] = [];
  let answer = false;
  globalThis.window = {
    confirm: (message: string) => { confirmations.push(message); return answer; },
  } as unknown as Window & typeof globalThis;
  try {
    let renderer: ReactTestRenderer;
    const add = async () => ({ added: [], failed: 0 });
    // Start with an empty listing so the manual fallback is open, stage one
    // manual model, then add a listed tick as well.
    await act(async () => { renderer = create(rowElement([], add)); });
    await act(async () => {
      renderer!.root.findAllByType("button").find((button) => extractText(button) === "Add model")!.props.onClick();
    });
    let dialog = renderer!.root.findByType("dialog");
    const manualId = dialog.findAllByType("input").find((input) => input.props.placeholder === "Exact ID from provider documentation")!;
    await act(async () => { manualId.props.onChange({ target: { value: "staged-model" } }); });
    await act(async () => {
      dialog.findAllByType("button").find((button) => extractText(button) === "Add to selection")!.props.onClick();
    });
    await act(async () => { renderer!.update(rowElement([{ id: "listed-a" }], add)); });
    dialog = renderer!.root.findByType("dialog");
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "listed-a" }).props.onChange({ target: { checked: true } });
    });

    const cancel = dialog.findAllByType("button").find((button) => extractText(button) === "Cancel")!;
    await act(async () => { cancel.props.onClick(); });
    assert.equal(confirmations.length, 1);
    assert.equal(renderer!.root.findAllByType("dialog").length, 1, "declining keeps the dialog and its draft");

    answer = true;
    await act(async () => { cancel.props.onClick(); });
    assert.equal(confirmations.length, 2);
    assert.equal(renderer!.root.findAllByType("dialog").length, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});

function partialAdd(calls: string[]) {
  return async (_providerId: string, requests: import("@sciencediscovery/schema").CreateProviderModelRequest[]) => {
    calls.push(...requests.map((request) => request.model));
    return {
      added: [{ id: "profile-a", model: requests[0]!.model } as ModelProfile],
      failed: requests.length - 1,
    };
  };
}

test("Add model partial result clears on refresh", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls: string[] = [];
  const refreshes: string[] = [];
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(rowElement([{ id: "listed-a" }, { id: "listed-b" }], partialAdd(calls), provider("p1", "DeepSeek"), (id) => refreshes.push(id)));
  });
  await act(async () => {
    renderer!.root.findAllByType("button").find((button) => extractText(button) === "Add model")!.props.onClick();
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Register all listed models" }).props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    await renderer!.root.findByType("dialog").findAllByType("button")
      .find((button) => extractText(button) === "Add selected models")!.props.onClick();
  });
  assert.match(extractText(renderer!.root.findByType("dialog")), /Added 1 of 2/);

  await act(async () => {
    renderer!.root.findByType("dialog").findAllByType("button")
      .find((button) => extractText(button) === "Refresh model list")!.props.onClick();
  });
  assert.deepEqual(refreshes, ["p1"]);
  assert.doesNotMatch(extractText(renderer!.root.findByType("dialog")), /Added 1 of 2/);
});

test("Add model partial result clears when the listing changes beyond the just-added row", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls: string[] = [];
  const add = partialAdd(calls);
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(rowElement([{ id: "listed-a" }, { id: "listed-b" }], add)); });
  await act(async () => {
    renderer!.root.findAllByType("button").find((button) => extractText(button) === "Add model")!.props.onClick();
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Register all listed models" }).props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    await renderer!.root.findByType("dialog").findAllByType("button")
      .find((button) => extractText(button) === "Add selected models")!.props.onClick();
  });
  assert.match(extractText(renderer!.root.findByType("dialog")), /Added 1 of 2/);

  // Removing only the just-added row keeps the outcome; adding another row
  // means the listing no longer describes the plan the banner reported.
  await act(async () => {
    renderer!.update(rowElement([
      { id: "listed-a", profileId: "profile-a" },
      { id: "listed-b" },
      { id: "listed-c" },
    ], add));
  });
  assert.doesNotMatch(extractText(renderer!.root.findByType("dialog")), /Added 1 of 2/);
});

test("ProviderModelSettings reconciles a mixed add success and failure", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const requests: string[] = [];
  const errors: unknown[] = [];
  const modelChanges: ModelProfile[][] = [];
  const client = {
    addProviderModel: async (providerId: string, body: import("@sciencediscovery/schema").CreateProviderModelRequest) => {
      requests.push(body.model);
      if (body.model === "listed-a") {
        return { ...profile("m1", providerId), model: "listed-a", name: "Model A" };
      }
      throw new Error("second add failed");
    },
    listProviderModels: async (providerId: string) => ({
      fetchedAt: "2026-09-20T00:00:00.000Z",
      models: [{ id: "listed-a" }, { id: "listed-b" }],
      providerId,
      source: "remote" as const,
    }),
  } as unknown as SettingsApiClient;

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "en" },
        createElement(ProviderModelSettings, {
          client,
          models: [],
          onError: (reason) => { errors.push(reason); },
          onModelsChange: (models) => { modelChanges.push(models); },
          onNotice: () => undefined,
          onProvidersChange: () => undefined,
          presets: PRESETS,
          providers: [provider("p1", "DeepSeek")],
        }),
      ),
    );
  });
  await act(async () => {
    renderer!.root.findByProps({ className: "provider-row" }).findByProps({ className: "provider-row-summary" }).props.onClick();
  });
  await act(async () => {
    renderer!.root.findAllByType("button").find((button) => extractText(button) === "Add model")!.props.onClick();
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Register all listed models" }).props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    await renderer!.root.findByType("dialog").findAllByType("button")
      .find((button) => extractText(button) === "Add selected models")!.props.onClick();
  });

  assert.deepEqual(requests, ["listed-a", "listed-b"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /second add failed/);
  assert.equal(modelChanges.at(-1)?.length, 1);
  assert.equal(modelChanges.at(-1)?.[0]?.model, "listed-a");
  assert.match(extractText(renderer!.root.findByType("dialog")), /Added 1 of 2/);
  assert.equal(renderer!.root.findAllByProps({ "aria-label": "listed-a" }).length, 0, "the succeeded listing row now carries its profile id");
  assert.equal(renderer!.root.findByProps({ "aria-label": "listed-b" }).props.checked, true);
});
