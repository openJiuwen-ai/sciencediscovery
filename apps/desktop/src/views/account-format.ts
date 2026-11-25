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
 * The account page's language-dependent formatting.
 *
 * These helpers used to live inside `AccountPage.tsx` and hardcode Chinese:
 * `万` for large token counts, Chinese business-type labels, and
 * `toLocaleString("zh-CN")` for numbers and times. An English UI therefore read
 * half-Chinese on its one translated page (#1394). Every helper now takes the
 * dictionary in force, so the caller reads `TEXT` while rendering (and
 * subscribes with `useLanguage()`), and the units, labels and locale all come
 * from `text/zh.ts` and `text/en.ts` instead of from this module.
 */

import type { Text } from "../text.js";

/** A whole number in the reader's own grouping: 23,956 / 23.956. */
export function formatAccountNumber(value: number, text: Text): string {
  return Math.round(value).toLocaleString(text.languageTag);
}

/** Credits settle per milli-credit, so a charge can be 0.35 and a balance
 *  598.891; flooring would turn that into -1 and 598 on the audit page. Three
 *  decimals are always shown, because "895.877" alone reads as a thousands
 *  separator in Chinese. The decimal separator follows the language: 598.891 in
 *  English, 598,891 in a decimal-comma locale. */
export function formatAccountCredits(value: number, text: Text): string {
  return value.toLocaleString(text.languageTag, { maximumFractionDigits: 3, minimumFractionDigits: 3 });
}

/** Large token counts. The scale is a property of the language — Chinese reads
 *  1.5万 where English reads 15K — so the dictionary owns it and this is only
 *  the named seam the page and its tests share. */
export function formatAccountTokens(value: number, text: Text): string {
  return text.account.tokenCount(value);
}

/** A ledger row's time in the reader's locale, with the same clock for both
 *  languages: `Intl` supplies the field order, so English reads
 *  11/25/2026, 14:00:00 where Chinese reads 2026/11/25 14:00:00. */
export function formatAccountTime(iso: string, text: Text): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(text.languageTag, { hour12: false });
}

/** The ledger's business type. The account service names the types and may add
 *  one this build does not know; an unknown type falls back to the server's own
 *  value, which still says more than a blank label. */
export function bizLabel(type: string, text: Text): string {
  const labels: Record<string, string> = text.account.biz;
  return labels[type] ?? type;
}
