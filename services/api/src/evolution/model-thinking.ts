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

import {
  DEFAULT_MODEL_API_VARIANT, lookupModelCatalog, THINKING_CONTROL_VARIANTS,
  type ModelProfile,
} from "@sciencediscovery/schema";

/** Why this endpoint cannot be told to stop thinking, or `undefined` if it can. */
export type ThinkingControlGap =
  | "no-control-field"
  | "no-disabled-mode"
  | "declared-unsupported"
  | "model-unsupported";

const ALL_MODES = ["auto", "enabled", "disabled"] as const;
/** Dialects whose toggle has no "disabled" stop: they can be asked to think
 *  harder, not to stop. */
const NO_DISABLED_MODES = ["auto", "enabled"] as const;
const NO_DISABLED_VARIANTS: readonly string[] = ["gemini", "kimi-k3"];

/**
 * Why this endpoint cannot be *told* to stop thinking.
 *
 * The distinction matters to a budget, not to a form: a dialect with no
 * thinking-control field accepts `thinking: {type: "disabled"}` and ignores it,
 * so a run that believes it turned thinking off pays for reasoning it never
 * sees. Measured on a custom gateway: every mutation came back exactly at the
 * quiet 16k per-call ceiling with no content at all.
 *
 * Mapping a field is not enough: `gemini` and `kimi-k3` carry a thinking
 * toggle without a "disabled" stop, so asking them to stop has the same
 * effect as a dialect that never hears the request.
 *
 * The user can overrule the dialect: `facts.thinkingSupported` is a statement
 * that this endpoint does or does not honor the field, and it wins over what
 * the wire protocol suggests.
 */
export function thinkingControlGap(model: ModelProfile | undefined): ThinkingControlGap | undefined {
  if (!model) return undefined;
  const protocol = model.apiProtocol ?? (model.baseUrl.includes("/api/plan")
    ? "anthropic-messages"
    : "openai-chat-completions");
  const variant = model.apiVariant ?? DEFAULT_MODEL_API_VARIANT[protocol];
  if (!THINKING_CONTROL_VARIANTS.includes(variant)) return "no-control-field";
  if (model.facts?.thinkingSupported === false) return "declared-unsupported";
  if (model.facts?.thinkingSupported === true) return undefined;

  const catalog = lookupModelCatalog(model.model)?.thinking;
  if (catalog?.supported === false) return "model-unsupported";
  const modes: readonly string[] = catalog?.modes?.length
    ? catalog.modes
    : NO_DISABLED_VARIANTS.includes(variant) ? NO_DISABLED_MODES : ALL_MODES;
  return modes.includes("disabled") ? undefined : "no-disabled-mode";
}

export function endpointCanDisableThinking(model: ModelProfile | undefined): boolean {
  return thinkingControlGap(model) === undefined;
}
