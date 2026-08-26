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

// Shared test fixture. The published catalog document is never committed, so
// tests that need catalog facts install this hand-written stand-in instead.
// Not exported from the package index: nothing in the product reads it.

import {
  mapModelsDevCatalog,
  setModelCatalogSnapshot,
  type ModelsDevPayload,
} from "@sciencediscovery/schema";

export const FIXTURE_FETCHED_AT = "2026-08-26T09:00:00.000Z";
export const FIXTURE_SOURCE_URL = "https://models.dev/api.json";

/** A hand-written stand-in for the published document: small enough to read,
 *  wide enough to cover every mapping rule. The real document is never
 *  committed — packaging downloads it. */
export const MODELS_DEV_FIXTURE: ModelsDevPayload = {
  anthropic: {
    doc: "https://platform.claude.com/docs/en/about-claude/models/overview.md",
    id: "anthropic",
    models: {
      "claude-haiku-4-5": {
        cost: { cache_read: 0.1, input: 1, output: 5 },
        id: "claude-haiku-4-5",
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "Claude Haiku 4.5",
        reasoning: true,
        reasoning_options: [{ min: 1_024, type: "budget_tokens" }] as never,
      },
      "claude-opus-5": {
        cost: { cache_read: 0.5, input: 5, output: 25 },
        id: "claude-opus-5",
        limit: { context: 1_000_000, output: 128_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "Claude Opus 5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
    },
  },
  deepseek: {
    doc: "https://api-docs.deepseek.com/quick_start/pricing",
    id: "deepseek",
    models: {
      "deepseek-v4-pro": {
        cost: { cache_read: 0.014, input: 0.55, output: 2.2 },
        id: "deepseek-v4-pro",
        limit: { context: 1_000_000, output: 384_000 },
        modalities: { input: ["text"], output: ["text"] },
        name: "DeepSeek V4 Pro",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
      },
    },
  },
  "moonshotai-cn": {
    doc: "https://platform.moonshot.cn/docs/api/chat",
    id: "moonshotai-cn",
    models: {
      "kimi-k3": {
        cost: { input: 3, output: 15 },
        id: "kimi-k3",
        limit: { context: 1_048_576, output: 131_072 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "Kimi K3",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
      },
    },
  },
  "ollama-cloud": {
    doc: "https://docs.ollama.com/cloud",
    id: "ollama-cloud",
    models: {
      "local-only-model": {
        cost: { input: 9, output: 9 },
        id: "local-only-model",
        limit: { context: 4_096, output: 4_096 },
        modalities: { input: ["text"], output: ["text"] },
        name: "Local Only Model",
        reasoning: false,
      },
    },
  },
  openai: {
    doc: "https://developers.openai.com/api/docs/api-reference/introduction",
    id: "openai",
    models: {
      "gpt-5.5": {
        cost: { cache_read: 0.125, input: 1.25, output: 10 },
        id: "gpt-5.5",
        limit: { context: 1_050_000, output: 128_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "GPT-5.5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh"] }],
      },
      "gpt-image-1.5": {
        id: "gpt-image-1.5",
        limit: { context: 0, output: 0 },
        modalities: { input: ["text", "image"], output: ["image"] },
        name: "GPT Image 1.5",
        reasoning: false,
      },
    },
  },
  openrouter: {
    doc: "https://openrouter.ai/docs/quickstart",
    id: "openrouter",
    models: {
      "deepseek/deepseek-v4-pro": {
        cost: { input: 0.9, output: 3 },
        id: "deepseek/deepseek-v4-pro",
        limit: { context: 128_000, output: 32_000 },
        modalities: { input: ["text"], output: ["text"] },
        name: "DeepSeek V4 Pro (OpenRouter)",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
      },
    },
  },
  zhipuai: {
    doc: "https://docs.z.ai/guides/overview/pricing",
    id: "zhipuai",
    models: {
      "glm-5": {
        cost: { input: 0.6, output: 2.2 },
        id: "glm-5",
        limit: { context: 200_000, output: 131_072 },
        modalities: { input: ["text"], output: ["text"] },
        name: "GLM-5",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
      },
    },
  },
};

export function installTestModelCatalog(): void {
  setModelCatalogSnapshot({
    fetchedAt: FIXTURE_FETCHED_AT,
    origin: "downloaded",
    records: mapModelsDevCatalog(MODELS_DEV_FIXTURE, { fetchedAt: FIXTURE_FETCHED_AT, sourceUrl: FIXTURE_SOURCE_URL }),
    sourceUrl: FIXTURE_SOURCE_URL,
  });
}
