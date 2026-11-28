// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * Schwartz–Hearst abbreviation detection (deterministic, zero LLM), ported
 * verbatim from the DeepAnalyze scholarly/abbrev-detector module.
 *
 * Academic text overwhelmingly defines abbreviations as "Full Name (ABBR)"
 * at first mention. The classic Schwartz & Hearst (2003) alignment finds
 * those pairs with high precision: a parenthesized candidate of 2–10
 * Latin chars is matched right-to-left against the preceding words (at
 * most |ABBR|+5 of them); every abbreviation character must align, and the
 * long form starts at the word containing the first aligned character.
 *
 * Deliberate scope limits (fail-silent, other resolver layers cover them):
 *   - CJK long forms don't align against Latin abbreviation characters —
 *     returns nothing (LLM aliases / judge handle cross-lingual cases);
 *   - "ABBR (Full Name)" inverted pattern and comma-separated parentheses
 *     ("(Large Language Model, LLM)") are not detected.
 */

const PAREN_ABBR_RE = /\(([A-Za-z][A-Za-z0-9-]{1,9})\)/g;
const MAX_LOOKBACK_CHARS = 300;

/** Right-to-left Schwartz–Hearst alignment; null when no full form aligns. */
export function findLongForm(abbr: string, preceding: string): string | null {
  const words = preceding.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const window = words.slice(-(abbr.length + 5));
  const candidate = window.join(" ");

  let sIdx = abbr.length - 1;
  let cIdx = candidate.length - 1;
  while (cIdx >= 0 && sIdx >= 0) {
    if (candidate[cIdx]!.toLowerCase() === abbr[sIdx]!.toLowerCase()) sIdx--;
    cIdx--;
  }
  if (sIdx >= 0) return null; // not all abbreviation characters aligned

  // Long form begins at the start of the word containing the first match.
  let start = cIdx + 1;
  while (start > 0 && candidate[start - 1] !== " ") start--;
  const longForm = candidate.slice(start).trim();
  // Sanity: the long form must be at least as long as the abbreviation and
  // must start with the same letter (Schwartz–Hearst constraint).
  if (longForm.length < abbr.length) return null;
  if (longForm[0]!.toLowerCase() !== abbr[0]!.toLowerCase()) return null;
  return longForm;
}

/**
 * Extract abbreviation → full-form pairs from a document.
 * Keys are lowercased abbreviations; first definition wins.
 */
export function extractAbbrevPairs(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  PAREN_ABBR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAREN_ABBR_RE.exec(text)) !== null) {
    const abbr = m[1]!;
    const key = abbr.toLowerCase();
    if (pairs.has(key)) continue;
    const preceding = text.slice(Math.max(0, m.index - MAX_LOOKBACK_CHARS), m.index);
    const full = findLongForm(abbr, preceding);
    if (full) pairs.set(key, full);
  }
  return pairs;
}
