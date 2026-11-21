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
 * Keeps a signed-in HUAWEI account able to chat without any manual model setup.
 *
 * The account service is an OpenAI-compatible gateway that bills the caller's
 * credits, so it is registered as an ordinary provider whose token is the
 * user's session token. Runs then take the normal model path; no dedicated
 * credit handling exists in the API.
 *
 * Provisioning only happens when the user has no model at all: an existing
 * configuration is never replaced, and the token on the managed provider is
 * refreshed so a re-login does not require the user to paste it again.
 */

import type { ModelProfile } from "@sciencediscovery/schema";

import type { ApiClient } from "../api.js";
import { accountsBaseUrl } from "./account.js";
import type { UserSession } from "./session.js";

/** Fixed name so the provider can be recognized across launches. */
export const CREDITS_PROVIDER_NAME = "华为账号积分";

/** LiteLLM deployment this gateway fronts; used when the gateway lists it. */
const PREFERRED_MODEL = "deepseek-v4.1-flash-1017";

type ModelsResponse = { data?: Array<{ id?: unknown }> };

/** Asks the account gateway which models the signed-in user may call. */
async function listGatewayModels(session: UserSession): Promise<string[]> {
  const response = await fetch(`${accountsBaseUrl()}/v1/models`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw new Error(`account gateway returned ${response.status}`);
  const body = (await response.json()) as ModelsResponse;
  return (body.data ?? [])
    .map((entry) => (typeof entry.id === "string" ? entry.id.trim() : ""))
    .filter(Boolean);
}

/** Absolute gateway root; the API requires a full origin for provider URLs. */
function gatewayBaseUrl(): string {
  return accountsBaseUrl() || window.location.origin;
}

function preferredModel(ids: string[]): string | undefined {
  return ids.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : ids[0];
}

/**
 * Creates the credits-backed provider and model when the user has none, or
 * rotates the stored token when the provider already exists.
 *
 * Returns the reloaded model list when the UI state must change, and
 * `undefined` when nothing visible changed.
 */
export async function ensureCreditsModel(client: ApiClient, session: UserSession): Promise<ModelProfile[] | undefined> {
  const [models, registry] = await Promise.all([client.listModels(), client.listProviders()]);
  const existing = registry.providers.find((provider) => provider.name === CREDITS_PROVIDER_NAME);
  const modelsOfProvider = existing ? models.filter((model) => model.providerId === existing.id) : [];
  if (!existing && models.length > 0) return undefined;

  const gatewayModels = await listGatewayModels(session);
  const model = preferredModel(gatewayModels);
  if (!model) throw new Error("the account gateway listed no model");

  if (existing) {
    // The token rotates on every sign-in, so the stored copy is refreshed
    // instead of asking the user to edit the provider by hand.
    await client.updateProvider(existing.id, { apiToken: session.accessToken });
    if (modelsOfProvider.some((entry) => entry.model === model)) return undefined;
    await client.addProviderModel(existing.id, { label: model, model, setGlobalDefault: models.length === 0 });
    return client.listModels();
  }

  const provider = await client.createProvider({
    apiProtocol: "openai-chat-completions",
    apiToken: session.accessToken,
    baseUrl: `${gatewayBaseUrl()}/v1`,
    name: CREDITS_PROVIDER_NAME,
  });
  await client.addProviderModel(provider.id, { label: model, model, setGlobalDefault: true });
  return client.listModels();
}
