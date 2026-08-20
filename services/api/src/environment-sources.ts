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
  DEFAULT_ENVIRONMENT_SOURCE_SETTINGS,
  ENVIRONMENT_CONDA_SOURCE_PRESETS,
  ENVIRONMENT_PIP_SOURCE_PRESETS,
  environmentPackageSourcePreset,
  normalizePipIndexUrl,
  type EnvironmentSourceSettings,
  type InstallEnvironmentRequest,
} from "@sciencediscovery/schema";

import type { RunnerInstallEnvironmentRequest } from "./runner-client.js";
import { hasOwn, isRecord } from "./store/catalog.js";

const CONDA_SOURCE_IDS = new Set<string>(ENVIRONMENT_CONDA_SOURCE_PRESETS.map((preset) => preset.id));
const PIP_SOURCE_IDS = new Set<string>(ENVIRONMENT_PIP_SOURCE_PRESETS.map((preset) => preset.id));

function normalizeSourceId<T extends string>(
  value: unknown,
  field: keyof EnvironmentSourceSettings,
  sourceIds: ReadonlySet<string>,
  fallback: T,
  strict: boolean,
): T {
  if (typeof value === "string" && sourceIds.has(value)) return value as T;
  if (strict) throw new Error(`${field} must reference a known package source`);
  return fallback;
}

export function normalizeEnvironmentSourceSettings(
  value: unknown,
  strict = true,
): EnvironmentSourceSettings {
  if (value === undefined || value === null) return structuredClone(DEFAULT_ENVIRONMENT_SOURCE_SETTINGS);
  if (!isRecord(value)) {
    if (strict) throw new Error("Environment source settings must be an object");
    return structuredClone(DEFAULT_ENVIRONMENT_SOURCE_SETTINGS);
  }
  if (strict) {
    const unknown = Object.keys(value).find((key) => key !== "condaSource" && key !== "pipSource");
    if (unknown) throw new Error(`Unknown environment source setting: ${unknown}`);
  }
  return {
    condaSource: hasOwn(value, "condaSource")
      ? normalizeSourceId(
          value.condaSource,
          "condaSource",
          CONDA_SOURCE_IDS,
          DEFAULT_ENVIRONMENT_SOURCE_SETTINGS.condaSource,
          strict,
        )
      : DEFAULT_ENVIRONMENT_SOURCE_SETTINGS.condaSource,
    pipSource: hasOwn(value, "pipSource")
      ? normalizeSourceId(
          value.pipSource,
          "pipSource",
          PIP_SOURCE_IDS,
          DEFAULT_ENVIRONMENT_SOURCE_SETTINGS.pipSource,
          strict,
        )
      : DEFAULT_ENVIRONMENT_SOURCE_SETTINGS.pipSource,
  };
}

export function resolveEnvironmentInstallRequest(
  input: InstallEnvironmentRequest,
  settings: EnvironmentSourceSettings,
  workspaceRoot?: string,
): RunnerInstallEnvironmentRequest {
  const manager = input.manager ?? "conda";
  const base = {
    manager,
    packages: input.packages,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  };

  if (manager === "pip") {
    if (input.channels?.length) throw new Error("channels can only be used with manager=conda");
    const indexUrl = normalizePipIndexUrl(
      input.indexUrl ?? environmentPackageSourcePreset(settings.pipSource).pipIndexUrl,
    );
    return { ...base, indexUrl };
  }

  if (input.indexUrl !== undefined) throw new Error("indexUrl can only be used with manager=pip");
  if (manager === "conda") {
    const channels = input.channels?.length
      ? input.channels
      : [...environmentPackageSourcePreset(settings.condaSource).condaChannels];
    return { ...base, channels };
  }

  return {
    ...base,
    ...(input.channels?.length ? { channels: input.channels } : {}),
  };
}
