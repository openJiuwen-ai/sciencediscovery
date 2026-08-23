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
    modelDiscovery: "openai-models",
    name: "DeepSeek",
  },
  {
    // Kimi speaks the DeepSeek-style thinking dialect: `thinking.type`,
    // `reasoning_effort` and streamed `reasoning_content`.
    apiProtocol: "openai-chat-completions",
    apiVariant: "deepseek",
    baseUrl: "https://api.moonshot.cn/v1",
    docsUrl: "https://platform.kimi.com/docs/api/chat",
    id: "moonshot",
    modelDiscovery: "openai-models",
    name: "Moonshot Kimi",
  },
  {
    // GLM also uses `thinking.type` + `reasoning_content`; bigmodel.cn has no
    // model-list endpoint, so discovery stays manual with catalog suggestions.
    apiProtocol: "openai-chat-completions",
    apiVariant: "deepseek",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction.md",
    id: "zhipu",
    modelDiscovery: "manual",
    name: "智谱 GLM",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "minimax",
    baseUrl: "https://api.minimaxi.com/v1",
    docsUrl: "https://platform.minimaxi.com/docs/api-reference/text-openai-api",
    id: "minimax",
    modelDiscovery: "openai-models",
    name: "MiniMax",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docsUrl: "https://help.aliyun.com/en/model-studio/base-url",
    id: "dashscope",
    modelDiscovery: "openai-models",
    name: "Alibaba Cloud Model Studio",
  },
  {
    apiProtocol: "openai-responses",
    apiVariant: "responses",
    baseUrl: "https://api.openai.com/v1",
    docsUrl: "https://developers.openai.com/api/docs/api-reference/introduction",
    id: "openai",
    modelDiscovery: "openai-models",
    name: "OpenAI",
  },
  {
    apiProtocol: "anthropic-messages",
    apiVariant: "anthropic-adaptive",
    baseUrl: "https://api.anthropic.com",
    docsUrl: "https://platform.claude.com/docs/en/api/overview.md",
    id: "anthropic",
    modelDiscovery: "anthropic-models",
    name: "Anthropic",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    id: "gemini",
    modelDiscovery: "openai-models",
    name: "Google Gemini",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    docsUrl: "https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions",
    id: "siliconflow",
    modelDiscovery: "openai-models",
    name: "SiliconFlow",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    docsUrl: "https://openrouter.ai/docs/quickstart",
    id: "openrouter",
    modelDiscovery: "openai-models",
    name: "OpenRouter",
  },
  {
    apiProtocol: "openai-chat-completions",
    apiVariant: "ollama",
    baseUrl: "http://localhost:11434/v1",
    docsUrl: "https://docs.ollama.com/openai",
    id: "ollama",
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
