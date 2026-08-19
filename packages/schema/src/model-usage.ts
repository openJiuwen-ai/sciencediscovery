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
  | "minimax"
  | "ollama"
  | "openai"
  | "qwen"
  | "responses";

export type ModelThinkingMode = "auto" | "disabled" | "enabled";
export type ModelThinkingEffort = "high" | "max";

export const MODEL_API_VARIANTS: Record<ModelApiProtocol, readonly ModelApiVariant[]> = {
  "openai-chat-completions": ["openai", "deepseek", "qwen", "minimax", "gemini", "ollama"],
  "openai-responses": ["responses"],
  "anthropic-messages": ["anthropic-adaptive", "anthropic-legacy"],
};

export const DEFAULT_MODEL_API_VARIANT: Record<ModelApiProtocol, ModelApiVariant> = {
  "openai-chat-completions": "openai",
  "openai-responses": "responses",
  "anthropic-messages": "anthropic-adaptive",
};

export interface ModelProfile {
  apiProtocol?: ModelApiProtocol;
  apiVariant?: ModelApiVariant;
  baseUrl: string;
  createdAt: string;
  hasApiToken: boolean;
  id: string;
  model: string;
  name: string;
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
  model: string;
  name: string;
  proxyPolicy?: ProxyPolicy;
  thinkingEffort?: ModelThinkingEffort;
  thinkingMode?: ModelThinkingMode;
  vision?: boolean;
}
