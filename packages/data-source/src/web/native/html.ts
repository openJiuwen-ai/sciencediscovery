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

const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#x27;", "'"],
  ["&#39;", "'"],
  ["&nbsp;", " "],
];

export function decodeEntities(value: string): string {
  let decoded = value;
  for (const [entity, character] of ENTITIES) decoded = decoded.replaceAll(entity, character);
  // Numeric references appear in titles from several engines.
  return decoded.replace(/&#(\d{1,6});/g, (_match, code: string) => {
    const point = Number(code);
    return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : _match;
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
