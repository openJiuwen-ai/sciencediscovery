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

// Catalog facts for the Web tests.
//
// The product downloads its catalog at runtime, so a test that needs model
// facts states them here rather than depending on whatever the live catalog
// happens to say today. These are records, not a models.dev document: the
// mapping from that document is covered in packages/model.

import { setModelCatalogSnapshot, type ModelCatalogRecord } from "@sciencediscovery/schema";

const source = { retrievedAt: "2026-08-26", url: "https://example.test/model-docs" };

export const WEB_CATALOG_RECORDS: readonly ModelCatalogRecord[] = [
  {
    // Legacy Anthropic thinking: a fixed token budget, so the form offers the
    // toggle and no effort scale.
    aliases: ["claude-haiku-4-5-20251001"],
    apiVariant: "anthropic-legacy",
    contextWindow: 200_000,
    key: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    maxOutputTokens: 64_000,
    source,
    thinking: { supported: true },
    vision: true,
  },
  {
    // Time-varying vendor rates. models.dev publishes no schedules, so this
    // record exists to keep the period rendering covered.
    contextWindow: 1_000_000,
    key: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    pricing: {
      deepseek: {
        cachedInput: 0.1,
        currency: "CNY",
        input: 3,
        output: 9,
        periods: [
          {
            cachedInput: 0.1,
            id: "peak",
            input: 3,
            output: 9,
            schedule: {
              intervals: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
              kind: "weekdays",
              timeZone: "Asia/Shanghai",
            },
          },
          {
            cachedInput: 0.05,
            id: "off-peak",
            input: 1.5,
            output: 4.5,
            schedule: { kind: "remainder", timeZone: "Asia/Shanghai" },
          },
        ],
        source: { retrievedAt: "2026-08-26", url: "https://api-docs.deepseek.com/quick_start/pricing" },
        unit: "per-1m-tokens",
      },
    },
    source: { retrievedAt: "2026-08-26", url: "https://api-docs.deepseek.com/quick_start/pricing" },
    thinking: { supported: true, efforts: ["low", "high", "max"] },
    vision: false,
  },
  {
    // Gemini reasons on every request; the dialect has no off state.
    contextWindow: 1_048_576,
    key: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    source,
    thinking: { supported: true, efforts: ["low", "medium", "high"] },
    vision: true,
  },
  {
    // The same GLM model on domestic vs international vs reseller hosts:
    // capabilities stay vendor-first; only the reseller has a price.
    contextWindow: 1_000_000,
    key: "glm-5.2",
    label: "GLM-5.2",
    maxOutputTokens: 131_072,
    pricing: {
      dashscope: {
        currency: "USD",
        input: 0.6,
        output: 1.8,
        source: { retrievedAt: "2026-08-26", url: "https://example.test/dashscope-pricing" },
        unit: "per-1m-tokens",
      },
    },
    source,
    thinking: { supported: true, efforts: ["high", "max"] },
    vision: false,
  },
  {
    apiVariant: "kimi-k3",
    contextWindow: 1_048_576,
    key: "kimi-k3",
    label: "Kimi K3",
    source,
    thinking: {
      defaultEffort: "max",
      defaultMode: "enabled",
      efforts: ["low", "high", "max"],
      modes: ["enabled"],
      supported: true,
    },
    vision: true,
  },
  {
    contextWindow: 1_050_000,
    key: "gpt-5.5",
    label: "GPT-5.5",
    maxOutputTokens: 128_000,
    source,
    thinking: { supported: true, efforts: ["low", "medium", "high", "xhigh"] },
    vision: true,
  },
];

export function installWebModelCatalog(): void {
  setModelCatalogSnapshot({
    fetchedAt: "2026-08-26T09:00:00.000Z",
    origin: "downloaded",
    records: WEB_CATALOG_RECORDS,
    sourceUrl: "https://models.dev/api.json",
  });
}
