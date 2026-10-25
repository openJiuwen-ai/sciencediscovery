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
 * Browser-side storage, tolerating a storage that refuses to work.
 *
 * Private windows and a full quota both make `localStorage` throw rather than
 * return null. That must degrade to "the setting did not stick", never to a
 * blank screen, so every access goes through here.
 */

export interface ReadableStorage {
  getItem(key: string): string | null;
  removeItem?(key: string): void;
  setItem(key: string, value: string): void;
}

const LEGACY_PREFIX = "science-agent";
const CURRENT_PREFIX = "sciencediscovery";

/**
 * The token key is not this app's to choose: `test/e2e-auth.ts` hardcodes it,
 * and the Electron shell injects the credential through the same fragment. It
 * is also the one key shared with `apps/web`, which is what lets a user move
 * between the two front ends on the same origin without signing in twice.
 */
export const TOKEN_STORAGE_KEY = `${CURRENT_PREFIX}-token`;

/** Everything else this app stores is namespaced separately, so a future shape
 *  change cannot collide with a key `apps/web` already owns. */

export const RIGHT_PANEL_STORAGE_KEY = `${CURRENT_PREFIX}-desktop:right-panel`;
/** The interface language picked in 设置 › 通用. Namespaced rather than shared
 *  with `apps/web`: the two front ends may be read on the same origin, and a
 *  choice made here should not reword the other one without being asked. */
export const LOCALE_STORAGE_KEY = `${CURRENT_PREFIX}-desktop:locale`;
/** How wide the user dragged the workspace panel, in CSS pixels. */
export const PANEL_WIDTH_STORAGE_KEY = `${CURRENT_PREFIX}-desktop:panel-width`;

function safeRead(storage: ReadableStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(storage: ReadableStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // A rejected write means the preference is ephemeral, not that the app is broken.
  }
}

/**
 * Read a key that was renamed from the `science-agent` prefix, importing the
 * old value once. Only the token has a legacy spelling; it is the one that
 * existed before the rename.
 */
export function readRenamedStorageItem(storage: ReadableStorage, key: string): string | null {
  const current = safeRead(storage, key);
  if (current !== null) return current;
  if (!key.startsWith(`${CURRENT_PREFIX}-`)) return null;
  const legacy = `${LEGACY_PREFIX}${key.slice(CURRENT_PREFIX.length)}`;
  const value = safeRead(storage, legacy);
  if (value === null) return null;
  safeWrite(storage, key, value);
  try {
    storage.removeItem?.(legacy);
  } catch {
    // Keeping the stale key is harmless; it is never read again once the new one exists.
  }
  return value;
}

export function readStoredText(storage: ReadableStorage, key: string): string | null {
  return readRenamedStorageItem(storage, key);
}

export function writeStoredText(storage: ReadableStorage, key: string, value: string): void {
  safeWrite(storage, key, value);
}

export function readStoredFlag(storage: ReadableStorage, key: string): boolean {
  return safeRead(storage, key) === "1";
}

export function writeStoredFlag(storage: ReadableStorage, key: string, value: boolean): void {
  safeWrite(storage, key, value ? "1" : "0");
}

/** Read a JSON-valued preference, falling back when it is absent or damaged. */
export function readStoredJson<T>(storage: ReadableStorage, key: string, fallback: T): T {
  const raw = safeRead(storage, key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStoredJson(storage: ReadableStorage, key: string, value: unknown): void {
  safeWrite(storage, key, JSON.stringify(value));
}
