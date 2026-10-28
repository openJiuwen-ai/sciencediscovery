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

import type { ApiClient } from "./client.js";
import type {
  CreateModelProviderRequest,
  GlobalSettings,
  ModelConnectivityTestResult,
  ModelProfile,
  ModelProvider,
  ProviderCatalog,
  ProviderModelList,
  ProviderModelPreview,
  RuntimeSettingsOverrides,
} from "./types.js";

/** `GET /health` and `GET /api/health` share one handler, and it sits ahead of
 *  the `/api/` token gate — so this doubles as a liveness probe that works
 *  before a token is known. It does NOT check the token: a 200 here means "the
 *  backend is up", never "you are authenticated". */
export interface HealthReport {
  memoryGraph?: string;
  // The route forwards the runner's own health body, which carries the
  // execution capability the first-run self-check gates on.
  runner?: { execution?: { ready?: boolean }; status?: string };
  service?: string;
  status?: string;
}

export function getHealth(client: ApiClient, signal?: AbortSignal): Promise<HealthReport> {
  return client.request<HealthReport>("/api/health", signal ? { signal } : {});
}

/** `{presets, providers}`. The preset list comes from the server on purpose:
 *  importing `MODEL_PROVIDER_PRESETS` from the schema would pull the whole
 *  schema barrel into the bundle for a constant. */
export function listProviders(client: ApiClient): Promise<ProviderCatalog> {
  return client.request<ProviderCatalog>("/api/providers");
}

export function listModels(client: ApiClient): Promise<ModelProfile[]> {
  return client.request<ModelProfile[]>("/api/models");
}

/**
 * Point one profile at a model, and name it.
 *
 * `PUT /api/models/:id` is a whole-record write, not a patch: the body goes
 * through the same validation a new profile does, so an omitted field falls
 * back to its default rather than to its stored value — an absent `vision`
 * would turn vision off, and an absent protocol would be re-derived from the
 * URL. Everything whose default differs from what is stored is therefore sent
 * back as it was read. `facts`, the token and the proxy policy are left out on
 * purpose: absent keeps the stored value for each of them.
 *
 * The service locks `baseUrl` and the protocol to the provider, so a provider
 * model can change which model it calls but not where it calls it.
 */
export function updateModel(
  client: ApiClient,
  profile: ModelProfile,
  change: { model: string; name: string },
): Promise<ModelProfile> {
  return client.request<ModelProfile>(`/api/models/${encodeURIComponent(profile.id)}`, {
    body: JSON.stringify({
      apiProtocol: profile.apiProtocol,
      apiVariant: profile.apiVariant,
      baseUrl: profile.baseUrl,
      model: change.model,
      name: change.name,
      thinkingEffort: profile.thinkingEffort,
      thinkingMode: profile.thinkingMode,
      vision: profile.vision,
    }),
    method: "PUT",
  });
}

export function createProvider(
  client: ApiClient,
  body: CreateModelProviderRequest,
): Promise<ModelProvider> {
  return client.request<ModelProvider>("/api/providers", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

export function updateProvider(
  client: ApiClient,
  providerId: string,
  body: CreateModelProviderRequest,
): Promise<ModelProvider> {
  return client.request<ModelProvider>(`/api/providers/${encodeURIComponent(providerId)}`, {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

/**
 * List the models of a provider that has not been saved yet.
 *
 * This is the listing the wizard uses: it sends the endpoint and the key from
 * the form, persists nothing, and caches nothing, so a half-filled
 * configuration cannot leave a stray provider behind.
 */
export function previewProviderModels(
  client: ApiClient,
  body: CreateModelProviderRequest,
): Promise<ProviderModelPreview> {
  return client.request<ProviderModelPreview>("/api/providers/preview-models", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

/** Add one model to a saved provider. Only `model` is required — connection
 *  fields belong to the provider, which is what keeps a hand-typed model on
 *  the same wire contract as a discovered one. */
export function addProviderModel(
  client: ApiClient,
  providerId: string,
  body: { label?: string; model: string; vision?: boolean },
): Promise<ModelProfile> {
  return client.request<ModelProfile>(`/api/providers/${encodeURIComponent(providerId)}/models`, {
    body: JSON.stringify(body),
    method: "POST",
  });
}

/**
 * What a saved provider's own listing endpoint reports.
 *
 * The entries carry `profileId` for the models this installation has already
 * added, which is what lets a row say 已添加 rather than 添加模型. `refresh`
 * bypasses the server's short-lived cache; the cache exists so two reads in one
 * visit do not spend a request on the vendor.
 */
export function listProviderModels(
  client: ApiClient,
  providerId: string,
  refresh = false,
): Promise<ProviderModelList> {
  const query = refresh ? "?refresh=1" : "";
  return client.request<ProviderModelList>(
    `/api/providers/${encodeURIComponent(providerId)}/models${query}`,
  );
}

/** Remove one model profile. The service refuses while any settings or session
 *  still names it, which comes back as an error rather than a silent no-op. */
export function deleteModel(client: ApiClient, modelId: string): Promise<{ deleted: string }> {
  return client.request<{ deleted: string }>(`/api/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
}

/**
 * The server calls the check itself, so it asks the caller to state that the
 * synthetic requests may cost tokens. Every call site here is a button the
 * user pressed, which is the consent it is asking for.
 */
export function testModel(
  client: ApiClient,
  modelId: string,
  compatibility = false,
): Promise<ModelConnectivityTestResult> {
  return client.request<ModelConnectivityTestResult>(
    `/api/models/${encodeURIComponent(modelId)}/test`,
    { body: JSON.stringify({ compatibility, consent: true }), method: "POST" },
  );
}

export function getSettings(client: ApiClient): Promise<GlobalSettings> {
  return client.request<GlobalSettings>("/api/settings");
}

/**
 * Replace the global settings layer.
 *
 * This is a whole-object write, not a patch: anything absent from `overrides`
 * is erased, including connector, skill and plugin selections that this app
 * never shows. Callers must read the current value first and send it back with
 * only the field they meant to change — see `setGlobalModel`.
 */
export function putSettings(
  client: ApiClient,
  overrides: RuntimeSettingsOverrides,
): Promise<GlobalSettings> {
  return client.request<GlobalSettings>("/api/settings", {
    body: JSON.stringify(overrides),
    method: "PUT",
  });
}

/**
 * Point the global default at one profile, preserving every other override.
 *
 * The read is not an optimisation to skip: `PUT /api/settings` normalizes the
 * body through the live model catalog and drops an unknown `modelId`, so a
 * profile that does not exist yet cannot be selected — the order is always
 * create profile, then set default, then create sessions.
 */
export async function setGlobalModel(client: ApiClient, modelId: string): Promise<GlobalSettings> {
  const current = await getSettings(client);
  return putSettings(client, { ...current.overrides, modelId });
}
