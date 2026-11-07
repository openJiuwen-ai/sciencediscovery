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
 * structured abstract with its own markup: `<h4>Background/purpose</h4>…<h4>
 * Methods</h4>…`. Rendering that string as one paragraph puts the tags on
 * screen, so this reads the section labels back out and hands each one to the
 * card as a heading over the prose it introduced.
 *
 * No HTML is rendered. The card draws text nodes only — an abstract is
 * third-party content and the two tags that carry meaning here (section
 * headings) are recognised by this parser rather than handed to a browser.
 */

/** One part of an abstract: prose, and the label the source gave it when the
 *  source marked a section at all. */
export interface AbstractSection {
  heading?: string;
  text: string;
}

/** `<h1>`–`<h6>` opening a section; the capture is the label. */
const SECTION_HEADING = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/giu;

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

/** Prose with its inline markup removed: block ends become spaces, so a
 *  `</p><p>` boundary never glues two sentences together. */
function plainText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<br\s*\/?>/giu, " ")
      .replace(/<\/(?:p|div|li|h[1-6])\s*>/giu, " ")
      .replace(/<[^>]*>/gu, ""),
  )
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Split an abstract into its sections, dropping markup.
 *
 * Text before the first heading, or an abstract with no headings at all, comes
 * back as one headingless section — the same card the reader had before, minus
 * the tags.
 */
export function paperAbstractSections(raw: string): AbstractSection[] {
  const source = raw.trim();
  if (source === "") return [];

  const sections: AbstractSection[] = [];
  let heading: string | undefined;
  let cursor = 0;

  for (const match of source.matchAll(SECTION_HEADING)) {
    const start = match.index ?? 0;
    const body = plainText(source.slice(cursor, start));
    if (body !== "") sections.push(heading === undefined ? { text: body } : { heading, text: body });
    const label = plainText(match[1] ?? "");
    heading = label === "" ? undefined : label;
    cursor = start + match[0].length;
  }

  const tail = plainText(source.slice(cursor));
  if (tail !== "") sections.push(heading === undefined ? { text: tail } : { heading, text: tail });

  return sections;
}
