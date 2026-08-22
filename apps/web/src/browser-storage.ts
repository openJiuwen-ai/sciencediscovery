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
 * Local-storage keys for browser-side state: the access token, the locale, and
 * the workspace panel layout.
 *
 * The keys were renamed from the `science-agent` prefix to `sciencediscovery`.
 * A browser that already holds the former keys must not silently lose its
 * token or its panel layout on upgrade, so reads fall back to the former key
 * and move the value across once. Writes only ever use the current key.
 */

const LEGACY_PREFIX = "science-agent";
const CURRENT_PREFIX = "sciencediscovery";

export const TOKEN_STORAGE_KEY = `${CURRENT_PREFIX}-token`;
export const LOCALE_STORAGE_KEY = `${CURRENT_PREFIX}-locale`;
export const WORKSPACE_COLLAPSED_STORAGE_KEY = `${CURRENT_PREFIX}-workspace-collapsed`;
export const WORKSPACE_WIDTH_STORAGE_KEY = `${CURRENT_PREFIX}-workspace-width`;
export const SHOW_PHYSICAL_FILES_STORAGE_KEY = `${CURRENT_PREFIX}-show-physical-files`;

/** Former spelling of a current key, or undefined when the key is not renamed. */
export function legacyStorageKey(key: string): string | undefined {
  if (!key.startsWith(`${CURRENT_PREFIX}-`) && !key.startsWith(`${CURRENT_PREFIX}:`)) return undefined;
  return `${LEGACY_PREFIX}${key.slice(CURRENT_PREFIX.length)}`;
}

/**
 * Storage surface used here; `Storage` itself is wider than these reads need.
 * `removeItem` is optional so narrower in-memory fakes stay usable.
 */
export interface ReadableStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * Read a renamed key, importing the former key's value once when only that one
 * exists. A storage that rejects writes (private mode, quota) still reads.
 */
export function readRenamedStorageItem(storage: ReadableStorage, key: string): string | null {
  const current = storage.getItem(key);
  if (current !== null) return current;
  const legacy = legacyStorageKey(key);
  if (!legacy) return null;
  const value = storage.getItem(legacy);
  if (value === null) return null;
  try {
    storage.setItem(key, value);
    storage.removeItem?.(legacy);
  } catch {
    // Keep serving the value even when the import cannot be persisted.
  }
  return value;
}
