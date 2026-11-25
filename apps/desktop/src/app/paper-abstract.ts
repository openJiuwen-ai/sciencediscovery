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

/** HTML and JATS elements that can occur in publisher text. */
const PUBLISHER_TAG_NAMES = [
  "a", "b", "br", "caption", "div", "em", "fig", "h[1-6]", "i", "label", "li", "ol", "p", "span",
  "strong", "sub", "sup", "table", "table-wrap", "tbody", "td", "th", "thead", "tr", "u", "ul", "xref",
  "abstract", "aff", "article-title", "bold", "contrib", "ext-link", "graphic", "italic", "journal-title",
  "kwd", "kwd-group", "mixed-citation", "named-content", "pub-date", "sec", "supplementary-material", "title",
  "mml:[a-z][a-z0-9-]*",
].join("|");
const TAG = new RegExp(String.raw`<\/?(?:${PUBLISHER_TAG_NAMES})(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "giu");
// A quoted attribute can contain a closing angle bracket. Read it as a whole
// and drop the attributes when restoring the structural tag.
const ATTRIBUTE_NAME = String.raw`[a-z_][\w:.-]*`;
const ATTRIBUTE_VALUE = String.raw`(?:"[^"]*"|'[^']*'|&(?:amp;)?quot;(?:(?!&(?:amp;)?quot;)[\s\S])*&(?:amp;)?quot;|&(?:amp;)?apos;(?:(?!&(?:amp;)?apos;)[\s\S])*&(?:amp;)?apos;)`;
const ESCAPED_ATTRIBUTES = String.raw`(?:\s+${ATTRIBUTE_NAME}\s*=\s*${ATTRIBUTE_VALUE})*`;
const ESCAPED_TAG = new RegExp(String.raw`&(amp;)?lt;(\/?)(${PUBLISHER_TAG_NAMES})${ESCAPED_ATTRIBUTES}\s*(\/?)&\1gt;`, "giu");

/** Restore paired publisher markup and line breaks before decoding prose.
 * Escaped blocks can then be handled by the same paragraph splitter as raw markup.
 * Keep unmatched escaped tags as text because they may be literal notation. */
function restoreEscapedTags(fragment: string): string {
  const open: Array<{ key: string; start: number }> = [];
  const markup = new Set<number>();
  for (const match of fragment.matchAll(ESCAPED_TAG)) {
    const [, escape = "", closing, tag, ending = ""] = match;
    if (tag === undefined) continue;
    const name = tag.toLowerCase();
    const key = `${escape.toLowerCase()}${name}`;
    if (!closing) {
      if (name === "br" || ending === "/") markup.add(match.index);
      else open.push({ key, start: match.index });
    } else {
      const start = open.at(-1);
      if (start?.key === key) {
        open.pop();
        markup.add(start.start);
        markup.add(match.index);
      }
    }
  }
  return fragment.replace(ESCAPED_TAG, (token: string, _escape: string, closing: string, tag: string, ending: string, offset: number) =>
    markup.has(offset) ? `<${closing}${tag}${ending}>` : token);
}

/** A section heading with its label, which is navigation rather than prose. */
const SECTION_HEADING = /<(h[1-6]|title)(?=[\s>])[^>]*>[\s\S]*?<\/\1\s*>/giu;

/** One run of text with no publisher markup in it. */
function cleanText(fragment: string): string {
  return decodeEntities(fragment.replace(TAG, "")).replace(/\s+/gu, " ").trim();
}

/** A paper's title, or any other single-line field of its record, as text. */
export function paperPlainText(raw: string): string {
  return cleanText(restoreEscapedTags(raw));
}

/**
 * Split an abstract into the paragraphs it reads as.
 *
 * Block boundaries — paragraph tags, line breaks, and section titles — end a
 * paragraph; a heading's *text* is scaffolding rather than prose, so HTML headings and JATS titles
 * take their label with them. Inline markup is dropped without
 * disturbing the words it wrapped.
 */
export function paperAbstractParagraphs(raw: string): string[] {
  if (raw.trim() === "") return [];

  return restoreEscapedTags(raw)
    .replace(SECTION_HEADING, PARAGRAPH_BREAK)
    .replace(/<br\s*\/?>/giu, PARAGRAPH_BREAK)
    .replace(/<\/(?:p|div|li|sec)\s*>/giu, PARAGRAPH_BREAK)
    .split(/\n+/u)
    .map(cleanText)
    .filter((block) => block !== "");
}
