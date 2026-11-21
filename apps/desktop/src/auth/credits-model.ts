/**
 * Keeps a signed-in HUAWEI account able to chat without manual model setup.
 *
 * The account service is an OpenAI-compatible gateway that bills the caller's
 * credits, so it is registered as an ordinary provider whose token is the
 * user's session token. Runs then take the normal model path; there is no
 * dedicated credit handling in the API.
 */

import {
  addProviderModel,
  createProvider,
  listModels,
  listProviders,
  updateProvider,
} from "../api/models.js";
import type { ModelProvider, ModelProfile } from "../api/types.js";
import type { ApiClient } from "../api/client.js";

import { accountsBaseUrl } from "./account.js";
import type { UserSession } from "./session.js";

/** Fixed name so the provider can be recognized across launches. */
export const CREDITS_PROVIDER_NAME = "华为账号积分";

/** LiteLLM deployment this gateway fronts; used when the gateway lists it. */
const PREFERRED_MODEL = "deepseek-v4.1-flash-1017";

interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
}

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
 * Creates the credits-backed provider when it is missing, or rotates the
 * stored token when it already exists. Other providers do not keep it out of
 * the catalog: a signed-in user can always pick the credits model.
 *
 * Returns the reloaded model list when the UI state must change, and
 * `undefined` when nothing visible changed.
 */
export async function ensureCreditsModel(
  client: ApiClient,
  session: UserSession,
): Promise<ModelProfile[] | undefined> {
  const [models, registry] = await Promise.all([listModels(client), listProviders(client)]);
  const existing = registry.providers.find((provider: ModelProvider) => provider.name === CREDITS_PROVIDER_NAME);
  const modelsOfProvider = existing ? models.filter((model) => model.providerId === existing.id) : [];

  const gatewayModels = await listGatewayModels(session);
  const model = preferredModel(gatewayModels);
  if (!model) throw new Error("the account gateway listed no model");

  if (existing) {
    // The token rotates on every sign-in, so the stored copy is refreshed
    // instead of asking the user to edit the provider by hand.
    await updateProvider(client, existing.id, {
      apiProtocol: "openai-chat-completions",
      apiToken: session.accessToken,
      baseUrl: existing.baseUrl,
      name: existing.name,
    });
    if (modelsOfProvider.some((entry) => entry.model === model)) return undefined;
    await addProviderModel(client, existing.id, { label: model, model });
    return listModels(client);
  }

  const provider = await createProvider(client, {
    apiProtocol: "openai-chat-completions",
    apiToken: session.accessToken,
    baseUrl: `${gatewayBaseUrl()}/v1`,
    name: CREDITS_PROVIDER_NAME,
  });
  await addProviderModel(client, provider.id, { label: model, model });
  return listModels(client);
}
