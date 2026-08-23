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
  CreateModelProviderRequest,
  ModelApiProtocol,
  ModelApiVariant,
  ModelDiscoveryStrategy,
  ModelProvider,
  UpdateModelProviderRequest,
} from "@sciencediscovery/schema";
import {
  DEFAULT_MODEL_API_VARIANT,
  DEFAULT_MODEL_DISCOVERY,
  getModelProviderPreset,
  MODEL_API_VARIANTS,
} from "@sciencediscovery/schema";
import { cleanLabel } from "@sciencediscovery/governance";

const DISCOVERY_STRATEGIES: readonly ModelDiscoveryStrategy[] = [
  "anthropic-models",
  "manual",
  "openai-models",
];

/** Provider tokens share the encrypted model-secret table under a reserved
 *  key prefix; profile ids are UUIDs so the namespaces cannot collide. */
export function providerSecretKey(providerId: string): string {
  return `provider:${providerId}`;
}

function validBaseUrl(value: string | undefined, fallback?: string): string {
  const raw = value?.trim() || fallback;
  let endpoint: URL;
  try {
    endpoint = new URL(raw ?? "");
  } catch {
    throw new Error("The provider base URL is invalid");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("The provider base URL must use http or https");
  }
  return endpoint.toString().replace(/\/$/, "");
}

/**
 * Normalize a create/update payload into the persisted provider fields.
 * Preset-derived providers start from the preset's endpoint facts; every
 * field stays overridable so self-hosted gateways and stubs keep working.
 */
export function validateLiveProvider(
  input: CreateModelProviderRequest | (UpdateModelProviderRequest & { presetId?: ModelProvider["presetId"] }),
): Omit<ModelProvider, "createdAt" | "hasApiToken" | "id" | "proxyPolicy" | "tokenOptional" | "updatedAt"> {
  const preset = input.presetId === undefined ? undefined : getModelProviderPreset(input.presetId);
  if (input.presetId !== undefined && !preset) {
    throw new Error("The provider preset is unknown");
  }
  const name = cleanLabel(input.name ?? preset?.name ?? "", "Untitled provider");
  const baseUrl = validBaseUrl(input.baseUrl, preset?.baseUrl);
  const apiProtocol: ModelApiProtocol = input.apiProtocol ?? preset?.apiProtocol ?? "openai-chat-completions";
  if (!Object.hasOwn(MODEL_API_VARIANTS, apiProtocol)) throw new Error("The provider API protocol is invalid");
  const apiVariant: ModelApiVariant = input.apiVariant ?? preset?.apiVariant ?? DEFAULT_MODEL_API_VARIANT[apiProtocol];
  if (!MODEL_API_VARIANTS[apiProtocol].includes(apiVariant)) {
    throw new Error(`Model API variant ${apiVariant} is not valid for ${apiProtocol}`);
  }
  const modelDiscovery: ModelDiscoveryStrategy =
    input.modelDiscovery ?? preset?.modelDiscovery ?? DEFAULT_MODEL_DISCOVERY[apiProtocol];
  if (!DISCOVERY_STRATEGIES.includes(modelDiscovery)) {
    throw new Error("The provider model discovery strategy is invalid");
  }
  return {
    apiProtocol,
    apiVariant,
    baseUrl,
    modelDiscovery,
    name,
    ...(preset ? { presetId: preset.id } : {}),
  };
}
