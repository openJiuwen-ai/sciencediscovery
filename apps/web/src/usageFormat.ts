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

import type { ModelInvocationUsage, ModelUsageBucket } from "@sciencediscovery/schema";

export function formatCompactTokenValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat().format(value);
}

export function formatTokenField(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat().format(value);
}

function pushTokenPart(
  parts: string[],
  label: string,
  value: number | null | undefined,
): void {
  if (value === null || value === undefined) return;
  parts.push(`${label} ${formatCompactTokenValue(value)}`);
}

/** Session chip / compact summary: only reported in/out. */
export function usageInOutLabel(bucket: Pick<ModelUsageBucket, "inputTokens" | "outputTokens">): string {
  const parts: string[] = [];
  pushTokenPart(parts, "in", bucket.inputTokens);
  pushTokenPart(parts, "out", bucket.outputTokens);
  return parts.join(" · ");
}

export function usageBreakdownLabel(bucket: Pick<ModelUsageBucket, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens" | "unreportedInvocationCount">): string {
  const parts: string[] = [];
  pushTokenPart(parts, "in", bucket.inputTokens);
  pushTokenPart(parts, "out", bucket.outputTokens);
  pushTokenPart(parts, "cache-read", bucket.cacheReadTokens);
  pushTokenPart(parts, "cache-write", bucket.cacheWriteTokens);
  return parts.join(" · ");
}

/** Per-message inline usage: omit fields the API did not return. */
export function usageInlineLabel(bucket: Pick<ModelUsageBucket, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens" | "unreportedInvocationCount">): string {
  const parts: string[] = [];
  pushTokenPart(parts, "input", bucket.inputTokens);
  pushTokenPart(parts, "output", bucket.outputTokens);
  pushTokenPart(parts, "cache read", bucket.cacheReadTokens);
  pushTokenPart(parts, "cache write", bucket.cacheWriteTokens);
  return parts.join(" / ");
}

export function invocationStatusLabel(usage: ModelInvocationUsage): string {
  return usage.usageStatus === "reported" ? "reported" : "unreported";
}
