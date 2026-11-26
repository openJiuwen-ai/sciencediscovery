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
 * One rule for the one-line titles that stand in for a long goal.
 *
 * A card title is a label, not the goal: an Evolve search and an Idea Tree
 * research sit in the same transcript, so they cut at the same number of
 * printed columns and mark the cut the same way. Counting code points instead
 * would give a CJK title twice the visible width of a Latin one, and leaving
 * the cut unmarked would make a shortened title read as the whole task.
 */

/** Longest title, in columns: a CJK character is two columns wide. */
export const TITLE_COLUMNS = 64;

/** The columns one character prints at: CJK ideographs, kana, Hangul and
 *  full-width forms take two; everything else takes one. */
export const columnsOf = (char: string): number =>
  (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(char) ? 2 : 1);

/** Cuts `text` at `maxColumns` printed columns and marks the cut with "…".
 *
 *  Text that fits is returned unchanged, so the marker only ever means the
 *  string was shortened. A trailing space at the cut is dropped so the marker
 *  sits against the last glyph; the marker itself is not counted in the
 *  budget, exactly as the search card has always shown it. */
export function truncateColumns(text: string, maxColumns: number): string {
  let width = 0;
  let out = "";
  for (const char of text) {
    width += columnsOf(char);
    if (width > maxColumns) return `${out.trimEnd()}…`;
    out += char;
  }
  return out;
}
