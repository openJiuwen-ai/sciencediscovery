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
 * One compact token count for every screen.
 *
 * The tier and the rounding decision live here, so a count cannot read one way
 * on the usage page and another way in the model settings badge; each surface
 * only picks its unit glyph afterwards (`formatCompactTokenValue` prints "K",
 * the model badge prints "k", as they already did).
 *
 * The tiers:
 * - 1M and up: one decimal, dropped when it is ".0" — a declared 10.5M context
 *   window reads "10.5M" everywhere. The badge used to round to whole millions
 *   from 10M ("11M") while the usage page kept the fraction.
 * - 10K to 1M: whole thousands — "200K", "131K".
 * - 1K to 10K: one decimal — "6.6K".
 * - Below 1K: the plain count.
 * - A count whose rounded thousands reach 1000 crosses into millions, so
 *   999,999 reads "1M" rather than "1000K".
 */
export type CompactTokenUnit = "k" | "M" | "";

function trimWholeFraction(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

export function compactTokenParts(value: number): { count: string; unit: CompactTokenUnit } {
  if (value >= 1_000_000 || Math.round(value / 1_000) >= 1_000) {
    return { count: trimWholeFraction((value / 1_000_000).toFixed(1)), unit: "M" };
  }
  if (value >= 10_000) return { count: String(Math.round(value / 1_000)), unit: "k" };
  if (value >= 1_000) return { count: (value / 1_000).toFixed(1), unit: "k" };
  return { count: new Intl.NumberFormat().format(value), unit: "" };
}
