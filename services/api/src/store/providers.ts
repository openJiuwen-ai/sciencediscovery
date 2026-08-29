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
  ModelProfile,
  ModelProvider,
  ProxyPolicy,
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
  "openai-models",
];

/** Catalogs written before the model list always came from the provider store
 *  `"manual"`, which meant "do not ask the provider". That mode is gone, so a
 *  saved one is read as the protocol's normal listing shape. Migrating here
 *  rather than in a separate pass means every load and every save converts it,
 *  including providers the user never edits again. */
function normalizeSavedDiscovery(
  value: ModelDiscoveryStrategy | "manual" | undefined,
  apiProtocol: ModelApiProtocol,
): ModelDiscoveryStrategy | undefined {
  if (value === undefined) return undefined;
  return value === "manual" ? DEFAULT_MODEL_DISCOVERY[apiProtocol] : value;
}

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
    normalizeSavedDiscovery(input.modelDiscovery as ModelDiscoveryStrategy | "manual" | undefined, apiProtocol)
    ?? preset?.modelDiscovery
    ?? DEFAULT_MODEL_DISCOVERY[apiProtocol];
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

/**
 * Compare two endpoints the way a provider would: same scheme, host, port and
 * path. Query, fragment and a trailing slash are display noise, and an
 * unparseable value is compared as the trimmed literal so a hand-edited
 * catalog still groups with itself.
 */
export function canonicalProviderBaseUrl(value: string): string {
  const raw = value.trim();
  try {
    const url = new URL(raw);
    // `URL` already lower-cases the scheme and host; the path stays as written
    // because some gateways route on a case-sensitive prefix.
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return raw.replace(/\/+$/u, "");
  }
}

function profileProtocol(profile: Pick<ModelProfile, "apiProtocol" | "baseUrl">): ModelApiProtocol {
  return profile.apiProtocol
    ?? (profile.baseUrl.includes("/api/plan") ? "anthropic-messages" : "openai-chat-completions");
}

function profileVariant(profile: Pick<ModelProfile, "apiProtocol" | "apiVariant" | "baseUrl">): ModelApiVariant {
  return profile.apiVariant ?? DEFAULT_MODEL_API_VARIANT[profileProtocol(profile)];
}

/**
 * The connection identity of a standalone profile. Protocol, dialect and
 * endpoint are exactly the three facts a `ModelProvider` owns, so two profiles
 * belong to the same migrated provider only when all three agree. Differences
 * that live on the profile — model id, thinking defaults, vision — never split
 * a group.
 */
export function standaloneProfileGroupKey(
  profile: Pick<ModelProfile, "apiProtocol" | "apiVariant" | "baseUrl">,
): string {
  return [profileProtocol(profile), profileVariant(profile), canonicalProviderBaseUrl(profile.baseUrl)].join(" ");
}

export interface StandaloneProfileMigration {
  /** Profile id to the provider it now belongs to. */
  assignments: Map<string, string>;
  /** Providers to append, in first-seen order. */
  providers: ModelProvider[];
}

export interface StandaloneProfileMigrationOptions {
  newProviderId: () => string;
  now: string;
}

/**
 * Plan the one-time move of legacy standalone profiles into custom providers.
 *
 * Profiles predating the provider registry carry their own connection fields.
 * Grouping them by connection turns each distinct endpoint into one provider
 * and leaves every profile id, endpoint, dialect and thinking default exactly
 * as it was: the only field that changes on a profile is `providerId`.
 *
 * Credentials are deliberately left alone. Copying a group's shared token up
 * to the provider would look harmless, but it changes what "remove saved
 * token" does on those profiles: the model would keep authenticating through
 * the provider copy after the user believed the key was gone. A migrated
 * provider therefore starts with no token, and each profile keeps resolving
 * its own, exactly as before.
 *
 * The plan is pure so the store can apply it inside its existing load
 * sequence, and so the grouping is testable without a database. It is
 * idempotent by construction: once a profile has a `providerId` it is no
 * longer standalone and later loads plan nothing.
 */
export function planStandaloneProfileMigration(
  models: readonly ModelProfile[],
  options: StandaloneProfileMigrationOptions,
): StandaloneProfileMigration {
  const assignments = new Map<string, string>();
  const providers: ModelProvider[] = [];
  const groups = new Map<string, ModelProfile[]>();
  for (const model of models) {
    if (model.providerId) continue;
    const key = standaloneProfileGroupKey(model);
    const group = groups.get(key);
    if (group) group.push(model);
    else groups.set(key, [model]);
  }

  for (const group of groups.values()) {
    const first = group[0]!;
    const apiProtocol = profileProtocol(first);
    const apiVariant = profileVariant(first);
    const id = options.newProviderId();
    // Every profile in the group answered on this endpoint, so a shared proxy
    // choice carries over; a mixed group falls back to the global default
    // rather than imposing one profile's policy on the others.
    const proxyPolicy: ProxyPolicy = group.every((model) => model.proxyPolicy === first.proxyPolicy)
      ? first.proxyPolicy
      : "inherit";
    let host = canonicalProviderBaseUrl(first.baseUrl);
    try {
      host = new URL(first.baseUrl).host;
    } catch {
      // Keep the canonical string for endpoints that are not valid URLs.
    }
    providers.push({
      apiProtocol,
      apiVariant,
      baseUrl: first.baseUrl,
      createdAt: options.now,
      // Each migrated profile keeps its own credential; nothing is copied up.
      hasApiToken: false,
      id,
      // The list always comes from the provider; whether this hand-configured
      // endpoint answers it is discovered by asking, not assumed.
      modelDiscovery: DEFAULT_MODEL_DISCOVERY[apiProtocol],
      name: cleanLabel(`${host} · ${apiVariant}`, "Migrated provider"),
      proxyPolicy,
      // Standalone profiles always required their own token, and that is what
      // `modelAllowsMissingToken` reported before the migration.
      tokenOptional: false,
      updatedAt: options.now,
    });
    for (const model of group) assignments.set(model.id, id);
  }

  return { assignments, providers };
}
