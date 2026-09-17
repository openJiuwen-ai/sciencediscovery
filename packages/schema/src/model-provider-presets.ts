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

import type { ModelProviderPreset, ModelProviderPresetId } from "./model-provider.js";

/**
 * Built-in provider presets. Every endpoint fact is read from the vendor's
 * official documentation (`docsUrl`); presets carry no secrets and users can
 * still edit the base URL after creating a provider from one (self-hosted
 * gateways, regional endpoints, test stubs).
 *
 * The list is ordered as presented in the UI.
 */
export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "deepseek",
    baseUrl: "https://api.deepseek.com",
    docsUrl: "https://api-docs.deepseek.com/",
    id: "deepseek",
    keyUrl: "https://platform.deepseek.com/api_keys",
    modelDiscovery: "openai-models",
    name: "DeepSeek",
  },
  {
    // K2.5/K2.6 use the DeepSeek-style thinking toggle. K3 is materialized
    // with its model-specific always-reasoning `kimi-k3` variant.
    apiProtocol: "openai-chat-completions",
    apiVariant: "deepseek",
    baseUrl: "https://api.moonshot.cn/v1",
    docsUrl: "https://platform.kimi.com/docs/api/chat",
    id: "moonshot",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    modelDiscovery: "openai-models",
    name: "Moonshot Kimi",
  },
  {
    // GLM also uses `thinking.type` + `reasoning_content`. Both bigmodel.cn
    // paths answer `GET /models` with 401 rather than 404, so the route exists
    // and only wants a key: the list comes from the vendor like everywhere
    // else. An earlier comment here claimed no listing endpoint existed, which
    // left GLM users seeing only whatever the catalog happened to know.
    apiProtocol: "openai-chat-completions",
    apiVariant: "deepseek",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction.md",
    id: "zhipu",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    modelDiscovery: "openai-models",
    name: "智谱 GLM",
  },
  {
    // The same GLM models on Zhipu's international host. It is a separate
    // provider rather than a base-URL edit of the one above because the two
    // hosts bill separately and take different keys, so a user has to be able
    // to configure and price them independently.
    apiProtocol: "openai-chat-completions",
    apiVariant: "deepseek",
    baseUrl: "https://api.z.ai/api/paas/v4",
    docsUrl: "https://docs.z.ai/api-reference/llm/chat-completion",
    id: "zai",
    keyUrl: "https://z.ai",
    // Same as bigmodel.cn: `GET /models` answers 401, so the route is there.
    modelDiscovery: "openai-models",
    name: "Z.AI",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "minimax",
    baseUrl: "https://api.minimaxi.com/v1",
    docsUrl: "https://platform.minimaxi.com/docs/api-reference/text-openai-api",
    id: "minimax",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    modelDiscovery: "openai-models",
    name: "MiniMax",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docsUrl: "https://help.aliyun.com/en/model-studio/base-url",
    id: "dashscope",
    keyUrl: "https://bailian.console.aliyun.com/",
    modelDiscovery: "openai-models",
    name: "Alibaba Cloud Model Studio",
  },
  {
    apiProtocol: "openai-responses",
    apiVariant: "responses",
    baseUrl: "https://api.openai.com/v1",
    docsUrl: "https://developers.openai.com/api/docs/api-reference/introduction",
    id: "openai",
    keyUrl: "https://platform.openai.com/api-keys",
    modelDiscovery: "openai-models",
    name: "OpenAI",
  },
  {
    apiProtocol: "anthropic-messages",
    apiVariant: "anthropic-adaptive",
    baseUrl: "https://api.anthropic.com",
    docsUrl: "https://platform.claude.com/docs/en/api/overview.md",
    id: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    modelDiscovery: "anthropic-models",
    name: "Anthropic",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    id: "gemini",
    keyUrl: "https://aistudio.google.com/app/apikey",
    modelDiscovery: "openai-models",
    name: "Google Gemini",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    docsUrl: "https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions",
    id: "siliconflow",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    modelDiscovery: "openai-models",
    name: "SiliconFlow",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    docsUrl: "https://openrouter.ai/docs/quickstart",
    id: "openrouter",
    keyUrl: "https://openrouter.ai/keys",
    modelDiscovery: "openai-models",
    name: "OpenRouter",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "ollama",
    baseUrl: "http://localhost:11434/v1",
    docsUrl: "https://docs.ollama.com/openai",
    id: "ollama",
    keyUrl: "https://ollama.com",
    modelDiscovery: "openai-models",
    name: "Ollama",
    tokenOptional: true,
  },
];

export function getModelProviderPreset(id: string): ModelProviderPreset | undefined {
  return MODEL_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function isModelProviderPresetId(value: unknown): value is ModelProviderPresetId {
  return typeof value === "string" && MODEL_PROVIDER_PRESETS.some((preset) => preset.id === value);
}
