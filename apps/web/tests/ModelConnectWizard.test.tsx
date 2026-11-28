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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });
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
    previewProviderModels: async () => ({
      fetchedAt: "2026-09-17T00:00:00.000Z",
      models: [{ id: "listed-model-first" }, { id: "listed-model-second" }],
      source: "remote" as const,
    }),
    getGlobalSettings: async () => ({ effective: {}, overrides: {} } as any),
    listProviders: async () => ({ presets: [...MODEL_PROVIDER_PRESETS], providers: [] }),
    replaceGlobalSettings: async () => ({} as any),
    clearGlobalModelIfCurrent: async () => ({ cleared: true }),
    testModel: async () => successResult,
    updateProvider: async (id: string, body: any) => ({
      id,
      name: body.name || "Provider",
    } as ModelProvider),
    ...overrides,
  } as unknown as SettingsApiClient;
}

async function acceptProbeCost(renderer: ReactTestRenderer): Promise<void> {
  const label = renderer.root.findAllByType("label").find(node => /我同意发送一次|I agree to one/.test(extractText(node)));
  assert.ok(label, "Cost disclosure must be reachable before a model request");
  await act(async () => { label.findByType("input").props.onChange({ target: { checked: true } }); });
}

/** The listing is visible by default but starts unselected; "register all
 *  listed models" is an explicit tick. Fetch first when the debounce has not
 *  fired yet, so a test never depends on wall-clock timing. */
async function chooseAllListed(renderer: ReactTestRenderer, locale: "en" | "zh-CN" = "zh-CN"): Promise<void> {
  const fetchButton = renderer.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" });
  await act(async () => { await fetchButton.props.onClick(); });
  const selectAll = renderer.root.findByProps({ "aria-label": locale === "en" ? "Register all listed models" : "登记全部列出的模型" });
  await act(async () => { selectAll.props.onChange({ target: { checked: true } }); });
}

function successNode(renderer: ReactTestRenderer) {
  const node = renderer.root.findAll((candidate) => typeof candidate.props.className === "string"
    && candidate.props.className.includes("wizard-alert-success"))[0];
  assert.ok(node, "success state is rendered");
  return node;
}

test("CFG-R14 manual HTTP lists without an extra checkbox, retains paid consent and preserves a retry", async () => {
  let listings = 0;
  let connects = 0;
  const probes: unknown[][] = [];
  const deleted: string[] = [];
  const client = createMockClient({
    previewProviderModels: async () => { listings++; return { models: [{ id: "fixture" }], source: "remote", fetchedAt: "now" }; },
    createProvider: async (body: any) => { connects++; return { ...body, id: `provider-${connects}` } as ModelProvider; },
    addProviderModel: async (providerId, body) => ({ id: `model-${connects}`, providerId, name: "Fixture", model: body.model, baseUrl: "http://gateway.invalid/v1", apiProtocol: "openai-chat-completions", apiVariant: "openai", updatedAt: `revision-${connects}` } as ModelProfile),
    testModel: async (...args) => { probes.push(args); return connects === 1 ? authFailResult : successResult; },
    deleteModel: async id => { deleted.push(id); return { deleted: id }; },
    deleteProvider: async id => { deleted.push(id); return { deleted: id }; },
  });
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ModelConnectWizard, { client, presets: [] }))); });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-custom-url" }).props.onChange({ target: { value: "http://gateway.invalid/v1" } });
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "synthetic-key" } });
  });
  const submit = () => renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  const preview = () => renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" });
  assert.equal(renderer!.root.findAllByProps({ className: "manual-http-consent" }).length, 0);
  assert.equal(preview().props.disabled, true, "the scheduled preview gates a second fetch");
  await act(async () => { preview().props.onClick(); });
  assert.equal(listings, 1);
  await act(async () => { renderer!.root.findByProps({ "aria-label": "fixture" }).props.onChange({ target: { checked: true } }); });
  assert.equal(submit().props.disabled, true, "Only the existing paid probe consent gates Add provider");
  await act(async () => { submit().props.onClick(); });
  assert.equal(connects, 0);
  await acceptProbeCost(renderer!);
  await act(async () => { submit().props.onClick(); });
  assert.deepEqual(deleted, ["model-1", "provider-1"]);
  assert.equal(renderer!.root.findByProps({ id: "wizard-api-key" }).props.value, "synthetic-key");
  await act(async () => { submit().props.onClick(); });
  assert.equal(probes.length, 2);
  assert.deepEqual(probes[1], ["model-2", false, { baseUrl: "http://gateway.invalid/v1", profileUpdatedAt: "revision-2" }]);
  await act(async () => { successNode(renderer!).findByType("button").props.onClick(); });
  await act(async () => { renderer!.root.findByProps({ id: "wizard-custom-url" }).props.onChange({ target: { value: "http://another.invalid/v1" } }); });
  assert.equal(submit().props.disabled, true);
  await act(async () => renderer!.unmount());
});

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
    previewProviderModels: async () => ({
      fetchedAt: "2026-09-17T00:00:00.000Z",
      models: [{ id: "listed-model-first" }, { id: "deepseek-chat" }],
      source: "remote" as const,
    }),
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

  // Enter API Key and explicitly register the listed models.
  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  await act(async () => {
    keyInput.props.onChange({ target: { value: "sk-deepseek-test-123" } });
  });
  await chooseAllListed(renderer!);

  // Click "添加服务商"
  await acceptProbeCost(renderer!);
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  // Assertions
  assert.equal(createdProviderInput?.presetId, "deepseek");
  assert.equal(createdProviderInput?.apiToken, "sk-deepseek-test-123");
  assert.equal(createdProviderInput?.baseUrl, "https://api.deepseek.com");

  // Every ticked listing entry is registered, and the saved provider's own
  // listing is never read behind the user's selection.
  assert.equal(listingProviderId, undefined);
  assert.deepEqual(registeredModels, ["listed-model-first", "deepseek-chat"]);

  assert.equal(testedModelId, "profile-listed-model-first");
  assert.equal(defaultModelSetId, "profile-listed-model-first");

  // Success ends the form with a Done state that reports the count and the new default.
  const successAlert = successNode(renderer!);
  assert.match(extractText(successAlert), /服务商已添加/);
  assert.match(extractText(successAlert), /登记 2 个模型；listed-model-first 已设为全局默认任务模型/);
  // The pass is a qualified basic check, never an unqualified task-readiness claim.
  assert.match(extractText(successAlert), /不验证完整会话执行路径、思考或工具调用/);
  assert.doesNotMatch(extractText(successAlert), /模型已连接并保存|已成功连接/);
  assert.match(extractText(successAlert), /88 ms/);
});

test("inline connection keeps the global default unset on an empty system", async () => {
  let globalWrites = 0;
  let connectedModelId: string | undefined;
  const registrationScopes: boolean[] = [];
  const client = createMockClient({
    addProviderModel: async (_providerId: string, body: any) => {
      registrationScopes.push(body.setGlobalDefault);
      return { id: `profile-${body.model}`, model: body.model, name: body.model } as ModelProfile;
    },
    replaceGlobalSettings: async () => {
      globalWrites += 1;
      return {} as any;
    },
  });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ModelConnectWizard, {
      client,
      onSuccess: (model) => { connectedModelId = model.id; },
      presets: MODEL_PROVIDER_PRESETS,
      setFirstModelAsGlobalDefault: false,
    })));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "demo-test-key" } });
  });
  await chooseAllListed(renderer!, "en");
  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.ok(connectedModelId);
  assert.equal(globalWrites, 0);
  assert.deepEqual(registrationScopes, [false, false]);
});

test("a failed inline connection does not rewrite global settings", async () => {
  let globalWrites = 0;
  const client = createMockClient({
    replaceGlobalSettings: async () => {
      globalWrites += 1;
      return {} as any;
    },
    testModel: async () => authFailResult,
  });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ModelConnectWizard, {
      client,
      presets: MODEL_PROVIDER_PRESETS,
      setFirstModelAsGlobalDefault: false,
    })));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "bad-key" } });
  });
  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.equal(globalWrites, 0);
  assert.match(JSON.stringify(renderer!.toJSON()), /Authorization|API key|invalid/i);
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
  await chooseAllListed(renderer!);

  await acceptProbeCost(renderer!);
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
  const successAlert = successNode(renderer!);
  assert.match(extractText(successAlert), /登记 2 个模型；全局默认任务模型保持不变/);
});

test("failure flow: rollbacks temporary model and provider on test failure, shows readable error, keeps key input", async () => {
  let deletedModelId: string | undefined;
  let deletedProviderId: string | undefined;
  let defaultModelSetCalled = false;
  const rollbackCalls: string[] = [];

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
      rollbackCalls.push(`delete:${modelId}`);
      deletedModelId = modelId;
      return { deleted: modelId };
    },
    deleteProvider: async (providerId: string) => {
      deletedProviderId = providerId;
      return { deleted: providerId };
    },
    clearGlobalModelIfCurrent: async (modelId: string) => {
      rollbackCalls.push(`clear:${modelId}`);
      return { cleared: true };
    },
    replaceGlobalSettings: async () => {
      throw new Error("failed connections must not restore a stale settings snapshot");
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
  await chooseAllListed(renderer!);

  // Click "添加服务商"
  await acceptProbeCost(renderer!);
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  // Temporary objects rolled back
  assert.equal(deletedModelId, "temp-profile-to-delete");
  assert.equal(deletedProviderId, "temp-provider-to-delete");
  assert.deepEqual(rollbackCalls, ["clear:temp-profile-to-delete", "delete:temp-profile-to-delete"]);

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
  await chooseAllListed(renderer!);

  // Click "添加服务商"
  await acceptProbeCost(renderer!);
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
        baseUrl: "http://localhost:8000/v1", apiProtocol: "openai-chat-completions", apiVariant: "openai", updatedAt: "fixture-v1",
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
  await act(async () => {
    await renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.onClick();
  });

  // Submit
  await acceptProbeCost(renderer!);
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

test("custom provider without a typed id: an explicit model ID is required and is registered alone", async () => {
  const registeredModels: string[] = [];
  let defaultModelSetId: string | undefined;

  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      registeredModels.push(body.model);
      return {
        baseUrl: "http://localhost:8000/v1", apiProtocol: "openai-chat-completions", apiVariant: "openai", updatedAt: "fixture-v1",
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

  // No silent register-all: the typed identifier is the explicit plan.
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-custom-model" }).props.onChange({ target: { value: "custom-manual-model" } });
  });
  await act(async () => {
    await renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.onClick();
  });
  await acceptProbeCost(renderer!);
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  assert.deepEqual(registeredModels, ["custom-manual-model"]);
  assert.equal(defaultModelSetId, "profile-custom-manual-model");

  const successAlert = successNode(renderer!);
  assert.match(extractText(successAlert), /custom-manual-model/);
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
    previewProviderModels: async () => ({
      fetchedAt: "2026-09-17T00:00:00.000Z",
      models: [],
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
  await act(async () => {
    await renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.onClick();
  });

  await acceptProbeCost(renderer!);
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  // Readable error, no provider is created, no model registration, no default change.
  const errorAlert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-error" });
  assert.match(extractText(errorAlert), /没有返回任何模型/);
  assert.equal(deletedProviderId, undefined);
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
    previewProviderModels: async () => {
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
  await act(async () => {
    await renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.onClick();
  });

  await acceptProbeCost(renderer!);
  const submitButton = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  await act(async () => {
    await submitButton.props.onClick();
  });

  const alertText = renderer!.root.findAllByProps({ className: "wizard-alert wizard-alert-error" })
    .map((node) => extractText(node)).join(" ");
  assert.match(alertText, /无法获取该服务商的模型列表/);
  assert.match(alertText, /401/);
  assert.equal(deletedProviderId, undefined);
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
  await acceptProbeCost(renderer!);
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
  assert.equal(extractText(manualBtn), "高级服务商设置");
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
  await chooseAllListed(renderer!);
  await acceptProbeCost(renderer!);
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

  await chooseAllListed(renderer!);
  await acceptProbeCost(renderer!);
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
  await chooseAllListed(renderer!);
  await acceptProbeCost(renderer!);
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

  // Success state shows for the new provider.
  const successAlert = successNode(renderer!);
  assert.match(extractText(successAlert), /服务商已添加/);
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

test("the fetched listing is visible before submit, starts unselected, and select-all is explicit", async () => {
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

  // Nothing is chosen yet: no silent "register everything".
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /尚未选择模型/);
  const fetchButton = renderer.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" });
  assert.match(extractText(fetchButton), /获取模型列表|正在获取模型列表/);
  await act(async () => {
    await fetchButton.props.onClick();
  });

  // The preview used the draft's own key and preset; the rows are visible but unticked.
  assert.equal(previewBody?.apiToken, "sk-advanced");
  assert.equal(previewBody?.presetId, "deepseek");
  const first = renderer.root.findByProps({ "aria-label": "listed-model-first" });
  const second = renderer.root.findByProps({ "aria-label": "listed-model-second" });
  assert.equal(first.props.checked, false);
  assert.equal(second.props.checked, false);
  assert.equal(renderer.root.findByProps({ "aria-label": "登记全部列出的模型" }).props.checked, false);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /尚未选择模型/);
  assert.equal(extractText(renderer.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" })), "刷新模型列表");

  // Register all is an explicit tick; unticking one row shrinks the plan.
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "登记全部列出的模型" }).props.onChange({ target: { checked: true } });
  });
  assert.equal(renderer.root.findByProps({ "aria-label": "listed-model-first" }).props.checked, true);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /登记 2 个模型/);
  await act(async () => {
    second.props.onChange({ target: { checked: false } });
  });
  assert.equal(renderer.root.findByProps({ "aria-label": "登记全部列出的模型" }).props.checked, false);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /登记 1 个模型/);

  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.deepEqual(registered, [{ model: "listed-model-first" }]);
  const success = successNode(renderer);
  assert.match(extractText(success), /登记 1 个模型/);
  // The flow is over: the form and submit are gone, and Done can start fresh.
  assert.equal(renderer.root.findAllByProps({ className: "primary-button wizard-submit-button" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ className: "wizard-model-table" }).length, 0);
  const again = success.findByType("button");
  assert.equal(extractText(again), "再添加一个服务商");
  await act(async () => { again.props.onClick(); });
  assert.equal(renderer.root.findByProps({ id: "wizard-api-key" }).props.value, "");
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /尚未选择模型/);
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
    renderer.root.findByProps({ "aria-label": "登记全部列出的模型" }).props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "登记全部列出的模型" }).props.onChange({ target: { checked: false } });
  });
  assert.equal(renderer.root.findByProps({ "aria-label": "listed-model-first" }).props.checked, false);
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /尚未选择模型/);

  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-alert wizard-alert-error" })), /请至少勾选一个列出的模型，或填写模型 ID/);
  assert.equal(createCalled, false);
});

test("a typed model ID is the explicit fallback for a listing that cannot return it", async () => {
  const registered: any[] = [];
  let listingCalled = false;
  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      registered.push(body);
      return { contextWindow: 32000, id: `profile-${body.model}`, model: body.model, name: body.label || body.model, providerId } as ModelProfile;
    },
    listProviderModels: async () => {
      listingCalled = true;
      throw new Error("a typed plan must not read the listing");
    },
    previewProviderModels: async () => ({
      fetchedAt: "2026-09-20T00:00:00.000Z",
      models: [],
      source: "remote" as const,
    }),
  });
  const renderer = await mountAdvanced(client);
  await act(async () => {
    await renderer.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.onClick();
  });

  await act(async () => {
    renderer.root.findByProps({ id: "wizard-manual-model" }).props.onChange({ target: { value: "gateway-model-x" } });
  });
  assert.match(extractText(renderer.root.findByProps({ className: "wizard-plan-summary" })), /登记 1 个模型/);
  assert.deepEqual(registered, []);

  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.deepEqual(registered, [{ model: "gateway-model-x" }]);
  assert.equal(listingCalled, false);
  assert.match(extractText(successNode(renderer)), /登记 1 个模型/);
});

test("success clears the form and Done offers Add another provider instead of a second submit", async () => {
  let creates = 0;
  const client = createMockClient({
    createProvider: async (body: any) => {
      creates += 1;
      return { ...existingDeepSeekProvider, id: `created-${creates}`, name: body.name } as ModelProvider;
    },
  });
  const renderer = await mountAdvanced(client);
  await act(async () => {
    await renderer.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.onClick();
  });
  await act(async () => {
    renderer.root.findByProps({ id: "wizard-manual-model" }).props.onChange({ target: { value: "one-model" } });
  });
  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });

  const done = successNode(renderer);
  assert.match(extractText(done), /服务商已添加/);
  assert.equal(renderer.root.findAllByProps({ className: "primary-button wizard-submit-button" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ id: "wizard-api-key" }).length, 0);
  await act(async () => { done.findByType("button").props.onClick(); });
  assert.equal(renderer.root.findByProps({ id: "wizard-api-key" }).props.value, "");
  assert.equal(creates, 1);
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
  await acceptProbeCost(renderer!);
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

  await chooseAllListed(renderer);
  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.equal(createdProviderInput?.presetId, "deepseek");
  assert.equal(createdProviderInput?.apiProtocol, "openai-responses");
  assert.equal(createdProviderInput?.apiVariant, "responses");
  assert.equal(createdProviderInput?.modelDiscovery, "openai-models");

  // Choosing another provider resets the overrides to that provider's facts.
  await act(async () => {
    successNode(renderer).findByType("button").props.onClick();
  });
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
  // The fetched table renders in the main area; selecting is an explicit tick.
  assert.ok(renderer!.root.findByProps({ className: "wizard-model-table" }));
  assert.equal(renderer!.root.findByProps({ "aria-label": "listed-model-first" }).props.checked, false);
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "登记全部列出的模型" }).props.onChange({ target: { checked: true } });
  });
  assert.equal(renderer!.root.findByProps({ "aria-label": "listed-model-first" }).props.checked, true);
  assert.equal(renderer!.root.findAllByProps({ className: "wizard-advanced" }).length, 0);
});

function renderWizard(presets: readonly (typeof MODEL_PROVIDER_PRESETS)[number][]) {
  const client = createMockClient();
  const element = (next: typeof presets) => createElement(
    LocaleProvider,
    { initialLocale: "zh-CN" },
    createElement(ModelConnectWizard, { client, presets: next }),
  );
  return { client, element };
}

function hasCustomFields(renderer: ReactTestRenderer): boolean {
  return renderer.root.findAll((node) => node.props.id === "wizard-custom-url").length > 0;
}

test("no presets offered: the card is in custom mode, so the select and the fields agree", async () => {
  const { element } = renderWizard([]);
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(element([]));
  });

  const select = renderer!.root.findByProps({ id: "wizard-provider-select" });
  assert.deepEqual(select.findAllByType("option").map((option) => option.props.value), ["custom"]);
  assert.equal(select.props.value, "custom");
  assert.equal(hasCustomFields(renderer!), true);
});

test("presets arriving after an empty list replace the automatic custom mode with the first preset", async () => {
  const { element } = renderWizard([]);
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(element([]));
  });
  await act(async () => {
    renderer!.update(element(MODEL_PROVIDER_PRESETS));
  });

  assert.equal(renderer!.root.findByProps({ id: "wizard-provider-select" }).props.value, MODEL_PROVIDER_PRESETS[0]!.id);
  assert.equal(hasCustomFields(renderer!), false);
});

test("presets arriving late keep the custom fields the user already started filling", async () => {
  const { element } = renderWizard([]);
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(element([]));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-custom-url" }).props.onChange({ target: { value: "http://localhost:8000/v1" } });
  });
  await act(async () => {
    renderer!.update(element(MODEL_PROVIDER_PRESETS));
  });

  assert.equal(renderer!.root.findByProps({ id: "wizard-provider-select" }).props.value, "custom");
  assert.equal(renderer!.root.findByProps({ id: "wizard-custom-url" }).props.value, "http://localhost:8000/v1");
});

test("a custom provider picked by the user survives a refreshed preset list", async () => {
  const { element } = renderWizard(MODEL_PROVIDER_PRESETS);
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(element(MODEL_PROVIDER_PRESETS));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-provider-select" }).props.onChange({ target: { value: "custom" } });
  });
  await act(async () => {
    renderer!.update(element([...MODEL_PROVIDER_PRESETS]));
  });

  assert.equal(renderer!.root.findByProps({ id: "wizard-provider-select" }).props.value, "custom");
  assert.equal(hasCustomFields(renderer!), true);
});

test("a selected preset that disappears from the list falls back to the first preset still offered", async () => {
  const [first, second] = MODEL_PROVIDER_PRESETS;
  const { element } = renderWizard(MODEL_PROVIDER_PRESETS);
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(element(MODEL_PROVIDER_PRESETS));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-provider-select" }).props.onChange({ target: { value: second!.id } });
  });
  await act(async () => {
    renderer!.update(element([first!]));
  });

  assert.equal(renderer!.root.findByProps({ id: "wizard-provider-select" }).props.value, first!.id);
  assert.equal(hasCustomFields(renderer!), false);
});

test("clearing a custom name the user already typed does not yield automatic custom mode when presets arrive", async () => {
  const { element } = renderWizard([]);
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(element([]));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-custom-name" }).props.onChange({ target: { value: "本地网关" } });
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-custom-name" }).props.onChange({ target: { value: "" } });
  });
  await act(async () => {
    renderer!.update(element(MODEL_PROVIDER_PRESETS));
  });

  assert.equal(renderer!.root.findByProps({ id: "wizard-provider-select" }).props.value, "custom");
  assert.equal(hasCustomFields(renderer!), true);
  assert.equal(renderer!.root.findByProps({ id: "wizard-custom-name" }).props.value, "");
});

test("an API key entered before presets arrive keeps automatic custom mode and the key", async () => {
  const { element } = renderWizard([]);
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(element([]));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-kept" } });
  });
  await act(async () => {
    renderer!.update(element(MODEL_PROVIDER_PRESETS));
  });

  assert.equal(renderer!.root.findByProps({ id: "wizard-provider-select" }).props.value, "custom");
  assert.equal(hasCustomFields(renderer!), true);
  assert.equal(renderer!.root.findByProps({ id: "wizard-api-key" }).props.value, "sk-kept");
});

test("a failed settings read after the probe rolls back the created provider and model", async () => {
  let replaceCalls = 0;
  let createCalls = 0;
  const rollbackCalls: string[] = [];
  const errors: unknown[] = [];
  const client = createMockClient({
    createProvider: async (body: any) => {
      createCalls += 1;
      return {
        apiProtocol: body.apiProtocol,
        apiVariant: body.apiVariant,
        baseUrl: body.baseUrl,
        createdAt: "2026-09-17T00:00:00.000Z",
        id: "settings-read-provider",
        modelDiscovery: body.modelDiscovery,
        name: body.name,
        presetId: body.presetId,
        proxyPolicy: "inherit",
        tokenOptional: false,
        updatedAt: "2026-09-17T00:00:00.000Z",
      } as ModelProvider;
    },
    clearGlobalModelIfCurrent: async (modelId: string) => {
      rollbackCalls.push(`clear:${modelId}`);
      return { cleared: true };
    },
    deleteModel: async (modelId: string) => {
      rollbackCalls.push(`delete:${modelId}`);
      return { deleted: modelId };
    },
    deleteProvider: async (providerId: string) => {
      rollbackCalls.push(`provider:${providerId}`);
      return { deleted: providerId };
    },
    getGlobalSettings: async () => { throw new Error("settings 500"); },
    replaceGlobalSettings: async () => {
      replaceCalls += 1;
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
          onError: (reason) => { errors.push(reason); },
          presets: MODEL_PROVIDER_PRESETS,
        }),
      ),
    );
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-invalid-key" } });
  });
  await chooseAllListed(renderer!);
  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });

  assert.equal(createCalls, 1);
  assert.equal(replaceCalls, 0);
  assert.deepEqual(rollbackCalls, [
    "clear:profile-settings-read-provider-listed-model-first",
    "clear:profile-settings-read-provider-listed-model-second",
    "delete:profile-settings-read-provider-listed-model-first",
    "delete:profile-settings-read-provider-listed-model-second",
    "provider:settings-read-provider",
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0] instanceof Error ? errors[0].message : errors[0], "settings 500");
  const alert = renderer!.root.findByProps({ className: "wizard-alert wizard-alert-error" });
  assert.match(extractText(alert), /settings 500/);
});

test("the first model merges into the settings read at save time when no callback is passed", async () => {
  const writes: unknown[] = [];
  const client = createMockClient({
    getGlobalSettings: async () => ({
      effective: {},
      overrides: { enabledConnectorIds: [], semanticReviewEnabled: true, thinkingEffort: "high" },
    } as any),
    replaceGlobalSettings: async (body: unknown) => {
      writes.push(body);
      return { effective: {}, overrides: body } as any;
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
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-deepseek-test-123" } });
  });
  await chooseAllListed(renderer!);
  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });

  assert.deepEqual(writes, [{
    enabledConnectorIds: [],
    modelId: "profile-created-provider-1-listed-model-first",
    semanticReviewEnabled: true,
    thinkingEffort: "high",
  }]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const kind of ['valid', 'auth', 'empty'] as const) test(`${locale} mounted wizard setup result ${kind} is honest and preserves rollback`, async () => {
  const deleted: string[] = []; let saved = false, probes = 0, renderer: ReactTestRenderer;
  const outcome: ModelConnectivityTestResult = kind === 'valid' ? successResult
    : { ...successResult, ok: false, category: 'invalid_response' };
  const client = createMockClient({ testModel: async () => { probes++; return outcome; }, deleteModel: async id => { deleted.push('model'); return { deleted: id }; }, deleteProvider: async id => { deleted.push('provider'); return { deleted: id }; } });
  await act(async () => { renderer = create(createElement(LocaleProvider, { initialLocale: locale }, createElement(ModelConnectWizard, { client, presets: MODEL_PROVIDER_PRESETS, onSuccess: () => { saved = true; } }))); });
  try {
    await act(async () => { renderer!.root.findByProps({ id: 'wizard-api-key' }).props.onChange({ target: { value: 'synthetic' } }); });
    assert.equal(probes, 0); await chooseAllListed(renderer!, locale); await acceptProbeCost(renderer!);
    await act(async () => { renderer!.root.findByProps({ className: 'primary-button wizard-submit-button' }).props.onClick(); const end = Date.now()+2000; while (!saved && deleted.length < 2 && Date.now()<end) await new Promise(r => setTimeout(r,10)); });
    assert.equal(probes, 1);
    if (kind === 'auth' || kind === 'empty') { assert.equal(saved, false); assert.deepEqual(deleted, ['model','provider']); }
    else {
      assert.equal(saved, true); assert.deepEqual(deleted, []);
      const rendered = extractText(renderer!.toJSON());
      // A pass is announced as the qualified basic check it is, not as proof
      // the model can run tasks (issue #824).
      assert.match(rendered, locale === 'en' ? /Provider added/ : /服务商已添加/);
      assert.match(rendered, locale === 'en' ? /does not verify the full session run path/ : /不验证完整会话执行路径/);
      assert.doesNotMatch(rendered, /Connected —|已成功连接/);
    }
  } finally { await act(async () => renderer!.unmount()); }
});

test("the wizard states before submit that the first model becomes the global default when none exists", async () => {
  let enRenderer: ReactTestRenderer;
  await act(async () => {
    enRenderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ModelConnectWizard, {
      client: createMockClient(),
      presets: MODEL_PROVIDER_PRESETS,
    })));
  });
  assert.match(extractText(enRenderer!.root), /first one becomes the global default task model/);

  let zhRenderer: ReactTestRenderer;
  await act(async () => {
    zhRenderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ModelConnectWizard, {
      client: createMockClient(),
      presets: MODEL_PROVIDER_PRESETS,
    })));
  });
  assert.match(extractText(zhRenderer!.root), /第一个登记的模型会成为全局默认任务模型/);
});

test("a pending preview disables fetch and submit but still offers the manual model ID fallback", async () => {
  let resolvePreview!: (value: { fetchedAt: string; models: { id: string }[]; source: "remote" }) => void;
  const pending = new Promise<{ fetchedAt: string; models: { id: string }[]; source: "remote" }>((resolve) => {
    resolvePreview = resolve;
  });
  const client = createMockClient({ previewProviderModels: async () => pending });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ModelConnectWizard, {
      client,
      presets: MODEL_PROVIDER_PRESETS,
    })));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-pending" } });
  });
  await acceptProbeCost(renderer!);
  // Wait past the debounce so the preview is genuinely in flight.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });

  const fetchButton = renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" });
  const submit = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  assert.equal(fetchButton.props.disabled, true);
  assert.equal(submit.props.disabled, true);
  assert.ok(renderer!.root.findByProps({ id: "wizard-manual-model" }), "the typed-ID fallback is visible before the listing arrives");

  // Editing must not freeze while the debounced listing is in flight.
  const keyInput = renderer!.root.findByProps({ id: "wizard-api-key" });
  assert.equal(keyInput.props.disabled, false);
  await act(async () => { keyInput.props.onChange({ target: { value: "sk-pending-more" } }); });
  assert.equal(renderer!.root.findByProps({ id: "wizard-api-key" }).props.value, "sk-pending-more");

  // The older request belongs to the older key; landing it must neither apply
  // its listing nor clear the gate for the newer inputs.
  await act(async () => {
    resolvePreview({ fetchedAt: "2026-09-20T00:00:00.000Z", models: [{ id: "stale-listing" }], source: "remote" });
    await pending;
  });
  assert.equal(extractText(renderer!.root).includes("stale-listing"), false);
  assert.equal(renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.disabled, true);

  // The request scheduled for the new key now runs (same resolved fixture).
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.disabled) break;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  }
  const settledFetch = renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" });
  assert.equal(settledFetch.props.disabled, false);
  await acceptProbeCost(renderer!);
  const settledSubmit = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  assert.equal(settledSubmit.props.disabled, false);
  assert.match(extractText(renderer!.root), /stale-listing/);
});

test("same-name provider confirmation declines without writing and accepts exactly one create", async () => {
  const previousWindow = globalThis.window;
  const confirmations: string[] = [];
  let answer = false;
  globalThis.window = {
    confirm: (message: string) => { confirmations.push(message); return answer; },
  } as unknown as Window & typeof globalThis;
  try {
    let creates = 0;
    const client = createMockClient({
      createProvider: async (body: any) => {
        creates += 1;
        return { ...existingDeepSeekProvider, id: "created-duplicate-check", name: body.name } as ModelProvider;
      },
    });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ModelConnectWizard, {
        client,
        presets: MODEL_PROVIDER_PRESETS,
        providers: [existingDeepSeekProvider],
      })));
    });
    await act(async () => {
      renderer!.root.findByProps({ id: "wizard-provider-select" }).props.onChange({ target: { value: "custom" } });
    });
    await act(async () => {
      renderer!.root.findByProps({ id: "wizard-custom-name" }).props.onChange({ target: { value: "DeepSeek" } });
      renderer!.root.findByProps({ id: "wizard-custom-url" }).props.onChange({ target: { value: "http://127.0.0.1:1/v1" } });
      renderer!.root.findByProps({ id: "wizard-custom-model" }).props.onChange({ target: { value: "dup-model" } });
      renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-duplicate" } });
    });
    // Let the scheduled preview settle; the typed ID is the plan.
    await act(async () => {
      await renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.onClick();
    });
    await acceptProbeCost(renderer!);

    await act(async () => {
      await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
    });
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0]!, /DeepSeek/);
    assert.equal(creates, 0, "declining the same-name warning writes nothing");

    answer = true;
    await act(async () => {
      await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
    });
    assert.equal(confirmations.length, 2);
    assert.equal(creates, 1, "accepting the warning creates exactly one provider");
  } finally {
    globalThis.window = previousWindow;
  }
});

test("a complete typed plan submits through a hanging preview and Done does not schedule another fetch", async () => {
  let previewCalls = 0;
  let creates = 0;
  const hanging = new Promise<never>(() => undefined);
  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => ({
      apiProtocol: "openai-chat-completions",
      apiVariant: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      id: `profile-${body.model}`,
      model: body.model,
      name: body.model,
      providerId,
      updatedAt: "revision-typed",
    } as ModelProfile),
    createProvider: async (body: any) => {
      creates += 1;
      return { ...existingDeepSeekProvider, id: "typed-provider", name: body.name } as ModelProvider;
    },
    previewProviderModels: async () => { previewCalls += 1; return hanging; },
  });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ModelConnectWizard, {
      client,
      presets: MODEL_PROVIDER_PRESETS,
    })));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-provider-select" }).props.onChange({ target: { value: "custom" } });
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-custom-name" }).props.onChange({ target: { value: "Typed provider" } });
    renderer!.root.findByProps({ id: "wizard-custom-url" }).props.onChange({ target: { value: "http://127.0.0.1:1/v1" } });
    renderer!.root.findByProps({ id: "wizard-custom-model" }).props.onChange({ target: { value: "typed-model" } });
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-typed" } });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });

  // The hanging preview gates the fetch action but not the editable fields or
  // the complete typed plan.
  assert.equal(renderer!.root.findByProps({ id: "wizard-provider-select" }).props.disabled, false);
  assert.equal(renderer!.root.findByProps({ id: "wizard-custom-name" }).props.disabled, false);
  assert.equal(renderer!.root.findByProps({ id: "wizard-custom-url" }).props.disabled, false);
  assert.equal(renderer!.root.findByProps({ id: "wizard-custom-model" }).props.disabled, false);
  assert.equal(renderer!.root.findByProps({ id: "wizard-api-key" }).props.disabled, false);
  assert.equal(renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.disabled, true);
  await acceptProbeCost(renderer!);
  const submit = renderer!.root.findByProps({ className: "primary-button wizard-submit-button" });
  assert.equal(submit.props.disabled, false);
  await act(async () => { await submit.props.onClick(); });

  assert.equal(creates, 1);
  assert.equal(previewCalls, 1);
  assert.match(extractText(successNode(renderer!)), /Provider added/);

  // Done must not schedule a preview behind Add another provider.
  await act(async () => { successNode(renderer!).findByType("button").props.onClick(); });
  assert.equal(renderer!.root.findByProps({ className: "secondary-button compact-button wizard-fetch-models" }).props.disabled, false);
  assert.equal(previewCalls, 1);
});

test("an endpoint change clears old ticks and a failed new preview cannot register them", async () => {
  let previewCalls = 0;
  let creates = 0;
  const client = createMockClient({
    createProvider: async (body: any) => {
      creates += 1;
      return { ...existingDeepSeekProvider, id: "endpoint-provider", name: body.name } as ModelProvider;
    },
    previewProviderModels: async () => {
      previewCalls += 1;
      if (previewCalls === 1) {
        return { fetchedAt: "2026-09-20T00:00:00.000Z", models: [{ id: "old-endpoint-model" }], source: "remote" as const };
      }
      throw new Error("new endpoint listing failed");
    },
  });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ModelConnectWizard, {
      client,
      presets: MODEL_PROVIDER_PRESETS,
    })));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-endpoint" } });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
  const oldModel = renderer!.root.findByProps({ "aria-label": "old-endpoint-model" });
  await act(async () => { oldModel.props.onChange({ target: { checked: true } }); });
  assert.match(extractText(renderer!.root.findByProps({ className: "wizard-plan-summary" })), /1 model/);

  await act(async () => {
    renderer!.root.findAllByType("button").find((button) => extractText(button) === "Advanced provider settings")!.props.onClick();
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-base-url-override" }).props.onChange({ target: { value: "https://new.example.test/v1" } });
  });
  assert.equal(renderer!.root.findAllByProps({ "aria-label": "old-endpoint-model" }).length, 0, "old ticks disappear with the endpoint");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
  assert.match(extractText(renderer!.root), /new endpoint listing failed/);
  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.equal(creates, 0, "the failed new endpoint cannot submit the old listing");
  assert.equal(previewCalls, 2);
});

test("API-key edits keep the same-endpoint listing and ticks while the refresh is pending", async () => {
  let previewCalls = 0;
  const client = createMockClient({
    previewProviderModels: async () => {
      previewCalls += 1;
      return { fetchedAt: "2026-09-20T00:00:00.000Z", models: [{ id: "same-endpoint-model" }], source: "remote" as const };
    },
  });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ModelConnectWizard, {
      client,
      presets: MODEL_PROVIDER_PRESETS,
    })));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-same" } });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "same-endpoint-model" }).props.onChange({ target: { checked: true } });
  });

  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-same-updated" } });
  });
  // The refresh is now pending, but the same endpoint's listing and tick stay.
  assert.equal(renderer!.root.findByProps({ "aria-label": "same-endpoint-model" }).props.checked, true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
  assert.equal(renderer!.root.findByProps({ "aria-label": "same-endpoint-model" }).props.checked, true);
  assert.equal(previewCalls, 2);
});

test("editing a custom provider name keeps the settled listing and tick", async () => {
  let previewCalls = 0;
  let creates = 0;
  const registered: string[] = [];
  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      registered.push(body.model);
      return {
        apiProtocol: "openai-chat-completions",
        apiVariant: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        id: "profile-custom-listed",
        model: body.model,
        name: body.model,
        providerId,
        updatedAt: "revision-custom-name",
      } as ModelProfile;
    },
    createProvider: async (body: any) => {
      creates += 1;
      return { ...existingDeepSeekProvider, id: "renamed-provider", name: body.name } as ModelProvider;
    },
    previewProviderModels: async () => {
      previewCalls += 1;
      return { fetchedAt: "2026-09-20T00:00:00.000Z", models: [{ id: "custom-listed" }], source: "remote" as const };
    },
  });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ModelConnectWizard, {
      client,
      presets: MODEL_PROVIDER_PRESETS,
    })));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-provider-select" }).props.onChange({ target: { value: "custom" } });
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-custom-name" }).props.onChange({ target: { value: "Custom before rename" } });
    renderer!.root.findByProps({ id: "wizard-custom-url" }).props.onChange({ target: { value: "http://127.0.0.1:1/v1" } });
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-custom-name" } });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "custom-listed" }).props.onChange({ target: { checked: true } });
  });
  assert.equal(previewCalls, 1);

  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-custom-name" }).props.onChange({ target: { value: "Renamed provider" } });
  });
  // The name is not an endpoint attribute: the old listing and tick survive
  // and no refetch is scheduled.
  assert.equal(renderer!.root.findByProps({ "aria-label": "custom-listed" }).props.checked, true);
  assert.equal(previewCalls, 1);
  assert.match(extractText(renderer!.root.findByProps({ className: "wizard-plan-summary" })), /1 model/);

  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.equal(creates, 1);
  assert.deepEqual(registered, ["custom-listed"]);
  assert.match(extractText(successNode(renderer!)), /Provider added/);
});

test("after a preview failure a typed model ID creates one provider with that model", async () => {
  let creates = 0;
  const registered: string[] = [];
  const client = createMockClient({
    addProviderModel: async (providerId: string, body: any) => {
      registered.push(body.model);
      return {
        apiProtocol: "openai-chat-completions",
        apiVariant: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        id: "profile-typed-fallback",
        model: body.model,
        name: body.model,
        providerId,
        updatedAt: "revision-typed-fallback",
      } as ModelProfile;
    },
    createProvider: async (body: any) => {
      creates += 1;
      return { ...existingDeepSeekProvider, id: "fallback-provider", name: body.name } as ModelProvider;
    },
    previewProviderModels: async () => { throw new Error("listing unavailable"); },
  });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ModelConnectWizard, {
      client,
      presets: MODEL_PROVIDER_PRESETS,
    })));
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-provider-select" }).props.onChange({ target: { value: "custom" } });
  });
  await act(async () => {
    renderer!.root.findByProps({ id: "wizard-custom-name" }).props.onChange({ target: { value: "Fallback provider" } });
    renderer!.root.findByProps({ id: "wizard-custom-url" }).props.onChange({ target: { value: "http://127.0.0.1:1/v1" } });
    renderer!.root.findByProps({ id: "wizard-custom-model" }).props.onChange({ target: { value: "typed-after-failure" } });
    renderer!.root.findByProps({ id: "wizard-api-key" }).props.onChange({ target: { value: "sk-fallback" } });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
  assert.match(extractText(renderer!.root), /listing unavailable/);

  await acceptProbeCost(renderer!);
  await act(async () => {
    await renderer!.root.findByProps({ className: "primary-button wizard-submit-button" }).props.onClick();
  });
  assert.equal(creates, 1);
  assert.deepEqual(registered, ["typed-after-failure"]);
  assert.match(extractText(successNode(renderer!)), /Registered 1 model/);
});
