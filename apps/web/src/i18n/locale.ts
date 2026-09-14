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

import { LOCALE_STORAGE_KEY, readRenamedStorageItem } from "../browser-storage.js";
import { en, type MessageKey, zhCN } from "./messages.js";

export type Locale = "en" | "zh-CN";
export { LOCALE_STORAGE_KEY };

interface LocaleEnvironment {
  languages?: readonly string[];
  storedLocale?: string | null;
}

interface LocaleTarget {
  documentElement?: { lang: string };
  storage?: Pick<Storage, "setItem">;
}

export function detectLocale(environment?: LocaleEnvironment): Locale {
  const storedLocale = environment?.storedLocale
    ?? (typeof window !== "undefined" ? readRenamedStorageItem(window.localStorage, LOCALE_STORAGE_KEY) : null);
  if (storedLocale === "en" || storedLocale === "zh-CN") return storedLocale;

  const languages = environment?.languages
    ?? (typeof navigator !== "undefined" ? navigator.languages : []);
  return languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
}

export function applyLocale(locale: Locale, target?: LocaleTarget): void {
  const storage = target?.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  const documentElement = target?.documentElement ?? (typeof document !== "undefined" ? document.documentElement : undefined);
  activeLocale = locale;
  storage?.setItem(LOCALE_STORAGE_KEY, locale);
  if (documentElement) documentElement.lang = locale;
}

// Locale used by non-React modules (usage formatting, run-stream toasts, api
// fallbacks) that cannot call useLocale(). LocaleProvider keeps it in sync via
// applyLocale; it only affects chrome produced outside the React tree.
let activeLocale: Locale = "en";

export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
}

export function translateActive(
  key: MessageKey,
  variables: Record<string, string | number> = {},
): string {
  return translate(activeLocale, key, variables);
}

export function translate(
  locale: Locale,
  key: MessageKey,
  variables: Record<string, string | number> = {},
): string {
  // A key with no catalogue entry falls back to the key itself rather than
  // throwing. Call sites build keys dynamically from server data
  // (`node.relation.${edgeType}` in MemoryGraphProduct, `settings.groups.${id}`
  // in App), so an unrecognised value must degrade to a readable string — not
  // take down the whole tree on a `undefined.replace`. Callers that want a
  // nicer fallback compare the result against the key they passed in.
  const template = (locale === "zh-CN" ? zhCN[key] : undefined) ?? en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(variables[name] ?? match));
}
