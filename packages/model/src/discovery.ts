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

/**
 * Provider model discovery: one GET against the provider's listing endpoint,
 * normalized into ids plus whatever capability facts the endpoint itself
 * reports (OpenRouter pricing/context, Moonshot vision/reasoning flags,
 * Anthropic capabilities). Nothing is invented here — absent facts stay
 * absent and the curated catalog fills them in later, at lower precedence.
 */

import { request } from "undici";

import type { ModelDiscoveryStrategy, ResolvedProxy } from "@sciencediscovery/schema";

import { endpointRoot, proxyDispatcher } from "./client.js";

export interface ModelDiscoveryEndpoint {
  apiToken?: string;
  baseUrl: string;
  discovery: Exclude<ModelDiscoveryStrategy, "manual">;
  proxy?: ResolvedProxy;
}

export interface DiscoveredModelPricing {
  cachedInput?: number;
  currency: "USD";
  input: number;
  output: number;
}

export interface DiscoveredModel {
  contextWindow?: number;
  displayName?: string;
  id: string;
  maxOutputTokens?: number;
  pricing?: DiscoveredModelPricing;
  thinkingSupported?: boolean;
  vision?: boolean;
}

/** Listing failures keep the upstream status so the API can distinguish bad
 *  credentials (401/403) from an endpoint without a listing (404) or an
 *  unreachable host (no status). */
export class ModelDiscoveryError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}

const DISCOVERY_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelsUrl(endpoint: ModelDiscoveryEndpoint): string {
  const root = endpointRoot(endpoint.baseUrl);
  if (endpoint.discovery === "anthropic-models") {
    return root.endsWith("/v1") ? `${root}/models` : `${root}/v1/models`;
  }
  return `${root}/models`;
}

function discoveryHeaders(endpoint: ModelDiscoveryEndpoint): Record<string, string> {
  if (endpoint.discovery === "anthropic-models") {
    return {
      "anthropic-version": "2023-06-01",
      ...(endpoint.apiToken ? { "x-api-key": endpoint.apiToken } : {}),
    };
  }
  // Local endpoints (Ollama) and some public listings work unauthenticated;
  // only send credentials we actually have.
  return endpoint.apiToken ? { authorization: `Bearer ${endpoint.apiToken}` } : {};
}

/** OpenRouter reports USD-per-token decimal strings; convert to per-1M. */
function perMillion(value: unknown): number | undefined {
  const raw = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(raw) || raw < 0) return undefined;
  return Math.round(raw * 1e6 * 1e6) / 1e6;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizeEntry(item: Record<string, unknown>): DiscoveredModel | undefined {
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id) return undefined;
  const model: DiscoveredModel = { id };

  const displayName = typeof item.display_name === "string" ? item.display_name
    : typeof item.name === "string" ? item.name : undefined;
  if (displayName?.trim() && displayName.trim() !== id) model.displayName = displayName.trim();

  // Context window: OpenRouter/Moonshot `context_length`, Anthropic `max_input_tokens`.
  const contextWindow = positiveInt(item.context_length) ?? positiveInt(item.max_input_tokens);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxOutputTokens = positiveInt(item.max_tokens)
    ?? (isRecord(item.top_provider) ? positiveInt(item.top_provider.max_completion_tokens) : undefined);
  if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens;

  // Vision: Moonshot `supports_image_in`, Anthropic `capabilities.image_input`,
  // OpenRouter `architecture.input_modalities`.
  const capabilities = isRecord(item.capabilities) ? item.capabilities : undefined;
  const architecture = isRecord(item.architecture) ? item.architecture : undefined;
  if (typeof item.supports_image_in === "boolean") model.vision = item.supports_image_in;
  else if (capabilities && typeof capabilities.image_input === "boolean") model.vision = capabilities.image_input;
  else if (Array.isArray(architecture?.input_modalities)) {
    model.vision = architecture.input_modalities.includes("image");
  }

  // Thinking: Moonshot `supports_reasoning`, Anthropic `capabilities.thinking`,
  // OpenRouter `supported_parameters` containing "reasoning".
  if (typeof item.supports_reasoning === "boolean") model.thinkingSupported = item.supports_reasoning;
  else if (capabilities && isRecord(capabilities.thinking)) model.thinkingSupported = true;
  else if (Array.isArray(item.supported_parameters)) {
    model.thinkingSupported = item.supported_parameters.includes("reasoning");
  }

  if (isRecord(item.pricing)) {
    const input = perMillion(item.pricing.prompt);
    const output = perMillion(item.pricing.completion);
    if (input !== undefined && output !== undefined) {
      const cachedInput = perMillion(item.pricing.input_cache_read);
      model.pricing = {
        currency: "USD",
        input,
        output,
        ...(cachedInput !== undefined ? { cachedInput } : {}),
      };
    }
  }
  return model;
}

export async function listProviderModels(
  endpoint: ModelDiscoveryEndpoint,
  options: { timeoutMs?: number } = {},
): Promise<DiscoveredModel[]> {
  const dispatcher = proxyDispatcher(endpoint.proxy);
  const url = modelsUrl(endpoint);
  let statusCode: number;
  let bodyText: string;
  try {
    const response = await request(url, {
      method: "GET",
      headers: discoveryHeaders(endpoint),
      headersTimeout: options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
      bodyTimeout: options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
      ...(dispatcher ? { dispatcher } : {}),
    });
    statusCode = response.statusCode;
    bodyText = await response.body.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelDiscoveryError(`The provider model list is unreachable: ${message}`);
  }
  if (statusCode < 200 || statusCode >= 300) {
    const detail = bodyText.slice(0, 500).trim();
    throw new ModelDiscoveryError(
      `The provider model list request failed with status ${statusCode}${detail ? `: ${detail}` : ""}`,
      statusCode,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    throw new ModelDiscoveryError("The provider model list response is not valid JSON");
  }
  const rawList = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data
    : isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models
    : Array.isArray(parsed) ? parsed
    : undefined;
  if (!rawList) throw new ModelDiscoveryError("The provider model list response has an unknown shape");
  const models = rawList.filter(isRecord).map(normalizeEntry)
    .filter((model): model is DiscoveredModel => model !== undefined);
  models.sort((left, right) => left.id.localeCompare(right.id));
  return models;
}
