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
  /** Whether the upstream prices apply to the preset's own endpoint. */
  pricing: boolean;
  presetId: ModelProviderPresetId;
}

export const MODELS_DEV_PROVIDER_MAPPINGS: readonly ModelsDevProviderMapping[] = [
  { id: "openai", presetId: "openai", pricing: true },
  { id: "anthropic", presetId: "anthropic", pricing: true },
  { id: "google", presetId: "gemini", pricing: true },
  { id: "deepseek", presetId: "deepseek", pricing: true },
  // These four presets call the mainland endpoints (api.moonshot.cn,
  // api.minimaxi.com, dashscope.aliyuncs.com, api.siliconflow.cn), so the
  // upstream mainland listing is the one whose price list applies to them.
  { id: "moonshotai-cn", presetId: "moonshot", pricing: true },
  { id: "minimax-cn", presetId: "minimax", pricing: true },
  { id: "alibaba-cn", presetId: "dashscope", pricing: true },
  { id: "siliconflow-cn", presetId: "siliconflow", pricing: true },
  // Upstream only lists Zhipu's international host (z.ai) while our preset
  // calls open.bigmodel.cn. The models are still worth suggesting; their
  // prices belong to the other host and are not attributed here.
  { id: "zhipuai", presetId: "zhipu", pricing: false },
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
  presets: ModelProviderPresetId[];
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
          presets: [],
          pricing: {},
          source,
        };
        drafts.set(key, draft);
      }
      if (!draft.presets.includes(mapping.presetId)) draft.presets.push(mapping.presetId);
      // Capability facts: the first mapping that publishes one keeps it, so a
      // vendor listing outranks an aggregator that rehosts the same model.
      const limit = isRecord(model.limit) ? model.limit : undefined;
      draft.contextWindow ??= positiveInt(limit?.context);
      draft.maxOutputTokens ??= positiveInt(limit?.output);
      const inputModalities = isRecord(model.modalities) ? model.modalities.input : undefined;
      if (draft.vision === undefined && Array.isArray(inputModalities)) {
        draft.vision = inputModalities.includes("image");
      }
      draft.thinking ??= mapModelsDevThinking(model);
      if (mapping.presetId === "anthropic") draft.apiVariant ??= anthropicVariant(model);
      if (mapping.pricing && draft.pricing[mapping.presetId] === undefined) {
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
      ...(draft.presets.length ? { presets: draft.presets } : {}),
      ...(Object.keys(draft.pricing).length ? { pricing: draft.pricing } : {}),
      source: draft.source,
      ...(draft.thinking ? { thinking: draft.thinking } : {}),
      ...(draft.vision !== undefined ? { vision: draft.vision } : {}),
    }));
}
