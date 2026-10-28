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

import { normalizeUsage, type UsageAliasConflict } from "@sciencediscovery/model";
import type { ModelApiProtocol, ModelUsageStatus } from "@sciencediscovery/schema";

export interface ProviderUsageBreakdown {
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageStatus: ModelUsageStatus;
  aliasConflict?: UsageAliasConflict;
}

/** API accounting uses the same dialect rules as streaming model calls. */
export function parseProviderUsage(value: unknown, protocol?: ModelApiProtocol): ProviderUsageBreakdown {
  const usage = normalizeUsage(value, protocol);
  if (!usage) return {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    usageStatus: "provider-not-reported",
  };
  return {
    ...usage,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    usageStatus: "reported",
  };
}
