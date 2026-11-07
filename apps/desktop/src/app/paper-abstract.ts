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
 * A Paper's abstract, as the reader should see it.
 *
 * The graph stores the string the source returned, and Europe PMC returns a
 * structured abstract with its own markup: `<h4>Background/purpose</h4><p>…`.
 * Printed as-is, that puts tags on the card. What belongs under the paper's
 * title is the abstract itself — its sentences, not the publisher's section
 * scaffolding — so this reads the prose out of the markup and returns it one
 * paragraph per block.
 *
 * No HTML is rendered: an abstract is third-party content, and the card draws
 * text nodes only.
 */

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
]);

/** One reference per pass; the replacement is never scanned again, which keeps
 *  `&amp;lt;` at the two characters `&lt;`. */
const CHARACTER_REFERENCE = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]*));/gu;

const MAX_CODE_POINT = 0x10_ffff;

const PARAGRAPH_BREAK = "\n";

function decodable(point: number): boolean {
  if (!Number.isInteger(point) || point <= 0 || point > MAX_CODE_POINT) return false;
  if (point >= 0xd800 && point <= 0xdfff) return false;
  const trail = point & 0xffff;
  return trail !== 0xfffe && trail !== 0xffff;
}

export function decodeEntities(value: string): string {
  return value.replace(CHARACTER_REFERENCE, (match: string, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES.get(name.toLowerCase()) ?? match;
    const point = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
    return decodable(point) ? String.fromCodePoint(point) : match;
  });
}

/**
 * Split an abstract into the paragraphs it reads as.
 *
 * Block boundaries — `</p>`, `<br>`, a section heading's tag — end a
 * paragraph; a heading's *text* is scaffolding rather than prose, so `<h1>`–
 * `<h6>` take their label with them. Inline markup is dropped without
 * disturbing the words it wrapped.
 */
export function paperAbstractParagraphs(raw: string): string[] {
  if (raw.trim() === "") return [];

  const withoutHeadings = raw.replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/giu, PARAGRAPH_BREAK);
  const blocks = withoutHeadings
    .replace(/<br\s*\/?>/giu, PARAGRAPH_BREAK)
    .replace(/<\/(?:p|div|li)\s*>/giu, PARAGRAPH_BREAK)
    .replace(/<[^>]*>/gu, "");

  return decodeEntities(blocks)
    .split(/\n+/u)
    .map((block) => block.replace(/\s+/gu, " ").trim())
    .filter((block) => block !== "");
}
