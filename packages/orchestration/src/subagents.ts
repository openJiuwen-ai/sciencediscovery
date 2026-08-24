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

import type { SubagentInput } from "@sciencediscovery/schema";

export interface SubagentPreset {
  description: string;
  disallowedTools: readonly string[];
  maxTurns: number;
  name: string;
  systemPrompt: string;
  timeoutSeconds: number;
  tools: readonly string[] | null;
}

export interface ResolvedSubagentConfig extends SubagentPreset {
  maxTurns: number;
  timeoutSeconds: number;
  tools: readonly string[] | null;
}

export const DEFAULT_SUBAGENT_MAX_TURNS = 300;
export const DEFAULT_SUBAGENT_TIMEOUT_SECONDS = 7_200;
export const MAX_SUBAGENT_MAX_TURNS = 1_000;
export const MAX_SUBAGENT_TIMEOUT_SECONDS = 14_400;

export const GENERAL_PURPOSE_SUBAGENT: SubagentPreset = {
  description: "A capable subagent for complex, multi-step tasks that require exploration and action.",
  disallowedTools: ["task", "propose_plan", "propose_remote_job"],
  maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
  name: "general-purpose",
  systemPrompt: [
    "You are a general-purpose subagent working on a delegated task.",
    "Complete the task autonomously with the available tools and return a clear, concise result.",
    "Do not ask for clarification and do not dispatch another subagent.",
  ].join(" "),
  timeoutSeconds: DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
  tools: null,
};

const SUBAGENT_TYPE_ALIASES = new Map<string, string>([
  ["general", GENERAL_PURPOSE_SUBAGENT.name],
]);

const SUBAGENT_PRESETS = new Map<string, SubagentPreset>([
  [GENERAL_PURPOSE_SUBAGENT.name, GENERAL_PURPOSE_SUBAGENT],
]);

function boundedInteger(value: number | undefined, fallback: number, maximum: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function budgetAtLeastPresetDefault(value: number, presetDefault: number, allowBelowDefault: boolean): number {
  return allowBelowDefault ? value : Math.max(value, presetDefault);
}

export function resolveSubagentConfig(input: SubagentInput): ResolvedSubagentConfig {
  const rawRequestedName = input.subagentType?.trim();
  const requestedName = rawRequestedName || GENERAL_PURPOSE_SUBAGENT.name;
  const name = SUBAGENT_TYPE_ALIASES.get(requestedName) ?? requestedName;
  const preset = SUBAGENT_PRESETS.get(name) ?? GENERAL_PURPOSE_SUBAGENT;
  const allowBelowDefault = rawRequestedName === GENERAL_PURPOSE_SUBAGENT.name || rawRequestedName === "general";
  const maxTurns = boundedInteger(input.maxTurns, preset.maxTurns, MAX_SUBAGENT_MAX_TURNS, "maxTurns");
  const timeoutSeconds = boundedInteger(input.timeoutSeconds, preset.timeoutSeconds, MAX_SUBAGENT_TIMEOUT_SECONDS, "timeoutSeconds");
  return {
    ...preset,
    maxTurns: budgetAtLeastPresetDefault(maxTurns, preset.maxTurns, allowBelowDefault),
    timeoutSeconds: budgetAtLeastPresetDefault(timeoutSeconds, preset.timeoutSeconds, allowBelowDefault),
    tools: input.tools === undefined ? preset.tools : input.tools,
  };
}

export function listSubagentPresets(): SubagentPreset[] {
  return [...SUBAGENT_PRESETS.values()];
}
