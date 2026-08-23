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
  lookupModelCatalog,
  THINKING_CONTROL_VARIANTS,
  THINKING_EFFORT_VARIANTS,
} from "@sciencediscovery/schema";

export interface ModelThinkingControls {
  efforts: ModelThinkingEffort[];
  modes: ModelThinkingMode[];
  supported: boolean;
}

const DEFAULT_MODES: ModelThinkingMode[] = ["auto", "enabled", "disabled"];

/** Resolve only capabilities that can be translated onto the selected wire
 * protocol. Catalog facts narrow a known model; custom endpoints fall back to
 * the explicitly selected dialect instead of claiming facts about the model. */
export function modelThinkingControls(
  model: ModelProfile | undefined,
  providers: readonly ModelProvider[],
): ModelThinkingControls {
  if (!model) return { efforts: [], modes: [], supported: false };
  const protocol = model.apiProtocol ?? (model.baseUrl.includes("/api/plan")
    ? "anthropic-messages"
    : "openai-chat-completions");
  const variant = model.apiVariant ?? DEFAULT_MODEL_API_VARIANT[protocol];
  if (!THINKING_CONTROL_VARIANTS.includes(variant)) {
    return { efforts: [], modes: [], supported: false };
  }
  const provider = providers.find((candidate) => candidate.id === model.providerId);
  const catalog = lookupModelCatalog(model.model, provider?.presetId);
  if (catalog?.thinking?.supported === false) {
    return { efforts: [], modes: [], supported: false };
  }
  const modes = catalog?.thinking?.modes
    ?? (variant === "gemini" ? ["auto", "enabled"] : DEFAULT_MODES);
  let efforts = catalog?.thinking?.efforts ?? [];
  if (!catalog?.thinking && THINKING_EFFORT_VARIANTS.includes(variant)) {
    if (variant === "gemini") efforts = ["low", "medium", "high"];
    else if (variant === "anthropic-adaptive" || variant === "responses") efforts = ["low", "medium", "high", "max"];
    else efforts = ["high", "max"];
  }
  return { efforts: [...efforts], modes: [...modes], supported: true };
}
