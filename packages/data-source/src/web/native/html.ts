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
 * Minimal HTML helpers shared by the free search engines.
 *
 * The free engines read public result pages, so they need block splitting and
 * text extraction but not a DOM. Keeping this to a few well-tested functions
 * avoids pulling a parser (and its transitive tree) into the control plane for
 * three scrapers, and keeps every engine failing the same way when a page
 * changes: no blocks matched → no results → the aggregation moves on.
 */

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["nbsp", " "],
]);

/** Matches one reference in the source; its replacement is never scanned again,
 *  which is what keeps `&amp;lt;` at the two characters `&lt;`. */
const CHARACTER_REFERENCE = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]*));/g;

const MAX_CODE_POINT = 0x10_ffff;

/** Only scalars that survive UTF-8 and JSON: no lone surrogate, no non-character. */
function decodableCodePoint(point: number): boolean {
  if (!Number.isInteger(point) || point <= 0 || point > MAX_CODE_POINT) return false;
  if (point >= 0xd800 && point <= 0xdfff) return false;
  const trail = point & 0xffff;
  return trail !== 0xfffe && trail !== 0xffff;
}

export function decodeEntities(value: string): string {
  return value.replace(CHARACTER_REFERENCE, (match: string, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES.get(name) ?? match;
    const point = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
    return decodableCodePoint(point) ? String.fromCodePoint(point) : match;
  });
}

/** Strip tags, decode entities, and collapse whitespace into one line. */
export function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Split a document into one chunk per opening tag match.
 *
 * Each chunk runs from its own match to the next one (or the end), which is
 * enough to scope per-result sub-extraction without tracking nesting. Result
 * blocks on these pages are siblings, so a chunk never swallows the next one.
 */
export function sliceBlocks(html: string, opening: RegExp): string[] {
  const pattern = new RegExp(opening.source, opening.flags.includes("g") ? opening.flags : `${opening.flags}g`);
  const starts: number[] = [];
  for (const match of html.matchAll(pattern)) {
    if (match.index !== undefined) starts.push(match.index);
  }
  return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length));
}

/** First capture group of the first match, or undefined. */
export function firstMatch(fragment: string, pattern: RegExp): string | undefined {
  return fragment.match(pattern)?.[1];
}
