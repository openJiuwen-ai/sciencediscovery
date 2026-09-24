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
 * Saved Git import locations for the Skills quick-import flow. Presets are a
 * browser-side convenience (not a source of truth), so they live in local
 * storage: most-recently-used first, capped, and silently dropped when the
 * stored payload cannot be parsed or the storage rejects writes.
 */

import { readRenamedStorageItem, SKILL_GIT_IMPORT_PRESETS_STORAGE_KEY, type ReadableStorage } from "./browser-storage.js";

export interface SkillGitImportPreset {
  label: string;
  ref?: string;
  repositoryUrl: string;
  subdirectory?: string;
}

const MAX_PRESETS = 10;

function sanitizePreset(value: unknown): SkillGitImportPreset | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const repositoryUrl = typeof record.repositoryUrl === "string" ? record.repositoryUrl.trim() : "";
  if (!repositoryUrl) return undefined;
  const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : repositoryUrl;
  const ref = typeof record.ref === "string" && record.ref.trim() ? record.ref.trim() : undefined;
  const subdirectory = typeof record.subdirectory === "string" && record.subdirectory.trim() ? record.subdirectory.trim() : undefined;
  return {
    label,
    repositoryUrl,
    ...(ref ? { ref } : {}),
    ...(subdirectory ? { subdirectory } : {}),
  };
}

export function loadImportPresets(storage: ReadableStorage): SkillGitImportPreset[] {
  const raw = readRenamedStorageItem(storage, SKILL_GIT_IMPORT_PRESETS_STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const presets: SkillGitImportPreset[] = [];
  for (const entry of parsed) {
    const preset = sanitizePreset(entry);
    if (preset && !presets.some((candidate) => candidate.repositoryUrl === preset.repositoryUrl)) {
      presets.push(preset);
    }
    if (presets.length >= MAX_PRESETS) break;
  }
  return presets;
}

export function saveImportPresets(storage: ReadableStorage, presets: SkillGitImportPreset[]): void {
  try {
    storage.setItem(SKILL_GIT_IMPORT_PRESETS_STORAGE_KEY, JSON.stringify(presets.slice(0, MAX_PRESETS)));
  } catch {
    // Private mode or quota exceeded: presets stay a session-only convenience.
  }
}

/** Move `preset` to the front (most recently used), keeping at most {@link MAX_PRESETS} entries. */
export function addImportPreset(storage: ReadableStorage, preset: SkillGitImportPreset): SkillGitImportPreset[] {
  const next = [
    preset,
    ...loadImportPresets(storage).filter((candidate) => candidate.repositoryUrl !== preset.repositoryUrl),
  ].slice(0, MAX_PRESETS);
  saveImportPresets(storage, next);
  return next;
}
