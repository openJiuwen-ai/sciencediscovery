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

import type { ModelProfile, ModelProvider } from "../api/types.js";

/**
 * The logos the model menu ships, one per brand. A model with no recognisable
 * brand still gets an icon — the neutral one — so every row starts at the same
 * place and the list reads as a column.
 */
export type ModelBrand =
  | "anthropic"
  | "dashscope"
  | "deepseek"
  | "minimax"
  | "moonshot"
  | "openai"
  | "zhipu"
  | "custom";

/** Presets whose brand has its own mark. The rest — gemini, ollama,
 *  openrouter, siliconflow — were not in the handoff, and borrowing another
 *  company's logo would be worse than the neutral one. */
const PRESET_BRANDS: Partial<Record<string, ModelBrand>> = {
  anthropic: "anthropic",
  dashscope: "dashscope",
  deepseek: "deepseek",
  minimax: "minimax",
  moonshot: "moonshot",
  openai: "openai",
  // Z.ai is 智谱's international brand, so the two share a mark.
  zai: "zhipu",
  zhipu: "zhipu",
};

/** What is left to go on when the provider is not a preset: a standalone
 *  profile, one saved before providers existed, or a custom gateway. */
const NAME_HINTS: ReadonlyArray<readonly [RegExp, ModelBrand]> = [
  [/deepseek/iu, "deepseek"],
  [/minimax|abab/iu, "minimax"],
  [/kimi|moonshot/iu, "moonshot"],
  [/glm|zhipu|z\.ai|智谱/iu, "zhipu"],
  [/qwen|qwq|dashscope|通义|百炼/iu, "dashscope"],
  [/claude|anthropic/iu, "anthropic"],
  [/(?:^|[^a-z])o[1-9](?:[^0-9]|$)|gpt|davinci|openai/iu, "openai"],
];

/**
 * The brand mark for a model row.
 *
 * The provider is the first authority: it knows which preset it was created
 * from. A custom gateway knows nothing useful — it can be pointed at any
 * vendor's endpoint — so those rows fall back to reading the names, which is
 * also all a standalone profile has. Whatever nothing recognises gets the
 * neutral mark.
 */
export function modelBrand(
  model: Pick<ModelProfile, "model" | "name" | "providerId">,
  providers: readonly ModelProvider[] = [],
): ModelBrand {
  const provider =
    model.providerId === undefined
      ? undefined
      : providers.find((candidate) => candidate.id === model.providerId);
  const preset = provider?.presetId;
  const known = preset === undefined ? undefined : PRESET_BRANDS[preset];
  if (known !== undefined) return known;
  const haystack = `${provider?.name ?? ""} ${model.name} ${model.model}`;
  for (const [pattern, brand] of NAME_HINTS) {
    if (pattern.test(haystack)) return brand;
  }
  return "custom";
}
