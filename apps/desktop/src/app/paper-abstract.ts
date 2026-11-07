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

/** A tag, not a comparison: `5 < 10` and `a > b` stay as the author wrote them. */
const TAG = /<\/?[a-zA-Z][^>]*>/gu;

/** A section heading with its label, which is navigation rather than prose. */
const SECTION_HEADING = /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/giu;

/**
 * One run of text with no markup in it.
 *
 * The decode pass is followed by a second strip because some records come back
 * double-escaped — a title stored as `&lt;i&gt;BRCA1&lt;/i&gt;` means an italic
 * run, not four characters to show the reader.
 */
function cleanText(fragment: string): string {
  const decoded = decodeEntities(fragment.replace(TAG, ""));
  return decoded.replace(TAG, "").replace(/\s+/gu, " ").trim();
}

/** A paper's title, or any other single-line field of its record, as text. */
export function paperPlainText(raw: string): string {
  return cleanText(raw);
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

  return raw
    .replace(SECTION_HEADING, PARAGRAPH_BREAK)
    .replace(/<br\s*\/?>/giu, PARAGRAPH_BREAK)
    .replace(/<\/(?:p|div|li)\s*>/giu, PARAGRAPH_BREAK)
    .split(/\n+/u)
    .map(cleanText)
    .filter((block) => block !== "");
}
