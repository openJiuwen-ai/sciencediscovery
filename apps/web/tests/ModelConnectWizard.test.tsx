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
          existingModels: [],
          existingProviders: [],
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
          existingModels: [],
          existingProviders: [],
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

test("successful flow: creates provider, registers the first listed model, tests connectivity, and sets global default model", async () => {
  let createdProviderInput: any;
  let addedModelInput: any;
  let testedModelId: string | undefined;
  let defaultModelSetId: string | undefined;
  let listingProviderId: string | undefined;

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      addedModelInput = { providerId, ...body };
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
          existingModels: [],
          existingProviders: [],
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

  // The provider's own listing was consulted, and its first entry wins —
  // not any preset recommendation (deepseek-chat sits second on purpose).
  assert.equal(listingProviderId, "provider-deepseek-1");
  assert.equal(addedModelInput?.providerId, "provider-deepseek-1");
  assert.equal(addedModelInput?.model, "listed-model-first");

  assert.equal(testedModelId, "profile-listed-model-first");
  assert.equal(defaultModelSetId, "profile-listed-model-first");

  // Success alert is visible
  const successAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-success" });
  assert.match(extractText(successAlert), /模型已连接并保存/);
  assert.match(extractText(successAlert), /已成功连接 listed-model-first 并设为全局默认任务模型/);
  assert.match(extractText(successAlert), /88 ms/);
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
          existingModels: [],
          existingProviders: [],
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

test("existing provider with bad key: does NOT update existing provider's token, deletes temp objects, keeps input and default model", async () => {
  let updateProviderCalled = false;
  let deletedModelId: string | undefined;
  let deletedProviderId: string | undefined;
  let defaultModelSetCalled = false;

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

  const existingDeepSeekModel: ModelProfile = {
    contextWindow: 64000,
    id: "existing-profile-deepseek-chat",
    model: "deepseek-chat",
    name: "DeepSeek-V3",
    providerId: "existing-provider-deepseek-1",
  };

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
    testModel: async () => authFailResult,
    updateProvider: async () => {
      updateProviderCalled = true;
      throw new Error("Should not update existing provider when test fails!");
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
          existingModels: [existingDeepSeekModel],
          existingProviders: [existingDeepSeekProvider],
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

  // Existing provider's token must NOT be updated!
  assert.equal(updateProviderCalled, false);

  // Temporary objects must be cleaned up
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
          existingModels: [],
          existingProviders: [],
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

test("custom provider without model id: falls back to the first listed model", async () => {
  let addedModelInput: any;
  let defaultModelSetId: string | undefined;

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      addedModelInput = { providerId, ...body };
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
          existingModels: [],
          existingProviders: [],
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

  assert.equal(addedModelInput?.model, "listed-model-first");
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
          existingModels: [],
          existingProviders: [],
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
          existingModels: [],
          existingProviders: [],
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
          existingModels: [],
          existingProviders: [],
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
          existingModels: [],
          existingProviders: [],
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
          existingModels: [],
          existingProviders: [],
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
  let addedModelInput: any;

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      addedModelInput = { providerId, ...body };
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
          existingModels: [],
          existingProviders: [],
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
  // No explicit model identifier: the first listed model is registered.
  assert.equal(addedModelInput?.model, "listed-model-first");
});

test("advanced area with an existing matching provider shows the reuse note instead of fields", async () => {
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

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConnectWizard, {
          client: createMockClient(),
          existingModels: [],
          existingProviders: [existingDeepSeekProvider],
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });

  await act(async () => {
    renderer!.root.findByProps({ className: "secondary-button compact-button" }).props.onClick();
  });

  const note = renderer!.root.findByProps({ className: "wizard-advanced-note" });
  assert.match(extractText(note), /已在下方列表中/);
  // No creation-time fields: the existing provider's endpoint wins.
  assert.equal(renderer!.root.findAllByProps({ id: "wizard-base-url-override" }).length, 0);
});
