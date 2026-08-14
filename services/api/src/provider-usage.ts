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

import type { ModelUsageStatus } from "@science-agent/schema";

export interface ProviderUsageBreakdown {
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageStatus: ModelUsageStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function firstTokenCount(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    if (!(key in record)) continue;
    const count = tokenCount(record[key]);
    if (count !== null) return count;
  }
  return null;
}

function unreportedUsage(): ProviderUsageBreakdown {
  return {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    usageStatus: "provider-not-reported",
  };
}

/**
 * Normalize OpenAI-compatible / provider usage payloads.
 * Kept aligned with gateway `_usage_from_mapping` field aliases and total derivation.
 */
export function parseProviderUsage(value: unknown): ProviderUsageBreakdown {
  if (!isRecord(value)) return unreportedUsage();

  let inputTokens = firstTokenCount(value, [
    "input_tokens",
    "prompt_tokens",
    "input_token_count",
    "prompt_token_count",
  ]);
  let outputTokens = firstTokenCount(value, [
    "output_tokens",
    "completion_tokens",
    "output_token_count",
    "completion_token_count",
  ]);
  let totalTokens = firstTokenCount(value, ["total_tokens", "total_token_count"]);

  let cacheReadTokens = firstTokenCount(value, [
    "cache_read_input_tokens",
    "cache_read_tokens",
    "cached_tokens",
    "prompt_cache_hit_tokens",
  ]);
  let cacheWriteTokens = firstTokenCount(value, [
    "cache_creation_input_tokens",
    "cache_write_tokens",
    "prompt_cache_miss_tokens",
  ]);

  const promptDetails = value.prompt_tokens_details;
  if (isRecord(promptDetails)) {
    if (cacheReadTokens === null) {
      cacheReadTokens = firstTokenCount(promptDetails, ["cached_tokens", "cache_read_tokens", "cache_tokens"]);
    }
    if (cacheWriteTokens === null) {
      cacheWriteTokens = firstTokenCount(promptDetails, ["cache_write_tokens", "cache_creation_tokens"]);
    }
  }

  const inputDetails = value.input_token_details;
  if (isRecord(inputDetails) && cacheReadTokens === null) {
    cacheReadTokens = firstTokenCount(inputDetails, ["cache_read", "cached_tokens", "cache_read_tokens"]);
  }

  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens;
  }
  if (inputTokens === null && totalTokens !== null && outputTokens !== null) {
    inputTokens = Math.max(totalTokens - outputTokens, 0);
  }
  if (outputTokens === null && totalTokens !== null && inputTokens !== null) {
    outputTokens = Math.max(totalTokens - inputTokens, 0);
  }

  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    return unreportedUsage();
  }

  return {
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
    outputTokens,
    totalTokens,
    usageStatus: "reported",
  };
}
