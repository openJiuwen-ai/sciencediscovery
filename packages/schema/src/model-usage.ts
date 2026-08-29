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

// Type-only, so the mutual reference with model-provider.ts costs nothing at
// runtime: the fact-override shape is defined next to the catalog types it
// competes with, and consumed here by the profile that stores it.
import type { ModelFactOverrides } from "./model-provider.js";
import type { ProxyPolicy } from "./proxy.js";

export type ModelApiProtocol =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";

export type ModelApiVariant =
  | "anthropic-adaptive"
  | "anthropic-legacy"
  | "deepseek"
  | "gemini"
  | "kimi-k3"
  | "minimax"
  | "ollama"
  | "openai"
  | "qwen"
  | "responses";

export type ModelThinkingMode = "auto" | "disabled" | "enabled";
export type ModelThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const MODEL_API_VARIANTS: Record<ModelApiProtocol, readonly ModelApiVariant[]> = {
  "openai-chat-completions": ["openai", "deepseek", "kimi-k3", "qwen", "minimax", "gemini", "ollama"],
  "openai-responses": ["responses"],
  "anthropic-messages": ["anthropic-adaptive", "anthropic-legacy"],
};

export const DEFAULT_MODEL_API_VARIANT: Record<ModelApiProtocol, ModelApiVariant> = {
  "openai-chat-completions": "openai",
  "openai-responses": "responses",
  "anthropic-messages": "anthropic-adaptive",
};

/** Variants whose thinking toggle maps to real wire fields. The rest treat
 *  `enabled`/`disabled` as display-only because their endpoints have no
 *  compatible control field. */
export const THINKING_CONTROL_VARIANTS: readonly ModelApiVariant[] = [
  "anthropic-adaptive",
  "anthropic-legacy",
  "deepseek",
  "gemini",
  "kimi-k3",
  "minimax",
  "qwen",
  "responses",
];

/** Variants that send a thinking-effort field when thinking is enabled. */
export const THINKING_EFFORT_VARIANTS: readonly ModelApiVariant[] = [
  "anthropic-adaptive",
  "anthropic-legacy",
  "deepseek",
  "gemini",
  "kimi-k3",
  "responses",
];

export interface ModelProfile {
  apiProtocol?: ModelApiProtocol;
  apiVariant?: ModelApiVariant;
  baseUrl: string;
  createdAt: string;
  /** Facts the user stated for this model. Saved here rather than in the
   *  catalog snapshot, so refreshing the catalog cannot overwrite them. */
  facts?: ModelFactOverrides;
  hasApiToken: boolean;
  id: string;
  model: string;
  name: string;
  /** Provider this profile belongs to. Connection fields (base URL, protocol,
   *  variant, proxy) mirror the provider and the provider's token is used
   *  when the profile has none of its own. Absent for standalone profiles. */
  providerId?: string;
  proxyPolicy: ProxyPolicy;
  thinkingEffort?: ModelThinkingEffort;
  thinkingMode?: ModelThinkingMode;
  updatedAt: string;
  vision: boolean;
}

export type ModelConnectivityTestCategory =
  | "ok"
  | "missing_token"
  | "authorization"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "network"
  | "provider_error"
  | "invalid_response";

export interface ModelConnectivityTestResult {
  category: ModelConnectivityTestCategory;
  latencyMs: number;
  message: string;
  ok: boolean;
  providerStatus?: number;
  testedAt: string;
}

export interface ModelRunInfo {
  id: string;
  model: string;
  name: string;
}

export type ModelInvocationKind =
  | "delegation-track"
  /** A `/evolve` search's mutation calls. Its own kind because a search's spend
   *  is not a chat turn: the usage page has to be able to say "this went on
   *  evolution" rather than burying it among the turns. */
  | "evolve"
  | "paper-vision"
  | "review-correction"
  | "semantic-review"
  | "session-naming"
  | "task";

export type ModelUsageStatus = "provider-not-reported" | "reported";

export interface ModelInvocationUsage {
  attemptIndex: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  finishedAt: string;
  id: string;
  inputTokens: number | null;
  invocationId: string;
  invocationKind: ModelInvocationKind;
  model: string;
  modelProfileId: string;
  modelProfileName: string;
  outputTokens: number | null;
  projectId?: string;
  promptManifestId?: string;
  runId?: string;
  sessionId: string;
  startedAt: string;
  totalTokens: number | null;
  usageStatus: ModelUsageStatus;
}

export interface ModelUsageBucket {
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  invocationCount: number;
  key: string;
  label: string;
  outputTokens: number | null;
  reportedInvocationCount: number;
  totalTokens: number | null;
  unreportedInvocationCount: number;
}

export interface SessionUsageSummary {
  byInvocationKind: ModelUsageBucket[];
  byModel: ModelUsageBucket[];
  byRun: ModelUsageBucket[];
  invocations: ModelInvocationUsage[];
  latestInvocation?: ModelInvocationUsage;
  sessionId: string;
  totals: ModelUsageBucket;
}

export interface GlobalUsageRunGroup {
  bucket: ModelUsageBucket;
  invocations: ModelInvocationUsage[];
  runId: string | null;
}

export interface GlobalUsageSessionGroup {
  bucket: ModelUsageBucket;
  runs: GlobalUsageRunGroup[];
  sessionId: string;
  sessionTitle: string;
}

export interface GlobalUsageProjectGroup {
  bucket: ModelUsageBucket;
  projectId: string;
  projectName: string;
  sessions: GlobalUsageSessionGroup[];
}

export interface GlobalUsageModelGroup {
  bucket: ModelUsageBucket;
  model: string;
  modelProfileId: string;
  modelProfileName: string;
  projects: GlobalUsageProjectGroup[];
}

export interface GlobalModelUsageSummary {
  byModel: GlobalUsageModelGroup[];
  totals: ModelUsageBucket;
}

export interface CreateModelProfileRequest {
  apiToken?: string;
  apiProtocol?: ModelApiProtocol;
  apiVariant?: ModelApiVariant;
  baseUrl: string;
  facts?: ModelFactOverrides;
  model: string;
  name: string;
  proxyPolicy?: ProxyPolicy;
  thinkingEffort?: ModelThinkingEffort;
  thinkingMode?: ModelThinkingMode;
  vision?: boolean;
}

export interface UpdateModelProfileRequest {
  apiToken?: string | null;
  apiProtocol?: ModelApiProtocol;
  apiVariant?: ModelApiVariant;
  baseUrl: string;
  /** Replaces the saved overrides. `null` clears them and lets the listing and
   *  catalog answer again. */
  facts?: ModelFactOverrides | null;
  model: string;
  name: string;
  proxyPolicy?: ProxyPolicy;
  thinkingEffort?: ModelThinkingEffort;
  thinkingMode?: ModelThinkingMode;
  vision?: boolean;
}
