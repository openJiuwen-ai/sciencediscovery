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
 * The active language, and the `TEXT` every component reads.
 *
 * `TEXT` is a proxy rather than a plain object so `TEXT.composer.send` is
 * resolved against whichever dictionary is current at the moment the
 * component renders. Reading it at module scope would freeze a language; the
 * components therefore read it inside their render functions, and App
 * subscribes to the store so a change re-renders the tree.
 */

import { LOCALE_STORAGE_KEY, readStoredText, writeStoredText } from "./state/storage.js";
import { EN } from "./text/en.js";
import { ZH, type Text } from "./text/zh.js";

export type Language = "zh-CN" | "en";

const DICTIONARIES: Record<Language, Text> = { "zh-CN": ZH, en: EN };

const DEFAULT_LANGUAGE: Language = "zh-CN";

function isLanguage(value: string | null): value is Language {
  return value === "zh-CN" || value === "en";
}

/**
 * The stored choice, or Chinese.
 *
 * The default is deliberately not taken from `navigator.languages`, which is
 * how `apps/web` picks its first language: this UI ships for a Chinese-first
 * deployment, and an English-configured browser would otherwise open it in
 * English without ever saying that a setting exists.
 */
function initialLanguage(): Language {
  if (typeof localStorage === "undefined") return DEFAULT_LANGUAGE;
  const stored = readStoredText(localStorage, LOCALE_STORAGE_KEY);
  return isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
}

let language: Language = initialLanguage();

const listeners = new Set<() => void>();

/**
 * Hand the current language to the Electron shell when one is hosting us.
 * [F25] History: this mirror was built for the retired fail-closed error
 * page (review F13/F16 — a file:// page that could not read this origin's
 * localStorage, so the shell persisted the locale on its behalf and passed
 * it via query). That page is gone; the shell-side handler still accepts
 * the report and mirrors it best-effort, but nothing reads the mirror
 * anymore. Kept (not deleted) because removing the bridge call is a wider
 * cleanup than this PR's text-comment fix warrants.
 * In a plain browser there is no sdShell and this is a no-op.
 */
function reportLocaleToShell(l: Language): void {
  const bridge = (globalThis as { sdShell?: { reportLocale?: (lang: Language) => void } }).sdShell;
  bridge?.reportLocale?.(l);
}

// F16: report the persisted language once at module load. `language` was
// just initialized from localStorage above, so the shell learns the
// stored choice even if the user never touches the language setting.
reportLocaleToShell(language);

export function getLanguage(): Language {
  return language;
}

/** `useSyncExternalStore` calls this for both the render and the update check,
 *  so it has to be a stable, synchronous read of a primitive. */
export function getLanguageSnapshot(): Language {
  return language;
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Set `<html lang>`, which is what screen readers and spellcheck look at.
 *  Kept next to the store so both the boot and every switch do the same
 *  thing. */
export function applyDocumentLanguage(): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

export function setLanguage(next: Language): void {
  if (next === language) return;
  language = next;
  if (typeof localStorage !== "undefined") {
    writeStoredText(localStorage, LOCALE_STORAGE_KEY, next);
  }
  // Report the change to the shell (F13/F16 — see reportLocaleToShell).
  reportLocaleToShell(next);
  applyDocumentLanguage();
  for (const listener of [...listeners]) listener();
}

/**
 * The strings for the current language.
 *
 * Only the top level is proxied: `TEXT.settings.nav` returns a whole
 * dictionary object, which is immutable, so a component cannot hold a stale
 * nested table across a language change as long as it reads `TEXT` again on
 * its next render.
 */
export const TEXT: Text = new Proxy({} as Text, {
  get(_target, key) {
    return DICTIONARIES[language][key as keyof Text];
  },
});

/**
 * A user-facing date and time, in the interface language.
 *
 * `toLocaleString()` with no argument formats for the host, so a Chinese
 * interface on an English-locale machine printed `11/25/2026, 10:31:05 PM`
 * inside otherwise Chinese text. These two helpers are what the six call
 * sites that had no locale use; callers that already pass `TEXT.languageTag`
 * keep their own option set. The locale is read at call time, so rendering
 * code that calls the helper again after a language switch formats in the
 * new language.
 */
const STAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

export function formatStamp(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString(TEXT.languageTag, STAMP_OPTIONS);
}

/** The clock half of `formatStamp`, for a `saved at` line: `09:05`. */
export function formatClock(value: string | number | Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleTimeString(TEXT.languageTag, { hour: "2-digit", minute: "2-digit" });
}

export type { Text };
