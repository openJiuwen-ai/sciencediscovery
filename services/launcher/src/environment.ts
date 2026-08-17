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

export type CompatibilityLog = (message: string) => void;

/**
 * Resolve a renamed environment variable without exposing its value in logs.
 * The new name is authoritative; the legacy name remains a visible fallback.
 */
export function renamedEnvironmentValue(
  env: NodeJS.ProcessEnv,
  currentName: string,
  legacyName: string,
  log?: CompatibilityLog,
): string | undefined {
  const current = env[currentName]?.trim();
  const legacy = env[legacyName]?.trim();
  if (current) {
    if (legacy) {
      log?.(`[compat] Both ${currentName} and ${legacyName} are set; ${currentName} takes precedence.`);
    }
    return current;
  }
  if (legacy) {
    log?.(`[compat] ${legacyName} is deprecated; using its value as ${currentName}.`);
    return legacy;
  }
  return undefined;
}

export function hasRenamedEnvironmentValue(
  env: NodeJS.ProcessEnv,
  currentName: string,
  legacyName: string,
): boolean {
  return Boolean(env[currentName]?.trim() || env[legacyName]?.trim());
}
