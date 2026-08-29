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
 * Mapping layer for the models.dev catalog (https://models.dev/api.json,
 * source at https://github.com/anomalyco/models.dev).
 *
 * This is the only place that reads the upstream field names. Everything past
 * it works with `ModelCatalogRecord`, so the product's own wire contracts —
 * protocol family, dialect variant, thinking mode/effort — never become
 * whatever the community catalog happens to call them. Two rules keep the
 * mapping honest:
 *
 *   1. A fact the upstream entry does not carry stays absent, never inferred.
 *      In particular the catalog says nothing about which API protocol or
 *      dialect a model needs, so `apiVariant` comes from the explicit rules
 *      below and from nowhere else.
 *   2. Prices are attributed to exactly the built-in preset whose endpoint the
 *      upstream provider describes. A model rehosted somewhere else keeps its
 *      capability facts and loses the original vendor's prices.
 */

import type { ModelCatalogRecord } from "./model-catalog.js";
import { normalizeCatalogModelId } from "./model-catalog.js";
import type {
  ModelCatalogPricing,
  ModelCatalogThinking,
  ModelProviderPresetId,
} from "./model-provider.js";
import { getModelProviderPreset } from "./model-provider-presets.js";
import type { ModelApiVariant, ModelThinkingEffort } from "./model-usage.js";

/** The subset of a models.dev model entry this product reads. */
export interface ModelsDevModel {
  cost?: { cache_read?: number; input?: number; output?: number };
  id?: string;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  name?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: string[] }>;
}

export interface ModelsDevProvider {
  /** The endpoint this listing describes. Upstream states it for most
   *  providers and omits it for a few; it is the only reliable way to tell two
   *  hosts of the same brand apart, such as Zhipu's open.bigmodel.cn and
   *  Z.AI's api.z.ai. */
  api?: string;
  /** Official vendor page the upstream entry cites for this provider. */
  doc?: string;
  id?: string;
  models?: Record<string, ModelsDevModel>;
  name?: string;
}

/** The whole document: provider id → provider. */
export type ModelsDevPayload = Record<string, ModelsDevProvider>;

/**
 * Which upstream provider describes which built-in preset.
 *
 * Order is precedence for capability facts: the vendor's own listing comes
 * before an aggregator that merely rehosts the model, so a model's context
 * window and thinking capability are read from the vendor entry even when
 * OpenRouter also lists it.
 *
 * Ollama is deliberately absent: our preset is a local endpoint, and the
 * upstream `ollama-cloud` provider describes a paid hosted service whose
 * prices must not be shown for a model running on the user's own machine.
 */
export interface ModelsDevProviderMapping {
  /** Upstream provider id. */
  id: string;
  /**
   * Whether this listing's prices are meant for the preset's endpoint at all.
   *
   * Even when true they are only applied if the listing's own `api` host
   * agrees with the preset's base URL, so a rate published for one host of a
   * brand is never shown for another. When upstream states no `api` there is
   * nothing to disagree with and this flag decides alone.
   */
  pricing: boolean;
  presetId: ModelProviderPresetId;
}

/**
 * Whether a listing's prices may be attributed to a preset's endpoint.
 *
 * Compared by host, not by full URL: one host serves the same account and
 * price list through several paths — MiniMax publishes its
 * Anthropic-compatible path while our preset uses the OpenAI-compatible one —
 * and a price list is per account, not per protocol path.
 */
export function pricesApplyToPreset(upstreamApi: string | undefined, presetBaseUrl: string | undefined): boolean {
  const upstreamHost = endpointHost(upstreamApi);
  const presetHost = endpointHost(presetBaseUrl);
  // Nothing to disagree with: upstream states no endpoint, or one of the two
  // is not a URL we can read.
  if (!upstreamHost || !presetHost) return true;
  return upstreamHost === presetHost;
}

/** Host of an absolute URL, without depending on a `URL` implementation:
 *  this package compiles for both the browser and the control plane and
 *  carries no DOM or Node lib. */
function endpointHost(value: string | undefined): string | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/iu.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const authority = match[1]!;
  const credentials = authority.lastIndexOf("@");
  return (credentials === -1 ? authority : authority.slice(credentials + 1)).toLowerCase() || undefined;
}

export const MODELS_DEV_PROVIDER_MAPPINGS: readonly ModelsDevProviderMapping[] = [
  // --- The vendors that build the models. Listed first so first-publish-wins
  // means the model's own maker describes it. ---
  { id: "openai", presetId: "openai", pricing: true },
  { id: "anthropic", presetId: "anthropic", pricing: true },
  { id: "google", presetId: "gemini", pricing: true },
  { id: "deepseek", presetId: "deepseek", pricing: true },
  // These presets call the mainland endpoints (api.moonshot.cn,
  // api.minimaxi.com, dashscope.aliyuncs.com), so the upstream mainland
  // listing is the one whose price list applies to them.
  { id: "moonshotai-cn", presetId: "moonshot", pricing: true },
  { id: "minimax-cn", presetId: "minimax", pricing: true },
  // Zhipu's two hosts bill separately, and upstream lists them as separate
  // providers whose `api` says which is which. Each preset therefore takes its
  // own listing's prices; the host check above stops one from borrowing the
  // other's should upstream ever merge them.
  { id: "zhipuai", presetId: "zhipu", pricing: true },
  { id: "zai", presetId: "zai", pricing: true },
  // DashScope is the vendor for Qwen but also rehosts other brands — it
  // republishes GLM with a shorter output limit and no effort scale — so it
  // comes after Zhipu. Zhipu publishes no Qwen, so nothing is lost the other
  // way round.
  { id: "alibaba-cn", presetId: "dashscope", pricing: true },

  // --- Aggregators, which rehost other vendors' models. They must come after
  // every vendor above: a rehosted entry often publishes a shorter output
  // limit and a bare `reasoning: true` with no effort scale, and whichever
  // mapping is reached first is the one that keeps the fact. `pricing: false`
  // on a vendor above does not change this — it withholds that vendor's
  // prices, not its capability facts. ---
  { id: "siliconflow-cn", presetId: "siliconflow", pricing: true },
  { id: "openrouter", presetId: "openrouter", pricing: true },
];

/**
 * Wire contracts the product has confirmed against the vendor's endpoint and
 * that the community catalog does not express. These win over the mapped
 * values, so refreshing the catalog can never silently change how a request
 * is encoded.
 */
export interface ModelsDevProtocolOverride {
  apiVariant?: ModelApiVariant;
  /** Normalized model keys this contract applies to. */
  keys: readonly string[];
  thinking?: ModelCatalogThinking;
}

export const MODELS_DEV_PROTOCOL_OVERRIDES: readonly ModelsDevProtocolOverride[] = [
  {
    // Kimi K3 always reasons: its endpoint takes a top-level `reasoning_effort`
    // and no thinking toggle, so the product offers no off state for it.
    // Upstream records a generic toggle, which this contract overrides.
    apiVariant: "kimi-k3",
    keys: ["kimi-k3"],
    thinking: {
      defaultEffort: "max",
      defaultMode: "enabled",
      efforts: ["low", "high", "max"],
      modes: ["enabled"],
      supported: true,
    },
  },
];

const KNOWN_EFFORTS: readonly ModelThinkingEffort[] = ["low", "medium", "high", "xhigh", "max"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function reasoningOptions(model: ModelsDevModel): Array<{ type?: string; values?: string[] }> {
  return Array.isArray(model.reasoning_options) ? model.reasoning_options.filter(isRecord) : [];
}

/**
 * Thinking capability, restricted to what the upstream entry actually states.
 *
 * `modes` is deliberately not derived: upstream enumerates how reasoning is
 * *requested* (a toggle, an effort scale, a token budget) and never states
 * that a model cannot be turned off. Leaving `modes` absent keeps the
 * auto/enabled/disabled contract with the selected protocol dialect, which is
 * where the product's protocol knowledge lives.
 */
export function mapModelsDevThinking(model: ModelsDevModel): ModelCatalogThinking | undefined {
  if (typeof model.reasoning !== "boolean") return undefined;
  if (!model.reasoning) return { supported: false };
  const effortOption = reasoningOptions(model).find((option) => option.type === "effort");
  const efforts = (effortOption?.values ?? [])
    .filter((value): value is ModelThinkingEffort => KNOWN_EFFORTS.includes(value as ModelThinkingEffort));
  return { supported: true, ...(efforts.length ? { efforts } : {}) };
}

/**
 * The Anthropic Messages protocol has two thinking contracts and the upstream
 * entry distinguishes them: a model that only accepts `thinking.budget_tokens`
 * is the legacy dialect, while an effort scale means the adaptive one. Every
 * other provider leaves `apiVariant` unset so the provider's configured
 * dialect applies.
 */
function anthropicVariant(model: ModelsDevModel): ModelApiVariant | undefined {
  const options = reasoningOptions(model);
  const hasBudget = options.some((option) => option.type === "budget_tokens");
  const hasEffort = options.some((option) => option.type === "effort");
  return hasBudget && !hasEffort ? "anthropic-legacy" : undefined;
}

/** Upstream costs are US dollars per million tokens. Absent numbers stay
 *  absent; a model without both an input and an output price gets none. */
function mapPricing(
  model: ModelsDevModel,
  source: { retrievedAt: string; url: string },
): ModelCatalogPricing | undefined {
  if (!isRecord(model.cost)) return undefined;
  const input = nonNegative(model.cost.input);
  const output = nonNegative(model.cost.output);
  if (input === undefined || output === undefined) return undefined;
  const cachedInput = nonNegative(model.cost.cache_read);
  return {
    ...(cachedInput !== undefined ? { cachedInput } : {}),
    currency: "USD",
    input,
    output,
    source,
    unit: "per-1m-tokens",
  };
}

interface DraftRecord {
  apiVariant?: ModelApiVariant;
  contextWindow?: number;
  key: string;
  label: string;
  maxOutputTokens?: number;
  pricing: Partial<Record<ModelProviderPresetId, ModelCatalogPricing>>;
  source: { retrievedAt: string; url: string };
  thinking?: ModelCatalogThinking;
  vision?: boolean;
}

/**
 * Turn one downloaded models.dev document into catalog records.
 *
 * `fetchedAt` is the time of the download the payload came from, so every
 * record and every price carries the same honest retrieval date.
 */
export function mapModelsDevCatalog(
  payload: unknown,
  options: { fetchedAt: string; sourceUrl: string },
): ModelCatalogRecord[] {
  if (!isRecord(payload)) return [];
  const drafts = new Map<string, DraftRecord>();
  for (const mapping of MODELS_DEV_PROVIDER_MAPPINGS) {
    const provider = payload[mapping.id];
    if (!isRecord(provider)) continue;
    const models = provider.models;
    if (!isRecord(models)) continue;
    // Upstream cites the vendor's own page per provider; fall back to the
    // catalog endpoint so a record never claims a source it does not have.
    const url = typeof provider.doc === "string" && provider.doc.trim() ? provider.doc.trim() : options.sourceUrl;
    // Resolved once per provider: whether this listing's rates describe the
    // endpoint our preset actually calls.
    const priceApplies = mapping.pricing
      && pricesApplyToPreset(
        typeof provider.api === "string" ? provider.api : undefined,
        getModelProviderPreset(mapping.presetId)?.baseUrl,
      );
    const source = { retrievedAt: options.fetchedAt, url };
    for (const [entryId, entry] of Object.entries(models)) {
      if (!isRecord(entry)) continue;
      const model = entry as ModelsDevModel;
      const id = typeof model.id === "string" && model.id.trim() ? model.id.trim() : entryId;
      const key = normalizeCatalogModelId(id);
      if (!key) continue;
      let draft = drafts.get(key);
      if (!draft) {
        draft = {
          key,
          label: typeof model.name === "string" && model.name.trim() ? model.name.trim() : key,
          pricing: {},
          source,
        };
        drafts.set(key, draft);
      }
      // Capability facts: the first mapping that publishes one keeps it, so a
      // vendor listing outranks an aggregator that rehosts the same model.
      const limit = isRecord(model.limit) ? model.limit : undefined;
      draft.contextWindow ??= positiveInt(limit?.context);
      draft.maxOutputTokens ??= positiveInt(limit?.output);
      const inputModalities = isRecord(model.modalities) ? model.modalities.input : undefined;
      if (draft.vision === undefined && Array.isArray(inputModalities)) {
        draft.vision = inputModalities.includes("image");
      }
      // A provider that names the effort scale is describing the model's
      // control surface; one that only says `reasoning: true` is silent about
      // it, not contradicting it. Prefer the specific over the silent, so a
      // rehoster's thinner entry cannot erase the scale even if it is reached
      // first. A provider that says the model does not reason at all is never
      // overridden here — that is a claim, not silence.
      const thinking = mapModelsDevThinking(model);
      if (!draft.thinking) draft.thinking = thinking;
      else if (draft.thinking.supported && !draft.thinking.efforts?.length
        && thinking?.supported && thinking.efforts?.length) {
        draft.thinking = thinking;
      }
      if (mapping.presetId === "anthropic") draft.apiVariant ??= anthropicVariant(model);
      if (priceApplies && draft.pricing[mapping.presetId] === undefined) {
        const pricing = mapPricing(model, source);
        if (pricing) draft.pricing[mapping.presetId] = pricing;
      }
    }
  }

  for (const override of MODELS_DEV_PROTOCOL_OVERRIDES) {
    for (const key of override.keys) {
      const draft = drafts.get(key);
      if (!draft) continue;
      if (override.apiVariant) draft.apiVariant = override.apiVariant;
      if (override.thinking) draft.thinking = override.thinking;
    }
  }

  return [...drafts.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((draft) => ({
      ...(draft.apiVariant ? { apiVariant: draft.apiVariant } : {}),
      ...(draft.contextWindow !== undefined ? { contextWindow: draft.contextWindow } : {}),
      key: draft.key,
      label: draft.label,
      ...(draft.maxOutputTokens !== undefined ? { maxOutputTokens: draft.maxOutputTokens } : {}),
      ...(Object.keys(draft.pricing).length ? { pricing: draft.pricing } : {}),
      source: draft.source,
      ...(draft.thinking ? { thinking: draft.thinking } : {}),
      ...(draft.vision !== undefined ? { vision: draft.vision } : {}),
    }));
}
