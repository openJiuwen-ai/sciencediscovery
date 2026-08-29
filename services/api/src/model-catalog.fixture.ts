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

// Catalog facts for tests that drive the store or a run directly, without an
// HTTP server to load a snapshot for them. The product downloads its catalog at
// runtime, so a test states the facts it asserts on instead of depending on
// whatever the live document says today.

import { setModelCatalogSnapshot, type ModelCatalogRecord } from "@sciencediscovery/schema";

const source = { retrievedAt: "2026-08-26", url: "https://example.test/model-docs" };

export const API_TEST_CATALOG_RECORDS: readonly ModelCatalogRecord[] = [
  {
    // Only the legacy fixed thinking budget, so profiles created for it must
    // be materialized on the legacy Anthropic dialect.
    aliases: ["claude-haiku-4-5-20251001"],
    apiVariant: "anthropic-legacy",
    contextWindow: 200_000,
    key: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    source,
    thinking: { supported: true },
  },
  {
    // Publishes a narrower effort scale than the product's full range, so a
    // saved `low` or `xhigh` has to be narrowed to something legal.
    contextWindow: 1_000_000,
    key: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    source,
    thinking: { supported: true, efforts: ["high", "max"] },
  },
  {
    contextWindow: 1_050_000,
    key: "gpt-5.5",
    label: "GPT-5.5",
    maxOutputTokens: 128_000,
    source,
    thinking: { supported: true, efforts: ["low", "medium", "high", "xhigh"] },
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
  },
];

export function installApiTestModelCatalog(): void {
  setModelCatalogSnapshot({
    fetchedAt: "2026-08-26T09:00:00.000Z",
    origin: "downloaded",
    records: API_TEST_CATALOG_RECORDS,
    sourceUrl: "https://models.dev/api.json",
  });
}
