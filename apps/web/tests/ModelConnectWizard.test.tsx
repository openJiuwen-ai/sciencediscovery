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

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MODEL_PROVIDER_PRESETS } from "@sciencediscovery/schema";
import type {
  ModelConnectivityTestResult,
  ModelProfile,
  ModelProvider,
} from "@sciencediscovery/schema";

import type { SettingsApiClient } from "../src/api/settings.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { ModelConnectWizard } from "../src/ModelConnectWizard.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const successResult: ModelConnectivityTestResult = {
  category: "ok",
  latencyMs: 88,
  message: "Connected successfully",
  ok: true,
  providerStatus: 200,
  testedAt: "2026-09-17T00:00:00.000Z",
};

const authFailResult: ModelConnectivityTestResult = {
  category: "authorization",
  latencyMs: 25,
  message: "Invalid API key provided",
  ok: false,
  providerStatus: 401,
  testedAt: "2026-09-17T00:00:01.000Z",
};

const existingDeepSeekProvider: ModelProvider = {
  apiProtocol: "openai-chat-completions",
  apiVariant: "deepseek",
  baseUrl: "https://api.deepseek.com",
  createdAt: "2026-09-01T00:00:00.000Z",
  hasApiToken: true,
  id: "existing-provider-deepseek-1",
  modelDiscovery: "openai-models",
  name: "DeepSeek",
  presetId: "deepseek",
  proxyPolicy: "inherit",
  tokenOptional: false,
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function extractText(node: any): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node || !node.children) return "";
  return node.children.map(extractText).join("");
}

function createMockClient(overrides: Partial<SettingsApiClient> = {}): SettingsApiClient {
  return {
    addProviderModel: async (providerId: string, body: any) => ({
      contextWindow: 64000,
      id: `profile-${providerId}-${body.model}`,
      model: body.model,
      name: body.label || body.model,
      providerId,
    } as ModelProfile),
    createProvider: async (body: any) => ({
      apiProtocol: body.apiProtocol,
      apiVariant: body.apiVariant,
      baseUrl: body.baseUrl,
      createdAt: "2026-09-17T00:00:00.000Z",
      id: "created-provider-1",
      modelDiscovery: body.modelDiscovery,
      name: body.name,
      presetId: body.presetId,
      proxyPolicy: "inherit",
      tokenOptional: body.tokenOptional ?? false,
      updatedAt: "2026-09-17T00:00:00.000Z",
    } as ModelProvider),
    deleteModel: async (_modelId: string) => ({ deleted: _modelId }),
    deleteProvider: async (_providerId: string) => ({ deleted: _providerId }),
    listModels: async () => [],
    // The first entry deliberately differs from any preset's former
    // recommended model, so tests prove the listing order is what wins.
    listProviderModels: async (providerId: string) => ({
      fetchedAt: "2026-09-17T00:00:00.000Z",
      models: [{ id: "listed-model-first" }, { id: "listed-model-second" }],
      providerId,
      source: "remote" as const,
    }),
    listProviders: async () => ({ presets: [...MODEL_PROVIDER_PRESETS], providers: [] }),
    replaceGlobalSettings: async () => ({} as any),
    testModel: async () => successResult,
    updateProvider: async (id: string, body: any) => ({
      id,
      name: body.name || "Provider",
    } as ModelProvider),
    ...overrides,
  } as unknown as SettingsApiClient;
}

test("renders preset provider selection, official registration link, and billing notice in zh-CN and en", async () => {
  let zhRenderer: ReactTestRenderer;
  await act(async () => {
    zhRenderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client: createMockClient(),
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  const zhLink = zhRenderer!.root.findByProps({ className: "wizard-key-link" });
  assert.equal(zhLink.props.href, "https://platform.deepseek.com/api_keys");
  assert.match(extractText(zhLink), /前往 DeepSeek 获取 API Key/);

  const zhNotice = zhRenderer!.root.findByProps({ className: "wizard-billing-notice" });
  assert.match(extractText(zhNotice), /调用模型将按服务商标准计费/);

  // No recommended-model badge or equivalent copy anywhere in the wizard.
  assert.ok(!extractText(zhRenderer!.root).includes("推荐模型"));

  let enRenderer: ReactTestRenderer;
  await act(async () => {
    enRenderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "en" },
        createElement(ModelConnectWizard, {
          client: createMockClient(),
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  const enLink = enRenderer!.root.findByProps({ className: "wizard-key-link" });
  assert.equal(enLink.props.href, "https://platform.deepseek.com/api_keys");
  assert.match(extractText(enLink), /Get API key for DeepSeek/);

  const enNotice = enRenderer!.root.findByProps({ className: "wizard-billing-notice" });
  assert.match(extractText(enNotice), /Calls will be billed according to the provider's standard rates/);
});

test("successful flow: creates provider, registers ALL listed models, tests the first, and sets it as global default on an empty system", async () => {
  let createdProviderInput: any;
  const registeredModels: string[] = [];
  let testedModelId: string | undefined;
  let defaultModelSetId: string | undefined;
  let listingProviderId: string | undefined;

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      registeredModels.push(body.model);
      return {
        contextWindow: 64000,
        id: `profile-${body.model}`,
        model: body.model,
        name: body.label || body.model,
        providerId,
      } as ModelProfile;
    },
    createProvider: async (body: any) => {
      createdProviderInput = body;
      return {
        apiProtocol: body.apiProtocol,
        apiVariant: body.apiVariant,
        baseUrl: body.baseUrl,
        createdAt: "2026-09-17T00:00:00.000Z",
        id: "provider-deepseek-1",
        modelDiscovery: body.modelDiscovery,
        name: body.name,
        presetId: body.presetId,
        proxyPolicy: "inherit",
        tokenOptional: false,
        updatedAt: "2026-09-17T00:00:00.000Z",
      } as ModelProvider;
    },
    listProviderModels: async (providerId: string) => {
      listingProviderId = providerId;
      return {
        fetchedAt: "2026-09-17T00:00:00.000Z",
        models: [{ id: "listed-model-first" }, { id: "deepseek-chat" }],
        providerId,
        source: "remote" as const,
      };
    },
    testModel: async (modelId: string) => {
      testedModelId = modelId;
      return successResult;
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          onDefaultModelSet: async (modelId: string) => {
            defaultModelSetId = modelId;
          },
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  // Enter API Key
  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-deepseek-test-123" } });
  });

  // Click "保存并连接"
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  // Assertions
  assert.equal(createdProviderInput?.presetId, "deepseek");
  assert.equal(createdProviderInput?.apiToken, "sk-deepseek-test-123");
  assert.equal(createdProviderInput?.baseUrl, "https://api.deepseek.com");

  // Every listing entry is registered (deepseek-chat sits second on purpose,
  // proving the order comes from the listing, not any preset recommendation).
  assert.equal(listingProviderId, "provider-deepseek-1");
  assert.deepEqual(registeredModels, ["listed-model-first", "deepseek-chat"]);

  assert.equal(testedModelId, "profile-listed-model-first");
  assert.equal(defaultModelSetId, "profile-listed-model-first");

  // Success alert is visible, reports the count and the new default
  const successAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-success" });
  assert.match(extractText(successAlert), /模型已连接并保存/);
  assert.match(extractText(successAlert), /登记 2 个模型；listed-model-first 已设为全局默认任务模型/);
  assert.match(extractText(successAlert), /88 ms/);
});

test("successful flow with existing models: registers all listed models but leaves the global default alone", async () => {
  const registeredModels: string[] = [];
  let defaultModelSetCalled = false;
  let replaceSettingsCalledWithModel = false;

  const existingModelProfile: ModelProfile = {
    contextWindow: 64000,
    id: "existing-profile-1",
    model: "existing-model",
    name: "Existing Model",
    providerId: "some-other-provider",
  };

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      registeredModels.push(body.model);
      return {
        contextWindow: 64000,
        id: `profile-${body.model}`,
        model: body.model,
        name: body.label || body.model,
        providerId,
      } as ModelProfile;
    },
    // The system already has a model before this connect.
    listModels: async () => [existingModelProfile],
    replaceGlobalSettings: async (body: any) => {
      if (body && body.modelId) replaceSettingsCalledWithModel = true;
      return {} as any;
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          onDefaultModelSet: async () => {
            defaultModelSetCalled = true;
          },
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-deepseek-test-123" } });
  });

  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  // All listing entries registered…
  assert.deepEqual(registeredModels, ["listed-model-first", "listed-model-second"]);
  // …but the existing default is untouched.
  assert.equal(defaultModelSetCalled, false);
  assert.equal(replaceSettingsCalledWithModel, false);

  // Success copy says the default was kept.
  const successAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-success" });
  assert.match(extractText(successAlert), /登记 2 个模型；全局默认任务模型保持不变/);
});

test("failure flow: rollbacks temporary model and provider on test failure, shows readable error, keeps key input", async () => {
  let deletedModelId: string | undefined;
  let deletedProviderId: string | undefined;
  let defaultModelSetCalled = false;

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => ({
      contextWindow: 64000,
      id: "temp-profile-to-delete",
      model: body.model,
      name: "DeepSeek-V3",
      providerId,
    } as ModelProfile),
    createProvider: async (body: any) => ({
      apiProtocol: body.apiProtocol,
      apiVariant: body.apiVariant,
      baseUrl: body.baseUrl,
      createdAt: "2026-09-17T00:00:00.000Z",
      id: "temp-provider-to-delete",
      modelDiscovery: body.modelDiscovery,
      name: body.name,
      presetId: body.presetId,
      proxyPolicy: "inherit",
      tokenOptional: false,
      updatedAt: "2026-09-17T00:00:00.000Z",
    } as ModelProvider),
    deleteModel: async (modelId: string) => {
      deletedModelId = modelId;
      return { deleted: modelId };
    },
    deleteProvider: async (providerId: string) => {
      deletedProviderId = providerId;
      return { deleted: providerId };
    },
    testModel: async () => authFailResult,
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          onDefaultModelSet: async () => {
            defaultModelSetCalled = true;
          },
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  // Enter invalid API Key
  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-invalid-key" } });
  });

  // Click "测试并启用"
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  // Temporary objects rolled back
  assert.equal(deletedModelId, "temp-profile-to-delete");
  assert.equal(deletedProviderId, "temp-provider-to-delete");

  // Default model was NOT changed
  assert.equal(defaultModelSetCalled, false);

  // User input preserved
  const recheckKeyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  assert.equal(recheckKeyInput.props.value, "sk-invalid-key");

  // Error alert rendered with status code and readable failure message
  const errorAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-error" });
  const alertText = extractText(errorAlert);
  assert.match(alertText, /鉴权失败/);
  assert.match(alertText, /401/);
  assert.match(alertText, /Invalid API key provided/);
});

test("bad key with an existing provider: new provider is rolled back, existing row and its token stay untouched", async () => {
  let updateProviderCalled = false;
  let deletedModelId: string | undefined;
  let deletedProviderId: string | undefined;
  let defaultModelSetCalled = false;

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => ({
      contextWindow: 64000,
      id: `temp-profile-on-${providerId}`,
      model: body.model,
      name: "DeepSeek-V3",
      providerId,
    } as ModelProfile),
    createProvider: async (body: any) => ({
      apiProtocol: body.apiProtocol,
      apiVariant: body.apiVariant,
      baseUrl: body.baseUrl,
      createdAt: "2026-09-17T00:00:00.000Z",
      id: "temp-testing-provider",
      modelDiscovery: body.modelDiscovery,
      name: body.name,
      presetId: body.presetId,
      proxyPolicy: "inherit",
      tokenOptional: false,
      updatedAt: "2026-09-17T00:00:00.000Z",
    } as ModelProvider),
    deleteModel: async (modelId: string) => {
      deletedModelId = modelId;
      return { deleted: modelId };
    },
    deleteProvider: async (providerId: string) => {
      deletedProviderId = providerId;
      return { deleted: providerId };
    },
    listProviders: async () => ({ presets: [...MODEL_PROVIDER_PRESETS], providers: [existingDeepSeekProvider] }),
    testModel: async () => authFailResult,
    updateProvider: async () => {
      updateProviderCalled = true;
      throw new Error("Should never update an existing provider from the wizard!");
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          onDefaultModelSet: async () => {
            defaultModelSetCalled = true;
          },
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  // Enter invalid API Key
  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-bad-key-should-not-override" } });
  });

  // Click "测试并启用"
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  // No existing provider is ever updated from the wizard!
  assert.equal(updateProviderCalled, false);

  // The newly created objects are cleaned up on failure
  assert.equal(deletedProviderId, "temp-testing-provider");
  assert.equal(deletedModelId, "temp-profile-on-temp-testing-provider");

  // Global default model was NOT changed
  assert.equal(defaultModelSetCalled, false);

  // User input preserved
  const recheckKeyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  assert.equal(recheckKeyInput.props.value, "sk-bad-key-should-not-override");

  // Error alert rendered
  const errorAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-error" });
  const alertText = extractText(errorAlert);
  assert.match(alertText, /鉴权失败/);
  assert.match(alertText, /401/);
});

test("custom provider flow: creates custom provider with custom baseUrl and modelId, listing not consulted", async () => {
  let createdProviderInput: any;
  let addedModelInput: any;
  let defaultModelSetId: string | undefined;
  let listingCalled = false;

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      addedModelInput = { providerId, ...body };
      return {
        contextWindow: 32000,
        id: "profile-custom-model",
        model: body.model,
        name: body.label || body.model,
        providerId,
      } as ModelProfile;
    },
    createProvider: async (body: any) => {
      createdProviderInput = body;
      return {
        apiProtocol: body.apiProtocol,
        apiVariant: body.apiVariant,
        baseUrl: body.baseUrl,
        createdAt: "2026-09-17T00:00:00.000Z",
        id: "provider-custom-1",
        modelDiscovery: body.modelDiscovery,
        name: body.name,
        proxyPolicy: "inherit",
        tokenOptional: false,
        updatedAt: "2026-09-17T00:00:00.000Z",
      } as ModelProvider;
    },
    listProviderModels: async (providerId: string) => {
      listingCalled = true;
      return {
        fetchedAt: "2026-09-17T00:00:00.000Z",
        models: [{ id: "listed-model-first" }],
        providerId,
        source: "remote" as const,
      };
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          onDefaultModelSet: async (modelId: string) => {
            defaultModelSetId = modelId;
          },
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  // Switch to custom provider
  const select = renderer!.root.findByProps({ id: "wizard-provider-select" });
  await act(async () => {
    select.props.onChange({ target: { value: "custom" } });
  });

  // Fill in custom provider details
  const nameInput = renderer!.root.findByProps({ id: "wizard-custom-name" });
  await act(async () => {
    nameInput.props.onChange({ target: { value: "Local Gateway" } });
  });

  const urlInput = renderer!.root.findByProps({ id: "wizard-custom-url" });
  await act(async () => {
    urlInput.props.onChange({ target: { value: "http://localhost:8000/v1" } });
  });

  const modelInput = renderer!.root.findByProps({ id: "wizard-custom-model" });
  await act(async () => {
    modelInput.props.onChange({ target: { value: "qwen-2.5-72b" } });
  });

  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-custom-key" } });
  });

  // Submit
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  assert.equal(createdProviderInput?.name, "Local Gateway");
  assert.equal(createdProviderInput?.baseUrl, "http://localhost:8000/v1");
  assert.equal(createdProviderInput?.apiToken, "sk-custom-key");
  assert.equal(addedModelInput?.model, "qwen-2.5-72b");
  assert.equal(listingCalled, false);
  assert.equal(defaultModelSetId, "profile-custom-model");
});

test("custom provider without model id: registers every listed model", async () => {
  const registeredModels: string[] = [];
  let defaultModelSetId: string | undefined;

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      registeredModels.push(body.model);
      return {
        contextWindow: 32000,
        id: `profile-${body.model}`,
        model: body.model,
        name: body.label || body.model,
        providerId,
      } as ModelProfile;
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          onDefaultModelSet: async (modelId: string) => {
            defaultModelSetId = modelId;
          },
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  const select = renderer!.root.findByProps({ id: "wizard-provider-select" });
  await act(async () => {
    select.props.onChange({ target: { value: "custom" } });
  });

  const urlInput = renderer!.root.findByProps({ id: "wizard-custom-url" });
  await act(async () => {
    urlInput.props.onChange({ target: { value: "http://localhost:8000/v1" } });
  });

  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-custom-key" } });
  });

  // Model identifier intentionally left empty: the listing decides.
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  assert.deepEqual(registeredModels, ["listed-model-first", "listed-model-second"]);
  assert.equal(defaultModelSetId, "profile-listed-model-first");

  const successAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-success" });
  assert.match(extractText(successAlert), /listed-model-first/);
});

test("empty model listing: readable error, provider rolled back, default untouched", async () => {
  let deletedProviderId: string | undefined;
  let addModelCalled = false;
  let defaultModelSetCalled = false;

  const client = createMockClient({
    addProviderModel: async () => {
      addModelCalled = true;
      throw new Error("should not register a model when the listing is empty");
    },
    deleteProvider: async (providerId: string) => {
      deletedProviderId = providerId;
      return { deleted: providerId };
    },
    listProviderModels: async (providerId: string) => ({
      fetchedAt: "2026-09-17T00:00:00.000Z",
      models: [],
      providerId,
      source: "remote" as const,
    }),
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          onDefaultModelSet: async () => {
            defaultModelSetCalled = true;
          },
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-deepseek-test-123" } });
  });

  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  // Readable error, no half-created provider, no model registration, no default change.
  const errorAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-error" });
  assert.match(extractText(errorAlert), /未返回任何可用模型/);
  assert.equal(deletedProviderId, "created-provider-1");
  assert.equal(addModelCalled, false);
  assert.equal(defaultModelSetCalled, false);
});

test("model listing failure: readable error with detail, provider rolled back, default untouched", async () => {
  let deletedProviderId: string | undefined;
  let defaultModelSetCalled = false;

  const client = createMockClient({
    deleteProvider: async (providerId: string) => {
      deletedProviderId = providerId;
      return { deleted: providerId };
    },
    listProviderModels: async () => {
      throw new Error("The provider model list request failed with status 401");
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          onDefaultModelSet: async () => {
            defaultModelSetCalled = true;
          },
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-bad-key" } });
  });

  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  const errorAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-error" });
  const alertText = extractText(errorAlert);
  assert.match(alertText, /无法获取该服务商的模型列表/);
  assert.match(alertText, /401/);
  assert.equal(deletedProviderId, "created-provider-1");
  assert.equal(defaultModelSetCalled, false);
});

test("validation errors: missing key prevents client API calls", async () => {
  let clientCalled = false;
  const client = createMockClient({
    createProvider: async () => {
      clientCalled = true;
      throw new Error("should not be called");
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  // Submit without key
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  assert.equal(clientCalled, false);
  const errorAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-error" });
  assert.match(extractText(errorAlert), /请填写 API Key/);
});

test("advanced configuration expands fine-tuning fields in place; the wizard stays mounted", async () => {
  let renderer: ReactTestRenderer;

  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client: createMockClient(),
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  // The wizard card is present and the advanced area starts hidden.
  assert.equal(renderer!.root.findAllByProps({ className: "model-connect-wizard" }).length, 1);
  assert.equal(renderer!.root.findAllByProps({ className: "wizard-advanced" }).length, 0);

  const manualBtn = renderer!.root.findByProps({ className: "secondary-button compact-button" });
  assert.equal(extractText(manualBtn), "高级配置");
  assert.equal(manualBtn.props["aria-expanded"], false);
  await act(async () => {
    manualBtn.props.onClick();
  });

  // The wizard stays mounted; the advanced area expands inside the card.
  assert.equal(renderer!.root.findAllByProps({ className: "model-connect-wizard" }).length, 1);
  assert.equal(renderer!.root.findAllByProps({ className: "wizard-advanced" }).length, 1);
  const overrideInput = renderer!.root.findByProps({ id: "wizard-base-url-override" });
  assert.equal(overrideInput.props.placeholder, "https://api.deepseek.com");
  const expandedBtn = renderer!.root.findByProps({ className: "secondary-button compact-button" });
  assert.equal(expandedBtn.props["aria-expanded"], true);

  // Toggling again collapses the area; the wizard still remains.
  await act(async () => {
    expandedBtn.props.onClick();
  });
  assert.equal(renderer!.root.findAllByProps({ className: "model-connect-wizard" }).length, 1);
  assert.equal(renderer!.root.findAllByProps({ className: "wizard-advanced" }).length, 0);
});

test("advanced preset fields: base URL override is honored when creating a provider", async () => {
  let createdProviderInput: any;

  const client = createMockClient({
    createProvider: async (body: any) => {
      createdProviderInput = body;
      return {
        apiProtocol: body.apiProtocol,
        apiVariant: body.apiVariant,
        baseUrl: body.baseUrl,
        createdAt: "2026-09-17T00:00:00.000Z",
        id: "provider-deepseek-1",
        modelDiscovery: body.modelDiscovery,
        name: body.name,
        presetId: body.presetId,
        proxyPolicy: body.proxyPolicy ?? "inherit",
        tokenOptional: false,
        updatedAt: "2026-09-17T00:00:00.000Z",
      } as ModelProvider;
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  await act(async () => {
    renderer!.root.findByProps({ className: "secondary-button compact-button" }).props.onClick();
  });
  const overrideInput = renderer!.root.findByProps({ id: "wizard-base-url-override" });
  await act(async () => {
    overrideInput.props.onChange({ target: { value: "https://gateway.example.test/v1" } });
  });
  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-test" } });
  });
  await act(async () => {
    await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });

  assert.equal(createdProviderInput?.baseUrl, "https://gateway.example.test/v1");
  assert.equal(createdProviderInput?.proxyPolicy, "inherit");
});

test("advanced custom fields: protocol and variant drive creation, and the listing default still applies", async () => {
  let createdProviderInput: any;
  const registeredModels: string[] = [];

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      registeredModels.push(body.model);
      return {
        contextWindow: 32000,
        id: `profile-${body.model}`,
        model: body.model,
        name: body.label || body.model,
        providerId,
      } as ModelProfile;
    },
    createProvider: async (body: any) => {
      createdProviderInput = body;
      return {
        apiProtocol: body.apiProtocol,
        apiVariant: body.apiVariant,
        baseUrl: body.baseUrl,
        createdAt: "2026-09-17T00:00:00.000Z",
        id: "provider-custom-1",
        modelDiscovery: body.modelDiscovery,
        name: body.name,
        proxyPolicy: body.proxyPolicy ?? "inherit",
        tokenOptional: false,
        updatedAt: "2026-09-17T00:00:00.000Z",
      } as ModelProvider;
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  const select = renderer!.root.findByProps({ id: "wizard-provider-select" });
  await act(async () => {
    select.props.onChange({ target: { value: "custom" } });
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-custom-url" }).props.onChange({ target: { value: "https://claude.example.test" } });
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-custom" } });
  });

  // Expand advanced fields and pick Anthropic Messages.
  await act(async () => {
    renderer!.root.findByProps({ className: "secondary-button compact-button" }).props.onClick();
  });
  const protocolSelect = renderer!.root.findByProps({ id: "wizard-api-protocol" });
  await act(async () => {
    protocolSelect.props.onChange({ target: { value: "anthropic-messages" } });
  });
  // Variant follows the protocol default automatically.
  const variantSelect = renderer!.root.findByProps({ id: "wizard-api-variant" });
  assert.equal(variantSelect.props.value, "anthropic-adaptive");

  await act(async () => {
    await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });

  assert.equal(createdProviderInput?.apiProtocol, "anthropic-messages");
  assert.equal(createdProviderInput?.apiVariant, "anthropic-adaptive");
  assert.equal(createdProviderInput?.modelDiscovery, "anthropic-models");
  // No explicit model identifier: every listed model is registered.
  assert.deepEqual(registeredModels, ["listed-model-first", "listed-model-second"]);
});

test("advanced area always shows creation fields, even when the same preset already exists", async () => {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client: createMockClient({
            listProviders: async () => ({ presets: [...MODEL_PROVIDER_PRESETS], providers: [existingDeepSeekProvider] }),
          }),
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  await act(async () => {
    renderer!.root.findByProps({ className: "secondary-button compact-button" }).props.onClick();
  });

  // Duplicate adds are allowed: no "reuse the existing one" note anywhere,
  // and the display-name plus base-URL fields stay editable.
  assert.equal(renderer!.root.findAllByProps({ className: "wizard-advanced-note" }).length, 0);
  const nameInput = renderer!.root.findByProps({ id: "wizard-preset-name" });
  assert.equal(nameInput.props.placeholder, "DeepSeek");
  assert.ok(renderer!.root.findByProps({ id: "wizard-base-url-override" }));
  const fullText = extractText(renderer!.root);
  assert.ok(!fullText.includes("仅更新密钥"));
});

test("same preset can be added again with its own name and key; the existing row is never updated", async () => {
  let createdProviderInput: any;
  let updateProviderCalled = false;
  let providersAfter: ModelProvider[] | undefined;

  const createdProvider: ModelProvider = {
    ...existingDeepSeekProvider,
    createdAt: "2026-09-17T00:00:00.000Z",
    id: "created-provider-work-deepseek",
    name: "工作 DeepSeek",
    updatedAt: "2026-09-17T00:00:00.000Z",
  };

  const client = createMockClient({
    createProvider: async (body: any) => {
      createdProviderInput = body;
      return createdProvider;
    },
    listProviders: async () => ({ presets: [...MODEL_PROVIDER_PRESETS], providers: [existingDeepSeekProvider, createdProvider] }),
    updateProvider: async () => {
      updateProviderCalled = true;
      throw new Error("The wizard must never update an existing provider");
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client,
          onProvidersChange: (providers) => {
            providersAfter = providers;
          },
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  // Rename in advanced fields, then connect.
  await act(async () => {
    renderer!.root.findByProps({ className: "secondary-button compact-button" }).props.onClick();
  });
  const nameInput = renderer!.root.findByProps({ id: "wizard-preset-name" });
  await act(async () => {
    nameInput.props.onChange({ target: { value: "工作 DeepSeek" } });
  });
  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-second-key" } });
  });
  await act(async () => {
    await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });

  // A fresh provider is created with the user's own display name and key.
  assert.equal(createdProviderInput?.name, "工作 DeepSeek");
  assert.equal(createdProviderInput?.apiToken, "sk-second-key");
  assert.equal(createdProviderInput?.presetId, "deepseek");
  assert.equal(updateProviderCalled, false);
  // The refreshed list carries both rows.
  assert.equal(providersAfter?.length, 2);
  assert.ok(providersAfter?.some((provider) => provider.id === "existing-provider-deepseek-1"));
  assert.ok(providersAfter?.some((provider) => provider.id === "created-provider-work-deepseek"));

  // Success alert shows for the new connection.
  const successAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-success" });
  assert.match(extractText(successAlert), /模型已连接并保存/);
});

/** Mount the wizard in zh-CN, enter a key, and expand the advanced area. */
async function mountAdvanced(client: SettingsApiClient, props: Record<string, unknown> = {}): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, { client, presets: MODEL_PROVIDER_PRESETS, ...props }),
      ),
    );
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-advanced" } });
  });
  await act(async () => {
    renderer!.root.findByProps({ className: "secondary-button compact-button" }).props.onClick();
  });
  return renderer!;
}

test("advanced manual selection: the fetched list starts fully ticked, unticking a row registers only the rest, and the saved listing is never consulted", async () => {
  let previewBody: any;
  const registered: any[] = [];
  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      registered.push(body);
      return { contextWindow: 64000, id: `profile-${body.model}`, model: body.model, name: body.label || body.model, providerId } as ModelProfile;
    },
    listProviderModels: async () => {
      throw new Error("a hand-picked plan must not read the saved provider's listing");
    },
    previewProviderModels: async (body: any) => {
      previewBody = body;
      return {
        fetchedAt: "2026-09-20T00:00:00.000Z",
        models: [{ id: "listed-model-first", displayName: "First" }, { id: "listed-model-second" }],
        source: "remote" as const,
      };
    },
  });
  const renderer = await mountAdvanced(client);

  // Before any fetch the plan is "everything the provider lists".
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /登记服务商返回的全部模型/);
  const fetchButton = renderer.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" });
  assert.equal(extractText(fetchButton), "获取模型列表");
  await act(async () => {
    await fetchButton.props.onClick();
  });

  // The preview used the draft's own key and preset; every row starts ticked.
  assert.equal(previewBody?.apiToken, "sk-advanced");
  assert.equal(previewBody?.presetId, "deepseek");
  const first = renderer.root.findByProps({ "aria-label": "listed-model-first" });
  const second = renderer.root.findByProps({ "aria-label": "listed-model-second" });
  assert.equal(first.props.checked, true);
  assert.equal(second.props.checked, true);
  assert.equal(renderer.root.findByProps({ "aria-label": "全选" }).props.checked, true);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /登记 2 个模型/);
  assert.equal(extractText(renderer.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" })), "刷新列表");

  // Untick one row: the plan shrinks and select-all is no longer whole.
  await act(async () => {
    second.props.onChange({ target: { checked: false } });
  });
  assert.equal(renderer.root.findByProps({ "aria-label": "全选" }).props.checked, false);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /登记 1 个模型/);

  await act(async () => {
    await renderer.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.deepEqual(registered, [{ model: "listed-model-first" }]);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-alert wizard-alert-success" })), /登记 1 个模型/);
  // The plan belonged to the provider that now exists: the table is gone and
  // the next connect starts from "all listed models" again.
  assert.equal(renderer.root.findAllByProps({ className: "wizard-model-table" }).length, 0);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /登记服务商返回的全部模型/);
});

test("advanced: unticking every listed row is an explicit none — readable error and nothing is created", async () => {
  let createCalled = false;
  const client = createMockClient({
    createProvider: async () => {
      createCalled = true;
      throw new Error("nothing may be created without a model to register");
    },
    previewProviderModels: async () => ({
      fetchedAt: "2026-09-20T00:00:00.000Z",
      models: [{ id: "listed-model-first" }, { id: "listed-model-second" }],
      source: "remote" as const,
    }),
  });
  const renderer = await mountAdvanced(client);
  await act(async () => {
    await renderer.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.onClick();
  });
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "全选" }).props.onChange({ target: { checked: false } });
  });
  assert.equal(renderer.root.findByProps({ "aria-label": "listed-model-first" }).props.checked, false);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /登记 0 个模型/);

  await act(async () => {
    await renderer.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-alert wizard-alert-error" })), /请至少勾选一个列表模型，或手动添加模型/);
  assert.equal(createCalled, false);
});

test("advanced manual entry: a model described by hand is registered with its facts, and the listing is not consulted", async () => {
  const registered: any[] = [];
  let listingCalled = false;
  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      registered.push(body);
      return { contextWindow: 32000, id: `profile-${body.model}`, model: body.model, name: body.label || body.model, providerId } as ModelProfile;
    },
    listProviderModels: async () => {
      listingCalled = true;
      throw new Error("a manual plan must not read the listing");
    },
  });
  const renderer = await mountAdvanced(client);

  await act(async () => {
    renderer.root.findByProps({ className: "provider-add-model-toggle" }).props.onClick();
  });
  const manualForm = renderer.root.findByProps({ className: "provider-manual-form" });
  const inputs = manualForm.findAllByType("input");
  const byPlaceholder = (placeholder: string) => inputs.find((input) => input.props.placeholder === placeholder)!;
  await act(async () => {
    byPlaceholder("服务商文档中的精确 ID").props.onChange({ target: { value: "gateway-model-x" } });
  });
  await act(async () => {
    byPlaceholder("缺省使用模型 ID").props.onChange({ target: { value: "网关模型" } });
  });
  await act(async () => {
    byPlaceholder("1000000").props.onChange({ target: { value: "32000" } });
  });
  await act(async () => {
    byPlaceholder("low,high,max").props.onChange({ target: { value: "high, max" } });
  });
  await act(async () => {
    renderer.root.findByProps({ className: "secondary-button provider-manual-submit" }).props.onClick();
  });

  // The entry waits in the card, marked as manual, until Save & connect.
  const manualList = renderer.root.findByProps({ className: "wizard-manual-list" });
  assert.match(extractText(manualList), /网关模型/);
  assert.match(extractText(manualList), /gateway-model-x/);
  assert.match(extractText(manualList), /手动/);
  assert.equal(renderer.root.findAllByProps({ className: "provider-manual-form" }).length, 0, "the form folds away after adding");
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /登记 1 个模型/);
  assert.deepEqual(registered, []);

  await act(async () => {
    await renderer.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.deepEqual(registered, [{
    facts: { contextWindow: 32000, thinkingEfforts: ["high", "max"] },
    label: "网关模型",
    model: "gateway-model-x",
  }]);
  assert.equal(listingCalled, false);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-alert wizard-alert-success" })), /登记 1 个模型/);
});

test("advanced: a manual entry can be removed again before connecting", async () => {
  const renderer = await mountAdvanced(createMockClient());
  await act(async () => {
    renderer.root.findByProps({ className: "provider-add-model-toggle" }).props.onClick();
  });
  const manualId = renderer.root.findByProps({ className: "provider-manual-form" }).findAllByType("input")
    .find((input) => input.props.placeholder === "服务商文档中的精确 ID")!;
  await act(async () => {
    manualId.props.onChange({ target: { value: "to-be-removed" } });
  });
  await act(async () => {
    renderer.root.findByProps({ className: "secondary-button provider-manual-submit" }).props.onClick();
  });
  assert.equal(renderer.root.findAllByProps({ className: "wizard-manual-item" }).length, 1);
  await act(async () => {
    renderer.root.findByProps({ className: "danger-button compact-button wizard-manual-remove" }).props.onClick();
  });
  assert.equal(renderer.root.findAllByProps({ className: "wizard-manual-item" }).length, 0);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /登记服务商返回的全部模型/);
});

test("advanced: a failed preview is readable, keeps the card usable, and writes nothing", async () => {
  let createCalled = false;
  const client = createMockClient({
    createProvider: async () => {
      createCalled = true;
      throw new Error("a preview must not create anything");
    },
    previewProviderModels: async () => {
      throw new Error("The provider model list request failed with status 403: model-list permission denied");
    },
  });
  const renderer = await mountAdvanced(client);
  await act(async () => {
    await renderer.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.onClick();
  });
  const alert = renderer.root.findByProps({ className: "wizard-alert wizard-alert-error" });
  assert.match(extractText(alert), /无法获取该服务商的模型列表/);
  assert.match(extractText(alert), /model-list permission denied/);
  assert.match(extractText(alert), /手动添加已核对的模型 ID/);
  assert.equal(createCalled, false);
  assert.equal(renderer.root.findAllByProps({ className: "wizard-model-table" }).length, 0);
  assert.equal(extractText(renderer.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" })), "获取模型列表");
  // The card is still the same card: the simple path remains one click away.
  assert.equal(renderer.root.findAllByProps({ className: "model-connect-wizard" }).length, 1);
  assert.equal(renderer.root.findByProps({ className: "primary-button wizard-submit-button" }).props.disabled, false);
});

test("advanced preset fields: protocol and variant overrides drive creation just like the provider editor did", async () => {
  let createdProviderInput: any;
  const client = createMockClient({
    createProvider: async (body: any) => {
      createdProviderInput = body;
      return {
        apiProtocol: body.apiProtocol,
        apiVariant: body.apiVariant,
        baseUrl: body.baseUrl,
        createdAt: "2026-09-20T00:00:00.000Z",
        id: "provider-deepseek-responses",
        modelDiscovery: body.modelDiscovery,
        name: body.name,
        presetId: body.presetId,
        proxyPolicy: body.proxyPolicy ?? "inherit",
        tokenOptional: false,
        updatedAt: "2026-09-20T00:00:00.000Z",
      } as ModelProvider;
    },
  });
  const renderer = await mountAdvanced(client);

  // The preset's own protocol is the starting point…
  const protocolSelect = renderer.root.findByProps({ id: "wizard-api-protocol" });
  assert.equal(protocolSelect.props.value, "openai-chat-completions");
  assert.equal(renderer.root.findByProps({ id: "wizard-api-variant" }).props.value, "deepseek");
  // …and stays editable: switching protocol follows with the protocol default variant.
  await act(async () => {
    protocolSelect.props.onChange({ target: { value: "openai-responses" } });
  });
  assert.equal(renderer.root.findByProps({ id: "wizard-api-variant" }).props.value, "responses");

  await act(async () => {
    await renderer.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.equal(createdProviderInput?.presetId, "deepseek");
  assert.equal(createdProviderInput?.apiProtocol, "openai-responses");
  assert.equal(createdProviderInput?.apiVariant, "responses");
  assert.equal(createdProviderInput?.modelDiscovery, "openai-models");

  // Choosing another provider resets the overrides to that provider's facts.
  await act(async () => {
    renderer.root.findByProps({ id: "wizard-provider-select" }).props.onChange({ target: { value: "anthropic" } });
  });
  assert.equal(renderer.root.findByProps({ id: "wizard-api-protocol" }).props.value, "anthropic-messages");
  assert.equal(renderer.root.findByProps({ id: "wizard-api-variant" }).props.value, "anthropic-adaptive");
});

test("fetch model list lives in the card's main area, reachable without opening advanced", async () => {
  let previewCalled = false;
  const client = createMockClient({
    previewProviderModels: async () => {
      previewCalled = true;
      return {
        fetchedAt: "2026-09-20T00:00:00.000Z",
        models: [{ id: "listed-model-first" }, { id: "listed-model-second" }],
        source: "remote" as const,
      };
    },
  });

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, { client, presets: MODEL_PROVIDER_PRESETS }),
      ),
    );
  });

  // Advanced is closed, yet the fetch button is right there in the main area.
  assert.equal(renderer!.root.findAllByProps({ className: "wizard-advanced" }).length, 0);
  const fetchRow = renderer!.root.findByProps({ className: "wizard-fetch-side" });
  assert.ok(fetchRow);
  const fetchButton = renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-main-area" } });
  });
  await act(async () => {
    await fetchButton.props.onClick();
  });
  assert.equal(previewCalled, true);
  // The fetched table renders in the main area with every row ticked.
  assert.ok(renderer!.root.findByProps({ className: "wizard-model-table" }));
  assert.equal(renderer!.root.findByProps({ "aria-label": "listed-model-first" }).props.checked, true);
  assert.equal(renderer!.root.findAllByProps({ className: "wizard-advanced" }).length, 0);
});
