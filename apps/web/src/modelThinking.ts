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
  ModelProfile,
  ModelProvider,
  ModelThinkingEffort,
  ModelThinkingMode,
} from "@sciencediscovery/schema";
import {
  DEFAULT_MODEL_API_VARIANT,
  constrainCatalogThinking,
  lookupModelCatalog,
  THINKING_CONTROL_VARIANTS,
  THINKING_EFFORT_VARIANTS,
} from "@sciencediscovery/schema";

export interface ModelThinkingControls {
  efforts: ModelThinkingEffort[];
  legacyBudget: boolean;
  modes: ModelThinkingMode[];
  supported: boolean;
}

export interface ModelThinkingNormalization {
  thinkingEffort?: ModelThinkingEffort;
  thinkingMode?: ModelThinkingMode;
}

const DEFAULT_MODES: ModelThinkingMode[] = ["auto", "enabled", "disabled"];

export function modelVariantThinkingControls(
  modelId: string,
  variant: ModelProfile["apiVariant"],
): ModelThinkingControls {
  const catalog = lookupModelCatalog(modelId);
  const effectiveVariant = catalog?.apiVariant ?? variant;
  if (!effectiveVariant || !THINKING_CONTROL_VARIANTS.includes(effectiveVariant)) {
    return { efforts: [], legacyBudget: false, modes: [], supported: false };
  }
  if (catalog?.thinking?.supported === false) {
    return { efforts: [], legacyBudget: false, modes: [], supported: false };
  }
  const modes = catalog?.thinking?.modes
    ?? (["gemini", "kimi-k3"].includes(effectiveVariant) ? ["auto", "enabled"] : DEFAULT_MODES);
  let efforts = catalog?.thinking?.efforts ?? [];
  if (!catalog?.thinking && THINKING_EFFORT_VARIANTS.includes(effectiveVariant)) {
    if (effectiveVariant === "gemini") efforts = ["low", "medium", "high"];
    else if (effectiveVariant === "responses") efforts = ["low", "medium", "high", "xhigh", "max"];
    else if (effectiveVariant === "anthropic-adaptive") efforts = ["low", "medium", "high", "max"];
    else if (effectiveVariant === "kimi-k3") efforts = ["low", "high", "max"];
    else efforts = ["high", "max"];
  }
  return {
    efforts: [...efforts],
    legacyBudget: effectiveVariant === "anthropic-legacy",
    modes: [...modes],
    supported: true,
  };
}

/** Resolve only capabilities that can be translated onto the selected wire
 * protocol. Catalog facts narrow a known model; custom endpoints fall back to
 * the explicitly selected dialect instead of claiming facts about the model. */
export function modelThinkingControls(
  model: ModelProfile | undefined,
  providers: readonly ModelProvider[],
): ModelThinkingControls {
  if (!model) return { efforts: [], legacyBudget: false, modes: [], supported: false };
  const protocol = model.apiProtocol ?? (model.baseUrl.includes("/api/plan")
    ? "anthropic-messages"
    : "openai-chat-completions");
  const variant = model.apiVariant ?? DEFAULT_MODEL_API_VARIANT[protocol];
  const provider = providers.find((candidate) => candidate.id === model.providerId);
  const catalog = lookupModelCatalog(model.model, provider?.presetId);
  return modelVariantThinkingControls(model.model, catalog?.apiVariant ?? variant);
}

/** Return only fields whose persisted Session value is illegal for the
 * selected model. The caller can PATCH these fields together with modelId so
 * the UI, a page refresh, and the next Run all observe the same value. */
export function normalizeSessionThinking(
  model: ModelProfile | undefined,
  providers: readonly ModelProvider[],
  mode: ModelThinkingMode | undefined,
  effort: ModelThinkingEffort | undefined,
): ModelThinkingNormalization {
  if (!model) return {};
  const controls = modelThinkingControls(model, providers);
  if (!controls.supported) {
    return mode && mode !== "auto" ? { thinkingMode: "auto" } : {};
  }
  const constrained = constrainCatalogThinking(model.model, mode, effort);
  const update: ModelThinkingNormalization = {};
  if (mode !== undefined && !controls.modes.includes(mode)) update.thinkingMode = constrained.mode;
  if (effort !== undefined && controls.efforts.length && !controls.efforts.includes(effort)) {
    update.thinkingEffort = constrained.effort;
  }
  return update;
}
