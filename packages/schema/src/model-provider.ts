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

import type {
  ModelApiProtocol,
  ModelApiVariant,
  ModelThinkingEffort,
  ModelThinkingMode,
} from "./model-usage.js";
import type { ProxyPolicy } from "./proxy.js";

/**
 * How a provider's model list is obtained. The strategy is derived from the
 * protocol family by default but stays user-overridable because several
 * OpenAI-compatible gateways do not expose a listing endpoint.
 */
export type ModelDiscoveryStrategy = "anthropic-models" | "manual" | "openai-models";

export const DEFAULT_MODEL_DISCOVERY: Record<ModelApiProtocol, ModelDiscoveryStrategy> = {
  "anthropic-messages": "anthropic-models",
  "openai-chat-completions": "openai-models",
  "openai-responses": "openai-models",
};

/**
 * A configured model service connection. Built-in presets pre-fill everything
 * except the API token; custom providers describe any compatible endpoint.
 * The token itself is stored encrypted server-side and never leaves the API.
 */
export interface ModelProvider {
  baseUrl: string;
  apiProtocol: ModelApiProtocol;
  apiVariant: ModelApiVariant;
  createdAt: string;
  hasApiToken: boolean;
  id: string;
  modelDiscovery: ModelDiscoveryStrategy;
  name: string;
  /** Built-in preset this provider was created from, if any. */
  presetId?: ModelProviderPresetId;
  proxyPolicy: ProxyPolicy;
  /** Local endpoints (e.g. Ollama) accept requests without a real key, so
   *  runs and the UI must not demand a saved token. */
  tokenOptional: boolean;
  updatedAt: string;
}

export interface CreateModelProviderRequest {
  apiProtocol?: ModelApiProtocol;
  apiToken?: string;
  apiVariant?: ModelApiVariant;
  baseUrl?: string;
  modelDiscovery?: ModelDiscoveryStrategy;
  name?: string;
  presetId?: ModelProviderPresetId;
  proxyPolicy?: ProxyPolicy;
  tokenOptional?: boolean;
}

export interface UpdateModelProviderRequest {
  apiProtocol?: ModelApiProtocol;
  /** `null` removes the saved token. */
  apiToken?: string | null;
  apiVariant?: ModelApiVariant;
  baseUrl?: string;
  modelDiscovery?: ModelDiscoveryStrategy;
  name?: string;
  proxyPolicy?: ProxyPolicy;
  tokenOptional?: boolean;
}

/** Capability facts the provider's own listing endpoint reported. They take
 *  precedence over the curated catalog because they come from the live API. */
export interface RemoteModelFacts {
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: ModelCatalogPricing;
  thinkingSupported?: boolean;
  vision?: boolean;
}

/** One model reported by a provider's listing endpoint (normalized). */
export interface ProviderModelEntry {
  /** Present when a model profile already backs this provider/model pair. */
  profileId?: string;
  catalog?: ModelCatalogEntry;
  displayName?: string;
  id: string;
  remote?: RemoteModelFacts;
}

export interface ProviderModelList {
  fetchedAt: string;
  models: ProviderModelEntry[];
  providerId: string;
  /** `remote` = fetched from the provider's listing endpoint; `catalog` =
   *  curated suggestions for providers without a listing endpoint. */
  source: "catalog" | "remote";
}

/** Thinking capability recorded for a catalog model. */
export interface ModelCatalogThinking {
  /** Effort levels the product exposes for this model, when supported. */
  efforts?: ModelThinkingEffort[];
  /** Modes the provider accepts. Omitted means the model supports the normal
   *  auto/enabled/disabled toggle for its protocol variant. */
  modes?: ModelThinkingMode[];
  supported: boolean;
}

/**
 * Pricing is copied from the vendor's official price page, never inferred.
 * `source` says where and when it was read; absent fields mean the vendor
 * does not publish them, not zero.
 */
export interface ModelCatalogPricing {
  /** Discounted price for cache-hit input tokens, if published. */
  cachedInput?: number;
  currency: "CNY" | "USD";
  input: number;
  /** Qualifiers such as off-peak discounts or tiered long-context pricing. */
  notes?: string;
  output: number;
  source: { retrievedAt: string; url: string };
  unit: "per-1m-tokens";
}

/**
 * Curated metadata for a well-known model. The catalog is a static, source-
 * annotated table: remote listings only prove a model id exists, so context
 * windows, vision, thinking and pricing come from vendor documentation.
 */
export interface ModelCatalogEntry {
  contextWindow?: number;
  label: string;
  maxOutputTokens?: number;
  pricing?: ModelCatalogPricing;
  /** Official page the facts were read from. */
  source: { retrievedAt: string; url: string };
  thinking?: ModelCatalogThinking;
  vision?: boolean;
}

export type ModelProviderPresetId =
  | "anthropic"
  | "dashscope"
  | "deepseek"
  | "gemini"
  | "minimax"
  | "moonshot"
  | "ollama"
  | "openai"
  | "openrouter"
  | "siliconflow"
  | "zhipu";

/**
 * A built-in provider preset: everything a common vendor needs except the
 * user's API token. `docsUrl` is the official page the endpoint facts were
 * read from so the preset stays auditable.
 */
export interface ModelProviderPreset {
  baseUrl: string;
  apiProtocol: ModelApiProtocol;
  apiVariant: ModelApiVariant;
  docsUrl: string;
  id: ModelProviderPresetId;
  modelDiscovery: ModelDiscoveryStrategy;
  /** English display name; the UI translates via i18n keys. */
  name: string;
  /** Local endpoints (Ollama) work without a token. */
  tokenOptional?: boolean;
}
